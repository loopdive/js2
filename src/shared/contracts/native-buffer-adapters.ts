// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) Symbolic native ArrayBuffer / DataView adapter ABI, shared by the IR
 * producer (`ir/native-buffer-lowering.ts`) and the backend provider
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
/** `(externref buffer, f64 byteOffset, externref byteLength) -> externref`; an omitted length is `undefined`. */
export const IR_NATIVE_DV_NEW_FN = "__ir_dv_new";
/** `(externref view) -> f64`. */
export const IR_NATIVE_DV_BYTE_LENGTH_FN = "__ir_dv_byte_length";
/** `(externref view) -> f64`. */
export const IR_NATIVE_DV_BYTE_OFFSET_FN = "__ir_dv_byte_offset";

/** Every adapter: the backend mints exactly these, keyed by this type. */
export const IR_NATIVE_BUFFER_FNS = [
  IR_NATIVE_AB_NEW_FN,
  IR_NATIVE_AB_NEW_RESIZABLE_FN,
  IR_NATIVE_AB_BYTE_LENGTH_FN,
  IR_NATIVE_AB_MAX_BYTE_LENGTH_FN,
  IR_NATIVE_AB_RESIZABLE_FN,
  IR_NATIVE_AB_SLICE_FN,
  IR_NATIVE_DV_NEW_FN,
  IR_NATIVE_DV_BYTE_LENGTH_FN,
  IR_NATIVE_DV_BYTE_OFFSET_FN,
] as const;

export type IrNativeBufferFn = (typeof IR_NATIVE_BUFFER_FNS)[number];

const ADAPTER_NAMES: ReadonlySet<string> = new Set(IR_NATIVE_BUFFER_FNS);

export function isIrNativeBufferFn(symbol: string): symbol is IrNativeBufferFn {
  return ADAPTER_NAMES.has(symbol);
}

/**
 * The DataView element accessors the IR admits: legacy's own `__dv_m_<name>`
 * helpers, `(recv, byteOffset, littleEndian) -> externref` for a get and
 * `(recv, byteOffset, value, littleEndian) -> externref` for a set. The BigInt
 * ones are not admitted (the IR claims no BigInt operand).
 */
export const IR_NATIVE_DV_ACCESSORS = [
  "getInt8",
  "getUint8",
  "getInt16",
  "getUint16",
  "getInt32",
  "getUint32",
  "getFloat16",
  "getFloat32",
  "getFloat64",
  "setInt8",
  "setUint8",
  "setInt16",
  "setUint16",
  "setInt32",
  "setUint32",
  "setFloat16",
  "setFloat32",
  "setFloat64",
] as const;

export type IrNativeDvAccessor = (typeof IR_NATIVE_DV_ACCESSORS)[number];

const DV_ACCESSOR_NAMES: ReadonlySet<string> = new Set(IR_NATIVE_DV_ACCESSORS);
const DV_ACCESSOR_PREFIX = "__dv_m_";

export function isIrNativeDvAccessor(name: string): name is IrNativeDvAccessor {
  return DV_ACCESSOR_NAMES.has(name);
}

/** The runtime symbol of a DataView accessor helper. */
export function irNativeDvAccessorFn(accessor: IrNativeDvAccessor): string {
  return `${DV_ACCESSOR_PREFIX}${accessor}`;
}

/** The accessor a runtime symbol names, if it is one of the admitted helpers. */
export function irNativeDvAccessorOf(symbol: string): IrNativeDvAccessor | undefined {
  const name = symbol.startsWith(DV_ACCESSOR_PREFIX) ? symbol.slice(DV_ACCESSOR_PREFIX.length) : "";
  return isIrNativeDvAccessor(name) ? name : undefined;
}

/** A runtime symbol the native-buffer surface lowers to: an adapter or an admitted accessor helper. */
export function isIrNativeBufferRuntimeSymbol(symbol: string): boolean {
  return isIrNativeBufferFn(symbol) || irNativeDvAccessorOf(symbol) !== undefined;
}
