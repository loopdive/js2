// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) The native `ArrayBuffer` construction and accessor sequences
 * (ECMA-262 §25.1), shared by the two callers that emit them:
 *
 *  - legacy codegen, which emits them inline at the source site
 *    (`new-indexed.ts`, `property-access-dispatch.ts`), and
 *  - the IR's externref-ABI adapters (`ir-native-buffer.ts`), which wrap each
 *    one in a plain helper function.
 *
 * Each emitter takes its operand from the stack (or from a local the caller
 * owns) so one instruction sequence serves both, and the IR and legacy paths
 * can never disagree about what a buffer is.
 *
 * Representation: a fixed buffer is a `$__vec_i32_byte` (packed i8 data,
 * field 0 = byte length, -1 once detached); a resizable one is its subtype
 * `$__resizable_ab`, whose field 2 is `maxByteLength`.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { buildThrowJsErrorInstrs } from "../expressions/helpers.js";

function pushRangeErrorIf(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "RangeError", message, { flush: fctx }),
    else: [],
  });
}

/**
 * §25.1.3.1 step 2, `ToIndex(length)`: f64 on the stack → i32 byte length.
 * NaN maps to 0 and fractions truncate; a negative length or one past the
 * i32-indexed backing's 2^31-1 ceiling throws a RangeError before
 * `array.new_default` could trap.
 */
export function emitArrayBufferLengthToIndex(ctx: CodegenContext, fctx: FunctionContext): void {
  const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: lenF64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "f64.eq" }); // false only for NaN
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: lenF64Local });
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "f64.const", value: 2147483647 });
  fctx.body.push({ op: "f64.gt" });
  fctx.body.push({ op: "i32.or" });
  pushRangeErrorIf(ctx, fctx, "RangeError: Invalid array buffer length");
  fctx.body.push({ op: "local.get", index: lenF64Local });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
}

/** i32 byte length on the stack → a fresh zero-filled fixed buffer. */
export function emitArrayBufferAllocFixed(fctx: FunctionContext, vecTypeIdx: number, arrTypeIdx: number): void {
  const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: sizeLocal });
  fctx.body.push({ op: "local.get", index: sizeLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
}

/**
 * Resizable byteLength: f64 on the stack → the i32 local holding it. A
 * fractional or negative length throws a RangeError.
 */
export function emitResizableAbLength(ctx: CodegenContext, fctx: FunctionContext): number {
  const lenF64 = allocLocal(fctx, `__rab_len_f64_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: lenF64 });
  fctx.body.push({ op: "local.get", index: lenF64 });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({ op: "local.get", index: lenF64 });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  fctx.body.push({ op: "i32.or" });
  pushRangeErrorIf(ctx, fctx, "RangeError: Invalid array buffer length");
  const lenI32 = allocLocal(fctx, `__rab_len_i32_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: lenF64 });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: lenI32 });
  return lenI32;
}

/**
 * `maxByteLength` option: f64 on the stack → the i32 local holding it, via
 * ToIndex (NaN → 0, truncate toward zero, negative → RangeError; the upper
 * 2^53-1 bound is subsumed by the i32 cap).
 */
export function emitResizableAbMaxLength(ctx: CodegenContext, fctx: FunctionContext): number {
  const maxF64 = allocLocal(fctx, `__rab_max_f64_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: maxF64 });
  fctx.body.push({ op: "local.get", index: maxF64 });
  fctx.body.push({ op: "local.get", index: maxF64 });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "f64.const", value: 0 },
      { op: "local.set", index: maxF64 },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: maxF64 });
  fctx.body.push({ op: "f64.trunc" });
  fctx.body.push({ op: "local.set", index: maxF64 });
  fctx.body.push({ op: "local.get", index: maxF64 });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.lt" });
  pushRangeErrorIf(ctx, fctx, "RangeError: Invalid array buffer max byte length");
  const maxI32 = allocLocal(fctx, `__rab_max_i32_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: maxF64 });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: maxI32 });
  return maxI32;
}

/**
 * AllocateArrayBuffer for a resizable buffer: `byteLength > maxByteLength` is
 * a RangeError, then `struct.new $__resizable_ab`. The backing array is sized
 * to the CURRENT byteLength (`.resize()` reallocates and swaps `data`).
 */
export function emitResizableAbAlloc(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  rabTypeIdx: number,
  lenI32: number,
  maxI32: number,
): void {
  fctx.body.push({ op: "local.get", index: lenI32 });
  fctx.body.push({ op: "local.get", index: maxI32 });
  fctx.body.push({ op: "i32.gt_s" });
  pushRangeErrorIf(ctx, fctx, "RangeError: ArrayBuffer byteLength exceeds maxByteLength");
  fctx.body.push({ op: "local.get", index: lenI32 });
  fctx.body.push({ op: "local.get", index: lenI32 });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: maxI32 });
  fctx.body.push({ op: "struct.new", typeIdx: rabTypeIdx });
}

/**
 * IsResizableArrayBuffer over the anyref in `abAny`: the native subtype
 * identity, intentionally unaffected by detachment.
 */
export function arrayBufferResizableInstrs(rabTypeIdx: number, abAny: number): Instr[] {
  return [
    { op: "local.get", index: abAny },
    { op: "ref.test", typeIdx: rabTypeIdx },
  ];
}

/**
 * §25.1.5.4 `maxByteLength` over the anyref in `abAny`, as an i32: 0 once
 * detached, field 2 of a resizable buffer, the byteLength of a fixed one.
 */
export function arrayBufferMaxByteLengthInstrs(vecTypeIdx: number, rabTypeIdx: number, abAny: number): Instr[] {
  return [
    { op: "local.get", index: abAny },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } as ValType },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: abAny },
        { op: "ref.test", typeIdx: rabTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } as ValType },
          then: [
            { op: "local.get", index: abAny },
            { op: "ref.cast", typeIdx: rabTypeIdx },
            { op: "struct.get", typeIdx: rabTypeIdx, fieldIdx: 2 },
          ],
          else: [
            { op: "local.get", index: abAny },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * A view or buffer's element count over the anyref in `recvAny`, as an i32:
 * field 0 of a `vecTypeIdx` receiver, clamped at 0 (a detached buffer stores
 * -1); `elseArm` answers for any other receiver.
 */
export function byteVecLengthInstrs(vecTypeIdx: number, recvAny: number, elseArm: Instr[]): Instr[] {
  return [
    { op: "local.get", index: recvAny },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } as ValType },
      then: [
        { op: "local.get", index: recvAny },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: recvAny },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "select" },
      ],
      else: elseArm,
    },
  ];
}

/**
 * (#5349 r3) The `else` arm of the `byteLength` runtime probe for a statically
 * "ArrayBuffer" receiver: consult the PACKED-BYTE view carrier before answering
 * zero. Byte-inert when `$__vec_i8_byte` is not registered in the module (the
 * whole JS-host lane, and any standalone module with no packed-byte view), so
 * the arm keeps its previous single `i32.const 0`.
 */
export function buildPackedByteLengthElse(ctx: CodegenContext, recvAnyLocal: number): Instr[] {
  const i8VecIdx = ctx.vecTypeMap.get("i8_byte");
  if (i8VecIdx === undefined) return [{ op: "i32.const", value: 0 }];
  return [
    { op: "local.get", index: recvAnyLocal },
    { op: "ref.test", typeIdx: i8VecIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } as ValType },
      then: [
        { op: "local.get", index: recvAnyLocal },
        { op: "ref.cast", typeIdx: i8VecIdx },
        { op: "struct.get", typeIdx: i8VecIdx, fieldIdx: 0 },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}
