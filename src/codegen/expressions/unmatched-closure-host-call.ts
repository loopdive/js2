// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) Terminal arm of the identifier-callee funcref ladder for a LIVE
// closure whose exact funcref type no arm names.
//
// The ladder is built from the signatures visible when the calling body
// compiles. A generic helper erases its callback's `T` to externref, while a
// callback compiled elsewhere keeps its own ABI: a nominal `(ref null $Node)`
// parameter, a `void` result. TypeScript's `forEach(nodes, bind)` in the binder
// is the witness — `bind` matched no arm and the call ended in the TypeError
// arm although the value was a perfectly callable closure.
//
// On the host lane such a closure is still callable through the host: the
// runtime wraps it and re-enters the finalize-time `__call_fn_<N>` dispatcher,
// which is built over the COMPLETE closure table and casts each externref
// argument to the formal's own type. Standalone, WASI and native-first
// profiles keep the TypeError arm — except for ONE callee shape (#6769 S7c):
// a binding that holds a property descriptor's accessor. A built-in accessor
// is a live closure whose lifted funcref carries an explicit receiver slot, so
// no ladder arm names it; there the arm calls the finalize-time native
// `__apply_closure` dispatcher, which is built over the complete closure table.

import ts from "typescript";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import {
  ensureHostCallFallbackImports,
  type HostCallFallbackPlan,
  planHostCallFallback,
} from "./host-call-fallback.js";
import { flushLateImportShifts } from "./late-imports.js";

/** (#6769 S7c) The standalone arm's plan: the argument-carrier local. */
type UnmatchedClosureApplyPlan = { apply: true; argsLocal: number };

/**
 * Register the host-call import for an unmatched-closure arm of `call` — or,
 * standalone, reserve the `__apply_closure` arm for a descriptor-accessor
 * callee. Must run before any dispatch arm captures a function index.
 */
export function reserveUnmatchedClosureHostCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): HostCallFallbackPlan | UnmatchedClosureApplyPlan | undefined {
  if (ctx.standalone || ctx.wasi) {
    if (!calleeIsDescriptorAccessor(ctx, call.expression)) return undefined;
    ensureObjVecBuilders(ctx);
    reserveApplyClosure(ctx);
    return {
      apply: true,
      argsLocal: allocLocal(fctx, `__unmatched_args_${fctx.locals.length}`, { kind: "externref" }),
    };
  }
  if (ctx.targetProfile.semanticProviders === "native-first") return undefined;
  const plan = planHostCallFallback(call.arguments.length);
  if (!plan.fixedArity) return undefined;
  ensureHostCallFallbackImports(ctx, plan);
  flushLateImportShifts(ctx, fctx);
  return plan;
}

/**
 * `__call_function_<N>(closure, this, args…)` — or, standalone,
 * `__apply_closure(closure, undefined, [args…])` — coerced to the ladder's
 * result type, or undefined when the result has no index-stable bridge.
 */
export function buildUnmatchedClosureHostCall(
  ctx: CodegenContext,
  plan: HostCallFallbackPlan | UnmatchedClosureApplyPlan,
  closureLocal: number,
  argExternLocals: readonly number[],
  expectedReturn: ValType | null,
  bridge: (from: ValType, to: ValType) => Instr[] | null,
): Instr[] | undefined {
  const callIdx = ctx.funcMap.get("apply" in plan ? "__apply_closure" : plan.importName);
  if (callIdx === undefined || ("arity" in plan && argExternLocals.length !== plan.arity)) return undefined;
  let result: Instr[] | null = [];
  if (expectedReturn === null) result = [{ op: "drop" }];
  else if (expectedReturn.kind !== "externref") result = bridge({ kind: "externref" }, expectedReturn);
  if (result === null) return undefined;
  // callee, then `this` = undefined (a bare identifier call).
  const head: Instr[] = [
    { op: "local.get", index: closureLocal },
    { op: "extern.convert_any" },
    { op: "ref.null.extern" },
  ];
  if (!("apply" in plan)) {
    for (const index of argExternLocals) head.push({ op: "local.get", index });
    return [...head, { op: "call", funcIdx: callIdx }, ...result];
  }
  // `__apply_closure` takes the arguments as ONE $ObjVec carrier, packed first.
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const pack: Instr[] = [
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: plan.argsLocal },
  ];
  for (const index of argExternLocals) {
    pack.push({ op: "local.get", index: plan.argsLocal }, { op: "local.get", index }, { op: "call", funcIdx: pushIdx });
  }
  return [...pack, ...head, { op: "local.get", index: plan.argsLocal }, { op: "call", funcIdx: callIdx }, ...result];
}

/**
 * (#6769 S7c) Is `expr` an identifier bound to a property descriptor's
 * ACCESSOR — `var g = Object.getOwnPropertyDescriptor(o, k).get` (or `.set`,
 * through `Reflect.getOwnPropertyDescriptor`, or one binding removed:
 * `var d = Object.getOwnPropertyDescriptor(o, k); var g = d.get`)? Those are
 * exactly the test262 `invoked-as-func` idioms, so no other call site changes
 * shape.
 */
function calleeIsDescriptorAccessor(ctx: CodegenContext, expr: ts.Expression): boolean {
  const init = bindingInitializer(ctx, expr);
  if (init === undefined || !ts.isPropertyAccessExpression(init)) return false;
  if (init.name.text !== "get" && init.name.text !== "set") return false;
  const source = unwrap(init.expression);
  return isDescriptorQuery(source) || isDescriptorQuery(bindingInitializer(ctx, source));
}

/** The unwrapped initializer of the `var`/`let`/`const` an identifier names. */
function bindingInitializer(ctx: CodegenContext, expr: ts.Expression): ts.Expression | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const decl = ctx.oracle.valueDeclarationOf(expr);
  if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return undefined;
  return unwrap(decl.initializer);
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  return expr;
}

/** `Object.getOwnPropertyDescriptor(…)` / `Reflect.getOwnPropertyDescriptor(…)`. */
function isDescriptorQuery(expr: ts.Expression | undefined): boolean {
  if (expr === undefined || !ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  const holder = expr.expression.expression;
  return (
    expr.expression.name.text === "getOwnPropertyDescriptor" &&
    ts.isIdentifier(holder) &&
    (holder.text === "Object" || holder.text === "Reflect")
  );
}
