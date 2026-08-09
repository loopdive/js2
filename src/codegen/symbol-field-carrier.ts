// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Symbol-brand preservation at struct and host-boundary seams. */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { isSymbolType } from "../checker/type-mapper.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export function symbolBrand(type: ts.Type, wasmType: ValType): ValType {
  if (wasmType.kind !== "i32") return wasmType;
  const parts = type.isUnion()
    ? type.types.filter((part) => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
    : [type];
  return parts.length > 0 && parts.every(isSymbolType) ? { kind: "i32", symbol: true } : wasmType;
}

export function commonScalarFieldType(kind: ValType["kind"], fields: readonly ValType[]): ValType {
  if (kind !== "i32") return { kind } as ValType;
  if (fields.every((field) => field.kind === "i32" && field.boolean === true)) {
    return { kind: "i32", boolean: true };
  }
  return fields.every((field) => field.kind === "i32" && field.symbol === true)
    ? { kind: "i32", symbol: true }
    : { kind: "i32" };
}

export function ensureScalarUnbox(ctx: CodegenContext, fctx: FunctionContext, type: ValType): number | undefined {
  if (type.kind !== "f64" && type.kind !== "i32") {
    flushLateImportShifts(ctx, fctx);
    return undefined;
  }
  const idx =
    type.kind === "i32" && type.symbol === true
      ? ensureLateImport(ctx, "__unbox_symbol", [{ kind: "externref" }], [{ kind: "i32", symbol: true }])
      : ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/** Returns undefined when this is not a symbol-specific boundary conversion. */
export function symbolBoundaryCoercionInstrs(
  ctx: CodegenContext,
  from: ValType,
  to: ValType,
  fctx?: FunctionContext,
): Instr[] | undefined {
  if ((from.kind === "externref" || from.kind === "ref_extern") && to.kind === "i32" && to.symbol === true) {
    if ((ctx.standalone || ctx.wasi) && ctx.symbolTypeIdx >= 0) {
      return [
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.symbolTypeIdx },
        { op: "struct.get", typeIdx: ctx.symbolTypeIdx, fieldIdx: 0 },
      ];
    }
    const idx =
      ctx.funcMap.get("__unbox_symbol") ??
      (fctx
        ? ensureLateImport(ctx, "__unbox_symbol", [{ kind: "externref" }], [{ kind: "i32", symbol: true }])
        : undefined);
    if (fctx) flushLateImportShifts(ctx, fctx);
    return idx === undefined ? undefined : [{ op: "call", funcIdx: idx }];
  }
  if (from.kind === "i32" && from.symbol === true && (to.kind === "externref" || to.kind === "ref_extern")) {
    const idx =
      ctx.funcMap.get("__box_symbol") ??
      (fctx ? ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]) : undefined);
    if (fctx) flushLateImportShifts(ctx, fctx);
    return idx === undefined ? undefined : [{ op: "call", funcIdx: idx }];
  }
  return undefined;
}
