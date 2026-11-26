// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7465) `__box_number` for an array HOF callback loop. The `arguments` extras box the index and a numeric element,
 * and the externref host bridge boxes a numeric element. The loop body is built as detached instruction lists, which a
 * late import cannot shift, so `setupArrayCallback` registers the helper while `fctx.body` still owns the code, and the
 * arms only `requireHelper` it. A callback declared after its call site used to find the helper unregistered and box null.
 */
import type { ValType } from "../ir/types.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** Register `__box_number` when the callback's loop boxes a number (fewer than two formals, or the externref bridge). */
export function registerCallbackBoxNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  closureInfo: ClosureInfo | undefined,
  bridgeArgType: ValType | undefined,
): void {
  const boxes = closureInfo
    ? closureInfo.needsCallSiteArity !== false && closureInfo.paramTypes.length < 2
    : bridgeArgType?.kind === "externref";
  if (!boxes) return;
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
}
