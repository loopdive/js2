// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

export type RyuI32 = { kind: "i32" };
export type RyuI64 = { kind: "i64" };
export type RyuF64 = { kind: "f64" };
export const RYU_I32: RyuI32 = { kind: "i32" };
export const RYU_I64: RyuI64 = { kind: "i64" };
export const RYU_F64: RyuF64 = { kind: "f64" };
export type RyuDataReference =
  | { readonly kind: "ref"; readonly typeIdx: number; readonly typeKey?: never }
  | { readonly kind: "ref"; readonly typeKey: string; readonly typeIdx?: never };
export interface NativeRyuBody {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}
export interface RyuDigitsResources {
  readonly mulShift: FuncHandle;
  readonly tableTypeIdx: number;
  readonly inverseGlobalIdx: number;
  readonly powersGlobalIdx: number;
}
export interface RyuToBufferResources {
  readonly digits: FuncHandle;
  readonly stringDataTypeIdx: number;
}
export function ryuMulShiftSignature(): {
  readonly params: [RyuI64, RyuI64, RyuI64, RyuI32];
  readonly results: [RyuI64];
} {
  return { params: [RYU_I64, RYU_I64, RYU_I64, RYU_I32], results: [RYU_I64] };
}
export function ryuDigitsSignature(): {
  readonly params: [RyuF64];
  readonly results: [RyuI64, RyuI32];
} {
  return { params: [RYU_F64], results: [RYU_I64, RYU_I32] };
}
export function ryuToBufferSignature<R extends RyuDataReference>(
  data: R,
): {
  readonly params: [RyuF64, RyuI32, R, RyuI32];
  readonly results: [RyuI32];
} {
  return { params: [RYU_F64, RYU_I32, data, RYU_I32], results: [RYU_I32] };
}
