// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../../ts-api.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Prepare host undefined padding before reserving the compiled apply bridge. */
export function prepareCompiledApplyBridge(ctx: CodegenContext, fctx: FunctionContext): void {
  if (ctx.standalone || ctx.wasi) return;
  ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
}

/** Push a materialized arguments vec as externref without iterable wrapping. */
export function emitMaterializedArgumentsVector(
  ctx: CodegenContext,
  fctx: FunctionContext,
  identifier: ts.Identifier,
): void {
  const localIdx = fctx.localMap.get(identifier.text)!;
  const type = getLocalType(fctx, localIdx)!;
  fctx.body.push({ op: "local.get", index: localIdx });
  if (type.kind === "ref" || type.kind === "ref_null") fctx.body.push({ op: "extern.convert_any" });
  else if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
}
