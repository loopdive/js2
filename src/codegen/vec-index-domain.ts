// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4434) The NUMERIC DOMAIN of array indices, and the SPARSE TAIL that a
 * logical `length` beyond the physical backing creates.
 *
 * Two invariants live here because they are the same invariant seen from two
 * sides — "which i32 may name an element" and "which i32 may address the
 * backing" — and every previous bug in this family came from a site that
 * enforced one while assuming the other.
 *
 * ## 1. Canonical-index overflow is not `val < 0`
 *
 * `__obj_index_of_key` (object-runtime.ts) accumulates decimal digits into an
 * i32 and rejected out-of-range keys by testing the accumulator for a NEGATIVE
 * value after the fact. That misses every key that wraps to a NON-negative
 * residue: `"4294967296"` (2^32) accumulates to exactly **0**, so the key was
 * reported as array index 0. Measured consequences on `--target standalone`,
 * all silent wrong answers:
 *
 * ```js
 * var a = [];
 * Object.defineProperty(a, "4294967296", { value: 100 });
 * a.length;   // 1   — should be 0 (2^32 is NOT an array index, §10.4.2.1)
 * a[0];       // 100 — a property was invented at a key nobody named
 * ```
 *
 * `"4294967295"` (2^32-1) happened to wrap to `-1` and so was caught, which is
 * why the family looked half-correct: the boundary tests immediately around it
 * disagreed with each other for no visible reason.
 *
 * The guard below is exact and runs BEFORE the multiply-add, so no wrap ever
 * occurs: `val*10 + d` exceeds `I32_MAX` iff `val > 214748364`, or
 * `val == 214748364 && d > 7`. Division-free (this runs per digit).
 *
 * The ceiling stays `2^31-1` rather than the spec's `2^32-2`, which is the
 * pre-existing documented cap of `__obj_index_of_key` (the result doubles as a
 * SIGNED sort key for OrdinaryOwnPropertyKeys ordering). Keys in
 * `[2^31, 2^32-2]` are therefore treated as ordinary string keys. That is a
 * deliberate, narrower approximation — and it is now a CONSISTENT one, which
 * is the property the wrap hole destroyed.
 *
 * ## 2. `vec.length` may EXCEED `array.len(vec.data)`
 *
 * A vec is `struct { 0: length i32, 1: data (ref $arr) }`. Every growth path
 * (index write, `push`, the overlay's define write-back) keeps the backing at
 * least as long as `length` — except the `a.length = N` SETTER, which bumps
 * field 0 alone (`expressions/assignment.ts`, the `arr.length = N` arm). #3225
 * already established this shape and fixed the in-place WRITE methods
 * (`fill`/`reverse`/`copyWithin`) by growing the backing.
 *
 * The dynamic-lane metaobject chokepoints were never given the same treatment.
 * They bounds-check the index against `vec.length` and then index `data[i]`
 * directly, so every one of them TRAPS — an uncatchable Wasm abort, not a
 * catchable error — on the ordinary ES5 presize idiom:
 *
 * ```js
 * var a = [];
 * a.length = 3;
 * a[1];                                     // TRAP (expected: undefined)
 * a[1] = 9;                                 // TRAP
 * a.hasOwnProperty("1");                    // TRAP
 * Object.getOwnPropertyDescriptor(a, "1");  // TRAP
 * a.join(",");                              // TRAP
 * Object.defineProperty(a, "1", {value: 1}); // TRAP
 * ```
 *
 * The fix is NOT to grow the backing at the setter: `a.length = 4294967294` is
 * legal ES5 and must not allocate four billion slots. The spec model is that
 * `length` is logical and indices in `[capacity, length)` are HOLES. So the
 * readers must tolerate the tail, which is what {@link backedBoundsGuard}
 * expresses: an index is BACKED only when `0 <= i < length && i < len(data)`,
 * and an in-range-but-unbacked index is a hole — the same `undefined` /
 * prototype-chain miss an out-of-range index already produces.
 *
 * Emitting the capacity test costs one `array.len` + compare on paths that
 * already do a bounds compare, and it is only emitted on the dynamic MOP
 * helpers, never in the typed dense loop.
 */
import type { Instr } from "../ir/types.js";

/**
 * Largest value `__obj_index_of_key` will report as an array index. See the
 * module header for why this is `2^31-1` and not the spec's `2^32-2`.
 */
export const MAX_CANONICAL_INDEX = 0x7fffffff;

/** `floor(I32_MAX / 10)` — the last accumulator value that can still take a digit. */
const ACC_LIMIT = 214748364;
/** `I32_MAX % 10` — the largest digit `ACC_LIMIT` can absorb without overflow. */
const ACC_LIMIT_LAST_DIGIT = 7;

/**
 * Emit the digit step of `__obj_index_of_key`'s accumulator with an EXACT,
 * pre-multiply overflow guard.
 *
 * Replaces the wrap-then-test-for-negative shape described in the module
 * header. On overflow the emitted code returns `-1` (not an array index)
 * directly from the enclosing function, matching the guard it supersedes.
 *
 * @param valLocal   i32 local holding the accumulator
 * @param charLocal  i32 local holding the current char code (already validated `'0'..'9'`)
 * @param digitLocal scratch i32 local for the decoded digit
 */
export function canonicalIndexDigitStep(valLocal: number, charLocal: number, digitLocal: number): Instr[] {
  const notAnIndex = (): Instr[] => [{ op: "i32.const", value: -1 }, { op: "return" }];
  return [
    // d = c - '0'
    { op: "local.get", index: charLocal },
    { op: "i32.const", value: 0x30 },
    { op: "i32.sub" },
    { op: "local.set", index: digitLocal },
    // val > ACC_LIMIT  →  val*10 overflows regardless of the digit
    { op: "local.get", index: valLocal },
    { op: "i32.const", value: ACC_LIMIT },
    { op: "i32.gt_s" },
    { op: "if", blockType: { kind: "empty" }, then: notAnIndex() },
    // val == ACC_LIMIT && d > ACC_LIMIT_LAST_DIGIT  →  the sum overflows
    { op: "local.get", index: valLocal },
    { op: "i32.const", value: ACC_LIMIT },
    { op: "i32.eq" },
    { op: "local.get", index: digitLocal },
    { op: "i32.const", value: ACC_LIMIT_LAST_DIGIT },
    { op: "i32.gt_s" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: notAnIndex() },
    // val = val * 10 + d   — provably in range
    { op: "local.get", index: valLocal },
    { op: "i32.const", value: 10 },
    { op: "i32.mul" },
    { op: "local.get", index: digitLocal },
    { op: "i32.add" },
    { op: "local.set", index: valLocal },
  ];
}

/** Func indices the canonical-numeric-string predicate needs. */
export interface CanonicalNumericDeps {
  /** `__str_to_number(externref) -> f64` (§7.1.4.1 StringToNumber). */
  strToNumber: number;
  /** `number_toString(f64) -> ref $AnyString` (§6.1.6.1.20 Number::toString). */
  numberToString: number;
  /** `__str_flatten(ref $AnyString) -> ref $NativeString`. */
  strFlatten: number;
  /** `__str_equals(ref $NativeString, ref $NativeString) -> i32`. */
  strEquals: number;
  /** The `$AnyString` type index, for the key cast. */
  anyStrTypeIdx: number;
}

/**
 * Emit `if (ToString(ToNumber(key)) === key) { ...then }` —
 * CanonicalNumericIndexString (§10.4.5.1) minus the `"-0"` special case, which
 * cannot reach an array receiver as an own key.
 *
 * ## Why a define needs this, and why `__obj_index_of_key` is not enough
 *
 * The overlay's `__extern_get_idx` prologue is gated on a module-global
 * "some vec carries a numeric-keyed companion entry" flag (#3673 — without it
 * the per-read linear table scan cost 29% of a compiled-acorn parse). That
 * flag was set only when `__obj_index_of_key` reported an index `>= 0`.
 *
 * But a key OUTSIDE the canonical index domain is still reachable through the
 * INDEXED read lane: `arr[4294967295]` arrives at `__extern_get_idx` as the
 * f64 `4294967295`, whose `number_toString` is exactly the key the companion
 * stored. With the flag clear the prologue never ran, the read fell through to
 * the vec (which has no such element), and the property that
 * `getOwnPropertyDescriptor` and `hasOwnProperty` both reported as present
 * read back as `undefined`.
 *
 * So the flag must follow REACHABILITY through the indexed lane, not
 * array-index-ness. This predicate is that condition, and it deliberately
 * stays narrow: an ordinary named expando (`arr.foo`) is not numeric, does not
 * set the flag, and keeps the fast path — which is the whole point of #3673.
 *
 * NOTE ON INSTRUMENTS: this defect is invisible to any probe whose module also
 * performs a normal indexed define, because that sets the flag for the whole
 * module and every later read then works. It was found only by mirroring the
 * failing test file exactly, one define per module.
 *
 * @param keyLocal externref local holding the property key
 * @param scratch  f64 local for the intermediate ToNumber result
 */
export function canonicalNumericKeyGuard(
  keyLocal: number,
  scratch: number,
  deps: CanonicalNumericDeps,
  then: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: deps.strToNumber },
    { op: "local.set", index: scratch },
    // ToString(n) === key ?  (NaN stringifies to "NaN", which no numeric key
    // can equal, so a non-numeric key falls out here without a NaN test.)
    { op: "local.get", index: scratch },
    { op: "call", funcIdx: deps.numberToString },
    { op: "call", funcIdx: deps.strFlatten },
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: deps.anyStrTypeIdx },
    { op: "call", funcIdx: deps.strFlatten },
    { op: "call", funcIdx: deps.strEquals },
    { op: "if", blockType: { kind: "empty" }, then },
  ];
}

/**
 * Emit `if (i >= array.len(vec.data)) { ...miss; return }` — the SPARSE-TAIL
 * guard the dynamic MOP chokepoints were missing.
 *
 * Callers reach this having already established `0 <= i < vec.length`; the
 * remaining question is whether the backing physically holds slot `i`. An
 * unsigned compare covers a negative `i` too, so the guard is safe to emit
 * before the sign test as well.
 *
 * @param anyLocal   local holding the receiver, already `ref.test`-proven to be `vecTypeIdx`
 * @param idxLocal   i32 local holding the index
 * @param miss       instructions producing the enclosing helper's miss result
 *                   (they must leave exactly its return value on the stack; a
 *                   `return` is appended)
 */
export function backedBoundsGuard(
  anyLocal: number,
  idxLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  miss: () => Instr[],
): Instr[] {
  return [
    { op: "local.get", index: idxLocal },
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "array.len", typeIdx: arrTypeIdx } as Instr,
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...miss(), { op: "return" }],
    },
  ];
}
