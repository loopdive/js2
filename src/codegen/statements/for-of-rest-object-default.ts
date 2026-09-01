// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Shared carriers for assignment patterns applied to a WasmGC rest array. */
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "../expressions/late-imports.js";

/**
 * Materialise a native rest vector as the Array carrier expected by the
 * generic iterator/object assignment path.
 *
 * A rest value is an Array, not a struct whose fields are the only observable
 * properties. Converting it to externref before property reads lets the
 * ordinary `__extern_get` path handle `length`, numeric keys, and Array/Object
 * prototype inheritance, while keeping default initialisers and PutValue
 * targets in one implementation.
 */
export function emitForOfRestObjectCarrier(ctx: CodegenContext, fctx: FunctionContext, vecLocal: number): number {
  const carrierLocal = allocLocal(fctx, `__forof_restobj_carrier_${fctx.locals.length}`, {
    kind: "externref",
  });
  const fromIterIdx = ensureLateImport(
    ctx,
    "__array_from_iter_n",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "local.get", index: vecLocal });
  if (fromIterIdx !== undefined) {
    fctx.body.push({ op: "f64.const", value: -1 });
    fctx.body.push({ op: "call", funcIdx: fromIterIdx });
  } else {
    fctx.body.push({ op: "extern.convert_any" });
  }
  fctx.body.push({ op: "local.set", index: carrierLocal });
  return carrierLocal;
}
