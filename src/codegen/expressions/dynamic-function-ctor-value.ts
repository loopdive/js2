// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4650) JS-host VALUE form `Function(<args>)` — the plain call, which
 * §20.2.1.1 defines as identical to `new Function(<args>)`.
 *
 * Only the NewExpression path (new-builtin-globals.ts) routed a DECLINED
 * constant compile-away to the `__extern_new_function` host shim. The call form
 * fell through the whole of `compileCallExpression` and answered
 * `ref.null.extern`, so `Function("return this;")` — test262
 * harness/fnGlobalObject.js, whose body contains `this` and is therefore
 * declined by the #2924 compile-away on purpose — evaluated to NULL, and the
 * immediate-call arm then packed that null into `__call_function`, producing
 * `TypeError: null is not a function`.
 *
 * Ordering constraints (this is an arm of an ordered dispatch chain):
 *   - AFTER `tryStaticFunctionCtorCall` — the constant compile-away is the
 *     better lowering whenever it applies, and it also owns the
 *     `Function(...)(args)` immediate-call shape.
 *   - BEFORE the generic any-callee dispatch, which is what used to swallow it.
 *
 * Standalone/wasi decline here and keep their own lowering
 * (`tryStandaloneDynamicFunctionCtorValue` → the runtime-eval provider, which
 * already passes this test), so there is no new host import and no dual-mode
 * gap: this arm reuses the shim dynamic `new Function` has used since #2960.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitDynamicNewFunctionHostEval, resolvesToGlobalFunctionAlias } from "./eval-inline.js";
import { noJsHost } from "./helpers.js";

export function tryHostDynamicFunctionCtorValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (noJsHost(ctx) || ctx.nativeStrings) return undefined;
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee) || !resolvesToGlobalFunctionAlias(callee, ctx.oracle)) return undefined;
  return emitDynamicNewFunctionHostEval(ctx, fctx, expr.arguments);
}
