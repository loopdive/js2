// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#1058) A nullable WasmGC reference whose TypeScript type is `T | undefined`
// (no `null`) uses `ref.null` as its `undefined`. Boxing it to externref with a
// bare `extern.convert_any` turns that absent value into JavaScript `null`, so
// every later `=== undefined` reads false. TypeScript's parser is the witness:
// `sourceFile.externalModuleIndicator = isFileProbablyExternalModule(sf)` stored
// `null` for a plain script, `isExternalModule` answered true, and the binder
// took the module path and trapped in `bindSourceFileAsExternalModule`.
//
// Host lane only: standalone keeps its own undefined representation.

import type { ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined, ensureGetUndefined, flushLateImportShifts } from "./expressions/late-imports.js";

/** Does a null reference produced for `expr` stand for `undefined`? */
function nullRefMeansUndefined(ctx: CodegenContext, expr: ts.Expression, result: ValType): boolean {
  if (result.kind !== "ref_null" || ctx.standalone || ctx.wasi) return false;
  if (result.typeIdx === ctx.anyValueTypeIdx) return false;
  const { nullable, undefinable } = ctx.oracle.nullabilityOf(expr);
  return undefinable && !nullable;
}

/**
 * With the boxed externref of `expr` on the stack, replace a null with the
 * JavaScript `undefined` when the value's type admits `undefined` but not
 * `null`. Emits nothing otherwise.
 */
export function boxNullRefAsUndefined(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  result: ValType,
): void {
  if (!nullRefMeansUndefined(ctx, expr, result)) return;
  // Register the import before detaching a branch body, so any index shift
  // reaches every buffer.
  if (ensureGetUndefined(ctx) !== undefined) flushLateImportShifts(ctx, fctx);
  const undefinedArm: FunctionContext["body"] = [];
  const savedBody = fctx.body;
  fctx.body = undefinedArm;
  try {
    emitUndefined(ctx, fctx);
  } finally {
    fctx.body = savedBody;
  }
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push(
    { op: "local.tee", index: tmp },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefinedArm,
      else: [{ op: "local.get", index: tmp }],
    },
  );
  releaseTempLocal(fctx, tmp);
}
