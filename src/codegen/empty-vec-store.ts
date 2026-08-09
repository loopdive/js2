// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921 follow-up) One shared, immutable zero-length backing store per array
 * element type, instead of a fresh `array.new_default(0)` per empty literal.
 *
 * `[]` lowers to `struct.new $__vec_T (i32.const 0, array.new_default $arr 0)`.
 * That zero-length array is **dead on arrival** whenever the array is ever
 * pushed to: `push` grows on `capacity < length + argc`, which from capacity 0
 * is unconditionally true, so the first push allocates a real store and drops
 * this one. The census measured **31,414 vec headers against 123,337 backing
 * stores** on one acorn parse — this is the first of those ~3.9 stores per vec,
 * and it is never read.
 *
 * Sharing is sound because a zero-length array has no observable contents:
 *
 *  - nothing can read a slot — every element read is gated by the vec's own
 *    `length` field, which is 0;
 *  - nothing can write a slot — a write goes through the grow path, and
 *    `capacity 0 < length + 1` always trips it, so the shared store is replaced
 *    before any store instruction targets it;
 *  - `array.len` of the shared store is 0, the same value a fresh one gives.
 *
 * The dangerous shape would be a writer that skips the capacity check. That is
 * the invariant this optimization rests on, so it is stated here rather than
 * left implicit: **the grow path must be the only producer of a writable
 * backing store.**
 *
 * `JS2WASM_SHARED_EMPTY_VEC=0` restores per-literal allocation as the paired
 * control.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

export function sharedEmptyVecEnabled(): boolean {
  return process.env.JS2WASM_SHARED_EMPTY_VEC !== "0";
}

/**
 * Instructions pushing a zero-length backing store of `arrTypeIdx`, reusing a
 * module-level singleton. Returns `undefined` when the caller should emit its
 * own `array.new_default` (control disabled).
 */
export function emptyBackingStoreInstrs(ctx: CodegenContext, arrTypeIdx: number): Instr[] | undefined {
  if (!sharedEmptyVecEnabled()) return undefined;
  // Index space must still be open — this adds a global, never an import.
  if (ctx.indexSpaceFrozen) return undefined;

  const cached = ctx.sharedEmptyVecGlobals?.get(arrTypeIdx);
  if (cached !== undefined) return [{ op: "global.get", index: cached }];

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__empty_arr_${arrTypeIdx}`,
    type: { kind: "ref", typeIdx: arrTypeIdx },
    mutable: false,
    init: [
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: arrTypeIdx },
    ],
  });
  (ctx.sharedEmptyVecGlobals ??= new Map()).set(arrTypeIdx, globalIdx);
  return [{ op: "global.get", index: globalIdx }];
}
