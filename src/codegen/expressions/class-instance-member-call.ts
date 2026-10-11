// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6692) `o.name(…)` on a USER-CLASS instance whose `name` no static arm could
 * resolve — the shape a COMPUTED-key install produces:
 *
 * ```js
 * class K { constructor() { var m = "go"; this[m] = (a) => a + 1; } }
 * new K().go(5);   // standalone before: null. Node: 6.
 * ```
 *
 * hono installs every HTTP verb exactly this way (`this[method] = (args1,
 * ...args) => { …; return this; }` in `HonoBase`'s constructor), so `app.get(…)`
 * never ran and the npm-compat checksum read `Wasm 8, Node 9`.
 *
 * ## Why it fell through
 *
 * The write lands in the instance's #4194 expando bag, and the READ already
 * finds it (`var f = o.go; f(5)` answered 6): the member read lowers to
 * `__extern_get`, whose instance arm consults the bag. But the CALL has no
 * `K_go` method to bind, and `tryEmitStoredMemberClosureCall` admits only
 * members some `<expr>.go = …` DOT write (or `defineProperty`) names — a
 * computed key names nothing — and only an identifier receiver. So the call
 * reached `compileCallDispatchTail`'s graceful fallback, which evaluates the
 * callee, drops it, and answers `undefined` with the closure never invoked.
 *
 * ## The lowering
 *
 * `__apply_closure(__extern_get(R, "name"), R, [args…])` with `R` evaluated
 * ONCE (so `new K().go(5)` constructs once), the callee read BEFORE the
 * arguments (§13.3.6.1), and `R` threaded as `this`. It is the same pair the
 * #5195 instance arm (`class-dynamic-member-call.ts`) emits for a runtime key.
 *
 * ## Blast radius
 *
 * The arm sits immediately before the graceful fallback, so it can only claim
 * a call that answered `undefined` without running anything. On a real miss
 * `__extern_get` answers the undefined sentinel and `__apply_closure` answers
 * `undefined` for a non-callable — the fallback's value exactly, so no absent
 * member is turned into a throw by this arm. Host-free lanes only; the JS-host
 * lane never reaches this tail for these shapes and is byte-identical.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/** `fillApplyClosure` dispatches arities 0..8 (see `stored-member-closure-call.ts`). */
const APPLY_CLOSURE_MAX_ARITY = 8;

/** The static member name and receiver of `R.name(…)` / `R["name"](…)`, or undefined. */
function memberCallShape(expr: ts.CallExpression): { recv: ts.Expression; name: string } | undefined {
  const callee = expr.expression;
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr)) return undefined;
  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.name)) return undefined;
    return { recv: callee.expression, name: callee.name.text };
  }
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    if (key === undefined || !ts.isStringLiteralLike(key)) return undefined;
    return { recv: callee.expression, name: key.text };
  }
  return undefined;
}

/** True when the receiver's declared type names a compiled user class. */
function receiverIsUserClassInstance(ctx: CodegenContext, recv: ts.Expression): boolean {
  if (recv.kind === ts.SyntaxKind.SuperKeyword) return false;
  let name = ctx.oracle.declaredNameOf(recv);
  if (name && !ctx.classSet.has(name)) name = ctx.classExprNameMap.get(name) ?? name;
  if (!name || !ctx.classSet.has(name)) return false;
  // A class VALUE (`C.m()`) is a static-member call, not an instance one.
  return !(ts.isIdentifier(recv) && recv.text === name);
}

export function tryEmitClassInstanceMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  const shape = memberCallShape(expr);
  if (shape === undefined) return undefined;
  if (expr.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;
  if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;
  if (!receiverIsUserClassInstance(ctx, shape.recv)) return undefined;

  // Reserve every helper BEFORE compiling anything (#1839/#117/#1886).
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (applyIdx === undefined || newIdx === undefined || pushIdx === undefined || externGetIdx === undefined) {
    return undefined;
  }

  const pushAsExternref = (e: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, e, EXTERNREF);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  };

  const recvLocal = allocLocal(fctx, `__cim_recv_${fctx.locals.length}`, EXTERNREF);
  pushAsExternref(shape.recv);
  fctx.body.push({ op: "local.set", index: recvLocal });

  addStringConstantGlobal(ctx, shape.name);
  const calleeLocal = allocLocal(fctx, `__cim_callee_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, shape.name));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx } satisfies Instr);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argsLocal = allocLocal(fctx, `__cim_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? newIdx });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    pushAsExternref(arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
  }

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
  return EXTERNREF;
}
