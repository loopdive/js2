// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §7.3.14 Call step 2 for a callee the program reads as a value (`[[Get]](recv, name)`) and invokes through
 * `__apply_closure`. That bridge answers `undefined` for a non-callable instead of throwing, so each such call site
 * tests IsCallable itself, after the arguments (their side effects stay observable) and before [[Call]].
 */
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { ensureBoundaryCallableKind } from "../object-runtime.js";
import { ensureLateImport } from "./late-imports.js";

/** Register `__is_callable` before any funcIdx is captured; `undefined` when the module cannot provide it. */
export function registerCalleeCallableGuard(ctx: CodegenContext): number | undefined {
  ensureBoundaryCallableKind(ctx); // (#6686) admitted JS functions are callable
  return ensureLateImport(ctx, "__is_callable", [{ kind: "externref" }], [{ kind: "i32" }]);
}

/** Throw a TypeError unless the externref in `calleeLocal` is callable; `__is_callable` also rejects a class value. */
export function emitCalleeCallableGuard(ctx: CodegenContext, fctx: FunctionContext, calleeLocal: number): void {
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "called value is not a function", { flush: fctx });
  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__is_callable")! },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
  );
}
