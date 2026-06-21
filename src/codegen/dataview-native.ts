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
 * array of i32, one byte per element, values 0..255). Multi-byte accessors
 * honour the `littleEndian` flag at runtime.
 *
 * Backing-store representation:
 *   ArrayBuffer / DataView  → vec "i32_byte"  (one i32 per byte, 0..255)
 *   Uint8Array (native)     → vec "i8_byte"   (packed bytes, unsigned reads)
 *
 * The receiver (`this`) of a DataView accessor is an externref holding the
 * i32_byte vec; we `any.convert_extern` + `ref.cast` to recover the struct.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./index.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** DataView accessor descriptor parsed from a method name like "getUint32". */
interface DvAccessor {
  kind: "get" | "set";
  /** Number of bytes the element occupies (1, 2, 4, 8). */
  bytes: number;
  /** Signed integer read (Int8/Int16/Int32) — sign-extend on read. */
  signed: boolean;
  /** Float element (Float32/Float64) — reinterpret bits. */
  float: boolean;
}

const DV_ACCESSORS: Record<string, DvAccessor> = {
  getInt8: { kind: "get", bytes: 1, signed: true, float: false },
  getUint8: { kind: "get", bytes: 1, signed: false, float: false },
  getInt16: { kind: "get", bytes: 2, signed: true, float: false },
  getUint16: { kind: "get", bytes: 2, signed: false, float: false },
  getInt32: { kind: "get", bytes: 4, signed: true, float: false },
  getUint32: { kind: "get", bytes: 4, signed: false, float: false },
  getFloat32: { kind: "get", bytes: 4, signed: false, float: true },
  getFloat64: { kind: "get", bytes: 8, signed: false, float: true },
  setInt8: { kind: "set", bytes: 1, signed: true, float: false },
  setUint8: { kind: "set", bytes: 1, signed: false, float: false },
  setInt16: { kind: "set", bytes: 2, signed: true, float: false },
  setUint16: { kind: "set", bytes: 2, signed: false, float: false },
  setInt32: { kind: "set", bytes: 4, signed: true, float: false },
  setUint32: { kind: "set", bytes: 4, signed: false, float: false },
  setFloat32: { kind: "set", bytes: 4, signed: false, float: true },
  setFloat64: { kind: "set", bytes: 8, signed: false, float: true },
};

export function isDataViewAccessor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DV_ACCESSORS, name);
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
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;

  // Recover the source vec struct from the receiver (externref → struct).
  const srcVecLocal = allocLocal(fctx, `__abs_src_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: vecTypeIdx,
  });
  const recvType = compileExpr(receiver);
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    if ("typeIdx" in recvType && recvType.typeIdx !== vecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
    }
  } else {
    return null;
  }
  fctx.body.push({ op: "local.set", index: srcVecLocal } as Instr);

  // srcLen = src.length (field 0); srcArr = src.data (field 1).
  const srcLenLocal = allocLocal(fctx, `__abs_srclen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: srcVecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: srcLenLocal } as Instr);
  const srcArrLocal = allocLocal(fctx, `__abs_srcarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: srcVecLocal } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: srcArrLocal } as Instr);

  // begin (default 0). Spec §25.1.5.3 steps 5-7: ToIntegerOrInfinity, then
  // negative = max(srcLen + begin, 0), positive = min(begin, srcLen).
  const beginLocal = allocLocal(fctx, `__abs_begin_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 1) {
    compileExpr(args[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: beginLocal } as Instr);
  emitNormalizeIndex(fctx, beginLocal, srcLenLocal);

  // end (default srcLen). Same clamp/negate.
  const endLocal = allocLocal(fctx, `__abs_end_${fctx.locals.length}`, { kind: "i32" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    fctx.body.push({ op: "local.set", index: endLocal } as Instr);
    emitNormalizeIndex(fctx, endLocal, srcLenLocal);
  } else {
    fctx.body.push({ op: "local.get", index: srcLenLocal } as Instr);
    fctx.body.push({ op: "local.set", index: endLocal } as Instr);
  }

  // sliceLen = max(end - begin, 0)
  const sliceLenLocal = allocLocal(fctx, `__abs_slen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: endLocal } as Instr);
  fctx.body.push({ op: "local.get", index: beginLocal } as Instr);
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "local.set", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: sliceLenLocal } as Instr],
    else: [],
  });

  // dstArr = new i32[sliceLen]
  const dstArrLocal = allocLocal(fctx, `__abs_dstarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: dstArrLocal } as Instr);

  // for (i = 0; i < sliceLen; i++) dstArr[i] = srcArr[begin + i]
  const iLocal = allocLocal(fctx, `__abs_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: iLocal } as Instr);
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: sliceLenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    { op: "local.get", index: dstArrLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: srcArrLocal } as Instr,
    { op: "local.get", index: beginLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "array.get", typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  // struct.new vec(sliceLen, dstArr); return as externref (matches the
  // externref local that user code declares for the slice() result).
  fctx.body.push({ op: "local.get", index: sliceLenLocal } as Instr);
  fctx.body.push({ op: "local.get", index: dstArrLocal } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx } as Instr);
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  return { kind: "externref" };
}

/**
 * Normalize an index in-place per spec §25.1.5.3:
 *   if (idx < 0) idx = max(srcLen + idx, 0);
 *   else         idx = min(idx, srcLen);
 */
function emitNormalizeIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
  fctx.body.push({ op: "local.get", index: idxLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  const negBranch: Instr[] = [
    // idx = srcLen + idx; if (idx < 0) idx = 0
    { op: "local.get", index: lenLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: idxLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: idxLocal } as Instr],
      else: [],
    },
  ];
  const posBranch: Instr[] = [
    // if (idx > srcLen) idx = srcLen
    { op: "local.get", index: idxLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: lenLocal } as Instr, { op: "local.set", index: idxLocal } as Instr],
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
function i32ByteVec(ctx: CodegenContext): { vecTypeIdx: number; arrTypeIdx: number } {
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" });
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
  const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" });
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__dv_window",
    fields: [
      { name: "buf", type: { kind: "ref_null", typeIdx: vecTypeIdx }, mutable: false },
      { name: "byteOffset", type: { kind: "i32" }, mutable: false },
      { name: "byteLength", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.dvWindowTypeIdx = idx;
  ctx.structMap.set("__dv_window", idx);
  ctx.typeIdxToStructName.set(idx, "__dv_window");
  ctx.structFields.set("__dv_window", [
    { name: "buf", type: { kind: "ref_null" as const, typeIdx: vecTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
    { name: "byteLength", type: { kind: "i32" as const }, mutable: false },
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
): boolean {
  const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
  // Normalize the receiver to an anyref-castable `(ref any)` on the stack.
  if (recvType && recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
  } else if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    // already a gc ref
  } else {
    return false;
  }
  // Stash the anyref in a temp so we can test then cast.
  const anyLocal = allocLocal(fctx, `__dvn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal } as Instr);

  const winBranch: Instr[] = [
    // buf = (cast $__dv_window).buf ; base = .byteOffset
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: arrLocal } as Instr,
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
    { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: baseLocal } as Instr,
  ];
  if (viewLenLocal >= 0) {
    // viewLen = (cast $__dv_window).byteLength
    winBranch.push(
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx: dvWinTypeIdx } as Instr,
      { op: "struct.get", typeIdx: dvWinTypeIdx, fieldIdx: 2 } as Instr,
      { op: "local.set", index: viewLenLocal } as Instr,
    );
  }
  const vecBranch: Instr[] = [
    // bare vec: arr = .data ; base = 0
    { op: "local.get", index: anyLocal } as Instr,
    { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: arrLocal } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: baseLocal } as Instr,
  ];
  if (viewLenLocal >= 0) {
    // viewLen = array.len(arr)  (offset-0 view spans the whole backing buffer)
    vecBranch.push(
      { op: "local.get", index: arrLocal } as Instr,
      { op: "array.len" } as Instr,
      { op: "local.set", index: viewLenLocal } as Instr,
    );
  }
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: dvWinTypeIdx } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: winBranch, else: vecBranch } as Instr);
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
  if (noJsHost(ctx)) emitWasiErrorConstructor(ctx, "RangeError", 1);
  addStringConstantGlobal(ctx, DV_RANGE_MESSAGE);
  const ctorIdx = ensureLateImport(ctx, "__new_RangeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  const tagIdx = ensureExnTag(ctx);
  const instrs: Instr[] = [...stringConstantExternrefInstrs(ctx, DV_RANGE_MESSAGE)];
  if (ctorIdx !== undefined) instrs.push({ op: "call", funcIdx: ctorIdx } as Instr);
  instrs.push({ op: "throw", tagIdx } as Instr);
  return instrs;
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
  // native-regex's cap-throw). When `dv.byteLength` is unavailable we skip the
  // bounds check, so only register the template when we will emit it.
  const rangeThrow = emitDataViewRangeError(ctx);
  flushLateImportShifts(ctx, fctx);

  // Recover the i32_byte backing array AND the view's base byte offset from the
  // receiver. `dv` may be a `$__dv_window` wrapper (windowed view → base =
  // ctor byteOffset, sharing the parent's array) or a bare `$__vec_i32_byte`
  // (offset-0 view / ArrayBuffer → base = 0). (#2159/#38). `viewLenLocal`
  // receives the view's byte length for the #2199 bounds check.
  const arrLocal = allocLocal(fctx, `__dvn_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const baseLocal = allocLocal(fctx, `__dvn_base_${fctx.locals.length}`, { kind: "i32" });
  const viewLenLocal = allocLocal(fctx, `__dvn_vlen_${fctx.locals.length}`, { kind: "i32" });
  const recvType = compileExpr(receiver);
  if (!recoverDvBacking(ctx, fctx, recvType, arrLocal, baseLocal, vecTypeIdx, arrTypeIdx, viewLenLocal)) {
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
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: reqLocal });

  const getIdxLocal = allocLocal(fctx, `__dvn_gidx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
  fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  fctx.body.push({ op: "local.set", index: getIdxLocal });

  // (#2199b) The two §24.2.1.2 SetViewValue / §24.2.1.1 GetViewValue throws fire
  // at DIFFERENT points relative to `ToNumber(value)` for a setter:
  //   - INDEX throw (step 4, ToIndex): `isNaN(req) || getIndex < 0` — fires
  //     BEFORE `ToNumber(value)` (test: index-check-before-value-conversion).
  //   - BOUNDS throw (step 8): `getIndex + elementSize > viewByteLength` — fires
  //     AFTER `ToNumber(value)` runs (test: range-check-after-value-conversion;
  //     a `value` whose valueOf/Symbol throws must throw FIRST). i64 math so the
  //     +Infinity-saturated `getIndex=i32.MAX` + bytes can't overflow.
  const emitIndexThrow = (): void => {
    fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
    fctx.body.push({ op: "local.get", index: reqLocal } as Instr);
    fctx.body.push({ op: "f64.ne" } as Instr); // req != req  (NaN)
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    fctx.body.push({ op: "i32.lt_s" } as Instr); // getIndex < 0
    fctx.body.push({ op: "i32.or" } as Instr);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] } as Instr);
  };
  const emitBoundsThrow = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "i64.extend_i32_s" } as Instr);
    fctx.body.push({ op: "i64.const", value: BigInt(acc.bytes) } as Instr);
    fctx.body.push({ op: "i64.add" } as Instr);
    fctx.body.push({ op: "local.get", index: viewLenLocal } as Instr);
    fctx.body.push({ op: "i64.extend_i32_s" } as Instr);
    fctx.body.push({ op: "i64.gt_s" } as Instr); // (getIndex + bytes) > viewLen
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rangeThrow, else: [] } as Instr);
  };

  // off = getIndex + base (absolute byte in the shared buffer). Computed after
  // the bounds throw at each call site.
  const offLocal = allocLocal(fctx, `__dvn_off_${fctx.locals.length}`, { kind: "i32" });
  const setOff = (): void => {
    fctx.body.push({ op: "local.get", index: getIdxLocal } as Instr);
    fctx.body.push({ op: "local.get", index: baseLocal } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
    fctx.body.push({ op: "local.set", index: offLocal });
  };

  if (acc.kind === "get") {
    // Getter has no value to convert, so both throws are adjacent (ToIndex then
    // bounds), before the read. littleEndian is the 2nd arg.
    emitIndexThrow();
    emitBoundsThrow();
    setOff();
    const leLocal = emitLittleEndianFlag(ctx, fctx, args[1], compileExpr);
    emitReadBytes(ctx, fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    return { kind: "get", result: { kind: "f64" } };
  }

  // Setter: ToIndex throw → ToNumber(value) (+littleEndian) → bounds throw →
  // write. Compiling the value/le runs their valueOf/Symbol coercions, which can
  // throw and MUST do so after the index check but before the bounds check.
  emitIndexThrow();
  const valLocal = allocLocal(fctx, `__dvn_val_${fctx.locals.length}`, { kind: "f64" });
  if (args.length >= 2) {
    compileExpr(args[1]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: valLocal });
  const leLocal = emitLittleEndianFlag(ctx, fctx, args[2], compileExpr);
  emitBoundsThrow();
  setOff();
  emitWriteBytes(ctx, fctx, acc, arrLocal, offLocal, valLocal, leLocal, arrTypeIdx);
  return { kind: "set" };
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
    const t = compileExpr(leArg, { kind: "i32" });
    // If the boolean compiled to f64 (boxed), normalize to i32 truthiness.
    if (t && t.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 } as Instr);
      fctx.body.push({ op: "f64.ne" } as Instr);
    } else if (t && t.kind !== "i32") {
      // Non-i32, non-f64 (e.g. externref) — drop and default to big endian.
      fctx.body.push({ op: "drop" } as Instr);
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  }
  fctx.body.push({ op: "local.set", index: leLocal });
  return leLocal;
}

/** Push `arr[off + k]` (unsigned byte 0..255) as i32. */
function pushByte(fctx: FunctionContext, arrLocal: number, offLocal: number, k: number, arrTypeIdx: number): void {
  fctx.body.push({ op: "local.get", index: arrLocal } as Instr);
  fctx.body.push({ op: "local.get", index: offLocal } as Instr);
  if (k !== 0) {
    fctx.body.push({ op: "i32.const", value: k } as Instr);
    fctx.body.push({ op: "i32.add" } as Instr);
  }
  fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
  // Mask to a byte — the backing array holds 0..255 already, but defensively
  // keep only the low 8 bits so sign/overflow can't leak in.
  fctx.body.push({ op: "i32.const", value: 0xff } as Instr);
  fctx.body.push({ op: "i32.and" } as Instr);
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
      fctx.body.push({ op: "i32.const", value: 24 } as Instr);
      fctx.body.push({ op: "i32.shl" } as Instr);
      fctx.body.push({ op: "i32.const", value: 24 } as Instr);
      fctx.body.push({ op: "i32.shr_s" } as Instr);
      fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
    } else {
      fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
    }
    return;
  }

  if (acc.bytes === 8) {
    // Float64 only — assemble an i64 then f64.reinterpret_i64.
    emitReadI64(fctx, acc, arrLocal, offLocal, leLocal, arrTypeIdx);
    fctx.body.push({ op: "f64.reinterpret_i64" } as Instr);
    return;
  }

  // 2 or 4 byte values — assemble an i32 with a runtime endianness branch.
  // Result i32 is left on the stack, then converted to f64.
  emitReadI32(fctx, acc.bytes, arrLocal, offLocal, leLocal, arrTypeIdx);

  if (acc.float) {
    // Float32: reinterpret the 32-bit pattern, then promote to f64.
    fctx.body.push({ op: "f32.reinterpret_i32" } as Instr);
    fctx.body.push({ op: "f64.promote_f32" } as Instr);
    return;
  }

  if (acc.signed) {
    if (acc.bytes === 2) {
      // sign-extend 16-bit: (x << 16) >> 16
      fctx.body.push({ op: "i32.const", value: 16 } as Instr);
      fctx.body.push({ op: "i32.shl" } as Instr);
      fctx.body.push({ op: "i32.const", value: 16 } as Instr);
      fctx.body.push({ op: "i32.shr_s" } as Instr);
    }
    fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
  } else {
    fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
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

  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
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
    const seq: Instr[] = [{ op: "local.get", index: arrLocal } as Instr, { op: "local.get", index: offLocal } as Instr];
    if (k !== 0) {
      seq.push({ op: "i32.const", value: k } as Instr);
      seq.push({ op: "i32.add" } as Instr);
    }
    seq.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    seq.push({ op: "i32.const", value: 0xff } as Instr);
    seq.push({ op: "i32.and" } as Instr);
    return seq;
  };

  // Accumulate: for each byte k (0..bytes-1), shift = little ? k*8 : (bytes-1-k)*8
  for (let k = 0; k < bytes; k++) {
    const shift = little ? k * 8 : (bytes - 1 - k) * 8;
    out.push(...byteAt(k));
    if (shift !== 0) {
      out.push({ op: "i32.const", value: shift } as Instr);
      out.push({ op: "i32.shl" } as Instr);
    }
    if (k > 0) out.push({ op: "i32.or" } as Instr);
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
        { op: "local.get", index: arrLocal } as Instr,
        { op: "local.get", index: offLocal } as Instr,
      ];
      if (k !== 0) {
        seq.push({ op: "i32.const", value: k } as Instr);
        seq.push({ op: "i32.add" } as Instr);
      }
      seq.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
      seq.push({ op: "i32.const", value: 0xff } as Instr);
      seq.push({ op: "i32.and" } as Instr);
      seq.push({ op: "i64.extend_i32_u" } as Instr);
      return seq;
    };
    for (let k = 0; k < 8; k++) {
      const shift = little ? k * 8 : (7 - k) * 8;
      out.push(...byteAt(k));
      if (shift !== 0) {
        out.push({ op: "i64.const", value: BigInt(shift) } as Instr);
        out.push({ op: "i64.shl" } as Instr);
      }
      if (k > 0) out.push({ op: "i64.or" } as Instr);
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
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
  out.push({ op: "local.get", index: arrLocal } as Instr);
  out.push({ op: "local.get", index: offLocal } as Instr);
  if (k !== 0) {
    out.push({ op: "i32.const", value: k } as Instr);
    out.push({ op: "i32.add" } as Instr);
  }
  out.push(...byte);
  out.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
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
        { op: "local.get", index: valLocal } as Instr,
        { op: "i64.trunc_sat_f64_s" } as Instr,
        { op: "i32.wrap_i64" } as Instr,
        { op: "i32.const", value: 0xff } as Instr,
        { op: "i32.and" } as Instr,
      ],
      arrTypeIdx,
    );
    fctx.body.push(...out);
    return;
  }

  if (acc.bytes === 8) {
    // Float64: bits = i64.reinterpret_f64(val); store 8 bytes.
    const bitsLocal = allocLocal(fctx, `__dvn_bits64_${fctx.locals.length}`, { kind: "i64" });
    fctx.body.push({ op: "local.get", index: valLocal } as Instr);
    fctx.body.push({ op: "i64.reinterpret_f64" } as Instr);
    fctx.body.push({ op: "local.set", index: bitsLocal } as Instr);
    const storeAll = (little: boolean): Instr[] => {
      const out: Instr[] = [];
      for (let k = 0; k < 8; k++) {
        const shift = little ? k * 8 : (7 - k) * 8;
        const byte: Instr[] = [{ op: "local.get", index: bitsLocal } as Instr];
        if (shift !== 0) {
          byte.push({ op: "i64.const", value: BigInt(shift) } as Instr);
          byte.push({ op: "i64.shr_u" } as Instr);
        }
        byte.push({ op: "i32.wrap_i64" } as Instr);
        byte.push({ op: "i32.const", value: 0xff } as Instr);
        byte.push({ op: "i32.and" } as Instr);
        emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
      }
      return out;
    };
    fctx.body.push({ op: "local.get", index: leLocal } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: storeAll(true),
      else: storeAll(false),
    });
    return;
  }

  // 2 or 4 byte integers (or Float32) — derive an i32 bit pattern.
  const bitsLocal = allocLocal(fctx, `__dvn_bits32_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: valLocal } as Instr);
  if (acc.float) {
    // Float32: demote f64→f32, reinterpret to i32 bits.
    fctx.body.push({ op: "f32.demote_f64" } as Instr);
    fctx.body.push({ op: "i32.reinterpret_f32" } as Instr);
  } else {
    // Integer: the spec (SetValueInBuffer → ToInt{8,16,32}/ToUint{8,16,32}) is
    // MODULAR (`value mod 2^(8*bytes)`), not saturating. `i32.trunc_sat_f64_s`
    // *clamps* (e.g. setUint32(_, 4_000_000_000) → 0x7FFFFFFF), which is wrong
    // for any value ≥ 2^31. Truncate toward zero into an i64 first, then
    // `i32.wrap_i64` keeps the low 32 bits — i.e. `value mod 2^32`. Only the low
    // `acc.bytes` of those are stored below, giving the correct modular result
    // for 2- and 4-byte signed/unsigned setters across the ±2^53 integer range
    // that conformance exercises.
    fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
    fctx.body.push({ op: "i32.wrap_i64" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: bitsLocal } as Instr);

  const storeAll = (little: boolean): Instr[] => {
    const out: Instr[] = [];
    for (let k = 0; k < acc.bytes; k++) {
      const shift = little ? k * 8 : (acc.bytes - 1 - k) * 8;
      const byte: Instr[] = [{ op: "local.get", index: bitsLocal } as Instr];
      if (shift !== 0) {
        byte.push({ op: "i32.const", value: shift } as Instr);
        byte.push({ op: "i32.shr_u" } as Instr);
      }
      byte.push({ op: "i32.const", value: 0xff } as Instr);
      byte.push({ op: "i32.and" } as Instr);
      emitStoreByte(out, arrLocal, offLocal, k, byte, arrTypeIdx);
    }
    return out;
  };
  fctx.body.push({ op: "local.get", index: leLocal } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: storeAll(true),
    else: storeAll(false),
  });
}
