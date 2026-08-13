// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native (standalone / WASI) DataView and ArrayBuffer-backed TypedArray
 * support (#1654).
 *
 * In JS-host mode, DataView.prototype.{get,set}{Uint,Int,Float}* are
 * implemented by the JS runtime, which materializes a real `DataView` over the
 * WasmGC byte array (`__dv_byte_{get,set}` exports, see codegen/index.ts).
 *
 * In no-JS-host mode (`--target wasi` / `--target standalone`) there is no JS
 * runtime, so those accessors had no implementation and the compiler silently
 * dropped the call (writing nothing, reading garbage) — and the
 * ArrayBuffer-length RangeError path referenced a `global.get -1` sentinel,
 * producing an *invalid* module (`unknown global`).
 *
 * This module emits Wasm-native byte read/write directly into the `i32_byte`
 * vec struct that backs ArrayBuffer / DataView (field 0 = length i32, field 1 =
 * a PACKED `array(mut i8)`, one byte per element, values 0..255). Multi-byte
 * accessors honour the `littleEndian` flag at runtime.
 *
 * Backing-store representation:
 *   ArrayBuffer / DataView  → vec "i32_byte"  (packed i8, one byte per element)
 *   Uint8Array (native)     → vec "i8_byte"   (packed bytes, unsigned reads)
 *
 * (#2835) The `i32_byte` byte buffer is now backed by `array(mut i8)` (was
 * `array(mut i32)`) — a 4× GC-footprint cut for ArrayBuffer / DataView. The KEY
 * string is kept (`$__vec_i32_byte`, a type DISTINCT from Uint8Array's
 * `i8_byte`, so `ref.cast`-based DataView/ArrayBuffer dispatch stays
 * unambiguous), only the element type changed. Byte READS therefore MUST use
 * `array.get_u` (plain `array.get` is invalid Wasm on a packed array); the
 * assembled value is zero-extended, so the DataView accessor's own
 * sign-extension (`getInt8`/`getInt16`/…) is unaffected. WRITES use `array.set`,
 * which truncates the i32 to the low byte (the `& 0xff` masks become redundant
 * but are kept defensively).
 *
 * The receiver (`this`) of a DataView accessor is an externref holding the
 * i32_byte vec; we `any.convert_extern` + `ref.cast` to recover the struct.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs, emitThrowTypeError, noJsHost } from "./js-errors.js";
import { ts } from "../ts-api.js"; // (#3177 slice 2) literal-`undefined` length detection
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./index.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import {
  addFuncType,
  getOrRegisterResizableAbType,
  getOrRegisterTaCtorType,
  getOrRegisterTaDynViewType,
  getOrRegisterTaViewType,
  getTaViewName,
  TA_CTOR_BYTES,
  TA_CTOR_KINDS,
  taCtorKindOf,
} from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#2872) __ta_dyn_fill minting
import { undefinedExternInstrs } from "./any-helpers.js"; // (#3177) OOB read = undefined, not null
import { ensureObjectRuntime } from "./object-runtime.js"; // (#2872) $Object array-like construct arm
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** DataView accessor descriptor parsed from a method name like "getUint32". */
interface DvAccessor {
  kind: "get" | "set";
  /** Number of bytes the element occupies (1, 2, 4, 8). */
  bytes: number;
  /** Signed integer read (Int8/Int16/Int32) — sign-extend on read. */
  signed: boolean;
  /** Float element (Float32/Float64/Float16) — reinterpret bits. */
  float: boolean;
  /** (#3173) Float16 element (ES2025) — 2-byte half-precision codec. */
  f16?: boolean;
  /**
   * (#3173) 8-byte INTEGER element (getBigInt64/getBigUint64/setBigInt64/
   * setBigUint64). BigInt values carry the compiler's numeric (f64)
   * representation (#1349), so the codec converts through i64 — exact for
   * |v| < 2^53, which covers the conformance corpus's small-literal rows.
   */
  int64?: boolean;
}

const DV_ACCESSORS: Record<string, DvAccessor> = {
  getInt8: { kind: "get", bytes: 1, signed: true, float: false },
  getUint8: { kind: "get", bytes: 1, signed: false, float: false },
  getInt16: { kind: "get", bytes: 2, signed: true, float: false },
  getUint16: { kind: "get", bytes: 2, signed: false, float: false },
  getInt32: { kind: "get", bytes: 4, signed: true, float: false },
  getUint32: { kind: "get", bytes: 4, signed: false, float: false },
  getFloat16: { kind: "get", bytes: 2, signed: false, float: true, f16: true },
  getFloat32: { kind: "get", bytes: 4, signed: false, float: true },
  getFloat64: { kind: "get", bytes: 8, signed: false, float: true },
  getBigInt64: { kind: "get", bytes: 8, signed: true, float: false, int64: true },
  getBigUint64: { kind: "get", bytes: 8, signed: false, float: false, int64: true },
  setInt8: { kind: "set", bytes: 1, signed: true, float: false },
  setUint8: { kind: "set", bytes: 1, signed: false, float: false },
  setInt16: { kind: "set", bytes: 2, signed: true, float: false },
  setUint16: { kind: "set", bytes: 2, signed: false, float: false },
  setInt32: { kind: "set", bytes: 4, signed: true, float: false },
  setUint32: { kind: "set", bytes: 4, signed: false, float: false },
  setFloat16: { kind: "set", bytes: 2, signed: false, float: true, f16: true },
  setFloat32: { kind: "set", bytes: 4, signed: false, float: true },
  setFloat64: { kind: "set", bytes: 8, signed: false, float: true },
  setBigInt64: { kind: "set", bytes: 8, signed: true, float: false, int64: true },
  setBigUint64: { kind: "set", bytes: 8, signed: false, float: false, int64: true },
};

export function isDataViewAccessor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DV_ACCESSORS, name);
}

/** Select the Wasm-owned DataView carrier independently of the embedder. */
export function usesNativeDataViewProvider(ctx: CodegenContext): boolean {
  return noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first";
}

/**
 * #1698 — `ab.slice(begin?, end?)` in no-JS-host mode. Returns a new
 * ArrayBuffer (i32_byte vec struct) holding bytes `[begin, end)` of the
 * source, with the spec §25.1.5.3 negative-offset / clamp / default-end
 * normalisation applied at runtime. Receiver and result are externref
 * (the user's `const sliced = ab.slice(...)` local is typed externref;
 * matching that here keeps `new Uint8Array(sliced)` working without
 * additional coercion).
 */
export function emitArrayBufferSlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;
  const detachedThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: ArrayBuffer.prototype.slice called on a detached buffer",
  );

  // Recover the source vec struct from the receiver (externref → struct).
  const srcVecLocal = allocLocal(fctx, `__abs_src_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: vecTypeIdx,
  });
  const recvType = compileExpr(receiver);
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    if ("typeIdx" in recvType && recvType.typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
    }
  } else {
    return null;
  }
  fctx.body.push({ op: "local.set", index: srcVecLocal });

  // srcLen = src.length (field 0); srcArr = src.data (field 1).
  const srcLenLocal = allocLocal(fctx, `__abs_srclen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: srcLenLocal });
  // §25.1.5.3 step 4 — validate detachment before coercing begin/end. The
  // native detached state is the shared buffer vec's negative length marker.
  emitArrayBufferDetachedCheck(fctx, srcVecLocal, vecTypeIdx, detachedThrow);
  const srcArrLocal = allocLocal(fctx, `__abs_srcarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: srcArrLocal });

  // begin (default 0). Spec §25.1.5.3 steps 5-7: ToIntegerOrInfinity, then
  // negative = max(srcLen + begin, 0), positive = min(begin, srcLen).
  const beginLocal = allocLocal(fctx, `__abs_begin_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: beginLocal });
  emitNormalizeIndex(fctx, beginLocal, srcLenLocal);

  // end (default srcLen). Same clamp/negate.
  const endLocal = allocLocal(fctx, `__abs_end_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: endLocal });
    emitNormalizeIndex(fctx, endLocal, srcLenLocal);
  } else {
    fctx.body.push({ op: "local.get", index: srcLenLocal });
    fctx.body.push({ op: "local.set", index: endLocal });
  }

  // sliceLen = max(end - begin, 0)
  const sliceLenLocal = allocLocal(fctx, `__abs_slen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: endLocal });
  fctx.body.push({ op: "local.get", index: beginLocal });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: sliceLenLocal });
  fctx.body.push({ op: "local.get", index: sliceLenLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: sliceLenLocal },
    ],
    else: [],
  });

  // dstArr = new i32[sliceLen]
  const dstArrLocal = allocLocal(fctx, `__abs_dstarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: sliceLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dstArrLocal });

  // for (i = 0; i < sliceLen; i++) dstArr[i] = srcArr[begin + i]
  const iLocal = allocLocal(fctx, `__abs_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: sliceLenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dstArrLocal },
    { op: "local.get", index: iLocal },
    { op: "local.get", index: srcArrLocal },
    { op: "local.get", index: beginLocal },
    { op: "local.get", index: iLocal },
    { op: "i32.add" },
    // (#2835) packed i8 src/dst; read unsigned, `array.set` truncates to low byte.
    { op: "array.get_u", typeIdx: arrTypeIdx },
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: iLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // struct.new vec(sliceLen, dstArr); return as externref (matches the
  // externref local that user code declares for the slice() result).
  fctx.body.push({ op: "local.get", index: sliceLenLocal });
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

/**
 * (#3054 C) `rab.resize(newByteLength)` in no-JS-host mode, per §25.1.6.
 * `resize` exists only on a resizable buffer (a `$__resizable_ab` instance):
 *   1. If the receiver is NOT a `$__resizable_ab` (a fixed buffer / anything
 *      else) → TypeError (§25.1.6.1 step 3, IsFixedLengthArrayBuffer).
 *   2. newByteLength = ToIndex(arg); if `newByteLength > maxByteLength` (or < 0)
 *      → RangeError (step 6).
 *   3. Reallocate: `array.new_default $__arr_i32_byte` of size `newByteLength`,
 *      `array.copy` `min(oldLen, newLen)` bytes from the old data, then
 *      `struct.set field1` (swap `data` in place on the SAME struct) and
 *      `struct.set field0` (new byteLength). Views hold the vec-struct ref, so
 *      they observe the swap → length-tracking-on-resize is free (Phase A A.1).
 * Returns undefined (`resize` is a void method) — the caller drops nothing.
 */
export function emitArrayBufferResize(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const rabTypeIdx = getOrRegisterResizableAbType(ctx);
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;
  // Build real JS error objects before compiling operands so any helper
  // registration happens before later function indices are captured.
  const brandThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: ArrayBuffer.prototype.resize called on non-resizable buffer",
  );
  const detachedThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: ArrayBuffer.prototype.resize called on a detached buffer",
  );
  const rangeThrow = buildThrowJsErrorInstrs(
    ctx,
    "RangeError",
    "RangeError: ArrayBuffer.prototype.resize length exceeds maxByteLength",
  );

  // Recover the receiver as anyref, then require it to be a $__resizable_ab.
  const recvType = compileExpr(receiver);
  if (recvType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    return null;
  }
  const anyLocal = allocLocal(fctx, `__rabz_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // TypeError on a non-resizable receiver (IsFixedLengthArrayBuffer).
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: brandThrow, else: [] });

  // rab = ref.cast $__resizable_ab (the checked receiver).
  const rabLocal = allocLocal(fctx, `__rabz_rab_${fctx.locals.length}`, { kind: "ref", typeIdx: rabTypeIdx });
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.cast", typeIdx: rabTypeIdx });
  fctx.body.push({ op: "local.set", index: rabLocal });

  // newLen = ToIndex(arg): NaN→0, truncate toward zero.
  const newLenF64 = allocLocal(fctx, `__rabz_nl_f64_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: newLenF64 });
  // NaN → 0
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: newLenF64 },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: newLenF64 });
  const newLen = allocLocal(fctx, `__rabz_nl_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: newLen });

  // ToIndex range validation happens before the detached check.
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: newLenF64 });
  fctx.body.push({ op: "f64.const", value: 9007199254740991 });
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });

  // §25.1.6.4 step 5 — the shared negative-length marker is checked after
  // ToIndex, before the declared maxByteLength bound.
  emitArrayBufferDetachedCheck(fctx, rabLocal, vecTypeIdx, detachedThrow);

  // RangeError if newLen > maxByteLength (field 2).
  fctx.body.push({ op: "local.get", index: newLen });
  fctx.body.push({ op: "local.get", index: rabLocal });
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });

  // oldLen = min(rab.length, newLen) — bytes to preserve.
  const oldLen = allocLocal(fctx, `__rabz_ol_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: rabLocal });
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: oldLen });
  const copyLen = allocLocal(fctx, `__rabz_cl_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: oldLen });
  fctx.body.push({ op: "local.get", index: newLen });
  fctx.body.push({ op: "local.get", index: oldLen });
  fctx.body.push({ op: "local.get", index: newLen });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: copyLen });

  // newArr = new i8[newLen]; array.copy newArr[0..copyLen) ← rab.data[0..copyLen).
  const newArr = allocLocal(fctx, `__rabz_na_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: newLen });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newArr });
  // array.copy dst dstIdx src srcIdx len
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: rabLocal });
  fctx.body.push({ op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: copyLen });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });

  // struct.set field1 = newArr; struct.set field0 = newLen (same struct → views observe).
  fctx.body.push({ op: "local.get", index: rabLocal });
  fctx.body.push({ op: "local.get", index: newArr });
  fctx.body.push({ op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: rabLocal });
  fctx.body.push({ op: "local.get", index: newLen });
  fctx.body.push({ op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 0 });

  return null;
}

/**
 * Shared native IsDetachedBuffer check for ArrayBuffer operations. Standalone
 * detachment is represented by field 0 (`length`) being negative; every
 * operation consumes this same state instead of maintaining method-specific
 * sidecars or AST-only flags.
 */
function emitArrayBufferDetachedCheck(
  fctx: FunctionContext,
  bufferLocal: number,
  vecTypeIdx: number,
  detachedThrow: Instr[],
): void {
  fctx.body.push({ op: "local.get", index: bufferLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] });
}

type ArrayBufferTransferMethod = "transfer" | "transferToFixedLength";

function arrayBufferTransferHelperName(method: ArrayBufferTransferMethod): string {
  return method === "transfer" ? "__ab_transfer" : "__ab_transfer_fixed";
}

/**
 * Native ArrayBufferCopyAndDetach core shared by direct instance calls and
 * reflective `ArrayBuffer.prototype.<method>.call(...)` closures.
 *
 * ABI: `(receiver: externref, newLengthOrUndefined: externref) -> externref`.
 * The canonical standalone undefined singleton distinguishes an omitted or
 * explicit `undefined` length from an explicit JS `null` (which ToIndex maps
 * to zero).
 * The helper performs the observable ToIndex conversion before checking the
 * shared detached marker, allocates/copies a new native byte vec, preserves
 * resizability only for `transfer`, and finally detaches the source by setting
 * its length to -1. All semantics live here; AST and reflective call surfaces
 * are thin adapters to the same native runtime operation.
 */
export function ensureArrayBufferTransferHelper(
  ctx: CodegenContext,
  method: ArrayBufferTransferMethod,
): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const helperName = arrayBufferTransferHelperName(method);
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // ArrayBufferCopyAndDetach distinguishes undefined from null. Reserve the
  // canonical standalone undefined predicate before constructing the helper;
  // both direct and reflective adapters pass the same singleton for omission.
  ensureObjectRuntime(ctx);
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");

  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return undefined;
  const rabTypeIdx = getOrRegisterResizableAbType(ctx);

  const params: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
  const fctx: FunctionContext = {
    name: helperName,
    params: [
      { name: "receiver", type: params[0]! },
      { name: "newLength", type: params[1]! },
    ],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Error constructors are resolved before operand coercion freezes any
  // function indices. These templates throw real catchable Error instances.
  const brandThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    `TypeError: ArrayBuffer.prototype.${method} called on an incompatible receiver`,
  );
  const detachedThrow = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    `TypeError: ArrayBuffer.prototype.${method} called on a detached buffer`,
  );
  const rangeThrow = buildThrowJsErrorInstrs(ctx, "RangeError", "RangeError: Invalid array buffer length");

  const anyLocal = allocLocal(fctx, "receiverAny", { kind: "anyref" });
  const srcLocal = allocLocal(fctx, "source", { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.get", index: 0 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.tee", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "local.set", index: srcLocal },
    ],
    else: brandThrow,
  });

  const oldLenLocal = allocLocal(fctx, "oldLength", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: oldLenLocal });

  // Missing/undefined newLength defaults to the current byte length. An
  // explicit value takes the ordinary ToPrimitive(number) / ToNumber route.
  const hasLengthLocal = allocLocal(fctx, "hasLength", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: 1 });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
  } else {
    // Flag-disabled compatibility: standalone historically conflated null and
    // undefined. Default builds always use the distinct singleton above.
    fctx.body.push({ op: "ref.is_null" });
  }
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "local.set", index: hasLengthLocal });

  const newLenF64Local = allocLocal(fctx, "newLengthF64", { kind: "f64" });
  fctx.body.push({ op: "local.get", index: hasLengthLocal });
  const explicitLength: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = explicitLength;
  fctx.body.push({ op: "local.get", index: 1 });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body = savedBody;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: explicitLength,
    else: [
      // A detached source uses -1 internally, but the spec's detached
      // [[ArrayBufferByteLength]] default is observed as zero before the
      // subsequent IsDetachedBuffer TypeError.
      { op: "local.get", index: oldLenLocal },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: oldLenLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      { op: "select" },
      { op: "f64.convert_i32_s" },
    ],
  });
  fctx.body.push({ op: "local.set", index: newLenF64Local });

  // ToIndex: NaN -> +0, truncate toward zero, then reject negative or values
  // above Number.MAX_SAFE_INTEGER before reading the detached state.
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "f64.eq" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: newLenF64Local });
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "f64.const", value: 9007199254740991 });
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });

  const newLenLocal = allocLocal(fctx, "newLengthI32", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: newLenF64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: newLenLocal });

  // ArrayBufferCopyAndDetach checks detachment after argument conversion.
  emitArrayBufferDetachedCheck(fctx, srcLocal, vecTypeIdx, detachedThrow);

  const preserveResizableLocal = allocLocal(fctx, "preserveResizable", { kind: "i32" });
  if (method === "transfer") {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: preserveResizableLocal });

  const maxLenLocal = allocLocal(fctx, "maxLength", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: preserveResizableLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: srcLocal },
      { op: "ref.cast", typeIdx: rabTypeIdx },
      { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
      { op: "local.tee", index: maxLenLocal },
      { op: "local.get", index: newLenLocal },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] },
    ],
    else: [],
  });

  const srcArrLocal = allocLocal(fctx, "sourceData", { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: srcArrLocal });

  const dstArrLocal = allocLocal(fctx, "destinationData", { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: newLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dstArrLocal });

  const copyLenLocal = allocLocal(fctx, "copyLength", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: oldLenLocal });
  fctx.body.push({ op: "local.get", index: newLenLocal });
  fctx.body.push({ op: "local.get", index: oldLenLocal });
  fctx.body.push({ op: "local.get", index: newLenLocal });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: copyLenLocal });
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: srcArrLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: copyLenLocal });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });

  // Detach the source only after allocation and copying succeed.
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // `transfer` preserves a resizable source's maxByteLength;
  // `transferToFixedLength` and fixed sources return the parent vec type.
  fctx.body.push({ op: "local.get", index: preserveResizableLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: newLenLocal },
      { op: "local.get", index: dstArrLocal },
      { op: "local.get", index: maxLenLocal },
      { op: "struct.new", typeIdx: rabTypeIdx },
      { op: "extern.convert_any" },
    ],
    else: [
      { op: "local.get", index: newLenLocal },
      { op: "local.get", index: dstArrLocal },
      { op: "struct.new", typeIdx: vecTypeIdx },
      { op: "extern.convert_any" },
    ],
  });

  flushLateImportShifts(ctx, fctx);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/** Thin direct-call adapter to the shared native transfer helper. */
export function emitArrayBufferTransfer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: ArrayBufferTransferMethod,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  if (!noJsHost(ctx) || ensureArrayBufferTransferHelper(ctx, method) === undefined) return null;

  const receiverType = compileExpr(receiver);
  if (!receiverType) return null;
  coerceType(ctx, fctx, receiverType, { kind: "externref" });
  const receiverLocal = allocLocal(fctx, `__abt_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: receiverLocal });

  const lengthLocal = allocLocal(fctx, `__abt_len_${fctx.locals.length}`, { kind: "externref" });
  const omittedLength = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr];
  if (args.length > 0) {
    const argType = compileExpr(args[0]!);
    if (argType) {
      coerceType(ctx, fctx, argType, { kind: "externref" });
    } else {
      fctx.body.push(...omittedLength);
    }
  } else {
    fctx.body.push(...omittedLength);
  }
  fctx.body.push({ op: "local.set", index: lengthLocal });

  // Extra arguments are ignored by the operation but still evaluated.
  for (let i = 1; i < args.length; i++) {
    const extraType = compileExpr(args[i]!);
    if (extraType) fctx.body.push({ op: "drop" });
  }

  flushLateImportShifts(ctx, fctx);
  const helperIdx = ctx.funcMap.get(arrayBufferTransferHelperName(method));
  if (helperIdx === undefined) return null;
  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "local.get", index: lengthLocal });
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return { kind: "externref" };
}

/** Reflective member-closure adapter to the same native transfer helper. */
export function emitArrayBufferProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (member !== "transfer" && member !== "transferToFixedLength") return null;
  const helperIdx = ensureArrayBufferTransferHelper(ctx, member);
  if (helperIdx === undefined) return null;
  // Closure ABI: param 0 = wrapper, param 1 = this, param 2 = optional length.
  fctx.body.push({ op: "local.get", index: 1 });
  if (fctx.params.length > 2) {
    fctx.body.push({ op: "local.get", index: 2 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return { kind: "externref" };
}

/**
 * Normalize an index in-place per spec §25.1.5.3:
 *   if (idx < 0) idx = max(srcLen + idx, 0);
 *   else         idx = min(idx, srcLen);
 */
function emitNormalizeIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  const negBranch: Instr[] = [
    // idx = srcLen + idx; if (idx < 0) idx = 0
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "local.set", index: idxLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: idxLocal },
      ],
      else: [],
    },
  ];
  const posBranch: Instr[] = [
    // if (idx > srcLen) idx = srcLen
    { op: "local.get", index: idxLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenLocal },
        { op: "local.set", index: idxLocal },
      ],
      else: [],
    },
  ];
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: negBranch,
    else: posBranch,
  });
}

/** Lazily ensure the i32_byte vec type exists and return its struct/array indices. */
export function i32ByteVec(ctx: CodegenContext): { vecTypeIdx: number; arrTypeIdx: number } {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  return { vecTypeIdx, arrTypeIdx };
}

/**
 * (#2159 / #38) Lazily register the standalone `$__dv_window` wrapper struct:
 * `{buf: (ref null __vec_i32_byte), byteOffset: i32, byteLength: i32}`.
 *
 * `new DataView(buffer, byteOffset, byteLength)` produces one of these when the
 * view is *windowed* (byteOffset > 0 or an explicit byteLength); it shares the
 * parent buffer's backing array so windowed writes are visible through the full
 * view, and carries the window's byteOffset/byteLength so `dv.byteOffset` /
 * `dv.byteLength` reflect the ctor args. Offset-0 default-length views keep the
 * bare i32_byte vec representation (no wrapper) — the dominant, fully-native
 * case — so the accessor must accept BOTH a wrapper and a bare vec receiver.
 */
export function getOrRegisterDvWindowType(ctx: CodegenContext): number {
  if (ctx.dvWindowTypeIdx >= 0) return ctx.dvWindowTypeIdx;
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }); // (#2835) packed byte buffer
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__dv_window",
    fields: [
      { name: "buf", type: { kind: "ref_null", typeIdx: vecTypeIdx }, mutable: false },
      { name: "byteOffset", type: { kind: "i32" }, mutable: false },
      { name: "byteLength", type: { kind: "i32" }, mutable: false },
      // #3371: null selects DataView.prototype; a non-null $Object is the
      // distinct NewTarget.prototype selected by Reflect.construct.
      { name: "constructProto", type: { kind: "externref" }, mutable: true },
    ],
  });
  ctx.dvWindowTypeIdx = idx;
  ctx.structMap.set("__dv_window", idx);
  ctx.typeIdxToStructName.set(idx, "__dv_window");
  ctx.structFields.set("__dv_window", [
    { name: "buf", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
    { name: "byteLength", type: { kind: "i32" as const }, mutable: false },
    { name: "constructProto", type: { kind: "externref" as const }, mutable: true },
  ]);
  return idx;
}

/**
 * (#2159 / #38) Recover a DataView receiver into `(backing i32_byte array,
 * base byte offset)`, stashed in the two given locals. Accepts either:
 *   - a `$__dv_window` wrapper (windowed view) → array = buf.data, base = buf's
 *     byteOffset;
 *   - a bare `$__vec_i32_byte` (offset-0 view / ArrayBuffer) → array = data,
 *     base = 0.
 * The receiver value (externref or struct ref) must already be on the stack.
 * Emits a runtime `ref.test $__dv_window` branch so both shapes work.
 */
function recoverDvBacking(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType | null,
  arrLocal: number,
  baseLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  // (#2199) Optional: i32 local that receives the view's byte length (window's
  // `byteLength` field for a windowed view; the backing array's `array.len` for
  // a bare offset-0 view). Used by the §24.2.1.1 bounds check. Pass -1 to skip.
  viewLenLocal = -1,
  // (#3173) Optional spec-semantics extensions:
  //   `brandThrow`  — instructions to run for a NON-`$__dv_window` receiver
  //                   (the §24.3.1.1/2 [[DataView]] brand-check TypeError).
  //                   Standalone DataViews are ALWAYS `$__dv_window`-wrapped
  //                   (new-super.ts), so a bare vec receiver is an ArrayBuffer
  //                   (or worse) and must throw, not alias an offset-0 view.
  //                   When absent, the legacy both-shapes recovery is kept.
  //   `bufVecLocal` — `(ref null $__vec_i32_byte)` local that receives the
  //                   view's backing BUFFER STRUCT (window `buf` field / the
  //                   bare vec itself) for the detached-buffer check.
  opts?: { brandThrow?: Instr[]; bufVecLocal?: number },
): boolean {
  const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
  // Normalize the receiver to an anyref-castable `(ref any)` on the stack.
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    // already a gc ref
  } else {
    return false;
  }
  // Stash the anyref in a temp so we can test then cast.
  const anyLocal = allocLocal(fctx, `__dvn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  const winBranch: Instr[] = [
    // buf = (cast $__dv_window).buf ; base = .byteOffset
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: dvWinTypeIdx },
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: arrLocal },
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: dvWinTypeIdx },
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: baseLocal },
  ];
  if (viewLenLocal >= 0) {
    // viewLen = (cast $__dv_window).byteLength
    winBranch.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: dvWinTypeIdx },
      { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: viewLenLocal },
    );
  }
  if (opts?.bufVecLocal !== undefined) {
    // bufVec = (cast $__dv_window).buf — for the detached-buffer check.
    winBranch.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: dvWinTypeIdx },
      { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: opts.bufVecLocal },
    );
  }
  // (#3173) Brand mode: a non-window receiver has no [[DataView]] internal
  // slot — throw the catchable TypeError instead of aliasing a bare vec.
  // A non-vec receiver would previously TRAP on the `ref.cast` below; the
  // brand throw covers that too (never a trap, §22.2.6.4.1-step-2 rule).
  const vecBranch: Instr[] = opts?.brandThrow
    ? [...opts.brandThrow]
    : [
        // bare vec: arr = .data ; base = 0
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: arrLocal },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: baseLocal },
      ];
  if (!opts?.brandThrow && viewLenLocal >= 0) {
    // viewLen = array.len(arr)  (offset-0 view spans the whole backing buffer)
    vecBranch.push({ op: "local.get", index: arrLocal }, { op: "array.len" }, { op: "local.set", index: viewLenLocal });
  }
  if (!opts?.brandThrow && opts?.bufVecLocal !== undefined) {
    vecBranch.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "local.set", index: opts.bufVecLocal },
    );
  }
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: winBranch, else: vecBranch });
  void arrTypeIdx;
  return true;
}

/**
 * Emit native code for `dv.{get,set}{Uint,Int,Float}N(byteOffset[, value][, littleEndian])`
 * operating directly on the i32_byte backing array.
 *
 * Preconditions on the Wasm stack: nothing (this function compiles all operands).
 * Postcondition: for getters, the numeric result (f64) is on the stack; for
 * setters, nothing is pushed (void).
 *
 * Returns the result ValType for getters, or null for setters (void).
 *
 * `compileExpr`/`offsetArg`/`valueArg`/`leArg` are passed in so this module
 * stays decoupled from the big calls.ts dispatcher.
 */
/** Message for the §24.2.1.1 GetViewValue / SetViewValue out-of-bounds throw. */
const DV_RANGE_MESSAGE = "RangeError: Offset is outside the bounds of the DataView";

/**
 * (#2199) Build the instruction sequence for a DataView accessor bounds throw —
 * a catchable `RangeError` instance via the shared `$exc` tag, mirroring
 * `native-regex.ts`'s `regexCapExhaustionThrow`. §24.2.1.1 GetViewValue step 4/6
 * (and SetViewValue): a negative / non-finite `byteOffset`, or
 * `getIndex + elementSize > viewByteLength`, throws RangeError BEFORE the array
 * access (which would otherwise trap `array element access out of bounds`).
 *
 * MUST be called BEFORE any later funcIdx is captured in the caller: in JS-host
 * mode `ensureLateImport("__new_RangeError")` registers a host import (shifting
 * every function index); in no-JS-host mode `emitWasiErrorConstructor` emits the
 * in-module constructor (also a function push). Same ordering requirement as the
 * regex cap-throw. The caller pre-builds this template before emitting the
 * accessor body and flushes shifts.
 */
function emitDataViewRangeError(ctx: CodegenContext): Instr[] {
  // (#3191) Unified onto the shared builder. No `flush` opt: the caller
  // pre-builds this template BEFORE emitting the body and flushes shifts itself
  // (funcIdx-capture ordering, see the doc above) — exactly the former behavior.
  return buildThrowJsErrorInstrs(ctx, "RangeError", DV_RANGE_MESSAGE);
}

/** §24.3.1.1/§24.3.1.2 step 2 — receiver has no [[DataView]] internal slot. */
const DV_BRAND_MESSAGE = "TypeError: Method DataView.prototype called on incompatible receiver";
/** §24.3.1.1 GetViewValue step 5 / SetViewValue step 6 — detached buffer. */
const DV_DETACHED_MESSAGE = "TypeError: Cannot perform operation on a detached ArrayBuffer";
/** §7.1.13 ToBigInt(undefined) — the setBig{Int,Uint}64 missing-value throw. */
const DV_TOBIGINT_UNDEFINED_MESSAGE = "TypeError: Cannot convert undefined to a BigInt";

/**
 * (#3173) Build a catchable-TypeError throw template (a real TypeError instance
 * via `__new_TypeError` + `throw $exc`) for the DataView brand / detached-buffer
 * checks. Same function-push ordering rule as {@link emitDataViewRangeError}:
 * MUST be built (and shifts flushed) BEFORE any later funcIdx is captured.
 */
function dvTypeErrorThrow(ctx: CodegenContext, message: string): Instr[] {
  // (#3191) Unified onto the shared builder — caller-flush ordering (see above).
  return buildThrowJsErrorInstrs(ctx, "TypeError", message);
}

/**
 * (#3173) Build the detached-buffer TypeError throw template for callers
 * OUTSIDE this module (property-access.ts `dv.byteLength`/`dv.byteOffset`
 * static arms). Same funcIdx-capture ordering rule as the other templates:
 * build (and flush) BEFORE compiling the receiver.
 */
export function dvDetachedThrowInstrs(ctx: CodegenContext): Instr[] {
  return dvTypeErrorThrow(ctx, DV_DETACHED_MESSAGE);
}

/**
 * (#3173) Emit the §25.1.3.3 IsDetachedBuffer check: the detach marker is the
 * buffer vec's `length` field forced to `-1` by `$DETACHBUFFER` /
 * `ArrayBuffer.prototype.transfer` (see {@link tryCompileStandaloneDetachedWrite}).
 * `bufVecLocal` holds a `(ref null $__vec_i32_byte)`; a null buf (defensive)
 * counts as detached. Appends `if (detached) <detachedThrow>`.
 */
function emitDvDetachedCheck(
  fctx: FunctionContext,
  bufVecLocal: number,
  vecTypeIdx: number,
  detachedThrow: Instr[],
): void {
  fctx.body.push({ op: "local.get", index: bufVecLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 1 }],
    else: [
      { op: "local.get", index: bufVecLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
    ],
  });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] });
}

/**
 * (#3173) Mint `__f16_decode(bits: i32) → f64` — IEEE-754 binary16 → binary64.
 * sign = bits>>15, exp = (bits>>10)&0x1f, frac = bits&0x3ff:
 *   exp 31 → NaN (frac≠0) / ±Infinity; exp 0 → ±frac·2⁻²⁴ (subnormal/zero);
 *   else   → reassemble the f64 bit pattern directly (biased exp + 1008,
 *            mantissa << 42) — exact, no rounding. Idempotent.
 */
function ensureF16DecodeHelper(ctx: CodegenContext): number | undefined {
  const helperName = "__f16_decode";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "f64" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  // param 0 = bits; locals: 1 = sign, 2 = exp, 3 = frac (all i32).
  const body: Instr[] = [
    // sign = (bits >> 15) & 1
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 15 },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
    { op: "local.set", index: 1 },
    // exp = (bits >> 10) & 0x1f
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 10 },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 0x1f },
    { op: "i32.and" },
    { op: "local.set", index: 2 },
    // frac = bits & 0x3ff
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 0x3ff },
    { op: "i32.and" },
    { op: "local.set", index: 3 },
    // exp == 31 → NaN / ±Inf
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 31 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "f64.const", value: NaN }],
          else: [
            // select(v1, v2, cond) picks v1 when cond ≠ 0 — sign set → −∞.
            { op: "f64.const", value: Number.NEGATIVE_INFINITY },
            { op: "f64.const", value: Number.POSITIVE_INFINITY },
            { op: "local.get", index: 1 },
            { op: "select" },
          ],
        },
        { op: "return" },
      ],
      else: [],
    },
    // exp == 0 → ±frac·2⁻²⁴ (covers ±0)
    { op: "local.get", index: 2 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "f64.convert_i32_u" },
        { op: "f64.const", value: 2 ** -24 },
        { op: "f64.mul" },
        { op: "local.set", index: 4 }, // scratch — if-arms can't consume outer stack
        // negate when sign set (f64.neg keeps −0 correct for frac == 0)
        { op: "local.get", index: 1 },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [{ op: "local.get", index: 4 }, { op: "f64.neg" }],
          else: [{ op: "local.get", index: 4 }],
        },
        { op: "return" },
      ],
      else: [],
    },
    // normal: f64 bits = sign<<63 | (exp+1008)<<52 | frac<<42
    { op: "local.get", index: 1 },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 63n },
    { op: "i64.shl" },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 1008 }, // −15 (f16 bias) + 1023 (f64 bias)
    { op: "i32.add" },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 52n },
    { op: "i64.shl" },
    { op: "i64.or" },
    { op: "local.get", index: 3 },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 42n },
    { op: "i64.shl" },
    { op: "i64.or" },
    { op: "f64.reinterpret_i64" },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [
      { name: "sign", type: { kind: "i32" } },
      { name: "exp", type: { kind: "i32" } },
      { name: "frac", type: { kind: "i32" } },
      { name: "scratch", type: { kind: "f64" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#3173) Mint `__f16_encode(v: f64) → i32` — IEEE-754 binary64 → binary16 bit
 * pattern with roundTiesToEven applied DIRECTLY to the f64 mantissa (single
 * rounding — no f64→f32→f16 double-rounding hazard). NaN → 0x7e00|sign,
 * overflow (≥ 2¹⁶ after rounding) → ±Infinity (0x7c00), |v| < 2⁻²⁵ ties to ±0,
 * subnormal range rounds against the shifted mantissa. Idempotent.
 */
function ensureF16EncodeHelper(ctx: CodegenContext): number | undefined {
  const helperName = "__f16_encode";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  // param 0 = v (f64). locals: 1 = b64 (i64), 2 = sign (i32), 3 = e (i32),
  // 4 = E (i32), 5 = m (i64), 6 = m16 (i64), 7 = sh (i32), 8 = rest (i64),
  // 9 = half (i64).
  const L = { b64: 1, sign: 2, e: 3, E: 4, m: 5, m16: 6, sh: 7, rest: 8, half: 9 };

  /** m16 += (rest > half) || (rest == half && (m16 & 1)) — RN-even increment. */
  const roundIncr: Instr[] = [
    { op: "local.get", index: L.m16 },
    // cond (i64 0/1)
    { op: "local.get", index: L.rest },
    { op: "local.get", index: L.half },
    { op: "i64.gt_u" },
    { op: "local.get", index: L.rest },
    { op: "local.get", index: L.half },
    { op: "i64.eq" },
    { op: "local.get", index: L.m16 },
    { op: "i32.wrap_i64" },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.set", index: L.m16 },
  ];

  const body: Instr[] = [
    // b64 = reinterpret(v); sign = wrap(b64 >> 48) & 0x8000
    { op: "local.get", index: 0 },
    { op: "i64.reinterpret_f64" },
    { op: "local.tee", index: L.b64 },
    { op: "i64.const", value: 48n },
    { op: "i64.shr_u" },
    { op: "i32.wrap_i64" },
    { op: "i32.const", value: 0x8000 },
    { op: "i32.and" },
    { op: "local.set", index: L.sign },
    // e = wrap(b64 >> 52) & 0x7ff
    { op: "local.get", index: L.b64 },
    { op: "i64.const", value: 52n },
    { op: "i64.shr_u" },
    { op: "i32.wrap_i64" },
    { op: "i32.const", value: 0x7ff },
    { op: "i32.and" },
    { op: "local.set", index: L.e },
    // m = b64 & (2^52 − 1)
    { op: "local.get", index: L.b64 },
    { op: "i64.const", value: 0xfffffffffffffn },
    { op: "i64.and" },
    { op: "local.set", index: L.m },
    // e == 0x7ff → NaN (qNaN payload bit) / ±Inf
    { op: "local.get", index: L.e },
    { op: "i32.const", value: 0x7ff },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.sign },
        { op: "i32.const", value: 0x7c00 },
        { op: "i32.or" },
        { op: "local.get", index: L.m },
        { op: "i64.eqz" },
        { op: "i32.eqz" }, // m != 0 → NaN
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: 0x200 }],
          else: [{ op: "i32.const", value: 0 }],
        },
        { op: "i32.or" },
        { op: "return" },
      ],
      else: [],
    },
    // E = e − 1008 (f16-biased exponent)
    { op: "local.get", index: L.e },
    { op: "i32.const", value: 1008 },
    { op: "i32.sub" },
    { op: "local.set", index: L.E },
    // E ≥ 31 → overflow → ±Inf
    { op: "local.get", index: L.E },
    { op: "i32.const", value: 31 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.sign },
        { op: "i32.const", value: 0x7c00 },
        { op: "i32.or" },
        { op: "return" },
      ],
      else: [],
    },
    // E ≥ 1 → normal: m16 = m >> 42 rounded RN-even against the low 42 bits.
    { op: "local.get", index: L.E },
    { op: "i32.const", value: 1 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.m },
        { op: "i64.const", value: 42n },
        { op: "i64.shr_u" },
        { op: "local.set", index: L.m16 },
        { op: "local.get", index: L.m },
        { op: "i64.const", value: 0x3ffffffffffn }, // 2^42 − 1
        { op: "i64.and" },
        { op: "local.set", index: L.rest },
        { op: "i64.const", value: 0x20000000000n }, // 2^41
        { op: "local.set", index: L.half },
        ...roundIncr,
        // mantissa carry: m16 == 0x400 → m16 = 0, E += 1 (E == 31 → Inf)
        { op: "local.get", index: L.m16 },
        { op: "i64.const", value: 0x400n },
        { op: "i64.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i64.const", value: 0n },
            { op: "local.set", index: L.m16 },
            { op: "local.get", index: L.E },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L.E },
            { op: "local.get", index: L.E },
            { op: "i32.const", value: 31 },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L.sign },
                { op: "i32.const", value: 0x7c00 },
                { op: "i32.or" },
                { op: "return" },
              ],
              else: [],
            },
          ],
          else: [],
        },
        { op: "local.get", index: L.sign },
        { op: "local.get", index: L.E },
        { op: "i32.const", value: 10 },
        { op: "i32.shl" },
        { op: "i32.or" },
        { op: "local.get", index: L.m16 },
        { op: "i32.wrap_i64" },
        { op: "i32.or" },
        { op: "return" },
      ],
      else: [],
    },
    // Subnormal / zero. e == 0 (f64 zero/subnormal, < 2⁻¹⁰²²) → ±0.
    { op: "local.get", index: L.e },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: L.sign }, { op: "return" }],
      else: [],
    },
    // sh = 42 + (1 − E); values below 2⁻³⁶ (shift > 21 ⇒ sh > 63) round to ±0.
    { op: "i32.const", value: 43 },
    { op: "local.get", index: L.E },
    { op: "i32.sub" },
    { op: "local.set", index: L.sh },
    { op: "local.get", index: L.sh },
    { op: "i32.const", value: 63 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: L.sign }, { op: "return" }],
      else: [],
    },
    // M = m | 2^52 (restore the implicit 1)
    { op: "local.get", index: L.m },
    { op: "i64.const", value: 0x10000000000000n },
    { op: "i64.or" },
    { op: "local.set", index: L.m },
    // m16 = M >> sh; rest = M & ((1<<sh) − 1); half = 1 << (sh − 1)
    { op: "local.get", index: L.m },
    { op: "local.get", index: L.sh },
    { op: "i64.extend_i32_u" },
    { op: "i64.shr_u" },
    { op: "local.set", index: L.m16 },
    { op: "i64.const", value: 1n },
    { op: "local.get", index: L.sh },
    { op: "i64.extend_i32_u" },
    { op: "i64.shl" },
    { op: "i64.const", value: 1n },
    { op: "i64.sub" },
    { op: "local.get", index: L.m },
    { op: "i64.and" },
    { op: "local.set", index: L.rest },
    { op: "i64.const", value: 1n },
    { op: "local.get", index: L.sh },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "i64.extend_i32_u" },
    { op: "i64.shl" },
    { op: "local.set", index: L.half },
    ...roundIncr,
    // A round-up to 0x400 IS the smallest normal (sign | 0x400) — encodes as-is.
    { op: "local.get", index: L.sign },
    { op: "local.get", index: L.m16 },
    { op: "i32.wrap_i64" },
    { op: "i32.or" },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [
      { name: "b64", type: { kind: "i64" } },
      { name: "sign", type: { kind: "i32" } },
      { name: "e", type: { kind: "i32" } },
      { name: "E", type: { kind: "i32" } },
      { name: "m", type: { kind: "i64" } },
      { name: "m16", type: { kind: "i64" } },
      { name: "sh", type: { kind: "i32" } },
      { name: "rest", type: { kind: "i64" } },
      { name: "half", type: { kind: "i64" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

export function emitDataViewAccessor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  receiver: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): { kind: "get"; result: ValType } | { kind: "set" } | null {
  const acc = DV_ACCESSORS[methodName];
  if (!acc) return null;

  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return null;

  // (#2199) Pre-build the §24.2.1.1 out-of-bounds RangeError template FIRST.
  // `emitDataViewRangeError` registers `__new_RangeError` as a late import (and
  // in no-JS-host mode emits the in-module constructor) — both push a function,
  // shifting every funcIdx. Building + flushing it before any operand compile or
  // backing-recovery keeps later funcIdx captures correct (same ordering rule as
  // native-regex's cap-throw). (#3173) The brand / detached TypeError templates
  // and the f16 codec helpers follow the same rule — all built before any
  // operand compile.
  // (#3173) `__is_truthy` (ToBoolean on a runtime littleEndian value) is
  // registered BEFORE the throw templates capture their ctor funcIdx — in
  // no-JS-host mode it resolves to an appended native (no shift), but keeping
  // every possible function push ahead of the first funcIdx capture makes the
  // ordering rule locally checkable.
  ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
  const rangeThrow = emitDataViewRangeError(ctx);
  const brandThrow = dvTypeErrorThrow(ctx, DV_BRAND_MESSAGE);
  const detachedThrow = dvTypeErrorThrow(ctx, DV_DETACHED_MESSAGE);
  if (acc.f16) {
    ensureF16DecodeHelper(ctx);
    ensureF16EncodeHelper(ctx);
  }
  flushLateImportShifts(ctx, fctx);

  // Recover the i32_byte backing array AND the view's base byte offset from the
  // receiver. (#3173) Standalone DataViews are ALWAYS `$__dv_window`-wrapped
  // (new-super.ts), so the recovery doubles as the §24.3.1.1/2 [[DataView]]
  // brand check: any non-window receiver (an ArrayBuffer, `{}`, a TypedArray…)
  // throws the catchable TypeError. `viewLenLocal` receives the view's byte
  // length for the #2199 bounds check; `bufVecLocal` the backing buffer struct
  // for the detached check.
  const arrLocal = allocLocal(fctx, `__dvn_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, `__dvn_base_${fctx.locals.length}`, { kind: "i32" });
  const viewLenLocal = allocLocal(fctx, `__dvn_vlen_${fctx.locals.length}`, { kind: "i32" });
  const bufVecLocal = allocLocal(fctx, `__dvn_buf_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const recvType = compileExpr(receiver);
  if (
    !recoverDvBacking(ctx, fctx, recvType, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, viewLenLocal, {
      brandThrow,
      bufVecLocal,
    })
  ) {
    return null;
  }

  // byteOffset (arg 0) → §24.2.1.1 GetViewValue: ToIndex(requestIndex) then the
  // `getIndex + elementSize > viewByteLength` bounds check, both throwing
  // RangeError BEFORE any access. Capture the f64 request, derive the i32
  // getIndex (the *view-relative* index, before adding base), then guard.
  const reqLocal = allocLocal(fctx, `__dvn_req_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
  } else {
    // ToIndex(undefined) = 0 (§7.1.22 step 1).
    fctx.body.push({ op: "f64.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: reqLocal });

  // (#3173) §7.1.22 ToIndex: integer = ToIntegerOrInfinity(value) — NaN → +0,
  // truncate toward zero — then RangeError iff integer < 0 or > 2^53-1. The
  // NaN → 0 rewrite runs FIRST (a NaN request reads offset 0; the previous code
  // wrongly threw). The range check runs in the f64 domain so ±Infinity / 2^53
  // requests throw at ToIndex time (BEFORE a setter's ToNumber(value) — the
  // index-check-before-value-conversion ordering), not at the bounds check.
  fctx.body.push({ op: "local.get", index: reqLocal }); // val-if-true: req
  fctx.body.push({ op: "f64.const", value: 0 }); // val-if-false: 0
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "f64.eq" }); // req == req (false only for NaN)
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "f64.trunc" }); // toward zero (−0.9 → −0, not negative)
  fctx.body.push({ op: "local.set", index: reqLocal });

  const getIdxLocal = allocLocal(fctx, `__dvn_gidx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: getIdxLocal });

  // (#2199b) The §24.2.1.2 SetViewValue / §24.2.1.1 GetViewValue throws fire
  // at DIFFERENT points relative to `ToNumber(value)` for a setter:
  //   - INDEX throw (ToIndex): fires BEFORE `ToNumber(value)`.
  //   - DETACHED throw (TypeError) + BOUNDS throw (step 8): fire AFTER
  //     `ToNumber(value)` runs (range-check-after-value-conversion /
  //     detached-buffer-after-number-value). i64 math for the bounds so a
  //     saturated `getIndex=i32.MAX` + bytes can't overflow.
  const emitIndexThrow = (): void => {
    fctx.body.push({ op: "local.get", index: reqLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.lt" }); // integer < 0
    fctx.body.push({ op: "local.get", index: reqLocal });
    fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53-1
    fctx.body.push({ op: "f64.gt" }); // integer > 2^53-1 (covers +Infinity)
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });
  };
  const emitBoundsThrow = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal });
    fctx.body.push({ op: "i64.extend_i32_s" });
    fctx.body.push({ op: "i64.const", value: BigInt(acc.bytes) });
    fctx.body.push({ op: "i64.add" });
    fctx.body.push({ op: "local.get", index: viewLenLocal });
    fctx.body.push({ op: "i64.extend_i32_s" });
    fctx.body.push({ op: "i64.gt_s" }); // (getIndex + bytes) > viewLen
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });
  };
  const emitDetachedThrow = (): void => emitDvDetachedCheck(fctx, bufVecLocal, vecTypeIdx, detachedThrow);

  // off = getIndex + base (absolute byte in the shared buffer). Computed after
  // the bounds throw at each call site.
  const offLocal = allocLocal(fctx, `__dvn_off_${fctx.locals.length}`, { kind: "i32" });
  const setOff = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal });
    fctx.body.push({ op: "local.get", index: baseLocal });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: offLocal });
  };

  if (acc.kind === "get") {
    // Getter has no value to convert: ToIndex → ToBoolean(littleEndian) →
    // detached TypeError → bounds RangeError → read. littleEndian is the 2nd arg.
    emitIndexThrow();
    const leLocal = emitLittleEndianFlag(ctx, fctx, args[1], compileExpr);
    emitDetachedThrow();
    emitBoundsThrow();
    setOff();
    emitReadBytes(ctx, fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    // (#3173) BigInt64/BigUint64 read back as the bigint-branded i64 carrier —
    // the exact rep a BigInt LITERAL produces — so `=== 0n` and any-boxing
    // agree; every other getter stays f64.
    return { kind: "get", result: acc.int64 ? { kind: "i64", bigint: true } : { kind: "f64" } };
  }

  // Setter: ToIndex throw → ToNumber(value) (+littleEndian) → detached throw →
  // bounds throw → write. Compiling the value/le runs their valueOf/Symbol
  // coercions, which can throw and MUST do so after the index check but before
  // the detached/bounds checks.
  emitIndexThrow();
  const valLocal = allocLocal(fctx, `__dvn_val_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 2 && ctx.oracle.staticJsTypeOf(args[1]!) === "symbol") {
    // §7.1.4 ToNumber(Symbol) / §7.1.13 ToBigInt(Symbol) throw TypeError —
    // evaluate the operand for side effects, drop, throw (unary.ts pattern).
    const t = compileExpr(args[1]!);
    if (t !== null) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
    fctx.body.push({ op: "f64.const", value: NaN }); // unreachable stack shape
  } else if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
  } else if (acc.int64) {
    // §7.1.13 ToBigInt(undefined) throws TypeError (setBigInt64 no-value-arg).
    const toBigIntThrow = dvTypeErrorThrow(ctx, DV_TOBIGINT_UNDEFINED_MESSAGE);
    fctx.body.push(...toBigIntThrow);
    fctx.body.push({ op: "f64.const", value: NaN }); // unreachable stack shape
  } else {
    // ToNumber(undefined) = NaN — integer setters wrap it to 0 in the codec;
    // float setters must genuinely write NaN (no-value-arg.js).
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  fctx.body.push({ op: "local.set", index: valLocal });
  const leLocal = emitLittleEndianFlag(ctx, fctx, args[2], compileExpr);
  emitDetachedThrow();
  emitBoundsThrow();
  setOff();
  emitWriteBytes(ctx, fctx, acc, arrLocal, offLocal, valLocal, leLocal, arrTypeIdx);
  return { kind: "set" };
}

/**
 * (#3173) Mint the runtime-receiver DataView accessor helper
 * `__dv_m_<member>(recv, byteOffset[, value], littleEndian) → externref`
 * (all params externref) — the SINGLE shared spec-order core behind
 *   - the closed-method dispatcher's `$__dv_window` brand arm (an `any`
 *     receiver `sample.getUint8(…)` inside an `assert.throws` callback), and
 *   - the reflective `DataView.prototype.<m>` member-closure body
 *     (`getUint8.call({}, 0)` — this-has-no-dataview-internal.js).
 *
 * Sequence (§24.3.1.1 GetViewValue / §24.3.1.2 SetViewValue):
 *   brand TypeError → ToIndex(requestIndex) RangeError → [ToNumber(value)] →
 *   ToBoolean(littleEndian) → detached TypeError → bounds RangeError → op.
 * Getters box the f64 result (`__box_number`); setters return undefined
 * (null extern). noJsHost lane only; idempotent per member.
 *
 * IMPORT DISCIPLINE: every reachable helper (`__to_primitive`/`__unbox_number`
 * via the externref→f64 coercion, `__is_truthy`, `__box_number`, the error
 * ctors) resolves to a NATIVE defined function on this lane, so registration
 * appends only and cannot shift baked funcIdxs; all are pre-ensured before the
 * throw templates capture their ctor indices anyway.
 */
export function ensureDvAccessorHelper(ctx: CodegenContext, member: string): number | undefined {
  if (!usesNativeDataViewProvider(ctx)) return undefined;
  const acc = DV_ACCESSORS[member];
  if (!acc) return undefined;
  const helperName = `__dv_m_${member}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return undefined;

  // Pre-ensure every dependency BEFORE the throw templates capture funcIdxs.
  ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  if (acc.f16) {
    ensureF16DecodeHelper(ctx);
    ensureF16EncodeHelper(ctx);
  }
  const rangeThrow = emitDataViewRangeError(ctx);
  const brandThrow = dvTypeErrorThrow(ctx, DV_BRAND_MESSAGE);
  const detachedThrow = dvTypeErrorThrow(ctx, DV_DETACHED_MESSAGE);
  const toBigIntThrow =
    acc.kind === "set" && acc.int64 ? dvTypeErrorThrow(ctx, DV_TOBIGINT_UNDEFINED_MESSAGE) : undefined;
  const truthyIdx = ctx.funcMap.get("__is_truthy");

  // Signature: recv + (get: offset, le | set: offset, value, le).
  const userArgs = acc.kind === "get" ? 2 : 3;
  const params: ValType[] = Array.from({ length: userArgs + 1 }, () => ({ kind: "externref" }) as ValType);
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const fctx: FunctionContext = {
    name: helperName,
    params: params.map((type, i) => ({ name: i === 0 ? "recv" : `a${i - 1}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  const arrLocal = allocLocal(fctx, "arr", { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, "base", { kind: "i32" });
  const viewLenLocal = allocLocal(fctx, "vlen", { kind: "i32" });
  const bufVecLocal = allocLocal(fctx, "buf", { kind: "ref_null", typeIdx: vecTypeIdx });

  // Brand check + backing recovery (param 0 = recv, externref).
  fctx.body.push({ op: "local.get", index: 0 });
  recoverDvBacking(ctx, fctx, { kind: "externref" }, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, viewLenLocal, {
    brandThrow,
    bufVecLocal,
  });

  // ToIndex(a0): externref → f64 (observable ToPrimitive/ToNumber — runs AFTER
  // the brand check, BEFORE the value conversion), then NaN→0, trunc, range.
  const reqLocal = allocLocal(fctx, "req", { kind: "f64" });
  fctx.body.push({ op: "local.get", index: 1 });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: reqLocal });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "f64.eq" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: reqLocal });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "f64.const", value: 9007199254740991 });
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });

  const getIdxLocal = allocLocal(fctx, "gidx", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: reqLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: getIdxLocal });

  // Setters: numberValue = ToNumber(value) (a1) — observable, after ToIndex.
  // (#3173) BigInt setters: §7.1.13 ToBigInt(undefined) throws TypeError — a
  // MISSING value arrives as a null extern (dispatcher/closure padding).
  const valLocal = acc.kind === "set" ? allocLocal(fctx, "val", { kind: "f64" }) : -1;
  if (acc.kind === "set") {
    if (toBigIntThrow) {
      fctx.body.push({ op: "local.get", index: 2 });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: toBigIntThrow, else: [] });
    }
    fctx.body.push({ op: "local.get", index: 2 });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valLocal });
  }

  // ToBoolean(littleEndian) — last user param; `__is_truthy` handles
  // undefined/null/objects/strings ({} → true, "" → false).
  const leLocal = allocLocal(fctx, "le", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: userArgs });
  if (truthyIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: truthyIdx });
  } else {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: leLocal });

  // Detached TypeError → bounds RangeError → absolute offset.
  emitDvDetachedCheck(fctx, bufVecLocal, vecTypeIdx, detachedThrow);
  fctx.body.push({ op: "local.get", index: getIdxLocal });
  fctx.body.push({ op: "i64.extend_i32_s" });
  fctx.body.push({ op: "i64.const", value: BigInt(acc.bytes) });
  fctx.body.push({ op: "i64.add" });
  fctx.body.push({ op: "local.get", index: viewLenLocal });
  fctx.body.push({ op: "i64.extend_i32_s" });
  fctx.body.push({ op: "i64.gt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] });

  const offLocal = allocLocal(fctx, "off", { kind: "i32" });
  fctx.body.push({ op: "local.get", index: getIdxLocal });
  fctx.body.push({ op: "local.get", index: baseLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });

  if (acc.kind === "get") {
    emitReadBytes(ctx, fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    // Box through the SAME chokepoint a literal/argument uses (coerceType) so
    // `assert_sameValue(<call>, 0n)` compares identical representations —
    // int64 getters carry the bigint-branded i64, the rest f64.
    coerceType(ctx, fctx, acc.int64 ? { kind: "i64", bigint: true } : { kind: "f64" }, { kind: "externref" });
  } else {
    emitWriteBytes(ctx, fctx, acc, arrLocal, offLocal, valLocal, leLocal, arrTypeIdx);
    // Setters return undefined — standalone lowers `undefined` to the null
    // externref (`x === undefined` is `ref.is_null`), so this IS undefined.
    fctx.body.push({ op: "ref.null.extern" });
  }

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#3173) Mint the reflective accessor-GETTER helper body deps and return the
 * per-member metadata for `buffer` / `byteLength` / `byteOffset` — see
 * {@link emitDataViewProtoMemberBody}.
 */
const DV_GETTER_MEMBERS: ReadonlySet<string> = new Set(["buffer", "byteLength", "byteOffset"]);

/**
 * (#3173) Reflective `DataView.prototype.<member>` member-closure body —
 * wired as the DataView glue's `emitMemberBody` (array-object-proto.ts).
 * Closure ABI: param 0 = self wrapper struct, param 1 = externref `this`,
 * params 2.. = externref args. Methods delegate to the shared
 * {@link ensureDvAccessorHelper}; the three accessor getters brand-check and
 * read the window inline (`buffer` returns the ACTUAL shared buffer —
 * identity-correct; `byteLength`/`byteOffset` throw TypeError on a detached
 * buffer per §25.3.4.2/3). Returns the closure result type, or null to refuse
 * (host lane / unknown member — degrades to the catchable-TypeError closure).
 */
export function emitDataViewProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (!usesNativeDataViewProvider(ctx)) return null;
  const resultType: ValType = { kind: "externref" };

  if (DV_GETTER_MEMBERS.has(member)) {
    const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
    if (arrTypeIdx < 0) return null;
    const boxNumIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    const brandThrow = dvTypeErrorThrow(ctx, DV_BRAND_MESSAGE);
    const detachedThrow = dvTypeErrorThrow(ctx, DV_DETACHED_MESSAGE);
    const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);

    const winLocal = allocLocal(fctx, "win", { kind: "ref_null", typeIdx: dvWinTypeIdx });
    const bufVecLocal = allocLocal(fctx, "buf", { kind: "ref_null", typeIdx: vecTypeIdx });
    const anyLocal = allocLocal(fctx, "any", { kind: "anyref" });
    // Brand: this (param 1) must be a $__dv_window.
    fctx.body.push({ op: "local.get", index: 1 });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.tee", index: anyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dvWinTypeIdx },
        { op: "local.set", index: winLocal },
        { op: "local.get", index: winLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: bufVecLocal },
      ],
      else: brandThrow,
    });

    if (member === "buffer") {
      // §25.3.4.1 — return the ACTUAL viewed buffer (identity; works on detached).
      fctx.body.push({ op: "local.get", index: bufVecLocal });
      fctx.body.push({ op: "extern.convert_any" });
      return resultType;
    }
    // §25.3.4.2/3 — TypeError on detached, else the window field boxed.
    emitDvDetachedCheck(fctx, bufVecLocal, vecTypeIdx, detachedThrow);
    fctx.body.push({ op: "local.get", index: winLocal });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: member === "byteOffset" ? 1 : 2 });
    fctx.body.push({ op: "f64.convert_i32_s" });
    if (boxNumIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxNumIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
    return resultType;
  }

  const helperIdx = ensureDvAccessorHelper(ctx, member);
  if (helperIdx === undefined) return null;
  const acc = DV_ACCESSORS[member]!;
  const helperArgs = acc.kind === "get" ? 2 : 3;
  // this (param 1) + args (params 2..), padded with null extern (undefined).
  fctx.body.push({ op: "local.get", index: 1 });
  for (let i = 0; i < helperArgs; i++) {
    const paramIdx = 2 + i;
    if (paramIdx < fctx.params.length) {
      fctx.body.push({ op: "local.get", index: paramIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return resultType;
}

/**
 * (#3173) Intercept the test262 `$DETACHBUFFER` shim's marker write —
 * `(buf as any).__detached__ = true` — on the standalone lane. The host lane
 * stores the marker in the runtime sidecar (`_sidecarGet`, runtime.ts); with
 * no host, the write previously vanished into the dynamic-set path and every
 * detached-buffer test silently mis-passed the buffer as live.
 *
 * The detach marker IS the buffer vec's `length` field forced to `-1`
 * (§25.1.3.3 IsDetachedBuffer maps to `length < 0`; the field is mutable and
 * `-1` is unreachable for a live buffer, so live/detached are unambiguous —
 * a zero-length buffer stays `0`). All views share the buffer STRUCT, so
 * windows/TA views observe the detach through their `buf` ref. Byte reads of
 * `.byteLength` clamp negatives to 0 (property-access.ts).
 *
 * Returns the assignment's result ValType when handled (receiver compiled,
 * runtime `ref.test $__vec_i32_byte`-gated mark, RHS evaluated and returned —
 * `=` yields the RHS), or `undefined` to fall through (host lane / different
 * property name).
 */
export function tryCompileStandaloneDetachedWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: import("../ts-api.js").ts.PropertyAccessExpression,
  value: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | undefined {
  if (!noJsHost(ctx)) return undefined;
  if (target.name.text !== "__detached__") return undefined;

  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return undefined;

  // Receiver → anyref local (drop-through for non-ref receivers).
  const recvT = compileExpr(target.expression);
  if (!recvT) return undefined;
  const anyLocal = allocLocal(fctx, `__dvdet_any_${fctx.locals.length}`, { kind: "anyref" });
  if (recvT.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.set", index: anyLocal });
  } else if (recvT.kind === "ref" || recvT.kind === "ref_null") {
    fctx.body.push({ op: "local.set", index: anyLocal });
  } else {
    // Numeric receiver (defensive) — evaluate RHS and yield it unchanged.
    fctx.body.push({ op: "drop" });
    const vt = compileExpr(value);
    return vt ?? { kind: "i32" };
  }

  // RHS — evaluated for value + truthiness (only a truthy write detaches).
  const valT = compileExpr(value) ?? { kind: "i32" };
  const valLocal = allocLocal(fctx, `__dvdet_val_${fctx.locals.length}`, valT);
  fctx.body.push({ op: "local.set", index: valLocal });

  // truthy(value) — i32 non-zero / f64 non-zero-non-NaN / refs count as true.
  const truthy: Instr[] = [];
  if (valT.kind === "i32") {
    truthy.push(
      { op: "local.get", index: valLocal },
      { op: "i32.eqz" },
      {
        op: "i32.eqz",
      },
    );
  } else if (valT.kind === "f64") {
    truthy.push(
      { op: "local.get", index: valLocal },
      { op: "f64.const", value: 0 },
      { op: "f64.ne" },
      { op: "local.get", index: valLocal },
      { op: "local.get", index: valLocal },
      { op: "f64.eq" },
      { op: "i32.and" },
    );
  } else {
    truthy.push({ op: "i32.const", value: 1 });
  }

  // if (recv is i32_byte vec && truthy) → struct.set length = -1.
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
  fctx.body.push(...truthy);
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "i32.const", value: -1 },
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
    ],
    else: [],
  });

  // `=` evaluates to the RHS.
  fctx.body.push({ op: "local.get", index: valLocal });
  return valT;
}

/**
 * Compile the optional `littleEndian` argument into an i32 local (0 = big
 * endian, 1 = little endian). When absent, defaults to 0 (big endian) per the
 * DataView spec. The argument is `boolean`; truthiness is captured via the
 * standard i32 boolean lowering.
 */
function emitLittleEndianFlag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leArg: import("../ts-api.js").ts.Expression | undefined,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): number {
  const leLocal = allocLocal(fctx, `__dvn_le_${fctx.locals.length}`, { kind: "i32" });
  if (leArg) {
    // (#3173) NO type hint: an i32 hint routed `{}`/string values through a
    // numeric unbox (→ NaN → falsy), but §7.1.2 ToBoolean(object) is TRUE.
    // The natural type dispatches below: i32 pass-through, f64 zero/NaN test,
    // extern/GC refs via the native `__is_truthy`.
    const t = compileExpr(leArg);
    // If the boolean compiled to f64 (boxed), normalize to i32 truthiness.
    if (t && t.kind === "f64") {
      // (#3173) §7.1.2 ToBoolean(f64): false for ±0 AND NaN. A bare `f64.ne 0`
      // wrongly made NaN truthy (NaN != 0).
      const leF64 = allocLocal(fctx, `__dvn_lef_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: leF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.ne" }); // v != 0
      fctx.body.push({ op: "local.get", index: leF64 });
      fctx.body.push({ op: "local.get", index: leF64 });
      fctx.body.push({ op: "f64.eq" }); // v == v (false for NaN)
      fctx.body.push({ op: "i32.and" });
    } else if (t && t.kind === "externref") {
      // (#3173) ToBoolean on an arbitrary runtime value (`{}` → true,
      // `undefined`/`null`/`0`/`""` → false) — `__is_truthy` resolves to the
      // in-module native under no-JS-host mode (to-boolean-littleendian.js).
      const truthyIdx = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (truthyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: truthyIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
      }
    } else if (t && (t.kind === "ref" || t.kind === "ref_null")) {
      // (#3173) A GC-ref littleEndian (object literal / AnyValue box / native
      // string) — normalize to externref and ask the native `__is_truthy`
      // (`{}` → true, `""` → false, boxed 0/NaN → false).
      const truthyIdx = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "extern.convert_any" });
      if (truthyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: truthyIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
      }
    } else if (t && t.kind !== "i32") {
      // Other non-i32 (defensive) — drop and default to big endian.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: leLocal });
  return leLocal;
}

/** Push `arr[off + k]` (unsigned byte 0..255) as i32. */
function pushByte(fctx: FunctionContext, arrLocal: number, offLocal: number, k: number, arrTypeIdx: number): void {
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: offLocal });
  if (k !== 0) {
    fctx.body.push({ op: "i32.const", value: k });
    fctx.body.push({ op: "i32.add" });
  }
  // (#2835) Packed `i8` backing → unsigned zero-extended read (plain `array.get`
  // is invalid on a packed array). Result already in [0,255].
  fctx.body.push({ op: "array.get_u", typeIdx: arrTypeIdx });
  // Mask to a byte — `array.get_u` already yields 0..255, but defensively
  // keep only the low 8 bits so sign/overflow can't leak in.
  fctx.body.push({ op: "i32.const", value: 0xff });
  fctx.body.push({ op: "i32.and" });
}

/**
 * Assemble the N bytes into an i32 (for <=4 byte ints / Float32) or an i64
 * (for Float64), honouring endianness, then convert to the f64 result.
 */
function emitReadBytes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  if (acc.bytes === 1) {
    pushByte(fctx, arrLocal, offLocal, 0, arrTypeIdx);
    if (acc.signed) {
      // sign-extend an 8-bit value: (x << 24) >> 24
      fctx.body.push({ op: "i32.const", value: 24 });
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.const", value: 24 });
      fctx.body.push({ op: "i32.shr_s" });
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else {
      fctx.body.push({ op: "f64.convert_i32_u" });
    }
    return;
  }

  if (acc.bytes === 8) {
    // Assemble an i64, then: Float64 → f64.reinterpret_i64; (#3173)
    // BigInt64/BigUint64 → LEAVE the i64 on the stack — the getter's result is
    // the bigint-branded `{kind:"i64", bigint:true}` carrier, the SAME rep a
    // BigInt literal produces, so `getBigInt64(0) === 0n` and any-boxing agree.
    // (getBigUint64 values ≥ 2^63 exceed the signed carrier; exactness holds
    // for the |v| < 2^63 range the conformance corpus exercises for reads.)
    emitReadI64(fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    if (!acc.int64) {
      fctx.body.push({ op: "f64.reinterpret_i64" });
    }
    return;
  }

  // 2 or 4 byte values — assemble an i32 with a runtime endianness branch.
  // Result i32 is left on the stack, then converted to f64.
  emitReadI32(fctx, acc.bytes, arrLocal, offLocal, leLocal, arrTypeIdx);

  if (acc.f16) {
    // (#3173) Float16: decode the 16-bit half-precision pattern via the minted
    // `__f16_decode` helper (pre-ensured in the accessor prologue).
    const decIdx = ctx.funcMap.get("__f16_decode");
    if (decIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: decIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
    return;
  }

  if (acc.float) {
    // Float32: reinterpret the 32-bit pattern, then promote to f64.
    fctx.body.push({ op: "f32.reinterpret_i32" });
    fctx.body.push({ op: "f64.promote_f32" });
    return;
  }

  if (acc.signed) {
    if (acc.bytes === 2) {
      // sign-extend 16-bit: (x << 16) >> 16
      fctx.body.push({ op: "i32.const", value: 16 });
      fctx.body.push({ op: "i32.shl" });
      fctx.body.push({ op: "i32.const", value: 16 });
      fctx.body.push({ op: "i32.shr_s" });
    }
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else {
    fctx.body.push({ op: "f64.convert_i32_u" });
  }
}

/**
 * Assemble a 2- or 4-byte little/big-endian integer into an i32 on the stack.
 * Emits a runtime branch on `leLocal`.
 */
function emitReadI32(
  fctx: FunctionContext,
  bytes: number,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  // little-endian assembly: b0 | b1<<8 | b2<<16 | b3<<24
  const leInstrs: Instr[] = [];
  buildIntoBranch(leInstrs, fctx, bytes, arrLocal, offLocal, arrTypeIdx, /*little*/ true);
  const beInstrs: Instr[] = [];
  buildIntoBranch(beInstrs, fctx, bytes, arrLocal, offLocal, arrTypeIdx, /*little*/ false);

  fctx.body.push({ op: "local.get", index: leLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: leInstrs,
    else: beInstrs,
  });
}

/**
 * Build the byte-assembly instructions for one endianness into `out`.
 * The assembly does not reference `fctx.body`; it composes a self-contained
 * Instr[] that pushes a single i32.
 */
function buildIntoBranch(
  out: Instr[],
  _fctx: FunctionContext,
  bytes: number,
  arrLocal: number,
  offLocal: number,
  arrTypeIdx: number,
  little: boolean,
): void {
  const byteAt = (k: number): Instr[] => {
    const seq: Instr[] = [
      { op: "local.get", index: arrLocal },
      { op: "local.get", index: offLocal },
    ];
    if (k !== 0) {
      seq.push({ op: "i32.const", value: k });
      seq.push({ op: "i32.add" });
    }
    seq.push({ op: "array.get_u", typeIdx: arrTypeIdx }); // (#2835) packed i8 byte read
    seq.push({ op: "i32.const", value: 0xff });
    seq.push({ op: "i32.and" });
    return seq;
  };

  // Accumulate: for each byte k (0..bytes-1), shift = little ? k*8 : (bytes-1-k)*8
  for (let k = 0; k < bytes; k++) {
    const shift = little ? k * 8 : (bytes - 1 - k) * 8;
    out.push(...byteAt(k));
    if (shift !== 0) {
      out.push({ op: "i32.const", value: shift });
      out.push({ op: "i32.shl" });
    }
    if (k > 0) out.push({ op: "i32.or" });
  }
}

/** Assemble an 8-byte little/big-endian value into an i64 on the stack. */
function emitReadI64(
  fctx: FunctionContext,
  _acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  const build = (little: boolean): Instr[] => {
    const out: Instr[] = [];
    const byteAt = (k: number): Instr[] => {
      const seq: Instr[] = [
        { op: "local.get", index: arrLocal },
        { op: "local.get", index: offLocal },
      ];
      if (k !== 0) {
        seq.push({ op: "i32.const", value: k });
        seq.push({ op: "i32.add" });
      }
      seq.push({ op: "array.get_u", typeIdx: arrTypeIdx }); // (#2835) packed i8 byte read
      seq.push({ op: "i32.const", value: 0xff });
      seq.push({ op: "i32.and" });
      seq.push({ op: "i64.extend_i32_u" });
      return seq;
    };
    for (let k = 0; k < 8; k++) {
      const shift = little ? k * 8 : (7 - k) * 8;
      out.push(...byteAt(k));
      if (shift !== 0) {
        out.push({ op: "i64.const", value: BigInt(shift) });
        out.push({ op: "i64.shl" });
      }
      if (k > 0) out.push({ op: "i64.or" });
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i64" } },
    then: build(true),
    else: build(false),
  });
}

/** Store `arr[off + k] = byte` (byte already an i32 0..255 on caller's responsibility). */
function emitStoreByte(
  out: Instr[],
  arrLocal: number,
  offLocal: number,
  k: number,
  byte: Instr[],
  arrTypeIdx: number,
): void {
  out.push({ op: "local.get", index: arrLocal });
  out.push({ op: "local.get", index: offLocal });
  if (k !== 0) {
    out.push({ op: "i32.const", value: k });
    out.push({ op: "i32.add" });
  }
  out.push(...byte);
  out.push({ op: "array.set", typeIdx: arrTypeIdx });
}

/**
 * Write the value into the backing byte array. The value local is f64; we
 * convert to the integer/bit representation then store each byte with an
 * endianness branch.
 */
function emitWriteBytes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  acc: DvAccessor,
  arrLocal: number,
  offLocal: number,
  valLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): void {
  if (acc.bytes === 1) {
    // arr[off] = (value mod 256). Spec ToInt8/ToUint8 are modular; go via i64
    // (`i64.trunc_sat_f64_s` + `i32.wrap_i64`) so large values wrap rather than
    // saturate (`i32.trunc_sat_f64_s` would clamp ≥2^31), then mask the low byte.
    const out: Instr[] = [];
    emitStoreByte(
      out,
      arrLocal,
      offLocal,
      0,
      [
        { op: "local.get", index: valLocal },
        { op: "i64.trunc_sat_f64_s" },
        { op: "i32.wrap_i64" },
        { op: "i32.const", value: 0xff },
        { op: "i32.and" },
      ],
      arrTypeIdx,
    );
    fctx.body.push(...out);
    return;
  }

  if (acc.bytes === 8) {
    // Float64: bits = i64.reinterpret_f64(val); (#3173) BigInt64/BigUint64:
    // bits = i64.trunc_sat_f64_s(val) — the numeric-rep BigInt value truncated
    // toward zero (exact for |v| < 2^53); store 8 bytes either way.
    const bitsLocal = allocLocal(fctx, `__dvn_bits64_${fctx.locals.length}`, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: acc.int64 ? "i64.trunc_sat_f64_s" : "i64.reinterpret_f64" });
    fctx.body.push({ op: "local.set", index: bitsLocal });
    const storeAll = (little: boolean): Instr[] => {
      const out: Instr[] = [];
      for (let k = 0; k < 8; k++) {
        const shift = little ? k * 8 : (7 - k) * 8;
        const byte: Instr[] = [{ op: "local.get", index: bitsLocal }];
        if (shift !== 0) {
          byte.push({ op: "i64.const", value: BigInt(shift) });
          byte.push({ op: "i64.shr_u" });
        }
        byte.push({ op: "i32.wrap_i64" });
        byte.push({ op: "i32.const", value: 0xff });
        byte.push({ op: "i32.and" });
        emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
      }
      return out;
    };
    fctx.body.push({ op: "local.get", index: leLocal });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: storeAll(true),
      else: storeAll(false),
    });
    return;
  }

  // 2 or 4 byte integers (or Float32/Float16) — derive an i32 bit pattern.
  const bitsLocal = allocLocal(fctx, `__dvn_bits32_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: valLocal });
  if (acc.f16) {
    // (#3173) Float16: encode via the minted `__f16_encode` helper
    // (roundTiesToEven directly from the f64 bits — single rounding).
    const encIdx = ctx.funcMap.get("__f16_encode");
    if (encIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: encIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
    }
  } else if (acc.float) {
    // Float32: demote f64→f32, reinterpret to i32 bits.
    fctx.body.push({ op: "f32.demote_f64" });
    fctx.body.push({ op: "i32.reinterpret_f32" });
  } else {
    // Integer: the spec (SetValueInBuffer → ToInt{8,16,32}/ToUint{8,16,32}) is
    // MODULAR (`value mod 2^(8*bytes)`), not saturating. `i32.trunc_sat_f64_s`
    // *clamps* (e.g. setUint32(_, 4_000_000_000) → 0x7FFFFFFF), which is wrong
    // for any value ≥ 2^31. Truncate toward zero into an i64 first, then
    // `i32.wrap_i64` keeps the low 32 bits — i.e. `value mod 2^32`. Only the low
    // `acc.bytes` of those are stored below, giving the correct modular result
    // for 2- and 4-byte signed/unsigned setters across the ±2^53 integer range
    // that conformance exercises.
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    fctx.body.push({ op: "i32.wrap_i64" });
  }
  fctx.body.push({ op: "local.set", index: bitsLocal });

  const storeAll = (little: boolean): Instr[] => {
    const out: Instr[] = [];
    for (let k = 0; k < acc.bytes; k++) {
      const shift = little ? k * 8 : (acc.bytes - 1 - k) * 8;
      const byte: Instr[] = [{ op: "local.get", index: bitsLocal }];
      if (shift !== 0) {
        byte.push({ op: "i32.const", value: shift });
        byte.push({ op: "i32.shr_u" });
      }
      byte.push({ op: "i32.const", value: 0xff });
      byte.push({ op: "i32.and" });
      emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: storeAll(true),
    else: storeAll(false),
  });
}

// ---------------------------------------------------------------------------
// (#3054 B1) Shared-backing TypedArray view element access.
//
// A `$__ta_view_<name>` is a byte-backed view over an ArrayBuffer's
// `$__vec_i32_byte` struct (field1 `buf`). Element `ta[i]` byte-decodes from
// `buf.data` at `byteOffset + i*width` using the SAME little/big-endian byte
// engine the native DataView accessors use — pinned little-endian (TypedArrays
// use native/platform endianness, and Wasm's is LE). Because the view holds a
// ref to the SHARED buffer vec, sibling views and DataViews over the same buffer
// observe each other's writes (the verified #3054 bug). Discriminated purely by
// the receiver's static ValType.typeIdx at compile time, so plain-array /
// native-TA element access never reaches these arms — byte-inert.
// ---------------------------------------------------------------------------

/** Per-view-name byte-decode descriptor (width, signedness, float, clamp-on-write). */
const TA_VIEW_DECODE: Record<
  string,
  { bytes: number; signed: boolean; float: boolean; clamp: boolean; int64?: boolean }
> = {
  Int8Array: { bytes: 1, signed: true, float: false, clamp: false },
  Uint8Array: { bytes: 1, signed: false, float: false, clamp: false },
  Uint8ClampedArray: { bytes: 1, signed: false, float: false, clamp: true },
  Int16Array: { bytes: 2, signed: true, float: false, clamp: false },
  Uint16Array: { bytes: 2, signed: false, float: false, clamp: false },
  Int32Array: { bytes: 4, signed: true, float: false, clamp: false },
  Uint32Array: { bytes: 4, signed: false, float: false, clamp: false },
  Float32Array: { bytes: 4, signed: false, float: true, clamp: false },
  Float64Array: { bytes: 8, signed: false, float: true, clamp: false },
  // (#3613) The two BigInt views. 8-byte INTEGER elements (`int64`), NOT the
  // bit-reinterpreted doubles `Float64Array` uses — without the flag an 8-byte
  // non-float read would `f64.reinterpret_i64` the integer bit pattern and read
  // back garbage. These entries exist ONLY to serve the runtime-kind dynamic
  // dispatch (`emitDynDecodeDispatch` / `emitDynEncodeDispatch`, both driven by
  // `TA_CTOR_KINDS`); the STATIC per-view path resolves names through
  // `getTaViewName` over `ctx.taViewTypeMap`, and #838 gave the BigInt views a
  // native i64-element vec instead of a `$__ta_view_<name>`, so no static
  // `$__ta_view_BigInt64Array` is ever registered and `taViewDecode` cannot
  // reach these rows. Adding them is therefore inert for the static lane.
  BigInt64Array: { bytes: 8, signed: true, float: false, clamp: false, int64: true },
  BigUint64Array: { bytes: 8, signed: false, float: false, clamp: false, int64: true },
};

/** Resolve a `$__ta_view` typeIdx to its byte-decode descriptor, or undefined. */
export function taViewDecode(
  ctx: CodegenContext,
  taViewTypeIdx: number,
): { bytes: number; signed: boolean; float: boolean; clamp: boolean } | undefined {
  const name = getTaViewName(ctx, taViewTypeIdx);
  return name ? TA_VIEW_DECODE[name] : undefined;
}

/**
 * (#3054 C) Push the CURRENT element length of a `$__ta_view` (held in `tvLocal`)
 * as an i32. Field 0 stores either a fixed element count (`>= 0`, the B1/B2 case
 * — a view over a NON-resizable buffer) or the **auto-length-tracking sentinel
 * `-1`** (set by `emitTaViewConstruct` when the offset-0 view is built over a
 * `$__resizable_ab`). For the sentinel, the live length is derived from the shared
 * buffer's current byte length (`buf.length / elementSize`), so after
 * `rab.resize(n)` swaps the buffer's `length`/`data` the view reflects the new
 * length — length-tracking-on-resize (Phase A A.1), which is only "free" for the
 * BYTES (the byte engine already reads `buf.data` live); the length field is
 * cached and needs this indirection. A fixed view (field0 >= 0) takes the
 * `then`-branch → byte-identical to the pre-C direct `struct.get 0` read.
 */
export function pushTaViewEffectiveLen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  tvLocal: number,
  taViewTypeIdx: number,
): void {
  // Byte-inert gate: a module with no resizable ArrayBuffer type can have NO
  // auto-length view, so the sentinel is impossible — read field0 directly,
  // byte-identical to B1. The tracking indirection is emitted only once a
  // `$__resizable_ab` exists in the module.
  if (ctx.resizableAbTypeIdx < 0) {
    fctx.body.push({ op: "local.get", index: tvLocal });
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 });
    return;
  }
  const { vecTypeIdx } = i32ByteVec(ctx);
  const bytes = taViewDecode(ctx, taViewTypeIdx)?.bytes ?? 1;
  const storedLocal = allocLocal(fctx, `__tav_slen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: tvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: storedLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });
  const elseInstrs: Instr[] = [
    { op: "local.get", index: tvLocal },
    { op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 }, // buf (ref_null $__vec_i32_byte)
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }, // buf.length (byte count)
  ];
  if (bytes !== 1) {
    elseInstrs.push({ op: "i32.const", value: bytes });
    elseInstrs.push({ op: "i32.div_u" });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: storedLocal }],
    else: elseInstrs,
  });
}

/**
 * (#3054 B1) `new <TA>(arrayBuffer)` → a shared-backing `$__ta_view_<name>` that
 * REFS the buffer's `$__vec_i32_byte` struct instead of COPYING its bytes into a
 * fresh backing array (the verified copy bug: sibling views / DataViews over the
 * same buffer didn't observe writes). Offset-0, default-length window (B1 scope;
 * B2 adds `(buffer, byteOffset, length)`). `viewName` is the TS TypedArray name.
 * `compileExpr` compiles the buffer arg expression. Returns the view ValType, or
 * null (leaving the stack balanced) when the buffer can't be recovered as a
 * native vec — the caller then falls back to the numeric-length ctor path.
 */
export function emitTaViewConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: import("../ts-api.js").ts.Expression,
  viewName: string,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = TA_VIEW_DECODE[viewName];
  if (!desc) return null;
  const taViewTypeIdx = getOrRegisterTaViewType(ctx, viewName);
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Compile the buffer expression and recover the shared i32_byte vec struct.
  const bufType = compileExpr(bufExpr);
  if (!bufType) return null;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && (bufType as { typeIdx: number }).typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
    }
  } else {
    fctx.body.push({ op: "drop" });
    return null;
  }
  const bufLocal = allocLocal(fctx, `__tav_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocal });

  // struct.new order = [length, buf, byteOffset]. length field = fixed element
  // count `buf.length / elementSize` (B1/B2). (#3054 C) When the MODULE contains a
  // resizable ArrayBuffer (`ctx.resizableAbTypeIdx >= 0`), this offset-0 view may
  // be AUTO-LENGTH over a `$__resizable_ab` (§23.2.5.1 — length arg omitted +
  // resizable backing ⇒ length-tracking): store the sentinel `-1` when the runtime
  // buffer is resizable so `pushTaViewEffectiveLen` derives the live length from
  // `buf.length` at each read (reflecting a later `rab.resize()`). This extra
  // `ref.test`/`select` is emitted ONLY when a resizable buffer type exists in the
  // module, so a program that uses only fixed buffers is BYTE-IDENTICAL to B1.
  fctx.body.push({ op: "local.get", index: bufLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  if (desc.bytes !== 1) {
    fctx.body.push({ op: "i32.const", value: desc.bytes });
    fctx.body.push({ op: "i32.div_u" });
  }
  if (ctx.resizableAbTypeIdx >= 0) {
    const rabTypeIdx = ctx.resizableAbTypeIdx;
    // -1 (auto-length sentinel). Wasm `select` yields `cond ? a : b` with `a` the
    // deeper operand (= fixedLen). We want `resizable ? -1 : fixedLen`, so invert
    // the test with `i32.eqz`: cond = !resizable ⇒ select = resizable ? -1 : fixedLen.
    fctx.body.push({ op: "i32.const", value: -1 });
    fctx.body.push({ op: "local.get", index: bufLocal });
    fctx.body.push({ op: "ref.test", typeIdx: rabTypeIdx });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "select" });
  }
  // buf (shared vec ref) — `ref` widens to the field's `ref_null` type.
  fctx.body.push({ op: "local.get", index: bufLocal });
  // byteOffset = 0 (B1: offset-0 window).
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "struct.new", typeIdx: taViewTypeIdx });
  return { kind: "ref_null", typeIdx: taViewTypeIdx };
}

/**
 * Recover `buf.data` (the shared i8 backing array) and the absolute byte offset
 * `byteOffset + index*width` for a `$__ta_view` receiver into the given locals.
 * The receiver ref (ref/ref_null `$__ta_view`) must already be on the stack; it
 * is consumed. `indexExpr` is compiled via `compileExpr`. Also sets `leLocal`
 * to 1 (little-endian, TypedArray native endianness).
 */
function emitTaViewAddress(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  bytes: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
): { idxLocal: number; lenLocal: number } {
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  // Stash the receiver.
  const tvLocal = allocLocal(fctx, `__tav_recv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: taViewTypeIdx });
  fctx.body.push({ op: "local.set", index: tvLocal });
  // len = the view's CURRENT element count — for the bounds check. Reads field0
  // directly for a fixed view, or derives it live from `buf.length` for an
  // auto-length view over a resizable buffer (#3054 C), so a `rab.resize()` grow
  // widens the in-bounds range and a shrink narrows it.
  const lenLocal = allocLocal(fctx, `__tav_len_${fctx.locals.length}`, { kind: "i32" });
  pushTaViewEffectiveLen(ctx, fctx, tvLocal, taViewTypeIdx);
  fctx.body.push({ op: "local.set", index: lenLocal });
  // arr = tv.buf.data  (buf is field1 → ref_null $__vec_i32_byte; .data is its field1)
  fctx.body.push({ op: "local.get", index: tvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  // idx = ToInt32(indexExpr) — kept for the bounds check.
  const idxLocal = allocLocal(fctx, `__tav_idx_${fctx.locals.length}`, { kind: "i32" });
  const it = compileExpr(indexExpr, { kind: "i32" });
  if (it && it.kind !== "i32") coerceType(ctx, fctx, it, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: idxLocal });
  // off = tv.byteOffset + idx*bytes
  fctx.body.push({ op: "local.get", index: tvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.get", index: idxLocal });
  if (bytes !== 1) {
    fctx.body.push({ op: "i32.const", value: bytes });
    fctx.body.push({ op: "i32.mul" });
  }
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });
  // little-endian
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });
  void arrTypeIdx;
  return { idxLocal, lenLocal };
}

/**
 * `ta[i]` read for a `$__ta_view` receiver (already on the stack). Byte-decodes
 * the element little-endian and leaves an f64 on the stack. An out-of-bounds
 * index yields `NaN` (the f64 image of the spec's `undefined` — §10.4.5.15
 * IntegerIndexedElementGet returns undefined for OOB) rather than trapping,
 * matching the native bounds-checked vec read. Returns the result ValType, or
 * null if `taViewTypeIdx` is not a registered view.
 */
export function emitTaViewElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { arrTypeIdx } = i32ByteVec(ctx);
  const arrLocal = allocLocal(fctx, `__tav_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__tav_off_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__tav_le_${fctx.locals.length}`, { kind: "i32" });
  const { idxLocal, lenLocal } = emitTaViewAddress(
    ctx,
    fctx,
    taViewTypeIdx,
    desc.bytes,
    indexExpr,
    compileExpr,
    arrLocal,
    offLocal,
    leLocal,
  );
  // if ((unsigned)idx < len) { decode } else { NaN }
  const readInstrs: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = readInstrs;
  emitReadBytes(
    ctx,
    fctx,
    { kind: "get", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    leLocal,
    arrTypeIdx,
  );
  fctx.body = savedBody;
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: readInstrs,
    else: [{ op: "f64.const", value: NaN }],
  });
  return { kind: "f64" };
}

/**
 * `ta[i] = v` write for a `$__ta_view` receiver (already on the stack).
 * Byte-encodes `v` little-endian into the shared buffer backing (true aliasing).
 * Leaves the (coerced) value on the stack as the assignment-expression result.
 */
export function emitTaViewElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  indexExpr: import("../ts-api.js").ts.Expression,
  valueExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { arrTypeIdx } = i32ByteVec(ctx);
  const arrLocal = allocLocal(fctx, `__tav_sarr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__tav_soff_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__tav_sle_${fctx.locals.length}`, { kind: "i32" });
  const { idxLocal, lenLocal } = emitTaViewAddress(
    ctx,
    fctx,
    taViewTypeIdx,
    desc.bytes,
    indexExpr,
    compileExpr,
    arrLocal,
    offLocal,
    leLocal,
  );
  // value → f64 (evaluated for its side effects regardless of bounds)
  const valLocal = allocLocal(fctx, `__tav_sval_${fctx.locals.length}`, { kind: "f64" });
  const vt = compileExpr(valueExpr, { kind: "f64" });
  if (vt && vt.kind !== "f64") coerceType(ctx, fctx, vt, { kind: "f64" });
  if (desc.clamp) {
    // Uint8Clamped: ToUint8Clamp §7.1.11 — round-half-to-even then clamp [0,255].
    // f64.nearest rounds ties-to-even; f64.max/min clamp; NaN propagates through
    // max/min and `emitWriteBytes` (trunc_sat_f64_s(NaN)=0) → NaN maps to 0.
    fctx.body.push({ op: "f64.nearest" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.max" });
    fctx.body.push({ op: "f64.const", value: 255 });
    fctx.body.push({ op: "f64.min" });
  }
  fctx.body.push({ op: "local.set", index: valLocal });
  // OOB write is a silent no-op (§10.4.5.16 IntegerIndexedElementSet): guard the
  // store on `(unsigned)idx < len` so an out-of-range write doesn't trap.
  const writeInstrs: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = writeInstrs;
  emitWriteBytes(
    ctx,
    fctx,
    { kind: "set", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    valLocal,
    leLocal,
    arrTypeIdx,
  );
  fctx.body = savedBody;
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: writeInstrs });
  // Assignment is an expression — re-push the coerced value as the result.
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "f64" };
}

// ---------------------------------------------------------------------------
// (#3057) Runtime-kind byte codec for a boxed `$__ta_dyn_view` element get/set.
//
// A `new <ctorVar>(rab)` where `ctorVar` is a TypedArray constructor held in a
// variable produces a `$__ta_dyn_view {length, buf, byteOffset, kind}` whose
// element kind is a RUNTIME field (B1's per-kind `$__ta_view_<K>` canonicalize to
// one WasmGC type, so the boxed view can't recover its kind via `ref.test`). When
// such a view is read back through an `any` receiver — `ta[i]` / `ta[i]=v` — the
// generic dynamic INDEX path has no arm that switches on that runtime `kind` byte,
// so #3054 D+E BANKED element access (reads returned 0, writes silently no-op via
// `__extern_get_idx`/`__extern_set` on the opaque struct). These two functions add
// a `ref.test $__ta_dyn_view`-gated arm that byte-decodes/encodes at
// `byteOffset + i*elemSize(kind)` through the SAME little-endian engine
// (`emitReadBytes`/`emitWriteBytes`) the static `$__ta_view` path and the
// proto-method write-through already use — switching on `kind` for width /
// signedness / float-vs-int (+ the Uint8Clamped clamp on set).
//
// HAZARD (opus-3054-de): the generic dynamic index path is SHARED with boxed
// plain-array `any` receivers (`values[i]` where `values` is statically `any`).
// The new arm MUST NOT hijack those — it gates on the concrete
// `ref.test $__ta_dyn_view` FIRST and, on a miss, falls through to the EXACT
// existing behavior (`__extern_get_idx` for read, `__extern_set` for write). The
// whole arm is only emitted when `ctx.taDynViewTypeIdx >= 0` (a dynamic TA-ctor
// view exists in the module), so a program without one is byte-identical.
// ---------------------------------------------------------------------------

/**
 * (#3057) Build the runtime-kind element DECODE dispatch: a nested `if`-chain over
 * the 9 `TA_CTOR_KINDS`, each arm byte-decoding `acc.bytes` bytes from `arrLocal`
 * at `offLocal` (little-endian) via {@link emitReadBytes} with the STATIC per-kind
 * descriptor. Leaves an f64 on the stack; an unrecognised kind yields `0`. Returns
 * the self-contained instruction list (the caller splices it into a bounds-guarded
 * arm).
 */
export function emitDynDecodeDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kindLocal: number,
  arrLocal: number,
  offLocal: number,
  leLocal: number,
  arrTypeIdx: number,
): Instr[] {
  // Build bottom-up so each `chain` is referenced exactly once (as the `else` of
  // the next-outer `if`) — no aliased-Instr[] double-remap hazard.
  let chain: Instr[] = [{ op: "f64.const", value: 0 }];
  for (let k = TA_CTOR_KINDS.length - 1; k >= 0; k--) {
    const desc = TA_VIEW_DECODE[TA_CTOR_KINDS[k]!]!;
    const decodeK: Instr[] = [];
    const saved = fctx.body;
    fctx.body = decodeK;
    emitReadBytes(
      ctx,
      fctx,
      { kind: "get", bytes: desc.bytes, signed: desc.signed, float: desc.float, int64: desc.int64 },
      arrLocal,
      offLocal,
      leLocal,
      arrTypeIdx,
    );
    if (desc.int64) {
      // (#3613) `emitReadBytes` deliberately LEAVES the i64 on the stack for an
      // `int64` accessor (the DataView getBigInt64 result is the i64-branded
      // BigInt carrier). This dispatch's `if` arms are all typed `f64`, so the
      // BigInt arms must converge to the same carrier — convert rather than
      // reinterpret. Exact for |v| < 2^53, the range the conformance corpus's
      // small BigInt literals occupy; the true i64 element representation is
      // #1349/#2401(b).
      fctx.body.push({ op: desc.signed ? "f64.convert_i64_s" : "f64.convert_i64_u" });
    }
    fctx.body = saved;
    chain = [
      { op: "local.get", index: kindLocal },
      { op: "i32.const", value: k },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "val", type: { kind: "f64" } }, then: decodeK, else: chain },
    ];
  }
  return chain;
}

/**
 * (#3057) Build the runtime-kind element ENCODE dispatch: a nested `if`-chain over
 * the 9 `TA_CTOR_KINDS`, each arm byte-encoding the f64 in `valF64Local` into
 * `arrLocal` at `offLocal` (little-endian) via {@link emitWriteBytes} with the
 * STATIC per-kind descriptor. The Uint8Clamped arm applies ToUint8Clamp
 * (round-half-to-even + clamp `[0,255]`) into a temp before the write. An
 * unrecognised kind is a no-op. Returns the self-contained instruction list.
 */
export function emitDynEncodeDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kindLocal: number,
  arrLocal: number,
  offLocal: number,
  valF64Local: number,
  leLocal: number,
  arrTypeIdx: number,
): Instr[] {
  let chain: Instr[] = [];
  for (let k = TA_CTOR_KINDS.length - 1; k >= 0; k--) {
    const desc = TA_VIEW_DECODE[TA_CTOR_KINDS[k]!]!;
    const encodeK: Instr[] = [];
    const saved = fctx.body;
    fctx.body = encodeK;
    let valForWrite = valF64Local;
    if (desc.clamp) {
      // Uint8Clamped ToUint8Clamp (§7.1.11): f64.nearest is round-ties-to-even,
      // then clamp to [0,255]; NaN propagates through max/min and the i64 trunc in
      // emitWriteBytes maps it to 0 (spec: NaN → 0).
      const clampedLocal = allocLocal(fctx, `__dtas_clv_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.get", index: valF64Local });
      fctx.body.push({ op: "f64.nearest" });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.max" });
      fctx.body.push({ op: "f64.const", value: 255 });
      fctx.body.push({ op: "f64.min" });
      fctx.body.push({ op: "local.set", index: clampedLocal });
      valForWrite = clampedLocal;
    }
    emitWriteBytes(
      ctx,
      fctx,
      { kind: "set", bytes: desc.bytes, signed: desc.signed, float: desc.float, int64: desc.int64 },
      arrLocal,
      offLocal,
      valForWrite,
      leLocal,
      arrTypeIdx,
    );
    fctx.body = saved;
    chain = [
      { op: "local.get", index: kindLocal },
      { op: "i32.const", value: k },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: encodeK, else: chain },
    ];
  }
  return chain;
}

/**
 * (#3057) `ta[i]` read where `ta` is a boxed `$__ta_dyn_view` reached through an
 * `any`/externref receiver. The receiver boxed externref is already on the stack.
 * Compiles the index ONCE (single evaluation), then a `ref.test $__ta_dyn_view`
 * gate byte-decodes on the runtime `kind` (in-bounds → boxed number, OOB →
 * `undefined`), falling through to the existing `__extern_get_idx` for any
 * non-dyn-view receiver (plain arrays / `$ObjVec` / `$Object`). Returns externref
 * (the caller coerces to f64 in numeric context), or null when no `$__ta_dyn_view`
 * type exists (byte-inert — caller keeps its existing path with the receiver still
 * on the stack).
 */
export function emitTaDynViewElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  indexExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  // Register the runtime-kinded view type on demand: this may compile in a helper
  // BEFORE the construct that would otherwise register it (the caller gates on the
  // module-level `moduleUsesDynTaView` pre-scan flag, so the type WILL exist).
  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);

  // Receiver boxed externref is on the stack — stash it (needed by both arms).
  const recvLocal = allocLocal(fctx, `__dtag_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Index compiled ONCE → f64 (single evaluation; used by the byte path AND the
  // __extern_get_idx fallback).
  const idxF64 = allocLocal(fctx, `__dtag_idx_${fctx.locals.length}`, { kind: "f64" });
  const it = compileExpr(indexExpr, { kind: "f64" });
  if (it && it.kind !== "f64") coerceType(ctx, fctx, it, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxF64 });

  // Resolve the fallback / boxing imports up front, then flush the funcIdx shift
  // once (before any body-swap building) so every captured funcIdx stays live.
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const boxNumFn = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  const resultLocal = allocLocal(fctx, `__dtag_res_${fctx.locals.length}`, { kind: "externref" });
  if (getIdxFn === undefined || boxNumFn === undefined) {
    // Defensive: the imports are always registerable in the noJsHost lane (the only
    // lane where a `$__ta_dyn_view` exists), so this is unreachable — but keep the
    // stack balanced if it ever fires.
    fctx.body.push({ op: "local.get", index: recvLocal });
    return { kind: "externref" };
  }

  const anyLocal = allocLocal(fctx, `__dtag_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // THEN arm — receiver IS a $__ta_dyn_view: byte-decode on the runtime kind.
  const dvLocal = allocLocal(fctx, `__dtag_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, `__dtag_k_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__dtag_es_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__dtag_len_${fctx.locals.length}`, { kind: "i32" });
  const idxI32 = allocLocal(fctx, `__dtag_i_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__dtag_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__dtag_off_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__dtag_le_${fctx.locals.length}`, { kind: "i32" });

  const thenArm: Instr[] = [];
  const saved = fctx.body;
  fctx.body = thenArm;
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.tee", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 }); // kind
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  pushTaDynViewInBoundsLen(ctx, fctx, dvLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
  // idx (i32) = trunc(idxF64) — a negative / huge index fails the unsigned bounds
  // check below → OOB → undefined (spec IsValidIntegerIndex).
  fctx.body.push({ op: "local.get", index: idxF64 });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxI32 });
  // arr = dv.buf.data (buf = field1 → $__vec_i32_byte; .data = its field1).
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  // off = dv.byteOffset + idx*elemSize(kind).
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 }); // byteOffset
  fctx.body.push({ op: "local.get", index: idxI32 });
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });
  fctx.body.push({ op: "i32.const", value: 1 }); // little-endian
  fctx.body.push({ op: "local.set", index: leLocal });
  const decodeInstrs = emitDynDecodeDispatch(ctx, fctx, kindLocal, arrLocal, offLocal, leLocal, arrTypeIdx);
  const inBounds: Instr[] = [
    ...decodeInstrs,
    { op: "call", funcIdx: boxNumFn },
    { op: "local.set", index: resultLocal },
  ];
  // if ((unsigned)idx < len) { box(decode) } else { undefined }
  // (#3177) OOB = the `undefined` SINGLETON, not ref.null.extern — a null read
  // makes `ta[oob] === undefined` false (it compares as null; probe code 2).
  fctx.body.push({ op: "local.get", index: idxI32 });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: inBounds,
    else: [
      ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr]),
      { op: "local.set", index: resultLocal },
    ],
  });
  fctx.body = saved;

  // ELSE arm — any other boxed receiver keeps the EXACT existing behavior.
  const elseArm: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: idxF64 },
    { op: "call", funcIdx: getIdxFn },
    { op: "local.set", index: resultLocal },
  ];

  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: elseArm });
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "externref" };
}

/**
 * (#3057) `ta[i] = v` write where `ta` is a boxed `$__ta_dyn_view` reached through
 * an `any`/externref receiver. The receiver boxed externref is already on the
 * stack. Compiles the index and value ONCE each, then a `ref.test $__ta_dyn_view`
 * gate byte-encodes `v` little-endian on the runtime `kind` into the SHARED buffer
 * (true aliasing — sibling views / DataViews observe it); an OOB write is a silent
 * no-op (§10.4.5.16). Any non-dyn-view receiver falls through to the existing
 * `__extern_set`. Leaves the assigned value (externref) as the expression result.
 * Returns null when no `$__ta_dyn_view` type exists (byte-inert).
 */
export function emitTaDynViewElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  indexExpr: import("../ts-api.js").ts.Expression,
  valueExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  // Register the runtime-kinded view type on demand (see emitTaDynViewElementGet).
  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);

  // Receiver boxed externref on the stack → recvLocal.
  const recvLocal = allocLocal(fctx, `__dtas_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Index ONCE → f64.
  const idxF64 = allocLocal(fctx, `__dtas_idx_${fctx.locals.length}`, { kind: "f64" });
  const it = compileExpr(indexExpr, { kind: "f64" });
  if (it && it.kind !== "f64") coerceType(ctx, fctx, it, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxF64 });

  // Value ONCE → externref (natural rep for the __extern_set fallback so a
  // non-number plain-array value survives intact; unboxed to f64 for the byte
  // path — the dyn-view arm only runs for a TA element write, where v is a number).
  const valExt = allocLocal(fctx, `__dtas_valx_${fctx.locals.length}`, { kind: "externref" });
  const vt = compileExpr(valueExpr, { kind: "externref" });
  if (vt && vt.kind !== "externref") coerceType(ctx, fctx, vt, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valExt });

  // Unbox the value to f64 up front (used only by the dyn-view THEN arm). Doing it
  // here — not inside the body-swapped arm — keeps coerceType's late imports on the
  // main body so no funcIdx shift lands mid-arm.
  const valF64 = allocLocal(fctx, `__dtas_valf_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.get", index: valExt });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: valF64 });

  const setFn = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  const boxNumFn = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (setFn === undefined || boxNumFn === undefined) {
    // Defensive (unreachable in the noJsHost lane): keep the value as the result.
    fctx.body.push({ op: "local.get", index: valExt });
    return { kind: "externref" };
  }

  const anyLocal = allocLocal(fctx, `__dtas_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // THEN arm — byte-encode into the shared backing on the runtime kind.
  const dvLocal = allocLocal(fctx, `__dtas_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, `__dtas_k_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__dtas_es_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__dtas_len_${fctx.locals.length}`, { kind: "i32" });
  const idxI32 = allocLocal(fctx, `__dtas_i_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__dtas_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const offLocal = allocLocal(fctx, `__dtas_off_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__dtas_le_${fctx.locals.length}`, { kind: "i32" });

  const thenArm: Instr[] = [];
  const saved = fctx.body;
  fctx.body = thenArm;
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.tee", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 }); // kind
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  pushTaDynViewInBoundsLen(ctx, fctx, dvLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
  fctx.body.push({ op: "local.get", index: idxF64 });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxI32 });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 }); // byteOffset
  fctx.body.push({ op: "local.get", index: idxI32 });
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });
  const encodeInstrs = emitDynEncodeDispatch(ctx, fctx, kindLocal, arrLocal, offLocal, valF64, leLocal, arrTypeIdx);
  // OOB write is a silent no-op — guard the encode on `(unsigned)idx < len`.
  fctx.body.push({ op: "local.get", index: idxI32 });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_u" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: encodeInstrs, else: [] });
  fctx.body = saved;

  // ELSE arm — any other boxed receiver keeps the EXACT existing behavior:
  // __extern_set(recv, box(idx), val).
  const elseArm: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: idxF64 },
    { op: "call", funcIdx: boxNumFn },
    { op: "local.get", index: valExt },
    { op: "call", funcIdx: setFn },
  ];

  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: elseArm });
  // Assignment is an expression — the value is its result.
  fctx.body.push({ op: "local.get", index: valExt });
  return { kind: "externref" };
}

/**
 * (#3057) Push the SPEC-CORRECT in-bounds element length of a `$__ta_dyn_view`
 * (`dvLocal`), given its runtime `elemSize` (`esLocal`), as an i32 — for the
 * element-access bounds check (IsValidIntegerIndex, §10.4.5.13). Unlike
 * `pushTaDynViewEffectiveLen` (which powers `.byteLength` and returns the STORED
 * length verbatim for a fixed view), this also enforces the resizable-buffer
 * out-of-bounds rule: when the backing buffer has SHRUNK below the view's window
 * (`byteOffset + storedLen*elemSize > buf.length`), a NON-length-tracking view is
 * fully out-of-bounds and every index reads `undefined` / writes no-op, so the
 * effective length is `0` (all-or-nothing per §10.4.5.11 IsTypedArrayOutOfBounds).
 * A length-tracking view (stored sentinel `-1`) tracks the live buffer:
 * `max(0, buf.length - byteOffset) / elemSize`. Reading this at each access is
 * what makes `array[i]` reflect a later `rab.resize()` (shrink → OOB, regrow →
 * back in-bounds), which the stored-length reader silently got wrong (returned a
 * stale in-bounds value after a shrink — the #3057 regression on
 * out-of-bounds-get-and-set.js).
 */
export function pushTaDynViewInBoundsLen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dvLocal: number,
  esLocal: number,
): void {
  const dynIdx = ctx.taDynViewTypeIdx;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const storedLocal = allocLocal(fctx, `__tdvib_s_${fctx.locals.length}`, { kind: "i32" });
  const availLocal = allocLocal(fctx, `__tdvib_av_${fctx.locals.length}`, { kind: "i32" });
  // availElems = max(0, buf.length - byteOffset) / elemSize.
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 }); // buf
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // buf.length (bytes)
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 }); // byteOffset
  fctx.body.push({ op: "i32.sub" }); // availBytes (may be < 0 after a deep shrink)
  // clamp availBytes to >= 0. `select` yields `cond ? val1 : val2` (val1 pushed
  // FIRST / deeper), so with val1=0, val2=availBytes, cond=(availBytes<0):
  // (availBytes<0) ? 0 : availBytes.
  const availBytesLocal = allocLocal(fctx, `__tdvib_ab_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: availBytesLocal });
  fctx.body.push({ op: "i32.const", value: 0 }); // val1 (deep) = 0
  fctx.body.push({ op: "local.get", index: availBytesLocal }); // val2 = availBytes
  fctx.body.push({ op: "local.get", index: availBytesLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" }); // cond = availBytes < 0
  fctx.body.push({ op: "select" }); // (availBytes < 0) ? 0 : availBytes
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.div_u" });
  fctx.body.push({ op: "local.set", index: availLocal });
  // storedLen = field0.
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: storedLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" }); // storedLen < 0 → length-tracking
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    // length-tracking: availElems.
    then: [{ op: "local.get", index: availLocal }],
    // fixed length: storedLen if the window still fits, else 0 (view is OOB). val1=0
    // (deep), val2=storedLen, cond=(storedLen>avail) → (storedLen>avail) ? 0 : storedLen.
    else: [
      { op: "i32.const", value: 0 }, // val1 (deep) = 0
      { op: "local.get", index: storedLocal }, // val2 = storedLen
      { op: "local.get", index: storedLocal },
      { op: "local.get", index: availLocal },
      { op: "i32.gt_u" }, // cond = storedLen > availElems (window overflows buffer)
      { op: "select" }, // (storedLen > avail) ? 0 : storedLen
    ],
  });
}

// ---------------------------------------------------------------------------
// (#3054 B2) View accessor props + windowing constructor on a `$__ta_view`.
//
// B1 populated a `$__ta_view {length, buf, byteOffset}` with byteOffset pinned
// 0. B2 (a) reads the accessor props off that struct (`.byteLength`,
// `.byteOffset`, `.buffer` identity, `BYTES_PER_ELEMENT`; `.length` stays on the
// B1 arm) and (b) the `(buffer, byteOffset, length)` windowing ctor that
// POPULATES byteOffset (byte offset) + a windowed element `length`. The byte
// engine is offset-agnostic (it reads `buf.data` at `byteOffset + i*width` and
// bounds-checks `i < length` — both fields the view already carries), so a
// windowed view reads/writes the correct absolute buffer bytes with ZERO byte-
// engine change. An offset-0 window is byte-identical to B1 (offsetLocal = 0).
// ---------------------------------------------------------------------------

/**
 * Emit an `if (cond) throw RangeError(msg)` — the i32 condition is on the stack.
 *
 * (#3177 slice 2) Throws a real RangeError INSTANCE (was: a bare string
 * payload). The #3104/#3285 assert_throws harness threads the expected error
 * TYPE (`e instanceof RangeError` + `.name` fallback) — a bare string matches
 * neither, so every ToIndex/bounds RangeError this file emits would read as
 * "threw the wrong thing" once that lands. `buildThrowJsErrorInstrs`
 * self-flushes late-import shifts against `fctx` (host lane) and mints the
 * in-module `__new_RangeError` DEFINED constructor on the standalone lane
 * (append-only — no funcIdx shift), so it is safe inside detached arm builds
 * as long as the returned instrs are attached before any further compile
 * (they are: the very next statement pushes the `if`).
 */
function emitThrowRangeErrorIf(ctx: CodegenContext, fctx: FunctionContext, msg: string): void {
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", msg, { flush: fctx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwInstrs,
    else: [],
  });
}

/**
 * ToIndex (§7.1.22) into `outLocal` (i32): compile `expr` → f64, NaN → 0,
 * truncate toward 0, RangeError if < 0 or > 2^53-1, then narrow to i32. Used by
 * the windowing ctor for both byteOffset and (element) length args.
 *
 * (#3177 slice 2) Two additions:
 *  - `outF64Local` (optional) also receives the TRUNCATED PRE-NARROWING f64 —
 *    the bounds math (`offset + length×elemSize > bufferByteLength`) must run
 *    in f64 because a spec-legal length (≤ 2^53−1) overflows i32.
 *  - a statically-`symbol` operand throws TypeError per §7.1.4 ToNumber(Symbol)
 *    (the DataView setter pattern) — `new TA(buffer, Symbol())` must be a
 *    TypeError, not a silent NaN→0 (byteoffset-is-symbol-throws.js).
 */
function emitToIndexI32(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
  outLocal: number,
  rangeErrMsg: string,
  outF64Local?: number,
): void {
  if (ctx.oracle.staticJsTypeOf(expr) === "symbol") {
    // Evaluate the operand for side effects, drop, throw (unary.ts pattern).
    const t = compileExpr(expr);
    if (t !== null) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
    // Unreachable-but-validated: keep the locals defined for downstream reads.
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: outLocal });
    if (outF64Local !== undefined) {
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "local.set", index: outF64Local });
    }
    return;
  }
  const f64Local = allocLocal(fctx, `__tav_ti_${fctx.locals.length}`, { kind: "f64" });
  const vt = compileExpr(expr, { kind: "f64" });
  if (vt && vt.kind !== "f64") coerceType(ctx, fctx, vt, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: f64Local });
  // NaN → 0 (v != v is true only for NaN).
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: f64Local },
    ],
    else: [],
  });
  // Truncate toward zero (ToIntegerOrInfinity for finite non-NaN).
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: f64Local });
  // RangeError if < 0 or > 2^53-1.
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  emitThrowRangeErrorIf(ctx, fctx, rangeErrMsg);
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: outLocal });
  if (outF64Local !== undefined) {
    fctx.body.push({ op: "local.get", index: f64Local });
    fctx.body.push({ op: "local.set", index: outF64Local });
  }
}

/**
 * (#3054 B2) `new <TA>(buffer, byteOffset[, length])` → a windowed shared-backing
 * `$__ta_view` that refs the buffer's vec (like `emitTaViewConstruct`) but with a
 * non-zero `byteOffset` field and a windowed element `length`. Validates per
 * §23.2.5.1 InitializeTypedArrayFromArrayBuffer: byteOffset is ToIndex'd and must
 * be a multiple of the element size; with an explicit length, byteOffset +
 * length*elemSize must fit the buffer; with the length omitted, the remaining
 * byte span must be a multiple of the element size. `lengthExpr` undefined ⇒
 * auto-length (2-arg form). Returns the view ValType, or null (stack balanced) if
 * the buffer can't be recovered as a native vec.
 */
export function emitTaViewConstructWindowed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: import("../ts-api.js").ts.Expression,
  offsetExpr: import("../ts-api.js").ts.Expression,
  lengthExpr: import("../ts-api.js").ts.Expression | undefined,
  viewName: string,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = TA_VIEW_DECODE[viewName];
  if (!desc) return null;
  const elemSize = desc.bytes;
  const taViewTypeIdx = getOrRegisterTaViewType(ctx, viewName);
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Recover the shared buffer vec struct (mirror emitTaViewConstruct exactly).
  const bufType = compileExpr(bufExpr);
  if (!bufType) return null;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && (bufType as { typeIdx: number }).typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
    }
  } else {
    fctx.body.push({ op: "drop" });
    return null;
  }
  const bufLocal = allocLocal(fctx, `__tavw_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocal });

  // bufByteLen = buf.length (field0 = byte count for an ArrayBuffer vec).
  const bufByteLenLocal = allocLocal(fctx, `__tavw_blen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: bufLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: bufByteLenLocal });

  // byteOffset = ToIndex(offsetExpr).
  const offsetLocal = allocLocal(fctx, `__tavw_off_${fctx.locals.length}`, { kind: "i32" });
  emitToIndexI32(ctx, fctx, offsetExpr, compileExpr, offsetLocal, "RangeError: Invalid typed array offset");

  // byteOffset must be a multiple of the element size (§23.2.5.1 step 11).
  if (elemSize !== 1) {
    fctx.body.push({ op: "local.get", index: offsetLocal });
    fctx.body.push({ op: "i32.const", value: elemSize });
    fctx.body.push({ op: "i32.rem_u" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.ne" });
    emitThrowRangeErrorIf(ctx, fctx, `RangeError: start offset of ${viewName} should be a multiple of ${elemSize}`);
  }

  const lenLocal = allocLocal(fctx, `__tavw_len_${fctx.locals.length}`, { kind: "i32" });
  if (lengthExpr) {
    // Explicit element length. byteOffset + length*elemSize must fit the buffer.
    emitToIndexI32(ctx, fctx, lengthExpr, compileExpr, lenLocal, "RangeError: Invalid typed array length");
    fctx.body.push({ op: "local.get", index: offsetLocal });
    fctx.body.push({ op: "local.get", index: lenLocal });
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize });
      fctx.body.push({ op: "i32.mul" });
    }
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: bufByteLenLocal });
    fctx.body.push({ op: "i32.gt_s" });
    emitThrowRangeErrorIf(ctx, fctx, "RangeError: Invalid typed array length");
  } else {
    // Auto length. byteOffset must not exceed the buffer, and the remaining byte
    // span must be a whole number of elements. length = (bufByteLen - offset)/elemSize.
    fctx.body.push({ op: "local.get", index: offsetLocal });
    fctx.body.push({ op: "local.get", index: bufByteLenLocal });
    fctx.body.push({ op: "i32.gt_s" });
    emitThrowRangeErrorIf(ctx, fctx, "RangeError: Start offset is outside the bounds of the buffer");
    const remLocal = allocLocal(fctx, `__tavw_rem_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: bufByteLenLocal });
    fctx.body.push({ op: "local.get", index: offsetLocal });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: remLocal });
    if (elemSize !== 1) {
      fctx.body.push({ op: "local.get", index: remLocal });
      fctx.body.push({ op: "i32.const", value: elemSize });
      fctx.body.push({ op: "i32.rem_u" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.ne" });
      emitThrowRangeErrorIf(ctx, fctx, `RangeError: byte length of ${viewName} should be a multiple of ${elemSize}`);
    }
    fctx.body.push({ op: "local.get", index: remLocal });
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize });
      fctx.body.push({ op: "i32.div_u" });
    }
    fctx.body.push({ op: "local.set", index: lenLocal });
  }

  // struct.new $__ta_view {length (elements), buf (shared vec), byteOffset (bytes)}.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: bufLocal });
  fctx.body.push({ op: "local.get", index: offsetLocal });
  fctx.body.push({ op: "struct.new", typeIdx: taViewTypeIdx });
  return { kind: "ref_null", typeIdx: taViewTypeIdx };
}

/**
 * (#3054 D) Emit a first-class TypedArray CONSTRUCTOR value for a bare TA name in
 * value position (`const c = Uint8Array`, `[Uint8Array, …]`, a `new ctor(rab)`
 * callee). Produces a `$__ta_ctor {kind}` struct boxed to externref — a distinct,
 * non-null value whose runtime `kind` (index into `TA_CTOR_KINDS`) drives the
 * dynamic `new ctor(…)` construct + `ctor.BYTES_PER_ELEMENT`. Before this the name
 * degraded to `ref.null.extern` (all TA ctors indistinguishable). Returns the
 * externref ValType, or null when `name` is not one of the 9 supported TA kinds.
 * Standalone/WASI lane only (the caller gates on `noJsHost`).
 */
export function emitTaCtorValue(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | null {
  const kind = taCtorKindOf(name);
  if (kind < 0) return null;
  // (#3177) Per-kind SINGLETON: every mention of the same ctor name must
  // produce the SAME struct ref, or `Uint8Array === Uint8Array` (and
  // `sample.constructor === TA`) fails ref.eq identity. `struct.new` per
  // site (the pre-#3177 behavior) minted a fresh struct each time; the
  // `taCtorSingletonGlobals` map (#3054 D) existed for exactly this but was
  // never consumed. Immutable global, `struct.new` constant initializer —
  // the `$Hole` singleton pattern (array-holes.ts).
  const globalIdx = getOrRegisterTaCtorSingleton(ctx, kind);
  fctx.body.push({ op: "global.get", index: globalIdx });
  // Box the struct ref to externref (ref → externref, per coerceType).
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

/**
 * (#3177) Get-or-register the per-kind `$__ta_ctor` singleton module-global:
 * `(global $__ta_ctor_<kind> (ref $__ta_ctor) (i32.const <kind>) (struct.new
 * $__ta_ctor))`. Returns the ABSOLUTE global index (imports included). Also
 * used by the finalize-time dyn-view `.constructor` MOP arm (kind →
 * singleton switch), so ctor identity holds across the instance→constructor
 * read and the bare-identifier mention.
 */
export function getOrRegisterTaCtorSingleton(ctx: CodegenContext, kind: number): number {
  const existing = ctx.taCtorSingletonGlobals.get(kind);
  if (existing !== undefined) return existing;
  const taCtorTypeIdx = getOrRegisterTaCtorType(ctx);
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__ta_ctor_singleton_${kind}`,
    type: { kind: "ref", typeIdx: taCtorTypeIdx },
    mutable: false,
    init: [
      { op: "i32.const", value: kind },
      { op: "struct.new", typeIdx: taCtorTypeIdx },
    ],
  });
  ctx.taCtorSingletonGlobals.set(kind, globalIdx);
  return globalIdx;
}

/**
 * (#3054 D) Read `ctor.BYTES_PER_ELEMENT` where `ctor` is a first-class
 * `$__ta_ctor` value (dynamic — the ctor kind is only known at runtime). Compiles
 * the receiver, `ref.test $__ta_ctor`, and on a match maps the runtime `kind` to
 * its byte width via a `select` chain over `TA_CTOR_BYTES`; a non-ctor receiver
 * yields `NaN`/`0` (declines gracefully). Returns the numeric ValType, or null if
 * no `$__ta_ctor` type is registered in the module (byte-inert). `compileRecv`
 * puts the receiver value on the stack as externref.
 */
export function emitTaCtorBytesPerElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  compileRecv: () => ValType | null,
): ValType | null {
  // Register the ctor type on demand: a dynamic `.BYTES_PER_ELEMENT` read may
  // compile BEFORE the value-position TA name that would otherwise register it
  // (e.g. `CreateRabForTest`'s body compiles before the top-level `ctors` array).
  const taCtorTypeIdx = getOrRegisterTaCtorType(ctx);
  const rt = compileRecv();
  if (rt === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (rt.kind !== "externref") {
    coerceType(ctx, fctx, rt, { kind: "externref" });
  }
  const anyLocal = allocLocal(fctx, `__tac_recv_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocal });
  // kind = ref.test $__ta_ctor ? ctor.kind : (ref.test $__ta_dyn_view ? view.kind : -1)
  // — handles BOTH `ctor.BYTES_PER_ELEMENT` (a first-class ctor value) and
  // `view.BYTES_PER_ELEMENT` (a dynamically-constructed view instance, §23.2.3.1).
  const kindLocal = allocLocal(fctx, `__tac_kind_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: taCtorTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: taCtorTypeIdx },
      { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: kindLocal },
    ],
    else: [],
  });
  if (ctx.taDynViewTypeIdx >= 0) {
    const dynIdx = ctx.taDynViewTypeIdx;
    fctx.body.push({ op: "local.get", index: anyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: dynIdx },
        { op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 }, // kind
        { op: "local.set", index: kindLocal },
      ],
      else: [],
    });
  }
  // Map kind → byte width via a select chain (default 0 for a non-ctor receiver).
  // `select` returns val1 (the deeper operand = running result) when cond≠0, so the
  // condition is `kind != k`: (kind != k) ? prevResult : bytes[k] ≡ (kind == k) ?
  // bytes[k] : prevResult.
  fctx.body.push({ op: "i32.const", value: 0 }); // running result = 0 (val1)
  for (let k = 0; k < TA_CTOR_KINDS.length; k++) {
    fctx.body.push({ op: "i32.const", value: TA_CTOR_BYTES[k]! }); // val2 = bytes[k]
    fctx.body.push({ op: "local.get", index: kindLocal });
    fctx.body.push({ op: "i32.const", value: k });
    fctx.body.push({ op: "i32.ne" }); // cond = (kind != k)
    fctx.body.push({ op: "select" });
  }
  if (ctx.fast) return { kind: "i32" };
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/**
 * (#3054 D) Push the element byte width for a runtime `kind` (i32 in `kindLocal`,
 * index into `TA_CTOR_KINDS`) via a `select` chain over `TA_CTOR_BYTES`. Leaves an
 * i32 on the stack; a kind out of range yields 1 (harmless default).
 */
export function pushElemSizeForKind(fctx: FunctionContext, kindLocal: number): void {
  fctx.body.push({ op: "i32.const", value: 1 }); // running result (val1) = 1
  for (let k = 0; k < TA_CTOR_BYTES.length; k++) {
    fctx.body.push({ op: "i32.const", value: TA_CTOR_BYTES[k]! }); // val2 = bytes[k]
    fctx.body.push({ op: "local.get", index: kindLocal });
    fctx.body.push({ op: "i32.const", value: k });
    fctx.body.push({ op: "i32.ne" }); // cond = (kind != k) → (kind==k) ? bytes[k] : prev
    fctx.body.push({ op: "select" });
  }
}

/**
 * (#3054 D) Read `.byteLength` (or `.BYTES_PER_ELEMENT`) off a boxed `$__ta_dyn_view`
 * at RUNTIME — a dynamically-constructed view read back through an `any`/union
 * receiver (e.g. length-tracking-N's `for (ta of tas) … ta.byteLength`), where the
 * compile-time-typeIdx accessor arm can't fire and the generic dynamic reader THROWS
 * on `.byteLength`. The view's element kind is stored in the struct's `kind` field
 * (B1's per-kind `$__ta_view_<K>` canonicalize together and can't be told apart by
 * `ref.test`, which is exactly why the dynamic path uses `$__ta_dyn_view`).
 * `byteLength = effectiveLen × elemSize(kind)`; a bare ArrayBuffer/DataView vec →
 * its byte length; anything else → 0 (never throws). `wantElemSize` returns
 * `elemSize(kind)` instead (for a dynamic `view.BYTES_PER_ELEMENT`). Returns the
 * numeric ValType, or null when no `$__ta_dyn_view` type exists (byte-inert).
 */
export function emitTaViewDynamicByteLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  compileRecv: () => ValType | null,
  wantElemSize = false,
): ValType | null {
  if (ctx.taDynViewTypeIdx < 0) return null;
  const dynIdx = ctx.taDynViewTypeIdx;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const rt = compileRecv();
  if (rt === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (rt.kind !== "externref") {
    coerceType(ctx, fctx, rt, { kind: "externref" });
  }
  const anyLocal = allocLocal(fctx, `__tvbl_recv_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocal });
  const resultLocal = allocLocal(fctx, `__tvbl_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // $__ta_dyn_view arm: read kind → elemSize; result = elemSize (BYTES_PER_ELEMENT)
  // or effectiveLen × elemSize (byteLength).
  const dvLocal = allocLocal(fctx, `__tvbl_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, `__tvbl_k_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__tvbl_es_${fctx.locals.length}`, { kind: "i32" });
  const arm: Instr[] = [];
  const saved = fctx.body;
  fctx.body = arm;
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.tee", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 }); // kind
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  if (wantElemSize) {
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "local.set", index: resultLocal });
  } else {
    pushTaDynViewEffectiveLen(ctx, fctx, dvLocal, kindLocal, esLocal);
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "local.set", index: resultLocal });
  }
  fctx.body = saved;
  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: arm, else: [] });

  // Fallback (byteLength only): a bare ArrayBuffer/DataView vec → its byte length.
  if (!wantElemSize) {
    fctx.body.push({ op: "local.get", index: anyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: resultLocal },
      ],
      else: [],
    });
  }

  fctx.body.push({ op: "local.get", index: resultLocal });
  if (ctx.fast) return { kind: "i32" };
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/**
 * (#3054 D) Push the CURRENT element length of a `$__ta_dyn_view` (`dvLocal`), given
 * its `kind` and `elemSize`. Field0 holds either a fixed element count (`>= 0`) or
 * the auto-length sentinel `-1` (a view built over a resizable buffer with no
 * explicit length); for the sentinel the live length is `buf.length / elemSize`
 * (length-tracking on resize, mirroring `pushTaViewEffectiveLen`).
 */
function pushTaDynViewEffectiveLen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dvLocal: number,
  _kindLocal: number,
  esLocal: number,
): void {
  const dynIdx = ctx.taDynViewTypeIdx;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const storedLocal = allocLocal(fctx, `__tdvl_s_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: storedLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: storedLocal }],
    else: [
      { op: "local.get", index: dvLocal },
      { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 }, // buf
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }, // buf.length (bytes)
      { op: "local.get", index: esLocal },
      { op: "i32.div_u" },
    ],
  });
}

/**
 * (#3177 slice 2) §23.2.5.1 InitializeTypedArrayFromArrayBuffer step 3:
 * `if (offset modulo elementSize ≠ 0) throw RangeError`. Runtime `es` (the
 * dynamic-ctor paths only know the kind at runtime). Emitted AFTER
 * ToIndex(byteOffset) and BEFORE ToIndex(length), exactly the spec order.
 */
function emitTaOffsetAlignmentCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  offLocal: number,
  esLocal: number,
): void {
  fctx.body.push({ op: "local.get", index: offLocal });
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.rem_u" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });
  emitThrowRangeErrorIf(ctx, fctx, "RangeError: Start offset should be a multiple of the element size");
}

/**
 * (#3177 slice 2) §23.2.5.1 InitializeTypedArrayFromArrayBuffer steps 6–14 —
 * the POST-COERCION half of the buffer-arg constructor protocol, shared by
 * both dynamic construct paths ({@link emitDynamicTaViewConstruct} and the
 * ArrayBuffer arm of {@link emitTaDynCtorConstructFromLocals}):
 *
 *   6.  IsDetachedBuffer(buffer) → TypeError. The byte length is RE-READ here
 *       (not reused from an earlier load) because a `valueOf` inside the
 *       preceding ToIndex(byteOffset)/ToIndex(length) coercions may have
 *       detached the buffer (byteoffset-to-number-detachbuffer.js /
 *       length-to-number-detachbuffer.js) — detach ≡ `buf.length < 0`
 *       ($DETACHBUFFER sentinel, see {@link emitDvDetachedCheck}).
 *   14. explicit length: `offset + newLength×elementSize > bufferByteLength`
 *       → RangeError. Computed in f64 (`lenF64Local` is the pre-narrowing
 *       ToIndex result): a spec-legal length up to 2^53−1 overflows i32, and
 *       i32 wrap-around would silently PASS the check.
 *   7.b resizable backing + length omitted → length-tracking: only
 *       `offset > bufferByteLength` throws (RangeError); the stored length is
 *       the `-1` auto-length sentinel (live length derives from `buf.length`).
 *       Distinguished at RUNTIME via `ref.test $__resizable_ab` — the previous
 *       code keyed length-tracking on the STATIC "module registers a resizable
 *       buffer type" flag, which skipped the fixed-buffer modulo validation
 *       for every buffer in such modules.
 *   13. fixed backing + length omitted: `bufferByteLength modulo elementSize
 *       ≠ 0` → RangeError, then `newByteLength = bufferByteLength − offset
 *       < 0` → RangeError, else length = newByteLength / elementSize.
 *
 * `hasLen` selects the arm: compile-time absent (`"static-no"`), compile-time
 * present (`"static-yes"`), or runtime-nullish-tested (`"runtime"`, the
 * pre-evaluated-argv path where `new TA(buffer, 0, undefined)` must take the
 * length-omitted arm per spec — "length is undefined", §23.2.5.1 step 13).
 * Writes the final element length (or the `-1` tracking sentinel) to
 * `lenOutLocal`. Standalone-lane only (both callers are noJsHost-gated).
 *
 * `skipAutoModulo` — the pre-evaluated-argv caller sets this. A STATIC
 * `new Int8Array(n)` value is represented as a bare `$__vec_i32_byte` — the
 * SAME struct as an ArrayBuffer (the representational pun the `.buffer`
 * identity relies on) — so its `ref.test $__vec_i32_byte` arm cannot tell a
 * genuine buffer from an int8-family VIEW used as a copy SOURCE
 * (`new Float64Array(int8x10)`, ctors/typedarray-arg/*). For that pun shape
 * the step-13.a modulo throw would convert a pre-existing silent-wrong-length
 * into an UNCAUGHT RangeError; the statically-ArrayBuffer-typed path (where
 * every corpus modulo test lives) keeps the full check. The other checks
 * (detached, offset-OOB, explicit-length bounds) are vacuously safe for the
 * pun shape (offset/length args are only passed with genuine buffers).
 */
function emitTaBufferBoundsAndLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufLocal: number,
  offLocal: number,
  esLocal: number,
  lenOutLocal: number,
  hasLen:
    | { kind: "static-no" }
    | { kind: "static-yes"; lenLocal: number; lenF64Local: number }
    | { kind: "runtime"; flagLocal: number; lenLocal: number; lenF64Local: number },
  skipAutoModulo = false,
): void {
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Fresh bufferByteLength read (post-coercion — see doc block).
  const bufBlLocal = allocLocal(fctx, `__tabl_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: bufLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: bufBlLocal });

  // Step 6: detached → TypeError.
  const detachedThrow = dvTypeErrorThrow(ctx, DV_DETACHED_MESSAGE);
  fctx.body.push({ op: "local.get", index: bufBlLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: detachedThrow, else: [] });

  // Detached arm builders — the shared `savedBody` is registered in
  // `liveBodies` during each swap (#2182 pattern) so a late-import funcIdx
  // shift (host lane; standalone mints defined funcs only) still walks it.
  const buildExplicitArm = (lenLocal: number, lenF64Local: number): Instr[] => {
    const arm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = arm;
    ctx.liveBodies.add(saved);
    try {
      // off + len×es > bufBl → RangeError (f64 — see doc block).
      fctx.body.push({ op: "local.get", index: offLocal });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "local.get", index: esLocal });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "f64.mul" });
      fctx.body.push({ op: "f64.add" });
      fctx.body.push({ op: "local.get", index: bufBlLocal });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "f64.gt" });
      emitThrowRangeErrorIf(ctx, fctx, "RangeError: Invalid typed array length");
      fctx.body.push({ op: "local.get", index: lenLocal });
      fctx.body.push({ op: "local.set", index: lenOutLocal });
    } finally {
      fctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    return arm;
  };

  const buildAutoArm = (): Instr[] => {
    const arm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = arm;
    ctx.liveBodies.add(saved);
    try {
      // Fixed-backing auto-length (steps 13.a–c).
      const fixedArm: Instr[] = [];
      const savedFixed = fctx.body;
      fctx.body = fixedArm;
      try {
        if (!skipAutoModulo) {
          fctx.body.push({ op: "local.get", index: bufBlLocal });
          fctx.body.push({ op: "local.get", index: esLocal });
          fctx.body.push({ op: "i32.rem_u" });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.ne" });
          emitThrowRangeErrorIf(
            ctx,
            fctx,
            "RangeError: Byte length of the buffer should be a multiple of the element size",
          );
        }
        fctx.body.push({ op: "local.get", index: bufBlLocal });
        fctx.body.push({ op: "local.get", index: offLocal });
        fctx.body.push({ op: "i32.lt_s" });
        emitThrowRangeErrorIf(ctx, fctx, "RangeError: Start offset is outside the bounds of the buffer");
        fctx.body.push({ op: "local.get", index: bufBlLocal });
        fctx.body.push({ op: "local.get", index: offLocal });
        fctx.body.push({ op: "i32.sub" });
        fctx.body.push({ op: "local.get", index: esLocal });
        fctx.body.push({ op: "i32.div_u" });
        fctx.body.push({ op: "local.set", index: lenOutLocal });
      } finally {
        fctx.body = savedFixed;
      }

      if (ctx.resizableAbTypeIdx >= 0) {
        // Length-tracking over a resizable backing (step 7.b): runtime brand
        // test — a FIXED buffer in a resizable-bearing module keeps the full
        // fixed-arm validation.
        const trackArm: Instr[] = [];
        const savedTrack = fctx.body;
        fctx.body = trackArm;
        try {
          fctx.body.push({ op: "local.get", index: offLocal });
          fctx.body.push({ op: "local.get", index: bufBlLocal });
          fctx.body.push({ op: "i32.gt_s" });
          emitThrowRangeErrorIf(ctx, fctx, "RangeError: Start offset is outside the bounds of the buffer");
          fctx.body.push({ op: "i32.const", value: -1 });
          fctx.body.push({ op: "local.set", index: lenOutLocal });
        } finally {
          fctx.body = savedTrack;
        }
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "ref.test", typeIdx: ctx.resizableAbTypeIdx });
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: trackArm, else: fixedArm });
      } else {
        for (const instr of fixedArm) fctx.body.push(instr);
      }
    } finally {
      fctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    return arm;
  };

  if (hasLen.kind === "static-yes") {
    const arm = buildExplicitArm(hasLen.lenLocal, hasLen.lenF64Local);
    for (const instr of arm) fctx.body.push(instr);
  } else if (hasLen.kind === "static-no") {
    const arm = buildAutoArm();
    for (const instr of arm) fctx.body.push(instr);
  } else {
    const explicitArm = buildExplicitArm(hasLen.lenLocal, hasLen.lenF64Local);
    const autoArm = buildAutoArm();
    fctx.body.push({ op: "local.get", index: hasLen.flagLocal });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: explicitArm, else: autoArm });
  }
}

/**
 * (#3054 D) Dynamic `new <ctorVal>(buffer[, byteOffset[, length]])` where
 * `ctorVal` is a first-class `$__ta_ctor` value (the kind is only known at
 * runtime — test262 `CreateRabForTest`, `for (ctor of ctors) new ctor(rab, …)`).
 * Recovers the buffer vec ONCE, reads the ctor `kind`, then a runtime kind-switch
 * builds the concrete per-kind `$__ta_view_<K>` (shared-backing, length-tracking
 * over a resizable buffer via the `-1` auto-length sentinel) and boxes it to
 * externref (the static result type is a TA union → externref). A non-`$__ta_ctor`
 * callee, or a buffer that can't be recovered as a native vec, yields
 * `ref.null.extern` (declines gracefully — same as the pre-D host-import drop).
 *
 * `ctorAnyLocal` is an anyref local already holding `any.convert_extern(ctorValue)`.
 * Byte-inert: only reachable once a `$__ta_ctor` value exists in the module.
 *
 * (#3177 slice 2) Full §23.2.5.1 InitializeTypedArrayFromArrayBuffer argument
 * protocol: ToIndex(byteOffset) → offset%elementSize RangeError →
 * ToIndex(length) → detached TypeError (fresh byte-length read, observing a
 * detach-during-valueOf) → bounds RangeError / auto-length computation (see
 * {@link emitTaBufferBoundsAndLength}). The alignment/bounds/detached checks
 * live INSIDE the kind-gated arm (they need the runtime element size and must
 * not fire for a non-TA callee); the ToIndex coercions stay unconditional,
 * matching the pre-slice-2 behavior. A literal-`undefined` length argument
 * counts as ABSENT (`new TA(buffer, 0, undefined)` takes the length-omitted
 * validation arm, per spec "length is undefined").
 */
export function emitDynamicTaViewConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ctorAnyLocal: number,
  bufExpr: import("../ts-api.js").ts.Expression,
  offsetExpr: import("../ts-api.js").ts.Expression | undefined,
  lengthExpr: import("../ts-api.js").ts.Expression | undefined,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const taCtorTypeIdx = getOrRegisterTaCtorType(ctx);
  const { vecTypeIdx } = i32ByteVec(ctx);

  // Result (boxed view) — default null so a non-ctor / unrecoverable buffer declines.
  const resultLocal = allocLocal(fctx, `__dtav_res_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Recover the shared buffer vec struct (mirror emitTaViewConstruct).
  const bufType = compileExpr(bufExpr);
  if (!bufType) return null;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && (bufType as { typeIdx: number }).typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
    }
  } else {
    fctx.body.push({ op: "drop" });
    return null;
  }
  const bufLocal = allocLocal(fctx, `__dtav_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.set", index: bufLocal });

  // byteOffset = ToIndex(offsetExpr) (0 when omitted). Element-count length arg is
  // kind-independent, so compute it ONCE (shared across all arms).
  const offsetLocal = allocLocal(fctx, `__dtav_off_${fctx.locals.length}`, { kind: "i32" });
  if (offsetExpr) {
    emitToIndexI32(ctx, fctx, offsetExpr, compileExpr, offsetLocal, "RangeError: Invalid typed array offset");
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: offsetLocal });
  }
  // A syntactic literal-`undefined` length is ABSENT per spec (§23.2.5.1 "If
  // length is undefined"). Restricted to the side-effect-free identifier shape
  // so a `void`-typed call expression is still evaluated.
  const lengthIsLiteralUndefined =
    lengthExpr !== undefined && ts.isIdentifier(lengthExpr) && lengthExpr.text === "undefined";
  const lenGiven = lengthExpr !== undefined && !lengthIsLiteralUndefined;
  const lenElemsLocal = allocLocal(fctx, `__dtav_len_${fctx.locals.length}`, { kind: "i32" });
  const lenF64Local = allocLocal(fctx, `__dtav_lenf_${fctx.locals.length}`, { kind: "f64" });
  if (lengthExpr && lenGiven) {
    emitToIndexI32(
      ctx,
      fctx,
      lengthExpr,
      compileExpr,
      lenElemsLocal,
      "RangeError: Invalid typed array length",
      lenF64Local,
    );
  }

  // kind = ref.test $__ta_ctor ? struct.get 0 : -1  (a non-ctor callee → -1 → the
  // gate below leaves the null result).
  const kindLocal = allocLocal(fctx, `__dtav_kind_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: -1 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  fctx.body.push({ op: "local.get", index: ctorAnyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: taCtorTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: ctorAnyLocal },
      { op: "ref.cast", typeIdx: taCtorTypeIdx },
      { op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: kindLocal },
    ],
    else: [],
  });

  // Build ONE `$__ta_dyn_view` carrying the runtime kind (B1's per-kind
  // `$__ta_view_<K>` canonicalize together, so a boxed view can't recover its kind
  // via `ref.test` — the dynamic path stores it). Only when `kind >= 0`.
  // (#3177 slice 2) The arm now runs the full §23.2.5.1 validation protocol:
  // alignment RangeError → detached TypeError → bounds RangeError / auto-length.
  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const buildArm: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = buildArm;
  ctx.liveBodies.add(savedBody);
  try {
    const esLocal = allocLocal(fctx, `__dtav_es_${fctx.locals.length}`, { kind: "i32" });
    pushElemSizeForKind(fctx, kindLocal);
    fctx.body.push({ op: "local.set", index: esLocal });
    emitTaOffsetAlignmentCheck(ctx, fctx, offsetLocal, esLocal);
    const lenOutLocal = allocLocal(fctx, `__dtav_lo_${fctx.locals.length}`, { kind: "i32" });
    emitTaBufferBoundsAndLength(
      ctx,
      fctx,
      bufLocal,
      offsetLocal,
      esLocal,
      lenOutLocal,
      lenGiven ? { kind: "static-yes", lenLocal: lenElemsLocal, lenF64Local } : { kind: "static-no" },
    );
    // view = {length (elements | -1 tracking), buf, byteOffset, kind, expando}.
    fctx.body.push({ op: "local.get", index: lenOutLocal });
    fctx.body.push({ op: "local.get", index: bufLocal });
    fctx.body.push({ op: "local.get", index: offsetLocal });
    fctx.body.push({ op: "local.get", index: kindLocal });
    fctx.body.push({ op: "ref.null.extern" }); // expando (#3177 slice 4) — lazily created
    fctx.body.push({ op: "ref.null.extern" }); // #3371 constructProto (intrinsic default)
    fctx.body.push({ op: "struct.new", typeIdx: dynIdx });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: resultLocal });
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }

  fctx.body.push({ op: "local.get", index: kindLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildArm, else: [] });

  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "externref" };
}

/**
 * (#2872) `ToIndex` an already-evaluated externref argument local into an i32
 * (§7.1.22): unbox → NaN→0 → truncate toward zero → RangeError when negative or
 * above 2^53−1. Mirrors {@link emitToIndexI32} but sources from a pre-boxed
 * externref local instead of compiling an expression.
 *
 * (#3177 slice 2) A runtime `$Symbol`-carrier operand throws TypeError per
 * §7.1.4 ToNumber(Symbol) — the arg is pre-boxed so the static-type check the
 * expression variant uses can't fire; test the carrier brand at runtime
 * (byte-inert when the module never registers the Symbol carrier). Also
 * optionally preserves the truncated pre-narrowing f64 in `outF64Local` for
 * overflow-safe bounds math (see {@link emitToIndexI32}).
 */
function emitToIndexI32FromArgLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argLocal: number,
  outLocal: number,
  rangeErrMsg: string,
  outF64Local?: number,
): void {
  if (ctx.symbolTypeIdx >= 0) {
    fctx.body.push({ op: "local.get", index: argLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: ctx.symbolTypeIdx });
    const symThrow = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a number", {
      flush: fctx,
    });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: symThrow, else: [] });
  }
  const f64Local = allocLocal(fctx, `__dtac_ti_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.get", index: argLocal });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: f64Local });
  // NaN → 0 (v != v is true only for NaN).
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: f64Local },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  emitThrowRangeErrorIf(ctx, fctx, rangeErrMsg);
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: outLocal });
  if (outF64Local !== undefined) {
    fctx.body.push({ op: "local.get", index: f64Local });
    fctx.body.push({ op: "local.set", index: outF64Local });
  }
}

/**
 * (#2872) General dynamic TypedArray construction from PRE-EVALUATED argument
 * locals — `new <ctorVal>(…)` where `<ctorVal>` is a runtime value that may be a
 * first-class `$__ta_ctor` (a TA constructor held in an `any` binding: a callback
 * param or array element — the test262
 * `testWithTypedArrayConstructors(TA => new TA(…))` harness shape).
 *
 * #3054 D covered ONLY the `(buffer[, off[, len]])` form, gated on a statically
 * buffer-typed first arg. The dominant harness forms — `new TA(n)` count,
 * `new TA([…])` array-copy, `new TA(otherTA)` view-copy and `new TA()` — all fell
 * through to `ref.null.extern`, so every downstream read yielded 0/undefined
 * (#2872's "assert #1" cluster over built-ins/TypedArray/**).
 *
 * Emits a `ref.test $__ta_ctor` gate over `descAnyLocal`; on a match, an
 * argument-shape dispatch at RUNTIME over the pre-evaluated externref arg0:
 *   - no args                     → 0-length view over a fresh buffer
 *   - `$__vec_i32_byte` arg0      → buffer form (off/len ToIndex'd from
 *                                   arg1/arg2; auto length uses the resizable
 *                                   `-1` length-tracking sentinel exactly like
 *                                   {@link emitDynamicTaViewConstruct})
 *   - `$__ta_dyn_view` arg0       → element copy with per-kind re-encode
 *   - registered plain-vec arg0   → element copy (f64 / i32 / boxed externref)
 *   - anything else               → ToIndex count form over a fresh ZEROED
 *                                   buffer (negative/oversize → RangeError,
 *                                   NaN/undefined/non-numeric → 0)
 * A non-`$__ta_ctor` callee leaves the null result — byte-identical to the
 * pre-#2872 outcome — so user-class / function ctors are never hijacked.
 *
 * IMPORT DISCIPLINE: noJsHost lane only. Every helper this can reach
 * (`__to_primitive`/`__unbox_number` via the externref→f64 coercion) resolves to
 * a NATIVE defined function (`OBJECT_RUNTIME_HELPER_NAMES` /
 * `UNION_NATIVE_HELPER_NAMES` routing in `ensureLateImport`), so building the
 * detached arms appends defined functions only and cannot shift baked funcIdxs
 * (#608/#794). Callers must NOT use this on the JS-host lane.
 *
 * Stack: `[] → [externref]` (the constructed view, or null-extern).
 */
export function emitTaDynCtorConstructFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descAnyLocal: number,
  argLocals: readonly number[],
): void {
  const taCtorTypeIdx = getOrRegisterTaCtorType(ctx);
  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);

  const resultLocal = allocLocal(fctx, `__dtac_res_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Shared per-arm locals (function-scoped; each arm fully re-initializes what
  // it reads).
  const kindLocal = allocLocal(fctx, `__dtac_kind_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__dtac_es_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__dtac_le_${fctx.locals.length}`, { kind: "i32" });
  const dstNLocal = allocLocal(fctx, `__dtac_n_${fctx.locals.length}`, { kind: "i32" });
  const dstBlLocal = allocLocal(fctx, `__dtac_bl_${fctx.locals.length}`, { kind: "i32" });
  const dstArrLocal = allocLocal(fctx, `__dtac_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: byteArrIdx,
  });

  // Build the whole `$__ta_ctor`-matched arm detached, then gate it on the
  // runtime test so a non-TA callee costs one ref.test.
  const taArm: Instr[] = [];
  const savedTa = fctx.body;
  fctx.body = taArm;

  fctx.body.push({ op: "local.get", index: descAnyLocal });
  fctx.body.push({ op: "ref.cast", typeIdx: taCtorTypeIdx });
  fctx.body.push({ op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  fctx.body.push({ op: "i32.const", value: 1 }); // little-endian
  fctx.body.push({ op: "local.set", index: leLocal });

  // Allocate a FRESH ZEROED buffer of dstN elements and publish the view.
  // Reads dstNLocal/esLocal/kindLocal; sets dstBlLocal/dstArrLocal/resultLocal.
  const emitAllocViewFromN = (): void => {
    fctx.body.push({ op: "local.get", index: dstNLocal });
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "local.set", index: dstBlLocal });
    fctx.body.push({ op: "local.get", index: dstBlLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: byteArrIdx });
    fctx.body.push({ op: "local.set", index: dstArrLocal });
    // view = {length: n, buf: {bl, arr}, byteOffset: 0, kind, expando}
    fctx.body.push({ op: "local.get", index: dstNLocal });
    fctx.body.push({ op: "local.get", index: dstBlLocal });
    fctx.body.push({ op: "local.get", index: dstArrLocal });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.new", typeIdx: byteVecIdx });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: kindLocal });
    fctx.body.push({ op: "ref.null.extern" }); // expando (#3177 slice 4) — lazily created
    fctx.body.push({ op: "ref.null.extern" }); // #3371 constructProto (intrinsic default)
    fctx.body.push({ op: "struct.new", typeIdx: dynIdx });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.set", index: resultLocal });
  };

  // Emit `for (i = 0; i < dstN; i++) { encode(kind, dstArr, i*es, pushElemF64(i)) }`.
  // `pushElemF64` must leave exactly one f64 on the stack.
  const emitCopyLoop = (pushElemF64: (iLocal: number) => void): void => {
    const iLocal = allocLocal(fctx, `__dtac_i_${fctx.locals.length}`, { kind: "i32" });
    const vLocal = allocLocal(fctx, `__dtac_v_${fctx.locals.length}`, { kind: "f64" });
    const dstOffLocal = allocLocal(fctx, `__dtac_doff_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iLocal });
    const loopBody: Instr[] = [];
    const savedLoop = fctx.body;
    fctx.body = loopBody;
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: dstNLocal });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "br_if", depth: 1 });
    pushElemF64(iLocal);
    fctx.body.push({ op: "local.set", index: vLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "local.set", index: dstOffLocal });
    const dstArrNn = allocLocal(fctx, `__dtac_arrnn_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: byteArrIdx,
    });
    fctx.body.push({ op: "local.get", index: dstArrLocal });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "local.set", index: dstArrNn });
    fctx.body.push(...emitDynEncodeDispatch(ctx, fctx, kindLocal, dstArrNn, dstOffLocal, vLocal, leLocal, byteArrIdx));
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: iLocal });
    fctx.body.push({ op: "br", depth: 0 });
    fctx.body = savedLoop;
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    });
  };

  if (argLocals.length === 0) {
    // `new TA()` → 0-length view.
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: dstNLocal });
    emitAllocViewFromN();
  } else {
    const a0AnyLocal = allocLocal(fctx, `__dtac_a0_${fctx.locals.length}`, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.get", index: argLocals[0]! });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.set", index: a0AnyLocal });

    // ── Count form (the innermost else): n = ToIndex(arg0) → fresh zeroed view.
    const countArm: Instr[] = [];
    {
      const saved = fctx.body;
      fctx.body = countArm;
      emitToIndexI32FromArgLocal(ctx, fctx, argLocals[0]!, dstNLocal, "RangeError: Invalid typed array length");
      emitAllocViewFromN();
      fctx.body = saved;
    }
    let chain: Instr[] = countArm;

    // ── Array-LIKE `$Object` arm (§23.2.5.1 InitializeTypedArrayFromArrayLike):
    // the harness `makeArrayLike` factory passes `{length: n, 0: v, …}` — read
    // `length` via the native `__extern_length` ($Object arm reads the `length`
    // property; NaN → 0) and each element via `__extern_get_idx` + ToNumber
    // (missing/undefined element → NaN → +0 for int kinds, per spec).
    {
      ensureObjectRuntime(ctx);
      const objTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx ?? -1;
      const externLengthIdx = ctx.funcMap.get("__extern_length");
      const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
      if (objTypeIdx >= 0 && externLengthIdx !== undefined && externGetIdxIdx !== undefined) {
        const objArm: Instr[] = [];
        const saved = fctx.body;
        fctx.body = objArm;
        const lenF64 = allocLocal(fctx, `__dtac_olen_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.get", index: argLocals[0]! });
        fctx.body.push({ op: "call", funcIdx: externLengthIdx });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // n = max(trunc_sat(len), 0)  — NaN→0 via trunc_sat, negatives clamp.
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "local.set", index: dstNLocal });
        fctx.body.push({ op: "local.get", index: dstNLocal });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.lt_s" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: dstNLocal },
          ],
          else: [],
        });
        emitAllocViewFromN();
        emitCopyLoop((iLocal) => {
          fctx.body.push({ op: "local.get", index: argLocals[0]! });
          fctx.body.push({ op: "local.get", index: iLocal });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "call", funcIdx: externGetIdxIdx });
          coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
        });
        fctx.body = saved;
        chain = [
          { op: "local.get", index: a0AnyLocal },
          { op: "ref.test", typeIdx: objTypeIdx },
          { op: "if", blockType: { kind: "empty" }, then: objArm, else: chain },
        ];
      }
    }

    // ── Plain-vec copy arms: one per registered numeric-capable carrier.
    // Skip `i32_byte` (the ArrayBuffer arm below owns it) and non-numeric
    // carriers (`ref_*` struct-elem vecs).
    for (const [carrierKey, vIdx] of Array.from(ctx.vecTypeMap.entries())) {
      if (carrierKey !== "f64" && carrierKey !== "i32" && carrierKey !== "externref") continue;
      const srcArrIdx = getArrTypeIdxFromVec(ctx, vIdx);
      if (srcArrIdx < 0) continue;
      const srcArrDef = ctx.mod.types[srcArrIdx];
      if (!srcArrDef || srcArrDef.kind !== "array") continue;
      const elemType = srcArrDef.element;
      const vecArm: Instr[] = [];
      const saved = fctx.body;
      fctx.body = vecArm;
      const srcVecLocal = allocLocal(fctx, `__dtac_sv_${fctx.locals.length}`, { kind: "ref", typeIdx: vIdx });
      const srcDataLocal = allocLocal(fctx, `__dtac_sd_${fctx.locals.length}`, { kind: "ref", typeIdx: srcArrIdx });
      fctx.body.push({ op: "local.get", index: a0AnyLocal });
      fctx.body.push({ op: "ref.cast", typeIdx: vIdx });
      fctx.body.push({ op: "local.tee", index: srcVecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vIdx, fieldIdx: 0 });
      fctx.body.push({ op: "local.set", index: dstNLocal });
      fctx.body.push({ op: "local.get", index: srcVecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.set", index: srcDataLocal });
      emitAllocViewFromN();
      emitCopyLoop((iLocal) => {
        fctx.body.push({ op: "local.get", index: srcDataLocal });
        fctx.body.push({ op: "local.get", index: iLocal });
        fctx.body.push({ op: "array.get", typeIdx: srcArrIdx });
        if (elemType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (elemType.kind === "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
        }
      });
      fctx.body = saved;
      chain = [
        { op: "local.get", index: a0AnyLocal },
        { op: "ref.test", typeIdx: vIdx },
        { op: "if", blockType: { kind: "empty" }, then: vecArm, else: chain },
      ];
    }

    // ── `$__ta_dyn_view` copy arm: re-encode element-by-element on both kinds.
    {
      const dvArm: Instr[] = [];
      const saved = fctx.body;
      fctx.body = dvArm;
      const srcDvLocal = allocLocal(fctx, `__dtac_sdv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
      const srcKindLocal = allocLocal(fctx, `__dtac_sk_${fctx.locals.length}`, { kind: "i32" });
      const srcEsLocal = allocLocal(fctx, `__dtac_ses_${fctx.locals.length}`, { kind: "i32" });
      const srcOffLocal = allocLocal(fctx, `__dtac_soff_${fctx.locals.length}`, { kind: "i32" });
      const srcArrLocal = allocLocal(fctx, `__dtac_sarr_${fctx.locals.length}`, { kind: "ref", typeIdx: byteArrIdx });
      const srcBoLocal = allocLocal(fctx, `__dtac_sbo_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: a0AnyLocal });
      fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
      fctx.body.push({ op: "local.tee", index: srcDvLocal });
      fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
      fctx.body.push({ op: "local.set", index: srcKindLocal });
      pushElemSizeForKind(fctx, srcKindLocal);
      fctx.body.push({ op: "local.set", index: srcEsLocal });
      fctx.body.push({ op: "local.get", index: srcDvLocal });
      fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
      fctx.body.push({ op: "local.set", index: srcBoLocal });
      fctx.body.push({ op: "local.get", index: srcDvLocal });
      fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
      fctx.body.push({ op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.set", index: srcArrLocal });
      pushTaDynViewInBoundsLen(ctx, fctx, srcDvLocal, srcEsLocal);
      fctx.body.push({ op: "local.set", index: dstNLocal });
      emitAllocViewFromN();
      emitCopyLoop((iLocal) => {
        // srcOff = srcByteOffset + i*srcEs
        fctx.body.push({ op: "local.get", index: srcBoLocal });
        fctx.body.push({ op: "local.get", index: iLocal });
        fctx.body.push({ op: "local.get", index: srcEsLocal });
        fctx.body.push({ op: "i32.mul" });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: srcOffLocal });
        fctx.body.push(
          ...emitDynDecodeDispatch(ctx, fctx, srcKindLocal, srcArrLocal, srcOffLocal, leLocal, byteArrIdx),
        );
      });
      fctx.body = saved;
      chain = [
        { op: "local.get", index: a0AnyLocal },
        { op: "ref.test", typeIdx: dynIdx },
        { op: "if", blockType: { kind: "empty" }, then: dvArm, else: chain },
      ];
    }

    // ── ArrayBuffer arm (outermost test): shared-backing view over the byte vec
    // (`$__resizable_ab` is a subtype, so resizable buffers match too).
    // (#3177 slice 2) Full §23.2.5.1 argument protocol: ToIndex(byteOffset) →
    // alignment RangeError → runtime-nullish length probe (a PRESENT-but-
    // `undefined` third arg — `new TA(buffer, 0, undefined)` — takes the
    // length-omitted arm per spec) → ToIndex(length) → detached TypeError /
    // bounds RangeError / auto-length via emitTaBufferBoundsAndLength. This
    // replaces the old clamp-offset + static-resizable-flag heuristics.
    {
      const bufArm: Instr[] = [];
      const saved = fctx.body;
      fctx.body = bufArm;
      ctx.liveBodies.add(saved);
      try {
        const bufLocal = allocLocal(fctx, `__dtac_buf_${fctx.locals.length}`, { kind: "ref", typeIdx: byteVecIdx });
        const offLocal = allocLocal(fctx, `__dtac_off_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: a0AnyLocal });
        fctx.body.push({ op: "ref.cast", typeIdx: byteVecIdx });
        fctx.body.push({ op: "local.set", index: bufLocal });
        if (argLocals.length >= 2) {
          emitToIndexI32FromArgLocal(ctx, fctx, argLocals[1]!, offLocal, "RangeError: Invalid typed array offset");
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: offLocal });
        }
        emitTaOffsetAlignmentCheck(ctx, fctx, offLocal, esLocal);
        if (argLocals.length >= 3) {
          // Runtime "length is undefined" probe (§23.2.5.1 step 13): normalize
          // the #2106 $undefined singleton to null when the helper exists,
          // then null-test. ToIndex(length) runs ONLY on a non-nullish value.
          const hasLenFlag = allocLocal(fctx, `__dtac_hl_${fctx.locals.length}`, { kind: "i32" });
          const lenF64Local = allocLocal(fctx, `__dtac_lf_${fctx.locals.length}`, { kind: "f64" });
          const nullishIdx = ctx.funcMap.get("__nullish_to_null");
          fctx.body.push({ op: "local.get", index: argLocals[2]! });
          if (nullishIdx !== undefined) fctx.body.push({ op: "call", funcIdx: nullishIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({ op: "local.set", index: hasLenFlag });
          const toIndexArm: Instr[] = [];
          const savedTi = fctx.body;
          fctx.body = toIndexArm;
          try {
            emitToIndexI32FromArgLocal(
              ctx,
              fctx,
              argLocals[2]!,
              dstNLocal,
              "RangeError: Invalid typed array length",
              lenF64Local,
            );
          } finally {
            fctx.body = savedTi;
          }
          fctx.body.push({ op: "local.get", index: hasLenFlag });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: toIndexArm, else: [] });
          emitTaBufferBoundsAndLength(
            ctx,
            fctx,
            bufLocal,
            offLocal,
            esLocal,
            dstNLocal,
            { kind: "runtime", flagLocal: hasLenFlag, lenLocal: dstNLocal, lenF64Local },
            /* skipAutoModulo — bare-byte-vec pun, see helper doc */ true,
          );
        } else {
          emitTaBufferBoundsAndLength(
            ctx,
            fctx,
            bufLocal,
            offLocal,
            esLocal,
            dstNLocal,
            { kind: "static-no" },
            /* skipAutoModulo — bare-byte-vec pun, see helper doc */ true,
          );
        }
        // view = {n, sharedBuf, off, kind, expando}
        fctx.body.push({ op: "local.get", index: dstNLocal });
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "local.get", index: offLocal });
        fctx.body.push({ op: "local.get", index: kindLocal });
        fctx.body.push({ op: "ref.null.extern" }); // expando (#3177 slice 4) — lazily created
        fctx.body.push({ op: "ref.null.extern" }); // #3371 constructProto (intrinsic default)
        fctx.body.push({ op: "struct.new", typeIdx: dynIdx });
        fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "local.set", index: resultLocal });
      } finally {
        fctx.body = saved;
        ctx.liveBodies.delete(saved);
      }
      chain = [
        { op: "local.get", index: a0AnyLocal },
        { op: "ref.test", typeIdx: byteVecIdx },
        { op: "if", blockType: { kind: "empty" }, then: bufArm, else: chain },
      ];
    }

    for (const instr of chain) fctx.body.push(instr);
  }

  fctx.body = savedTa;

  fctx.body.push({ op: "local.get", index: descAnyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: taCtorTypeIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: taArm, else: [] });
  fctx.body.push({ op: "local.get", index: resultLocal });
}

/**
 * (#3177 slice 5) Mint the shared native `__ta_from_arraylike(ctor, carrier) →
 * externref` — the builder behind the standalone `%TypedArray%.of` /
 * `%TypedArray%.from` statics. `ctor` is a `$__ta_ctor` value (its `kind` field
 * selects the element codec); `carrier` is ANY indexable read through the
 * dynamic `__extern_length` / `__extern_get_idx` arm — a native `$ObjVec` (the
 * packed `of(...)` args), an array-like `$Object`, a plain vec, or the
 * normalized carrier of `__array_from_iter_n` / `__array_from_mapped` (the
 * `from(...)` source, optionally mapped). Builds a fresh same-kind
 * `$__ta_dyn_view` of length `max(ToInteger(carrier.length), 0)` with every
 * element `ToNumber`'d and byte-encoded on the ctor's RUNTIME kind
 * (Uint8Clamped clamp included). The dyn-view rep gives `.constructor` /
 * `Object.getPrototypeOf` identity for free (slices 1/3).
 *
 * noJsHost lane only; every dependency is a native DEFINED function
 * (append-only — no import add / funcIdx shift). Idempotent via funcMap.
 */
export function ensureTaFromArrayLikeHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const helperName = "__ta_from_arraylike";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // The array-like reader (`$ObjVec` / `$Object {length}` / vec / host array)
  // is the object runtime's `__extern_length` / `__extern_get_idx`.
  ensureObjectRuntime(ctx);
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (externLengthIdx === undefined || externGetIdxIdx === undefined) return undefined;

  const taCtorTypeIdx = getOrRegisterTaCtorType(ctx);
  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);

  const params: ValType[] = [
    { kind: "externref" }, // ctor ($__ta_ctor)
    { kind: "externref" }, // carrier (indexable)
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const fctx: FunctionContext = {
    name: helperName,
    params: [
      { name: "ctor", type: { kind: "externref" } },
      { name: "carrier", type: { kind: "externref" } },
    ],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const nLocal = allocLocal(fctx, "n", { kind: "i32" });
  const blLocal = allocLocal(fctx, "bl", { kind: "i32" });
  const arrLocal = allocLocal(fctx, "arr", { kind: "ref", typeIdx: byteArrIdx });
  const leLocal = allocLocal(fctx, "le", { kind: "i32" });
  const iLocal = allocLocal(fctx, "i", { kind: "i32" });
  const offLocal = allocLocal(fctx, "off", { kind: "i32" });
  const vLocal = allocLocal(fctx, "v", { kind: "f64" });
  const lenF64Local = allocLocal(fctx, "lenf", { kind: "f64" });

  // kind = ctor.kind; es = elemSize(kind); le = 1 (little-endian).
  fctx.body.push({ op: "local.get", index: 0 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: taCtorTypeIdx });
  fctx.body.push({ op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });

  // n = max(trunc_sat_f64_s(carrier.length), 0)  — NaN→0, negatives clamp.
  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push({ op: "call", funcIdx: externLengthIdx });
  fctx.body.push({ op: "local.set", index: lenF64Local });
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: nLocal });
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: nLocal },
    ],
    else: [],
  });

  // bl = n * es; arr = new zeroed byte array[bl].
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "local.get", index: esLocal });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "local.set", index: blLocal });
  fctx.body.push({ op: "local.get", index: blLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: byteArrIdx });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // for (i = 0; i < n; i++) { v = ToNumber(get_idx(carrier, i)); encode at i*es }
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });
  const loopBody: Instr[] = [];
  {
    const saved = fctx.body;
    fctx.body = loopBody;
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "br_if", depth: 1 });
    fctx.body.push({ op: "local.get", index: 1 });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "call", funcIdx: externGetIdxIdx });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: vLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "local.set", index: offLocal });
    fctx.body.push(...emitDynEncodeDispatch(ctx, fctx, kindLocal, arrLocal, offLocal, vLocal, leLocal, byteArrIdx));
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: iLocal });
    fctx.body.push({ op: "br", depth: 0 });
    fctx.body = saved;
  }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // view = { length: n, buf: {byteLength: bl, data: arr}, byteOffset: 0, kind,
  //          expando: null, constructProto: null }.
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "local.get", index: blLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: byteVecIdx });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: kindLocal });
  fctx.body.push({ op: "ref.null.extern" }); // expando (#3177 slice 4) — lazily created
  fctx.body.push({ op: "ref.null.extern" }); // #3371 constructProto (intrinsic default)
  fctx.body.push({ op: "struct.new", typeIdx: dynIdx });
  fctx.body.push({ op: "extern.convert_any" });

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#2872) Mint the native `__ta_dyn_fill(recv, value, start, end, argc) →
 * externref` helper — `%TypedArray%.prototype.fill` (§23.2.3.8) over a
 * `$__ta_dyn_view` receiver (a dynamically-constructed TA view reached through
 * an `any` receiver — the `testWithTypedArrayConstructors(TA => new
 * TA(…).fill(…))` harness shape). Before this, an `any`-receiver `.fill` fell
 * to the open-`$Object` dispatcher arm, silently returned `undefined`, and
 * mutated nothing.
 *
 * Semantics: value is ToNumber'd (observable coercion order: value → start →
 * end), start/end are ToIntegerOrInfinity'd relative indices clamped to
 * `[0, len]` (in-bounds len — resizable-aware), an explicit `undefined` end
 * (normalized via `__nullish_to_null` when present) behaves as absent (= len),
 * and every element in `[start, end)` is byte-encoded on the view's RUNTIME
 * kind (Uint8Clamped clamp included) into the SHARED buffer at
 * `byteOffset + i*elemSize`. Returns `recv` itself, so `ta.fill(…) === ta`
 * holds (the identity the `return-this.js` tests assert).
 *
 * noJsHost lane only; every dependency resolves to a native defined function
 * (no imports → the minted stable handle never shifts). Idempotent via funcMap.
 */
export function ensureTaDynFillHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const helperName = "__ta_dyn_fill";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");

  const params: ValType[] = [
    { kind: "externref" }, // recv (guaranteed $__ta_dyn_view by the caller's ref.test)
    { kind: "externref" }, // value
    { kind: "externref" }, // start
    { kind: "externref" }, // end
    { kind: "i32" }, // argc (call-site arity, so absent args are distinguishable)
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const fctx: FunctionContext = {
    name: helperName,
    params: [
      { name: "recv", type: { kind: "externref" } },
      { name: "value", type: { kind: "externref" } },
      { name: "start", type: { kind: "externref" } },
      { name: "end", type: { kind: "externref" } },
      { name: "argc", type: { kind: "i32" } },
    ],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const lenF64Local = allocLocal(fctx, "lenf", { kind: "f64" });
  const vF64Local = allocLocal(fctx, "v", { kind: "f64" });
  const idxF64Local = allocLocal(fctx, "idxf", { kind: "f64" });
  const sLocal = allocLocal(fctx, "s", { kind: "i32" });
  const eLocal = allocLocal(fctx, "e", { kind: "i32" });
  const arrLocal = allocLocal(fctx, "arr", { kind: "ref", typeIdx: byteArrIdx });
  const boLocal = allocLocal(fctx, "bo", { kind: "i32" });
  const leLocal = allocLocal(fctx, "le", { kind: "i32" });
  const iLocal = allocLocal(fctx, "i", { kind: "i32" });
  const offLocal = allocLocal(fctx, "off", { kind: "i32" });

  // dv = ref.cast $__ta_dyn_view(any.convert_extern(recv))
  fctx.body.push({ op: "local.get", index: 0 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.set", index: dvLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  pushTaDynViewInBoundsLen(ctx, fctx, dvLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "f64.convert_i32_s" });
  fctx.body.push({ op: "local.set", index: lenF64Local });

  // v = ToNumber(value) — observable coercion, in spec order (value first).
  fctx.body.push({ op: "local.get", index: 1 });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: vF64Local });

  // ToIntegerOrInfinity an externref param into idxF64 (NaN→0, trunc toward 0),
  // then resolve the RELATIVE index against len into `outLocal` (i32):
  // idx < 0 ? max(len+idx, 0) : min(idx, len).
  const emitRelativeIndex = (paramIdx: number, outLocal: number): void => {
    fctx.body.push({ op: "local.get", index: paramIdx });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: idxF64Local });
    fctx.body.push({ op: "local.get", index: idxF64Local });
    fctx.body.push({ op: "local.get", index: idxF64Local });
    fctx.body.push({ op: "f64.ne" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: idxF64Local },
      ],
      else: [],
    });
    fctx.body.push({ op: "local.get", index: idxF64Local });
    fctx.body.push({ op: "f64.trunc" });
    fctx.body.push({ op: "local.set", index: idxF64Local });
    // relative resolve (all in f64, then trunc_sat to i32)
    fctx.body.push({ op: "local.get", index: idxF64Local });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.lt" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenF64Local },
        { op: "local.get", index: idxF64Local },
        { op: "f64.add" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
        { op: "local.set", index: idxF64Local },
      ],
      else: [
        { op: "local.get", index: idxF64Local },
        { op: "local.get", index: lenF64Local },
        { op: "f64.min" },
        { op: "local.set", index: idxF64Local },
      ],
    });
    fctx.body.push({ op: "local.get", index: idxF64Local });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: outLocal });
  };

  // start: argc >= 2 ? relative(start) : 0.
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.ge_s" });
  {
    const startArm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = startArm;
    emitRelativeIndex(2, sLocal);
    fctx.body = saved;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: startArm,
      else: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: sLocal },
      ],
    });
  }

  // end: (argc >= 3 && end is not undefined/null) ? relative(end) : len.
  // `__nullish_to_null` (when present) normalizes the #2106 $undefined
  // singleton to null so an EXPLICIT `fill(v, s, undefined)` takes the
  // spec's "end is undefined → len" default.
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 3 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "local.get", index: 3 });
  if (nullishToNullIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: nullishToNullIdx });
  }
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "i32.and" });
  {
    const endArm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = endArm;
    emitRelativeIndex(3, eLocal);
    fctx.body = saved;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: endArm,
      else: [
        { op: "local.get", index: lenLocal },
        { op: "local.set", index: eLocal },
      ],
    });
  }

  // arr = dv.buf.data ; bo = dv.byteOffset ; le = 1.
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: boLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });

  // for (i = s; i < e; i++) encode(kind, arr, bo + i*es, v).
  fctx.body.push({ op: "local.get", index: sLocal });
  fctx.body.push({ op: "local.set", index: iLocal });
  {
    const loopBody: Instr[] = [];
    const saved = fctx.body;
    fctx.body = loopBody;
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: eLocal });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "br_if", depth: 1 });
    fctx.body.push({ op: "local.get", index: boLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: esLocal });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: offLocal });
    fctx.body.push(...emitDynEncodeDispatch(ctx, fctx, kindLocal, arrLocal, offLocal, vF64Local, leLocal, byteArrIdx));
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: iLocal });
    fctx.body.push({ op: "br", depth: 0 });
    fctx.body = saved;
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    });
  }

  // return recv (the view itself — `ta.fill(…) === ta`).
  fctx.body.push({ op: "local.get", index: 0 });

  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#2872 slice 2) Shared preamble for a `$__ta_dyn_view`-receiver method helper:
 * casts `recv` (param 0) to the dyn-view struct, reads its runtime kind → elem
 * size, and computes the in-bounds ELEMENT length (resizable-aware). Leaves the
 * results in the passed locals; pushes nothing net. Byte-move methods
 * (copyWithin/reverse) need only these — no per-element decode/encode.
 */
function pushTaDynMethodPreamble(
  ctx: CodegenContext,
  fctx: FunctionContext,
  dynIdx: number,
  dvLocal: number,
  kindLocal: number,
  esLocal: number,
  lenLocal: number,
): void {
  fctx.body.push({ op: "local.get", index: 0 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.set", index: dvLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  pushTaDynViewInBoundsLen(ctx, fctx, dvLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
}

/**
 * (#2872 slice 2) Resolve a relative index param (externref → ToIntegerOrInfinity
 * → relative-to-`len`, clamped `[0, len]`) into `outLocal` (i32). Standalone
 * clone of the closure in `ensureTaDynFillHelper` — kept independent so the fill
 * helper's emitted bytes are untouched. `idxF64Scratch` / `lenF64` are caller
 * locals; `lenF64` must already hold `f64(len)`.
 */
function pushTaDynRelativeIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  outLocal: number,
  idxF64Scratch: number,
  lenF64: number,
): void {
  fctx.body.push({ op: "local.get", index: paramIdx });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxF64Scratch });
  // NaN → 0
  fctx.body.push({ op: "local.get", index: idxF64Scratch });
  fctx.body.push({ op: "local.get", index: idxF64Scratch });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: idxF64Scratch },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: idxF64Scratch });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: idxF64Scratch });
  // idx < 0 ? max(len+idx, 0) : min(idx, len)
  fctx.body.push({ op: "local.get", index: idxF64Scratch });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenF64 },
      { op: "local.get", index: idxF64Scratch },
      { op: "f64.add" },
      { op: "f64.const", value: 0 },
      { op: "f64.max" },
      { op: "local.set", index: idxF64Scratch },
    ],
    else: [
      { op: "local.get", index: idxF64Scratch },
      { op: "local.get", index: lenF64 },
      { op: "f64.min" },
      { op: "local.set", index: idxF64Scratch },
    ],
  });
  fctx.body.push({ op: "local.get", index: idxF64Scratch });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: outLocal });
}

function makeTaDynHelperFctx(helperName: string, params: { name: string; type: ValType }[]): FunctionContext {
  return {
    name: helperName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/**
 * (#2872 slice 2) Mint `__ta_dyn_copywithin(recv, target, start, end, argc) →
 * externref` — `%TypedArray%.prototype.copyWithin` (§23.2.3.5) over a
 * `$__ta_dyn_view` receiver. A pure in-buffer byte move: `to`/`from`/`final` are
 * relative indices clamped to `[0, len]`, `count = min(final - from, len - to)`,
 * and (when `count > 0`) `count * elemSize` bytes are `array.copy`'d from
 * `byteOffset + from*es` to `byteOffset + to*es`. `array.copy` is memmove-correct
 * for overlapping ranges within the same array (Wasm GC spec), so no direction
 * split is needed. Returns `recv` (`ta.copyWithin(…) === ta`). No element
 * decode/encode — the raw bytes move verbatim. noJsHost lane only; idempotent.
 */
export function ensureTaDynCopyWithinHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const helperName = "__ta_dyn_copywithin";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);

  const params: ValType[] = [
    { kind: "externref" }, // recv (guaranteed $__ta_dyn_view by the caller ref.test)
    { kind: "externref" }, // target
    { kind: "externref" }, // start
    { kind: "externref" }, // end
    { kind: "i32" }, // argc
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const fctx = makeTaDynHelperFctx(helperName, [
    { name: "recv", type: { kind: "externref" } },
    { name: "target", type: { kind: "externref" } },
    { name: "start", type: { kind: "externref" } },
    { name: "end", type: { kind: "externref" } },
    { name: "argc", type: { kind: "i32" } },
  ]);

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const lenF64Local = allocLocal(fctx, "lenf", { kind: "f64" });
  const idxF64Local = allocLocal(fctx, "idxf", { kind: "f64" });
  const toLocal = allocLocal(fctx, "to", { kind: "i32" });
  const fromLocal = allocLocal(fctx, "from", { kind: "i32" });
  const finalLocal = allocLocal(fctx, "final", { kind: "i32" });
  const countLocal = allocLocal(fctx, "count", { kind: "i32" });
  const arrLocal = allocLocal(fctx, "arr", { kind: "ref", typeIdx: byteArrIdx });
  const boLocal = allocLocal(fctx, "bo", { kind: "i32" });
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");

  pushTaDynMethodPreamble(ctx, fctx, dynIdx, dvLocal, kindLocal, esLocal, lenLocal);
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "f64.convert_i32_s" });
  fctx.body.push({ op: "local.set", index: lenF64Local });

  // to = argc >= 1 ? relative(target) : 0.
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.ge_s" });
  {
    const arm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = arm;
    pushTaDynRelativeIndex(ctx, fctx, 1, toLocal, idxF64Local, lenF64Local);
    fctx.body = saved;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: arm,
      else: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: toLocal },
      ],
    });
  }
  // from = argc >= 2 ? relative(start) : 0.
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.ge_s" });
  {
    const arm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = arm;
    pushTaDynRelativeIndex(ctx, fctx, 2, fromLocal, idxF64Local, lenF64Local);
    fctx.body = saved;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: arm,
      else: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: fromLocal },
      ],
    });
  }
  // final = (argc >= 3 && end not undefined/null) ? relative(end) : len.
  fctx.body.push({ op: "local.get", index: 4 });
  fctx.body.push({ op: "i32.const", value: 3 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "local.get", index: 3 });
  if (nullishToNullIdx !== undefined) fctx.body.push({ op: "call", funcIdx: nullishToNullIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "i32.and" });
  {
    const arm: Instr[] = [];
    const saved = fctx.body;
    fctx.body = arm;
    pushTaDynRelativeIndex(ctx, fctx, 3, finalLocal, idxF64Local, lenF64Local);
    fctx.body = saved;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: arm,
      else: [
        { op: "local.get", index: lenLocal },
        { op: "local.set", index: finalLocal },
      ],
    });
  }
  // count = min(final - from, len - to).
  fctx.body.push({ op: "local.get", index: finalLocal });
  fctx.body.push({ op: "local.get", index: fromLocal });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: toLocal });
  fctx.body.push({ op: "i32.sub" });
  // min: select (a<b)?a:b
  {
    const aLocal = allocLocal(fctx, "cwa", { kind: "i32" });
    const bLocal = allocLocal(fctx, "cwb", { kind: "i32" });
    fctx.body.push({ op: "local.set", index: bLocal });
    fctx.body.push({ op: "local.set", index: aLocal });
    fctx.body.push({ op: "local.get", index: aLocal }); // val1 (a)
    fctx.body.push({ op: "local.get", index: bLocal }); // val2 (b)
    fctx.body.push({ op: "local.get", index: aLocal });
    fctx.body.push({ op: "local.get", index: bLocal });
    fctx.body.push({ op: "i32.lt_s" }); // cond a<b
    fctx.body.push({ op: "select" }); // a<b ? a : b
    fctx.body.push({ op: "local.set", index: countLocal });
  }

  // arr = dv.buf.data ; bo = dv.byteOffset.
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: boLocal });

  // if (count > 0) array.copy arr (bo+to*es) arr (bo+from*es) (count*es).
  {
    const copyArm: Instr[] = [
      { op: "local.get", index: arrLocal }, // dst
      { op: "local.get", index: boLocal }, // dstIdx = bo + to*es
      { op: "local.get", index: toLocal },
      { op: "local.get", index: esLocal },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.get", index: arrLocal }, // src
      { op: "local.get", index: boLocal }, // srcIdx = bo + from*es
      { op: "local.get", index: fromLocal },
      { op: "local.get", index: esLocal },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.get", index: countLocal }, // len = count*es
      { op: "local.get", index: esLocal },
      { op: "i32.mul" },
      { op: "array.copy", dstTypeIdx: byteArrIdx, srcTypeIdx: byteArrIdx },
    ];
    fctx.body.push({ op: "local.get", index: countLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: copyArm, else: [] });
  }

  // return recv.
  fctx.body.push({ op: "local.get", index: 0 });
  pushDefinedFunc(ctx, funcIdx, { name: helperName, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return funcIdx;
}

/**
 * (#2872 slice 2) Mint `__ta_dyn_reverse(recv, _v1, _v2, _v3, argc) →
 * externref` — `%TypedArray%.prototype.reverse` (§23.2.3.21) over a
 * `$__ta_dyn_view` receiver. In-place element swap: for `i` in
 * `[0, floor(len/2))` swap the `elemSize`-byte blocks at `i` and `len-1-i`
 * (byte-by-byte through a scratch), so it is element-kind-agnostic (raw byte
 * swap). Takes-no-args, but carries the SAME `(recv, v1, v2, v3, argc)`
 * signature as fill/copyWithin (the trailing three externref slots are unused)
 * so the calls.ts dispatcher two-arm handles all three uniformly. Returns
 * `recv` (`ta.reverse() === ta`). noJsHost lane only; idempotent.
 */
export function ensureTaDynReverseHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const helperName = "__ta_dyn_reverse";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const dynIdx = getOrRegisterTaDynViewType(ctx);
  const { vecTypeIdx: byteVecIdx, arrTypeIdx: byteArrIdx } = i32ByteVec(ctx);

  const params: ValType[] = [
    { kind: "externref" }, // recv
    { kind: "externref" }, // unused (arg0)
    { kind: "externref" }, // unused (arg1)
    { kind: "externref" }, // unused (arg2)
    { kind: "i32" }, // argc
  ];
  const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);

  const fctx = makeTaDynHelperFctx(helperName, [
    { name: "recv", type: { kind: "externref" } },
    { name: "v1", type: { kind: "externref" } },
    { name: "v2", type: { kind: "externref" } },
    { name: "v3", type: { kind: "externref" } },
    { name: "argc", type: { kind: "i32" } },
  ]);

  const dvLocal = allocLocal(fctx, "dv", { kind: "ref", typeIdx: dynIdx });
  const kindLocal = allocLocal(fctx, "kind", { kind: "i32" });
  const esLocal = allocLocal(fctx, "es", { kind: "i32" });
  const lenLocal = allocLocal(fctx, "len", { kind: "i32" });
  const arrLocal = allocLocal(fctx, "arr", { kind: "ref", typeIdx: byteArrIdx });
  const boLocal = allocLocal(fctx, "bo", { kind: "i32" });
  const iLocal = allocLocal(fctx, "i", { kind: "i32" });
  const jLocal = allocLocal(fctx, "j", { kind: "i32" });
  const halfLocal = allocLocal(fctx, "half", { kind: "i32" });
  const bLocal = allocLocal(fctx, "b", { kind: "i32" });
  const loOffLocal = allocLocal(fctx, "looff", { kind: "i32" });
  const hiOffLocal = allocLocal(fctx, "hioff", { kind: "i32" });
  const tmpLocal = allocLocal(fctx, "tmp", { kind: "i32" });

  pushTaDynMethodPreamble(ctx, fctx, dynIdx, dvLocal, kindLocal, esLocal, lenLocal);
  // arr = dv.buf.data ; bo = dv.byteOffset.
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: byteVecIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: boLocal });
  // half = len / 2 ; i = 0.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.div_s" });
  fctx.body.push({ op: "local.set", index: halfLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // outer: for (i=0; i<half; i++) { j = len-1-i; loOff = bo+i*es; hiOff = bo+j*es;
  //   for (b=0; b<es; b++) { tmp=arr[loOff+b]; arr[loOff+b]=arr[hiOff+b]; arr[hiOff+b]=tmp; } }
  {
    const innerBody: Instr[] = [];
    {
      const saved = fctx.body;
      fctx.body = innerBody;
      // b >= es → break inner
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "local.get", index: esLocal });
      fctx.body.push({ op: "i32.ge_s" });
      fctx.body.push({ op: "br_if", depth: 1 });
      // tmp = arr[loOff+b]
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: loOffLocal });
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "array.get_u", typeIdx: byteArrIdx });
      fctx.body.push({ op: "local.set", index: tmpLocal });
      // arr[loOff+b] = arr[hiOff+b]
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: loOffLocal });
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: hiOffLocal });
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "array.get_u", typeIdx: byteArrIdx });
      fctx.body.push({ op: "array.set", typeIdx: byteArrIdx });
      // arr[hiOff+b] = tmp
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "local.get", index: hiOffLocal });
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "array.set", typeIdx: byteArrIdx });
      // b++
      fctx.body.push({ op: "local.get", index: bLocal });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: bLocal });
      fctx.body.push({ op: "br", depth: 0 });
      fctx.body = saved;
    }
    const outerBody: Instr[] = [];
    {
      const saved = fctx.body;
      fctx.body = outerBody;
      // i >= half → break outer
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: "local.get", index: halfLocal });
      fctx.body.push({ op: "i32.ge_s" });
      fctx.body.push({ op: "br_if", depth: 1 });
      // j = len-1-i
      fctx.body.push({ op: "local.get", index: lenLocal });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: jLocal });
      // loOff = bo + i*es ; hiOff = bo + j*es
      fctx.body.push({ op: "local.get", index: boLocal });
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: "local.get", index: esLocal });
      fctx.body.push({ op: "i32.mul" });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: loOffLocal });
      fctx.body.push({ op: "local.get", index: boLocal });
      fctx.body.push({ op: "local.get", index: jLocal });
      fctx.body.push({ op: "local.get", index: esLocal });
      fctx.body.push({ op: "i32.mul" });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: hiOffLocal });
      // b = 0 ; inner loop
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: bLocal });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: innerBody }],
      });
      // i++
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: iLocal });
      fctx.body.push({ op: "br", depth: 0 });
      fctx.body = saved;
    }
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: outerBody }],
    });
  }

  // return recv.
  fctx.body.push({ op: "local.get", index: 0 });
  pushDefinedFunc(ctx, funcIdx, { name: helperName, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return funcIdx;
}

/**
 * (#3054 B2) Read an accessor prop off a `$__ta_view` receiver:
 *   `.byteLength`   = length (field0, element count) × elementSize
 *   `.byteOffset`   = byteOffset (field2)
 *   `.buffer`       = the SHARED buffer vec (field1) itself — object IDENTITY, so
 *                     `a.buffer === b.buffer` for sibling views is `ref.eq`-true
 *   `BYTES_PER_ELEMENT` = the per-view element size (constant)
 * `.length` is intentionally NOT handled here — the B1 local-type `.length` arm
 * (property-access.ts) already reads field0. `receiverExpr` is the view receiver
 * (compiled via `compileExpr`). Returns the result ValType, or null (declining).
 */
export function emitTaViewAccessor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  propName: string,
  receiverExpr: import("../ts-api.js").ts.Expression,
  compileExpr: (expr: import("../ts-api.js").ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;
  const { vecTypeIdx } = i32ByteVec(ctx);
  const elemSize = desc.bytes;

  // BYTES_PER_ELEMENT is a compile-time constant — drop the (side-effecting) recv.
  if (propName === "BYTES_PER_ELEMENT") {
    const rt = compileExpr(receiverExpr);
    if (rt !== null) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: ctx.fast ? "i32.const" : "f64.const", value: elemSize });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  // Compile the receiver (the $__ta_view ref) onto the stack.
  const rt = compileExpr(receiverExpr);
  if (rt?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: taViewTypeIdx });
  }

  if (propName === "buffer") {
    // Object identity: return the shared buffer vec (field1) directly.
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }
  if (propName === "byteLength") {
    // (#3054 C) Effective element count × elementSize. When a resizable buffer
    // type exists in the module, stash the receiver + derive the live length so a
    // resize is tracked; otherwise read field0 directly (BYTE-IDENTICAL to B2 —
    // no extra local, receiver stays on the stack).
    if (ctx.resizableAbTypeIdx >= 0) {
      const tvLocal = allocLocal(fctx, `__tav_bl_recv_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: taViewTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: tvLocal });
      pushTaViewEffectiveLen(ctx, fctx, tvLocal, taViewTypeIdx);
    } else {
      fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 0 });
    }
    if (elemSize !== 1) {
      fctx.body.push({ op: "i32.const", value: elemSize });
      fctx.body.push({ op: "i32.mul" });
    }
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }
  if (propName === "byteOffset") {
    fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }
  // Unknown prop — leave the stack balanced and decline.
  fctx.body.push({ op: "drop" });
  return null;
}

/**
 * (#3054 B1, Option A) Materialize a `$__ta_view` into a fresh NATIVE
 * `$__vec_<elem>` by byte-decoding every element little-endian, so consumers that
 * expect a native typed-vec receiver (the shared array-method dispatch, which
 * `ref.cast`s the receiver to the native vec type) work on a view without
 * trapping. The view ref must already be on the stack; a `(ref null
 * nativeVecTypeIdx)` is left on the stack. This is a de-aliasing COPY — writes by
 * a mutating method (`.fill`/`.set`) land in the copy, NOT back in the buffer (B1
 * never claimed proto-method write-through; B3 will teach the methods to operate
 * on the view directly). `nativeVecTypeIdx` is the element-typed vec
 * `resolveArrayInfo` picked for the receiver's TS type, and drives the element
 * coercion (integer vecs truncate the decoded f64; f64 vecs keep it).
 */
export function emitTaViewToVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  nativeVecTypeIdx: number,
): void {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  const nativeArrTypeIdx = getArrTypeIdxFromVec(ctx, nativeVecTypeIdx);
  const nativeArrDef = ctx.mod.types[nativeArrTypeIdx];
  if (!desc || nativeArrTypeIdx < 0 || !nativeArrDef || nativeArrDef.kind !== "array") {
    // Shouldn't happen for a registered view; leave the view ref as-is (a later
    // ref.cast will surface the mismatch rather than silently miscompiling).
    return;
  }
  const nativeElemKind = nativeArrDef.element.kind;
  const { arrTypeIdx: bufArrTypeIdx } = i32ByteVec(ctx);

  // view (on stack) → local
  const vLocal = allocLocal(fctx, `__tav_mv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: taViewTypeIdx });
  fctx.body.push({ op: "local.set", index: vLocal });
  // len = EFFECTIVE element count, not raw field0. (#3054 C×B3) An auto-length
  // view over a resizable buffer stores a -1 sentinel in field0 (C); reading it
  // raw would de-view -1 elements (empty native copy) and B3's write-back would
  // then iterate the same -1 and lose every write. pushTaViewEffectiveLen
  // resolves the sentinel to the live count (buf.length / elemSize) and is
  // byte-inert-gated: a module with no resizable AB (resizableAbTypeIdx < 0)
  // emits the identical raw field0 read. emitTaViewWriteBack MUST use the same
  // length so native-copy-len == write-back-len.
  const lenLocal = allocLocal(fctx, `__tav_mlen_${fctx.locals.length}`, { kind: "i32" });
  pushTaViewEffectiveLen(ctx, fctx, vLocal, taViewTypeIdx);
  fctx.body.push({ op: "local.set", index: lenLocal });
  // arr = view.buf.data ; base = view.byteOffset ; le = 1
  const arrLocal = allocLocal(fctx, `__tav_marr_${fctx.locals.length}`, { kind: "ref", typeIdx: bufArrTypeIdx });
  const { vecTypeIdx: bufVecTypeIdx } = i32ByteVec(ctx);
  fctx.body.push({ op: "local.get", index: vLocal });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  const baseLocal = allocLocal(fctx, `__tav_mbase_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vLocal });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: baseLocal });
  const leLocal = allocLocal(fctx, `__tav_mle_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });
  // nativeArr = array.new_default(len)
  const nArrLocal = allocLocal(fctx, `__tav_mnarr_${fctx.locals.length}`, { kind: "ref", typeIdx: nativeArrTypeIdx });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: nativeArrTypeIdx });
  fctx.body.push({ op: "local.set", index: nArrLocal });
  // for (i = 0; i < len; i++) nativeArr[i] = coerce(decode(base + i*width))
  const iLocal = allocLocal(fctx, `__tav_mi_${fctx.locals.length}`, { kind: "i32" });
  const offLocal = allocLocal(fctx, `__tav_moff_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });
  const isIntArr = nativeElemKind === "i8" || nativeElemKind === "i16" || nativeElemKind === "i32";
  const decodeInstrs: Instr[] = [];
  // offLocal = base + i*width
  decodeInstrs.push({ op: "local.get", index: baseLocal });
  decodeInstrs.push({ op: "local.get", index: iLocal });
  if (desc.bytes !== 1) {
    decodeInstrs.push({ op: "i32.const", value: desc.bytes });
    decodeInstrs.push({ op: "i32.mul" });
  }
  decodeInstrs.push({ op: "i32.add" });
  decodeInstrs.push({ op: "local.set", index: offLocal });
  // nativeArr[i] = <decoded>
  decodeInstrs.push({ op: "local.get", index: nArrLocal });
  decodeInstrs.push({ op: "local.get", index: iLocal });
  // NOTE: emitReadBytes pushes an f64 directly onto fctx.body; capture it by
  // temporarily swapping the body so the read lands inside decodeInstrs.
  const savedBody = fctx.body;
  fctx.body = decodeInstrs;
  emitReadBytes(
    ctx,
    fctx,
    { kind: "get", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    arrLocal,
    offLocal,
    leLocal,
    bufArrTypeIdx,
  );
  fctx.body = savedBody;
  if (isIntArr) decodeInstrs.push({ op: "i32.trunc_sat_f64_s" });
  decodeInstrs.push({ op: "array.set", typeIdx: nativeArrTypeIdx });
  // i++
  decodeInstrs.push({ op: "local.get", index: iLocal });
  decodeInstrs.push({ op: "i32.const", value: 1 });
  decodeInstrs.push({ op: "i32.add" });
  decodeInstrs.push({ op: "local.set", index: iLocal });
  decodeInstrs.push({ op: "br", depth: 0 });
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    ...decodeInstrs,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
  // struct.new nativeVec(len, nativeArr)
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: nArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: nativeVecTypeIdx });
}

/**
 * (#3054 B3) WRITE-THROUGH — the reverse of {@link emitTaViewToVec}. After a
 * mutating TypedArray prototype method (`.fill` / `.set` / `.sort` /
 * `.copyWithin` / `.reverse`) has run on the DE-VIEWED native `$__vec_<elem>`
 * copy (`matLocalIdx`), byte-encode every (possibly-mutated) element back into
 * the view's SHARED buffer (`view.buf.data`) at `byteOffset + i*width`,
 * little-endian — so the mutation is observable through the underlying buffer
 * and every sibling view / DataView over it (per §23.2/§25 IntegerIndexed
 * element semantics).
 *
 * WHY a write-back copy, not method-rewrites: B1's Option-A de-view is a
 * de-ALIASING copy — writes by a mutating method landed in the copy and were
 * LOST (never reached the buffer). Rewriting each TA method to operate directly
 * on the view would touch the whole array-method dispatch (high floor risk). The
 * write-back confines B3 to the already-de-viewed path: the copy round-trips
 * back into the buffer, restoring shared-backing semantics with a bounded,
 * additive change.
 *
 * Bit-exact round trip: the value read out of the native copy is the exact
 * numeric value the method computed (sort permutes, fill sets a constant, set
 * writes new values, copyWithin/reverse move existing ones — all already coerced
 * to the view's element domain). It is read with the native vec's element opcode
 * (signedness per the TA kind = `desc.signed`) and re-encoded through the SAME
 * {@link emitWriteBytes} engine {@link emitTaViewElementSet} uses, so encode ∘
 * decode is identity. `viewLocalIdx` holds the `$__ta_view` ref (the receiver
 * identifier's ORIGINAL local, saved before the de-view rebind) — reading
 * `view.byteOffset` (field2, B2-populated) makes windowed views write to the
 * correct absolute bytes. Read-only methods MUST NOT call this (the caller gates
 * on the mutating-method set).
 */
export function emitTaViewWriteBack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  taViewTypeIdx: number,
  viewLocalIdx: number,
  matLocalIdx: number,
  nativeVecTypeIdx: number,
): void {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  const nativeArrTypeIdx = getArrTypeIdxFromVec(ctx, nativeVecTypeIdx);
  const nativeArrDef = ctx.mod.types[nativeArrTypeIdx];
  if (!desc || nativeArrTypeIdx < 0 || !nativeArrDef || nativeArrDef.kind !== "array") {
    // Shouldn't happen for a registered view + resolved native vec. Skipping the
    // write-back merely reverts to B1's lost-write behaviour (correctness-safe),
    // never a miscompile.
    return;
  }
  const nativeElemKind = nativeArrDef.element.kind;
  const { vecTypeIdx: bufVecTypeIdx, arrTypeIdx: bufArrTypeIdx } = i32ByteVec(ctx);

  // len = EFFECTIVE element count == the native copy length produced by
  // emitTaViewToVec (which uses the SAME pushTaViewEffectiveLen). (#3054 C×B3)
  // For an auto-length view over a resizable buffer field0 is a -1 sentinel (C)
  // and must be resolved to the live count; byte-inert-gated so a non-resizable
  // module reads raw field0, identical to B3's original bytes.
  const lenLocal = allocLocal(fctx, `__tav_wblen_${fctx.locals.length}`, { kind: "i32" });
  pushTaViewEffectiveLen(ctx, fctx, viewLocalIdx, taViewTypeIdx);
  fctx.body.push({ op: "local.set", index: lenLocal });
  // bufArr = view.buf.data  (buf field1 → $__vec_i32_byte; .data is its field1).
  const bufArrLocal = allocLocal(fctx, `__tav_wbarr_${fctx.locals.length}`, { kind: "ref", typeIdx: bufArrTypeIdx });
  fctx.body.push({ op: "local.get", index: viewLocalIdx });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: bufArrLocal });
  // base = view.byteOffset (field2) — non-zero for a windowed view (B2).
  const baseLocal = allocLocal(fctx, `__tav_wbbase_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: viewLocalIdx });
  fctx.body.push({ op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: baseLocal });
  // matArr = matLocal.data (native vec field1).
  const matArrLocal = allocLocal(fctx, `__tav_wbmarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: nativeArrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: matLocalIdx });
  fctx.body.push({ op: "struct.get", typeIdx: nativeVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: matArrLocal });
  const leLocal = allocLocal(fctx, `__tav_wble_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });

  const iLocal = allocLocal(fctx, `__tav_wbi_${fctx.locals.length}`, { kind: "i32" });
  const offLocal = allocLocal(fctx, `__tav_wboff_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__tav_wbval_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  const stepInstrs: Instr[] = [];
  // off = base + i*width
  stepInstrs.push({ op: "local.get", index: baseLocal });
  stepInstrs.push({ op: "local.get", index: iLocal });
  if (desc.bytes !== 1) {
    stepInstrs.push({ op: "i32.const", value: desc.bytes });
    stepInstrs.push({ op: "i32.mul" });
  }
  stepInstrs.push({ op: "i32.add" });
  stepInstrs.push({ op: "local.set", index: offLocal });
  // val = f64(matArr[i]) — read the native element with the TA kind's signedness.
  stepInstrs.push({ op: "local.get", index: matArrLocal });
  stepInstrs.push({ op: "local.get", index: iLocal });
  if (nativeElemKind === "f64") {
    stepInstrs.push({ op: "array.get", typeIdx: nativeArrTypeIdx });
  } else if (nativeElemKind === "f32") {
    stepInstrs.push({ op: "array.get", typeIdx: nativeArrTypeIdx });
    stepInstrs.push({ op: "f64.promote_f32" });
  } else if (nativeElemKind === "i8" || nativeElemKind === "i16") {
    // PACKED int element (i8/i16): `array.get_s`/`array.get_u` sign/zero-extend
    // the sub-word storage per the view's signedness, then convert to f64.
    stepInstrs.push({ op: desc.signed ? "array.get_s" : "array.get_u", typeIdx: nativeArrTypeIdx });
    stepInstrs.push({ op: desc.signed ? "f64.convert_i32_s" : "f64.convert_i32_u" });
  } else {
    // NON-packed i32 element (Int32/Uint32 `i32_elem`): `array.get_s`/`_u` are
    // illegal on a full-width type — read with plain `array.get`, then apply the
    // signedness at the f64 convert. Uint32 needs `convert_i32_u` so a high-bit-
    // set i32 image maps to the >2^31 double.
    stepInstrs.push({ op: "array.get", typeIdx: nativeArrTypeIdx });
    stepInstrs.push({ op: desc.signed ? "f64.convert_i32_s" : "f64.convert_i32_u" });
  }
  stepInstrs.push({ op: "local.set", index: valLocal });
  // bufArr[off .. off+width] = encode(val)  — same LE engine as element set.
  // emitWriteBytes pushes onto fctx.body, so redirect it into stepInstrs.
  const savedBody = fctx.body;
  fctx.body = stepInstrs;
  emitWriteBytes(
    ctx,
    fctx,
    { kind: "set", bytes: desc.bytes, signed: desc.signed, float: desc.float },
    bufArrLocal,
    offLocal,
    valLocal,
    leLocal,
    bufArrTypeIdx,
  );
  fctx.body = savedBody;
  // i++
  stepInstrs.push({ op: "local.get", index: iLocal });
  stepInstrs.push({ op: "i32.const", value: 1 });
  stepInstrs.push({ op: "i32.add" });
  stepInstrs.push({ op: "local.set", index: iLocal });
  stepInstrs.push({ op: "br", depth: 0 });
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    ...stepInstrs,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
}

/**
 * (#3058) ValidateTypedArray (§10.4.5.11 IsTypedArrayOutOfBounds, §23.2.3.* step 1)
 * for a boxed `$__ta_dyn_view` reached through an `any` receiver: throw a TypeError
 * when the view is out-of-bounds over its (resizable) backing buffer. A
 * NON-length-tracking (fixed) view — stored length field0 ≥ 0 — is OOB when its
 * window no longer fits the buffer (`byteOffset + storedLen*elemSize(kind) >
 * buf.byteLength`, e.g. after `rab.resize(smaller)`). A length-tracking view (field0
 * sentinel `-1`) tracks the live buffer and is OOB only when its byteOffset itself
 * exceeds the buffer. Emitted at the TOP of every dyn-view proto-method arm (#3058
 * Bucket A) so the interleaved `assert.throws(TypeError, () => ta.<m>())` cases in
 * every `prototype/<m>/resizable-buffer.js` file pass. `dvLocal` holds the
 * `(ref $__ta_dyn_view)`.
 * Leaves the stack unchanged (throws or falls through).
 */
export function emitTaDynViewValidate(ctx: CodegenContext, fctx: FunctionContext, dvLocal: number): void {
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return;
  const { vecTypeIdx: bufVecTypeIdx } = i32ByteVec(ctx);
  const kindLocal = allocLocal(fctx, `__tdvv_k_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__tdvv_es_${fctx.locals.length}`, { kind: "i32" });
  const storedLocal = allocLocal(fctx, `__tdvv_s_${fctx.locals.length}`, { kind: "i32" });
  const bufLenLocal = allocLocal(fctx, `__tdvv_bl_${fctx.locals.length}`, { kind: "i32" });
  const byteOffLocal = allocLocal(fctx, `__tdvv_bo_${fctx.locals.length}`, { kind: "i32" });
  // kind → elemSize
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  // storedLen = field0
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: storedLocal });
  // bufLen = dv.buf.byteLength (buf field1 → $__vec_i32_byte; .length = field0)
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: bufLenLocal });
  // byteOffset = field2
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: byteOffLocal });
  // oob = storedLen >= 0 ? (byteOffset + storedLen*elemSize > bufLen)
  //                      : (byteOffset > bufLen)
  fctx.body.push({ op: "local.get", index: storedLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: byteOffLocal },
      { op: "local.get", index: storedLocal },
      { op: "local.get", index: esLocal },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.get", index: bufLenLocal },
      { op: "i32.gt_s" },
    ],
    else: [{ op: "local.get", index: byteOffLocal }, { op: "local.get", index: bufLenLocal }, { op: "i32.gt_s" }],
  });
  // if (oob) throw TypeError. emitThrowTypeError pushes onto fctx.body → capture it
  // into a then-arm buffer via a body-swap. Keep the outer body registered on
  // fctx.savedBodies for the swap so any late-import shift the throw triggers
  // (WASI TypeError constructor) patches the outer funcIdxs too.
  const throwArm: Instr[] = [];
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = throwArm;
  emitThrowTypeError(ctx, fctx, "TypeError: attempting to access out-of-bounds TypedArray");
  fctx.body = saved;
  fctx.savedBodies.pop();
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwArm, else: [] });
}

/**
 * (#3058) Materialize a boxed `$__ta_dyn_view` (runtime element `kind`) into a fresh
 * native `$__vec_f64` by byte-decoding every in-bounds element little-endian on the
 * runtime kind (the #3057 {@link emitDynDecodeDispatch} engine). Widening every kind
 * to f64 lets the read-side array-method impls (`at`/`indexOf`/`includes`/`join`/
 * `find*`/`every`/`some`/`forEach`/`reduce*`/`toLocaleString`) run over the copy
 * through the EXISTING f64-vec dispatch — the caller rebinds the receiver identifier
 * to this vec and re-enters `compileArrayMethodCall` (#3058 two-arm). `dvLocal` holds
 * the `(ref $__ta_dyn_view)`; the caller has already run {@link emitTaDynViewValidate}
 * (OOB → TypeError), so the effective length used here is the live in-bounds element
 * count ({@link pushTaDynViewEffectiveLen}, resolving the auto-length `-1` sentinel).
 * Leaves a `(ref $__vec_f64)` on the stack and returns its typeIdx.
 */
export function emitTaDynViewToVec(ctx: CodegenContext, fctx: FunctionContext, dvLocal: number): number {
  const dynIdx = ctx.taDynViewTypeIdx;
  const { vecTypeIdx: bufVecTypeIdx, arrTypeIdx: bufArrTypeIdx } = i32ByteVec(ctx);
  const f64VecIdx = getOrRegisterVecType(ctx, "f64", { kind: "f64" });
  const f64ArrIdx = getArrTypeIdxFromVec(ctx, f64VecIdx);

  const kindLocal = allocLocal(fctx, `__tdtv_k_${fctx.locals.length}`, { kind: "i32" });
  const esLocal = allocLocal(fctx, `__tdtv_es_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__tdtv_len_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__tdtv_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: bufArrTypeIdx });
  const baseLocal = allocLocal(fctx, `__tdtv_base_${fctx.locals.length}`, { kind: "i32" });
  const leLocal = allocLocal(fctx, `__tdtv_le_${fctx.locals.length}`, { kind: "i32" });
  const nArrLocal = allocLocal(fctx, `__tdtv_narr_${fctx.locals.length}`, { kind: "ref", typeIdx: f64ArrIdx });
  const iLocal = allocLocal(fctx, `__tdtv_i_${fctx.locals.length}`, { kind: "i32" });
  const offLocal = allocLocal(fctx, `__tdtv_off_${fctx.locals.length}`, { kind: "i32" });

  // kind → elemSize
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
  fctx.body.push({ op: "local.set", index: kindLocal });
  pushElemSizeForKind(fctx, kindLocal);
  fctx.body.push({ op: "local.set", index: esLocal });
  // len = effective (live, in-bounds) element count.
  pushTaDynViewEffectiveLen(ctx, fctx, dvLocal, kindLocal, esLocal);
  fctx.body.push({ op: "local.set", index: lenLocal });
  // arr = dv.buf.data ; base = dv.byteOffset ; le = 1
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 });
  fctx.body.push({ op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: arrLocal });
  fctx.body.push({ op: "local.get", index: dvLocal });
  fctx.body.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: baseLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: leLocal });
  // nArr = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: f64ArrIdx });
  fctx.body.push({ op: "local.set", index: nArrLocal });
  // for (i=0; i<len; i++) nArr[i] = decode(base + i*elemSize)
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });
  const decodeInstrs = emitDynDecodeDispatch(ctx, fctx, kindLocal, arrLocal, offLocal, leLocal, bufArrTypeIdx);
  const stepInstrs: Instr[] = [];
  // off = base + i*elemSize (runtime elemSize)
  stepInstrs.push({ op: "local.get", index: baseLocal });
  stepInstrs.push({ op: "local.get", index: iLocal });
  stepInstrs.push({ op: "local.get", index: esLocal });
  stepInstrs.push({ op: "i32.mul" });
  stepInstrs.push({ op: "i32.add" });
  stepInstrs.push({ op: "local.set", index: offLocal });
  // nArr[i] = <decode(off) → f64>
  stepInstrs.push({ op: "local.get", index: nArrLocal });
  stepInstrs.push({ op: "local.get", index: iLocal });
  stepInstrs.push(...decodeInstrs);
  stepInstrs.push({ op: "array.set", typeIdx: f64ArrIdx });
  // i++
  stepInstrs.push({ op: "local.get", index: iLocal });
  stepInstrs.push({ op: "i32.const", value: 1 });
  stepInstrs.push({ op: "i32.add" });
  stepInstrs.push({ op: "local.set", index: iLocal });
  stepInstrs.push({ op: "br", depth: 0 });
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    ...stepInstrs,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
  // struct.new $__vec_f64(len, nArr)
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: nArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: f64VecIdx });
  return f64VecIdx;
}

/**
 * (#2639) Stage a native DataView's bytes into the linear write scratch so
 * `node:fs` `writeSync(fd, dv)` can hand the shim a (ptr, len) pair.
 *
 * The DataView arg (an externref / GC ref already produced by compiling the
 * argument expression — its `recvType` passed in) is resolved via
 * {@link recoverDvBacking} to its i32_byte backing array + base byte offset +
 * view byte length, mirroring exactly what the DataView accessors use. Then it
 * copies `viewLen` bytes from `arr[base + j]` (masked to a byte) into
 * `scratch[scratchStart + j]`. The DataView's backing array is `i32_byte` (one
 * i32 per byte, 0..255), so each element is `& 0xff`-ed before the byte store.
 *
 * Returns the i32 local holding the view byte length (the count to write), or
 * `-1` when the receiver isn't a resolvable DataView/ArrayBuffer view. The
 * receiver value must already be on the stack (its `recvType` is consumed here).
 * Memory is assumed already grown for `[scratchStart, scratchStart+viewLen)` —
 * the caller grows it (it must, since the length is only known at runtime).
 */
export function emitDataViewToWriteScratch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType | null,
  scratchStart: number,
): number {
  const { vecTypeIdx, arrTypeIdx } = i32ByteVec(ctx);
  if (arrTypeIdx < 0) return -1;

  const arrLocal = allocLocal(fctx, `__dvw_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, `__dvw_base_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__dvw_len_${fctx.locals.length}`, { kind: "i32" });
  if (!recoverDvBacking(ctx, fctx, recvType, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, lenLocal)) {
    return -1;
  }

  // Grow linear memory so [scratchStart, scratchStart + len) is addressable.
  const needPagesLocal = allocLocal(fctx, `__dvw_pages_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: scratchStart });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.const", value: 65535 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.const", value: 16 });
  fctx.body.push({ op: "i32.shr_u" });
  fctx.body.push({ op: "local.set", index: needPagesLocal });
  fctx.body.push({ op: "local.get", index: needPagesLocal });
  fctx.body.push({ op: "memory.size" });
  fctx.body.push({ op: "i32.gt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: needPagesLocal },
      { op: "memory.size" },
      { op: "i32.sub" },
      { op: "memory.grow" },
      { op: "drop" },
    ],
  });

  // for j in [0, len): scratch[scratchStart + j] = arr[base + j] & 0xff
  const jLocal = allocLocal(fctx, `__dvw_j_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: jLocal });
  const loopBody: Instr[] = [
    { op: "local.get", index: jLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    // addr = scratchStart + j
    { op: "i32.const", value: scratchStart },
    { op: "local.get", index: jLocal },
    { op: "i32.add" },
    // value = arr[base + j] & 0xff  ((#2835) packed i8 → unsigned read)
    { op: "local.get", index: arrLocal },
    { op: "local.get", index: baseLocal },
    { op: "local.get", index: jLocal },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: arrTypeIdx },
    { op: "i32.const", value: 0xff },
    { op: "i32.and" },
    { op: "i32.store8", align: 0, offset: 0 },
    { op: "local.get", index: jLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: jLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  return lenLocal;
}

/**
 * (#3058) Resizable-ArrayBuffer helper exports for the JS-host runtime.
 *
 * The JS-host lane lowers `new ArrayBuffer(n, {maxByteLength})` to the same
 * `$__resizable_ab` WasmGC subtype the standalone lane uses (#3054 C), but the
 * host-lane method/getter dispatch happens in the JS runtime
 * (`__extern_method_call` / `__extern_get`), which cannot touch WasmGC struct
 * fields directly. Two exports bridge that:
 *
 *   __ab_max_len(externref) -> f64   — maxByteLength (field 2) for a
 *       `$__resizable_ab` instance; -1 for a fixed buffer / any other value.
 *       The -1 sentinel doubles as the `resizable` discriminator.
 *   __rab_resize(externref, i32) -> i32 — the §25.1.6.4 resize core: realloc
 *       the backing i8 array to newLen, copy min(oldLen, newLen) bytes, swap
 *       `data` + `length` IN PLACE on the same struct (views/DataView fallback
 *       observe the swap through `__dv_byte_len`). Status: 0 ok · 1 receiver
 *       not resizable (TypeError) · 2 newLen out of range (RangeError). The
 *       runtime arm pre-validates per spec order and maps statuses to host
 *       error types; the in-function checks are a defensive backstop.
 *
 * Host lane only: standalone/WASI resize compiles to the inline native emitter
 * (`emitArrayBufferResize`) and has no JS runtime to call exports — the gate
 * keeps the standalone lane byte-identical. Modules that never construct a
 * resizable buffer (`ctx.resizableAbTypeIdx < 0`) are byte-identical too.
 */
export function emitResizableAbExports(ctx: CodegenContext): void {
  if (ctx.wasi || ctx.standalone) return; // JS-host lane only (see doc comment)
  const rabTypeIdx = ctx.resizableAbTypeIdx;
  if (rabTypeIdx < 0) return;
  const mod = ctx.mod;
  const byteVecTypeIdx = ctx.vecTypeMap.get("i32_byte");
  if (byteVecTypeIdx === undefined) return;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
  if (arrTypeIdx < 0) return;

  // __ab_max_len(externref) -> f64
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$__ab_max_len_type");
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: rabTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: rabTypeIdx },
          { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
          { op: "f64.convert_i32_s" },
          { op: "return" },
        ],
        else: [],
      },
      { op: "f64.const", value: -1 },
    ];
    mod.functions.push({
      name: "__ab_max_len",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__ab_max_len", desc: { kind: "func", index: funcIdx } });
  }

  // __rab_resize(externref, i32) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }], "$__rab_resize_type");
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    // locals: 2 = anyref scratch, 3 = (ref null $__resizable_ab), 4 = (ref null
    // $__arr_i32_byte) new backing, 5 = i32 copyLen.
    const body: Instr[] = [
      // if receiver is not a $__resizable_ab → status 1 (TypeError in the runtime arm)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: rabTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
        else: [],
      },
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: rabTypeIdx },
      { op: "local.set", index: 3 },
      // if newLen < 0 || newLen > maxByteLength (field 2) → status 2 (RangeError)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
      { op: "i32.gt_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 2 }, { op: "return" }],
        else: [],
      },
      // copyLen = min(oldLen = field 0, newLen)
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // newArr = array.new_default $__arr_i32_byte (newLen)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: 4 },
      // array.copy newArr[0..copyLen) ← rab.data[0..copyLen)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 5 },
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
      // swap data + length IN PLACE (same struct → views observe the resize)
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.set", typeIdx: rabTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 0 },
    ];
    mod.functions.push({
      name: "__rab_resize",
      typeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__rab", type: { kind: "ref_null", typeIdx: rabTypeIdx } },
        { name: "__newarr", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: "__copylen", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__rab_resize", desc: { kind: "func", index: funcIdx } });
  }
}
