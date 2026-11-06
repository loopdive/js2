// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) Symbolic native ArrayBuffer adapter ABI, shared by the IR producer
 * (`ir/native-buffer-lowering.ts`) and the backend provider
 * (`codegen/buffers/ir-native-buffer.ts`).
 */

/** `(f64 length) -> externref`: a fixed buffer. */
export const IR_NATIVE_AB_NEW_FN = "__ir_ab_new";
/** `(f64 length, f64 maxByteLength) -> externref`: a resizable buffer. */
export const IR_NATIVE_AB_NEW_RESIZABLE_FN = "__ir_ab_new_resizable";
/** `(externref buffer) -> f64`. */
export const IR_NATIVE_AB_BYTE_LENGTH_FN = "__ir_ab_byte_length";
/** `(externref buffer) -> f64`. */
export const IR_NATIVE_AB_MAX_BYTE_LENGTH_FN = "__ir_ab_max_byte_length";
/** `(externref buffer) -> i32` (boolean). */
export const IR_NATIVE_AB_RESIZABLE_FN = "__ir_ab_resizable";
/** `(externref buffer, externref start, externref end) -> externref`; an omitted bound is `undefined`. */
export const IR_NATIVE_AB_SLICE_FN = "__ir_ab_slice";

/** Every adapter: the backend mints exactly these, keyed by this type. */
export const IR_NATIVE_BUFFER_FNS = [
  IR_NATIVE_AB_NEW_FN,
  IR_NATIVE_AB_NEW_RESIZABLE_FN,
  IR_NATIVE_AB_BYTE_LENGTH_FN,
  IR_NATIVE_AB_MAX_BYTE_LENGTH_FN,
  IR_NATIVE_AB_RESIZABLE_FN,
  IR_NATIVE_AB_SLICE_FN,
] as const;

export type IrNativeBufferFn = (typeof IR_NATIVE_BUFFER_FNS)[number];

const ADAPTER_NAMES: ReadonlySet<string> = new Set(IR_NATIVE_BUFFER_FNS);

export function isIrNativeBufferFn(symbol: string): symbol is IrNativeBufferFn {
  return ADAPTER_NAMES.has(symbol);
}
