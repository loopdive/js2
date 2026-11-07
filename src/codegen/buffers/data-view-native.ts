// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) The native `DataView` sequences — `new DataView(buffer, byteOffset,
 * byteLength)` (ECMA-262 §25.3.2.1) and the `byteOffset` / `byteLength`
 * getters (§25.3.4.2/3) — shared by legacy codegen (`new-indexed.ts`,
 * `property-access-dispatch.ts`, inline at the source site) and the IR's
 * `__ir_dv_*` adapters (`ir-native-buffer.ts`).
 *
 * Every emitter works on locals the caller owns (or a value the caller left
 * on the stack), so one instruction sequence serves both. The step order is
 * the spec's: brand, ToIndex(byteOffset), detached, offset bounds,
 * ToIndex(byteLength) and its bounds, then the `$__dv_window` wrap.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { explicitUndefinedExternTestInstrs, getOrRegisterDvWindowType } from "../dataview-native.js";
import { buildThrowJsErrorInstrs } from "../expressions/helpers.js";
import { coerceType } from "../type-coercion.js";

const MAX_SAFE_INTEGER = 9007199254740991; // 2^53 - 1, the ToIndex bound

function pushThrowIf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: "TypeError" | "RangeError",
  message: string,
): void {
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, kind, message, { flush: fctx }),
    else: [],
  });
}

/** The buffer local's byte length as f64; an externref local is recovered as the i32_byte vec first. */
export function dataViewBufferByteLengthInstrs(bufLocal: number, isStructBuf: boolean, vecTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: bufLocal },
    ...(isStructBuf ? [] : ([{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: vecTypeIdx }] satisfies Instr[])),
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "f64.convert_i32_s" },
  ];
}

/**
 * §25.3.2.1 step 2, runtime half, for an externref buffer: no
 * [[ArrayBufferData]] → TypeError, before ToIndex(byteOffset) runs.
 */
export function emitDataViewBufferBrandCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufLocal: number,
  vecTypeIdx: number,
): void {
  fctx.body.push({ op: "local.get", index: bufLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "i32.eqz" });
  pushThrowIf(ctx, fctx, "TypeError", "First argument to DataView constructor must be an ArrayBuffer");
}

/**
 * Normalize the f64 in `local` per ToIndex (§7.1.22): NaN → 0, truncate
 * toward zero; leaves `local < 0 || local > 2^53-1` on the stack.
 */
function emitToIndexInPlace(fctx: FunctionContext, local: number): void {
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: local },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: local });
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "f64.const", value: MAX_SAFE_INTEGER });
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
}

/** f64 byteOffset on the stack → `offsetF64`, ToIndex'd; out of range → RangeError (step 4). */
export function emitDataViewOffsetToIndex(ctx: CodegenContext, fctx: FunctionContext, offsetF64: number): void {
  fctx.body.push({ op: "local.set", index: offsetF64 });
  emitToIndexInPlace(fctx, offsetF64);
  pushThrowIf(ctx, fctx, "RangeError", "RangeError: Start offset is outside the bounds of the buffer");
}

/** Step 7: a detached buffer (negative byte length marker) → TypeError. */
export function emitDataViewDetachedCheck(ctx: CodegenContext, fctx: FunctionContext, bufferByteLength: Instr[]): void {
  fctx.body.push(...bufferByteLength);
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  pushThrowIf(ctx, fctx, "TypeError", "Cannot construct a DataView on a detached ArrayBuffer");
}

/** Step 9: byteOffset > bufferByteLength → RangeError. */
export function emitDataViewOffsetBoundsCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  offsetF64: number,
  bufferByteLength: Instr[],
): void {
  fctx.body.push({ op: "local.get", index: offsetF64 });
  fctx.body.push(...bufferByteLength);
  fctx.body.push({ op: "f64.gt" });
  pushThrowIf(ctx, fctx, "RangeError", "RangeError: Start offset is outside the bounds of the buffer");
}

/**
 * An externref byteLength on the stack → its f64 ToNumber on the stack, with
 * `lenWasUndefined` set when it was the `undefined` singleton (step 11: an
 * explicit `undefined` means "to the end of the buffer"). `lenExtern` is the
 * caller's scratch local, allocated before the operand was evaluated.
 */
export function emitDataViewLengthFromExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  lenExtern: number,
  lenWasUndefined: number,
): void {
  fctx.body.push({ op: "local.tee", index: lenExtern });
  fctx.body.push(...explicitUndefinedExternTestInstrs(ctx, lenExtern));
  fctx.body.push({ op: "local.set", index: lenWasUndefined });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
}

/**
 * f64 byteLength on the stack → `lenF64`, ToIndex'd; out of range or past the
 * buffer's end → RangeError (step 11.b); then the explicit-`undefined`
 * default, applied after the bounds check (which its 0 placeholder passes).
 */
export function emitDataViewLengthToIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  locals: { readonly lenF64: number; readonly offsetF64: number; readonly lenWasUndefined: number },
  bufferByteLength: Instr[],
): void {
  const { lenF64, offsetF64, lenWasUndefined } = locals;
  fctx.body.push({ op: "local.set", index: lenF64 });
  emitToIndexInPlace(fctx, lenF64);
  fctx.body.push({ op: "local.get", index: offsetF64 });
  fctx.body.push({ op: "local.get", index: lenF64 });
  fctx.body.push({ op: "f64.add" });
  fctx.body.push(...bufferByteLength);
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  pushThrowIf(ctx, fctx, "RangeError", "RangeError: Invalid DataView length");
  fctx.body.push({ op: "local.get", index: lenWasUndefined });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...bufferByteLength,
      { op: "local.get", index: offsetF64 },
      { op: "f64.sub" },
      { op: "local.set", index: lenF64 },
    ],
    else: [],
  });
}

/** No byteLength argument: the view runs to the buffer's end. */
export function emitDataViewDefaultLength(
  fctx: FunctionContext,
  lenF64: number,
  offsetF64: number,
  bufferByteLength: Instr[],
): void {
  fctx.body.push(...bufferByteLength);
  fctx.body.push({ op: "local.get", index: offsetF64 });
  fctx.body.push({ op: "f64.sub" });
  fctx.body.push({ op: "local.set", index: lenF64 });
}

/**
 * The view: a `$__dv_window {buf, byteOffset, byteLength, proto}` as
 * externref when the buffer is (a subtype of) the i32_byte vec — the
 * window IS the standalone [[DataView]] brand — else the buffer itself.
 */
export function emitDataViewWindow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  view: {
    readonly bufLocal: number;
    readonly isStructBuf: boolean;
    readonly offsetF64: number;
    readonly lenF64: number;
  },
  vecTypeIdx: number,
): void {
  const { bufLocal, isStructBuf, offsetF64, lenF64 } = view;
  const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
  const wrapWindow: Instr[] = [
    { op: "local.get", index: bufLocal },
    ...(!isStructBuf ? ([{ op: "any.convert_extern" }] satisfies Instr[]) : []),
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "local.get", index: offsetF64 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.get", index: lenF64 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "ref.null.extern" }, // #3371 constructProto (intrinsic default)
    { op: "struct.new", typeIdx: dvWinTypeIdx },
    { op: "extern.convert_any" },
  ];
  const passThrough: Instr[] = [
    { op: "local.get", index: bufLocal },
    ...(isStructBuf ? ([{ op: "extern.convert_any" }] satisfies Instr[]) : []),
  ];
  fctx.body.push({ op: "local.get", index: bufLocal });
  if (!isStructBuf) fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: wrapWindow,
    else: passThrough,
  });
}

/**
 * `byteOffset` / `byteLength` of the view in `anyLocal`, as an i32: a
 * `$__dv_window`'s field (TypeError once its buffer is detached), or 0 / the
 * vec length for a bare buffer vec. `detachedThrow` is built by the caller
 * before the receiver was compiled (funcIdx-capture ordering).
 */
export function dataViewByteAttrInstrs(
  anyLocal: number,
  attr: "byteOffset" | "byteLength",
  detachedThrow: Instr[],
  vecTypeIdx: number,
  dvWinTypeIdx: number,
): Instr[] {
  const winBranch: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: dvWinTypeIdx },
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 }, // buf
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }, // buf.length
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] },
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: dvWinTypeIdx },
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: attr === "byteOffset" ? 1 : 2 },
  ];
  const vecBranch: Instr[] =
    attr === "byteOffset"
      ? [{ op: "i32.const", value: 0 }]
      : [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: vecTypeIdx },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        ];
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: dvWinTypeIdx },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: winBranch, else: vecBranch },
  ];
}
