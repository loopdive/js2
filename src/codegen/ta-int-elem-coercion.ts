// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7018) Integer TypedArray element conversion for the CONSTRUCTION paths of
 * the packed standalone/WASI representation (`i8_byte` / `i16_byte` /
 * `i32_elem` backing arrays).
 *
 * An integer view stores `ToInt8` / `ToUint8` / `ToInt16` / `ToUint16` /
 * `ToInt32` / `ToUint32` of the value (§7.1.6–§7.1.11) — every one of them is
 * MODULO 2ⁿ, so all of them are "the low n bits of ToInt32(x)". A packed
 * `array.set` already keeps the low 8/16 bits of the i32 it is given, so the
 * only thing the construction path has to produce is the exact ToInt32 bit
 * pattern. `i32.trunc_sat_f64_s` — what `coerceType(f64 → i32)` emits — is
 * NOT that: it clamps |x| ≥ 2³¹ to `0x7fffffff`/`0x80000000`, so
 * `Uint8Array.of(0xda39a3ee)` stored `0xff` instead of `0xee` (uuid's SHA-1
 * digest bytes). The indexed store `b[i] = v` already used `emitToInt32`; this
 * module gives the construction paths the same conversion.
 *
 * `Uint8ClampedArray` is the one non-modular view (§7.1.12 ToUint8Clamp) and
 * keeps its own clamp.
 *
 * Only reachable when the destination storage is packed/i32 — i.e. standalone
 * and WASI. The JS-host lane stores every numeric view as `f64` and never calls
 * in here, so its output is unchanged.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "./context/speculative.js";
import { emitToInt32, emitToUint8Clamp } from "./binary-ops.js";
import { emitWasmInt32Coercion } from "../backend/wasmgc/lowering/wasm-int32-coercion.js";
import { coerceType, compileExpression, elemGetOp, unpackedElemType } from "./shared.js";
import { getArrTypeIdxFromVec, typedArrayPackedSignedness } from "./index.js";
import { getVecInfo } from "./type-coercion.js";
import { typedArraySearchSignedness } from "./array-methods.js";
import { collectInstrs } from "./statements/shared.js";

/** The three element-load ops a (possibly packed) vec read can take. */
type ElemGetOp = ReturnType<typeof elemGetOp>;

/**
 * Convert the value on the operand stack (of stack type `from`) to the i32 that
 * an integer TypedArray's packed / `i32_elem` `array.set` stores for `taName`.
 */
export function emitTaIntElemConversion(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  taName: string,
): void {
  const clamp = taName === "Uint8ClampedArray";
  if (from.kind === "i32") {
    // Already an exact integer bit pattern: the packed store wraps it.
    if (!clamp) return;
    fctx.body.push({ op: "f64.convert_i32_s" });
    emitToUint8Clamp(fctx);
    return;
  }
  if (from.kind !== "f64") coerceType(ctx, fctx, from, { kind: "f64" });
  if (clamp) emitToUint8Clamp(fctx);
  else emitToInt32(fctx);
}

/** The same conversion as an instruction list, for loop bodies built as arrays. */
export function taIntElemConversionInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  taName: string,
): Instr[] {
  return collectInstrs(fctx, () => emitTaIntElemConversion(ctx, fctx, from, taName));
}

/**
 * The exact ToInt32 bit pattern of the f64 on the stack, for a helper body built
 * without a `FunctionContext`: four i64 scratch locals starting at `base`
 * (declare them with {@link WRAP_F64_TO_INT32_LOCALS}).
 */
export function wrapF64ToInt32Instrs(base: number): Instr[] {
  const out: Instr[] = [];
  emitWasmInt32Coercion(out, { bits: base, exponent: base + 1, significand: base + 2, magnitude: base + 3 });
  return out;
}

/** The four i64 scratch locals {@link wrapF64ToInt32Instrs} expects, in order. */
export const WRAP_F64_TO_INT32_LOCALS: readonly { name: string; type: ValType }[] = [
  { name: "wbits", type: { kind: "i64" } },
  { name: "wexp", type: { kind: "i64" } },
  { name: "wsig", type: { kind: "i64" } },
  { name: "wmag", type: { kind: "i64" } },
];

/** True for a `{ length, data }` vec struct type index. */
function isVecStruct(ctx: CodegenContext, typeIdx: number): boolean {
  const def = ctx.mod.types[typeIdx];
  return def?.kind === "struct" && def.fields[0]?.name === "length" && def.fields[1]?.name === "data";
}

/**
 * `TA.of(a, ...xs, b)` for an integer TypedArray with packed / `i32_elem`
 * storage. Every argument is evaluated left to right into a local (elements
 * converted per the view, spreads kept as their source vec), the total length
 * is summed, and the result array is filled in order. A spread source is read
 * with the extension its OWN view needs (`array.get_s` for `Int*`, `get_u` for
 * `Uint*`) — a plain `array.get` on a packed source is invalid Wasm.
 *
 * Returns null (with everything emitted rolled back) when a spread operand does
 * not lower to a native vec, so the caller's generic path still applies.
 */
export function tryEmitPackedTaOfWithSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  taName: string,
  taVecTypeIdx: number,
  taArrTypeIdx: number,
): ValType | null {
  const snap = snapshotSpeculative(ctx, fctx);
  type Part =
    | { kind: "elem"; local: number }
    | { kind: "spread"; local: number; vecIdx: number; srcArrIdx: number; getOp: ElemGetOp; conv: Instr[] };
  const parts: Part[] = [];
  const decline = (): null => {
    rollbackSpeculative(ctx, fctx, snap);
    return null;
  };
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      const t = compileExpression(ctx, fctx, arg.expression);
      if (!t || (t.kind !== "ref" && t.kind !== "ref_null") || !isVecStruct(ctx, t.typeIdx)) return decline();
      const info = getVecInfo(ctx, t.typeIdx);
      const srcArrIdx = getArrTypeIdxFromVec(ctx, t.typeIdx);
      if (!info || srcArrIdx < 0) return decline();
      const readType = unpackedElemType(info.elemType);
      if (readType.kind !== "i32" && readType.kind !== "f64" && readType.kind !== "externref") return decline();
      const local = allocLocal(fctx, `__taof_src_${fctx.locals.length}`, { kind: "ref", typeIdx: t.typeIdx });
      if (t.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "local.set", index: local });
      parts.push({
        kind: "spread",
        local,
        vecIdx: t.typeIdx,
        srcArrIdx,
        getOp: taSpreadGetOp(ctx, info.elemType, arg),
        conv: taIntElemConversionInstrs(ctx, fctx, readType, taName),
      });
    } else {
      const t = compileExpression(ctx, fctx, arg, { kind: "f64" });
      if (!t) return decline();
      emitTaIntElemConversion(ctx, fctx, t, taName);
      const local = allocLocal(fctx, `__taof_el_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.set", index: local });
      parts.push({ kind: "elem", local });
    }
  }

  // total length
  let fixed = 0;
  for (const p of parts) if (p.kind === "elem") fixed++;
  fctx.body.push({ op: "i32.const", value: fixed });
  for (const p of parts) {
    if (p.kind !== "spread") continue;
    fctx.body.push({ op: "local.get", index: p.local });
    fctx.body.push({ op: "struct.get", typeIdx: p.vecIdx, fieldIdx: 0 });
    fctx.body.push({ op: "i32.add" });
  }
  const lenLocal = allocLocal(fctx, `__taof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: taArrTypeIdx });
  const data = allocLocal(fctx, `__taof_data_${fctx.locals.length}`, { kind: "ref", typeIdx: taArrTypeIdx });
  fctx.body.push({ op: "local.set", index: data });
  const w = allocLocal(fctx, `__taof_w_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: w });
  const bumpW: Instr[] = [
    { op: "local.get", index: w },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: w },
  ];

  for (const p of parts) {
    if (p.kind === "elem") {
      fctx.body.push({ op: "local.get", index: data });
      fctx.body.push({ op: "local.get", index: w });
      fctx.body.push({ op: "local.get", index: p.local });
      fctx.body.push({ op: "array.set", typeIdx: taArrTypeIdx });
      fctx.body.push(...bumpW);
      continue;
    }
    const r = allocLocal(fctx, `__taof_r_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: r });
    const loop: Instr[] = [
      { op: "local.get", index: r },
      { op: "local.get", index: p.local },
      { op: "struct.get", typeIdx: p.vecIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: data },
      { op: "local.get", index: w },
      { op: "local.get", index: p.local },
      { op: "struct.get", typeIdx: p.vecIdx, fieldIdx: 1 },
      { op: "local.get", index: r },
      { op: p.getOp, typeIdx: p.srcArrIdx } as Instr,
      ...p.conv,
      { op: "array.set", typeIdx: taArrTypeIdx },
      ...bumpW,
      { op: "local.get", index: r },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: r },
      { op: "br", depth: 0 },
    ];
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loop }],
    });
  }
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: data });
  fctx.body.push({ op: "struct.new", typeIdx: taVecTypeIdx });
  return { kind: "ref", typeIdx: taVecTypeIdx };
}

/** Read op for a (possibly packed) spread operand's source vec, keyed on the operand's view. */
export function taSpreadGetOp(ctx: CodegenContext, elemType: ValType, el: ts.Expression): ElemGetOp {
  if (elemType.kind !== "i8" && elemType.kind !== "i16") return "array.get";
  return elemGetOp(elemType, typedArraySearchSignedness(ctx, ts.isSpreadElement(el) ? el.expression : el));
}

/**
 * Read op for a packed source vec, keyed on its TS VIEW name: `Int*` → `get_s`,
 * `Uint*` → `get_u` (signed and unsigned views share i8/i16 storage). Without a
 * view name it keeps the storage-kind default (i8 → `get_u`, i16 → `get_s`).
 */
export function taSourceGetOp(elemType: ValType, viewName: string | undefined): ElemGetOp {
  return elemGetOp(elemType, viewName ? typedArrayPackedSignedness(viewName) : undefined);
}
