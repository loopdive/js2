// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitGlobalEnvironmentObject } from "../global-environment.js";
import { emitThrowJsError } from "../js-errors.js";
import { compileExpression } from "../shared.js";
import { tryStandaloneUnavailableTimerCall } from "../standalone-timers.js";

/**
 * Host-free call sites on a standalone module, tried after the constant
 * `Function(...)` compile-away (#2924) declined: an unavailable timer global
 * (#6675), the `Function("return this")()` global probe, and — when no
 * runtime-eval provider is linked — the immediate `Function(src)(args)` form
 * (#6676). `undefined` for every other call.
 */
export function tryStandaloneHostFreeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  immediateFunctionCtor: boolean,
): ValType | undefined {
  const timer = tryStandaloneUnavailableTimerCall(ctx, fctx, expr);
  if (timer !== undefined) return timer;
  const global = tryStandaloneReturnThisFunctionCall(ctx, fctx, expr);
  if (global !== undefined) return global;
  if (immediateFunctionCtor && isRuntimeEvalProviderAbsent(ctx))
    return emitRefusedImmediateFunctionCall(ctx, fctx, expr);
  return undefined;
}

/**
 * Dynamic code on a standalone module that will NOT be linked against the
 * `js2wasm:runtime-eval` provider (`runtimeEvalProvider: false`).
 *
 * §20.2.1.1.1 CreateDynamicFunction asks HostEnsureCanCompileStrings before
 * parsing; a host that cannot compile source (a CSP without `unsafe-eval`,
 * V8's `--disallow-code-generation-from-strings`) throws `EvalError` there.
 * A zero-import standalone module is exactly such a host: it has no parser or
 * interpreter of its own, and the provider that would supply one is absent.
 * So the constructor throws that `EvalError` instead of importing
 * `__runtime_new_function` / `__runtime_apply_interpreted`, which would make
 * every module that merely CONTAINS the call (lodash's `template`) impossible
 * to instantiate. The parameter/body expressions still run first, in order.
 */
const DYNAMIC_FUNCTION_REFUSED =
  "Code generation from strings disallowed for this context " +
  "(standalone module compiled with runtimeEvalProvider: false)";

export function isRuntimeEvalProviderAbsent(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.runtimeEvalProviderAbsent === true;
}

export function emitRefusedDynamicFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType {
  for (const arg of args) {
    const type = compileExpression(ctx, fctx, arg);
    if (type !== null) fctx.body.push({ op: "drop" });
  }
  emitThrowJsError(ctx, fctx, "EvalError", DYNAMIC_FUNCTION_REFUSED);
  fctx.body.push({ op: "unreachable" });
  return { kind: "externref" };
}

/** `Function(src)(args)` / `new Function(src)(args)` with no provider: the
 * callee's CreateDynamicFunction throws before any outer argument runs. */
function emitRefusedImmediateFunctionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType {
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  const ctorArgs = ts.isCallExpression(callee) || ts.isNewExpression(callee) ? (callee.arguments ?? []) : [];
  return emitRefusedDynamicFunction(ctx, fctx, ctorArgs);
}

/**
 * `Function("return this")()` — the classic global-object probe (lodash
 * `_root.js`, core-js, regenerator). The body is a compile-time constant and a
 * dynamic function is never strict unless its own body says so, so the
 * immediate call binds `this` to the global object (§10.2.1.2
 * OrdinaryCallBindThis) and returns it. Fold it to the realm's global object
 * instead of routing a constant through the runtime-eval provider — the
 * general constant compile-away (#2924) declines any body that mentions
 * `this`, because its splice binds `this` to `undefined`.
 */
function tryStandaloneReturnThisFunctionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (ctx.targetProfile.environment !== "none" || expr.arguments.length !== 0) return undefined;
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isCallExpression(callee) && !ts.isNewExpression(callee)) return undefined;
  if (ts.isCallExpression(callee) && callee.questionDotToken) return undefined;
  const target = callee.expression;
  if (!ts.isIdentifier(target) || target.text !== "Function") return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(target);
  if (declaration !== undefined && !declaration.getSourceFile().isDeclarationFile) return undefined;
  const ctorArgs = callee.arguments ?? [];
  if (ctorArgs.length !== 1) return undefined;
  const body = ctorArgs[0]!;
  if (!ts.isStringLiteral(body) && !ts.isNoSubstitutionTemplateLiteral(body)) return undefined;
  if (!/^\s*return\s+this\s*;?\s*$/.test(body.text)) return undefined;
  return emitGlobalEnvironmentObject(ctx, fctx) ?? undefined;
}
