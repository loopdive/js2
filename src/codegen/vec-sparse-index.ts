// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-4 lane J) The UNBACKABLE end of the array-index domain — indices
 * that are legal §10.4.2 array indices but that no backing `$data` array may
 * be grown to hold.
 *
 * `vec-index-domain.ts` already establishes the model this module completes:
 * `vec.length` is LOGICAL, the backing may be shorter, and every index in
 * `[capacity, length)` is a HOLE. The READ side (`vec-oob-read.ts`) and the
 * `a.length = N` SETTER both honour it. The element-STORE side did not — it
 * unconditionally grew the backing to `idx + 1`, so the ordinary ES5 boundary
 * idiom aborted the whole module with an uncatchable Wasm trap:
 *
 * ```js
 * var x = [];
 * x[2147483648] = 1;   // TRAP "array element access out of bounds"
 * x[4294967294] = 1;   // TRAP "requested new array is too large"
 * new Array(4294967295) // TRAP "requested new array is too large"
 * ```
 *
 * (test262 `built-ins/Array/S15.4.5.2_A1_T1`, `Array/length/S15.4.5.2_A3_T4`,
 * `Array/length/S15.4.2.2_A2.1_T1`, `Array/S15.4_A1.1_T10`.) All three are
 * plain ES5 — a `length` of `2**32-1` is legal and must not allocate four
 * billion slots.
 *
 * ## What "unbackable" means, and why the test is UNSIGNED
 *
 * The index local is an i32 holding a **u32 bit pattern**, exactly like the
 * `$__vec_base` length field (see the #4491 sparse-length arm in
 * `vec-overlay.ts`, which stores `ToUint32(n)` there and relies on the readers
 * widening with `f64.convert_i32_u`). So index `4294967294` arrives as `-2`,
 * and `2147483648` as `i32.MIN`. Every comparison the store path makes about
 * an index therefore has to be UNSIGNED or it reads a large index as a
 * negative one:
 *
 *   * `idx >= capacity` — signed said "no" for `-2`, so the grow was skipped
 *     and `array.set` ran out of bounds. Unsigned says "yes", and the ceiling
 *     test below then routes it to the sparse arm.
 *   * `idx + 1 > vec.length` — signed said "yes" for an array whose length is
 *     already a huge u32 (`length = 4e9`), clobbering it downward.
 *
 * A genuinely negative index (`a[-1] = v`, when the non-index-key path has not
 * already claimed it) reads as `4294967295` unsigned, lands above the ceiling,
 * and becomes a no-op instead of a trap. `4294967295` is not an array index
 * (§10.4.2.1), so `length` must not move either — and it does not: `idx + 1`
 * wraps to `0`, which is never `> length` unsigned.
 *
 * ## The ceiling
 *
 * {@link SPARSE_INDEX_CEILING} is the same 16M allocation guard
 * `array-length-define.ts` uses for `defineProperty(arr, "length", …)`, kept
 * numerically identical on purpose: an index write and a length write must not
 * disagree about which lengths are backed.
 */
import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";

/**
 * Largest index whose element the store path will grow the backing `$data`
 * array to hold. Mirrors `SAFE_GROW_CEILING` in array-length-define.ts.
 */
export const SPARSE_INDEX_CEILING = 16777216;

/** 2^32 - 1 — the one uint32 that is NOT an array index (§10.4.2.1). */
const MAX_ARRAY_INDEX_EXCLUSIVE = 4294967295;

/**
 * Allocate and set an i32 flag local: 1 when `idxLocal`, read as u32, names an
 * index no backing array may be grown to hold.
 *
 * Emitted imperatively into `fctx.body` so the caller keeps its existing
 * straight-line emission order.
 */
export function emitUnbackableIndexFlag(fctx: FunctionContext, idxLocal: number): number {
  const flag = allocLocal(fctx, `__idx_unbacked_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: SPARSE_INDEX_CEILING });
  fctx.body.push({ op: "i32.gt_u" });
  fctx.body.push({ op: "local.set", index: flag });
  return flag;
}

/** `flag == 0` — "this index IS backed", for ANDing into an existing guard. */
function backedFlagInstrs(flag: number): Instr[] {
  return [{ op: "local.get", index: flag }, { op: "i32.eqz" }];
}

/** `idx >=u capacity && backed` — the backing-grow condition. */
export function needsGrowCondInstrs(flag: number, idxLocal: number, dataLocal: number): Instr[] {
  return [
    { op: "local.get", index: idxLocal },
    { op: "local.get", index: dataLocal },
    { op: "array.len" },
    { op: "i32.ge_u" },
    ...backedFlagInstrs(flag),
    { op: "i32.and" },
  ];
}

/** `idx >u oldLength && backed` — the #2773 externref gap-fill condition. */
export function needsGapFillCondInstrs(flag: number, idxLocal: number, oldLenLocal: number): Instr[] {
  return [
    { op: "local.get", index: idxLocal },
    { op: "local.get", index: oldLenLocal },
    { op: "i32.gt_u" },
    ...backedFlagInstrs(flag),
    { op: "i32.and" },
  ];
}

/**
 * `if (backed) data[idx] = val` — the element store itself. An unbackable
 * index writes nothing: the slot is a hole in the sparse tail and
 * `guardVecElementRead` already answers `undefined` there.
 */
export function guardedElementSetInstrs(
  flag: number,
  dataLocal: number,
  idxLocal: number,
  valLocal: number,
  arrTypeIdx: number,
): Instr[] {
  return [
    ...backedFlagInstrs(flag),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: dataLocal },
        { op: "local.get", index: idxLocal },
        { op: "local.get", index: valLocal },
        { op: "array.set", typeIdx: arrTypeIdx },
      ],
    },
  ];
}

/**
 * The i32 bit pattern for an element-access key spelled as a numeric literal
 * ABOVE `i32.MAX` but still inside the array-index domain — `x[2147483648]`,
 * `x[4294967294]`.
 *
 * `tryEmitStaticI32Expression` refuses anything over `0x7fffffff` and the
 * generic `compileExpression(key, {kind:"i32"})` fallback lowers the literal
 * through `f64 → i32.trunc_sat_f64_s`, which SATURATES to `2147483647`. That
 * silently renames the index: `x[2147483648] = 1` set `length` to
 * `2147483648` where §10.4.2.2 requires `2147483649`, and `x[4294967294]`
 * collapsed onto the same slot as `x[2147483647]`.
 *
 * Returns the wrapped (signed) i32 whose u32 reading is the index, or
 * `undefined` for every other spelling — so ordinary keys keep their existing
 * lowering byte-for-byte.
 */
export function highArrayIndexLiteralI32(key: ts.Expression): number | undefined {
  let inner: ts.Expression = key;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression;
  }
  if (!ts.isNumericLiteral(inner)) return undefined;
  const n = Number(inner.text);
  if (!Number.isInteger(n) || n <= 0x7fffffff || n >= MAX_ARRAY_INDEX_EXCLUSIVE) return undefined;
  return n | 0;
}

/**
 * `new Array(n)` for an `n` above the ceiling: the LENGTH field takes the full
 * `ToUint32(n)` bit pattern while the backing stays empty.
 *
 * `i32.trunc_sat_f64_s` on `4294967295` saturates to `2147483647`, so the old
 * lowering both reported the wrong `length` AND asked `array.new_default` for
 * two billion slots. `trunc_sat_f64_u` round-trips the whole u32 domain, and
 * the capacity is separately floored to `0` above the ceiling — the same split
 * `maybeEmitVecLengthDefine` makes.
 *
 * Consumes an f64 `n` from the stack and leaves `(length:i32, capacity:i32)`.
 */
export function sparseArrayNewSplitInstrs(lenLocal: number): Instr[] {
  return [
    { op: "i32.trunc_sat_f64_u" },
    { op: "local.tee", index: lenLocal },
    // capacity = len > CEILING ? 0 : len
    { op: "local.get", index: lenLocal },
    { op: "i32.const", value: SPARSE_INDEX_CEILING },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [{ op: "local.get", index: lenLocal }],
    },
  ];
}
