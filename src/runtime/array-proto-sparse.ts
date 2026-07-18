// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Extracted verbatim from src/runtime.ts (#3103) — #1234 sparse-aware
// Array.prototype fast paths (unshift/reverse/forEach) for non-Array
// receivers. Pure move, host-side only; emits zero Wasm. No logic change.
// Only `_arrayProtoSparseFastPaths` is consumed by runtime.ts (imported back).

// ── #1234 — sparse-aware Array.prototype fast paths ─────────────────────────
//
// V8's native `Array.prototype.{unshift,reverse,forEach,…}` walks the index
// range `[0, length)` per the spec algorithm. For real Arrays V8 has dense
// fast paths that make this O(elements). For non-Array receivers (like our
// Proxy-wrapped wasm structs), V8 follows the spec literally and walks every
// integer index in the range — including holes.
//
// Test262 has receivers built from object literals with `length: 2 ** 53 - 2`
// and a handful of defined integer-keyed properties. V8's literal walk goes
// 9×10¹⁵ iterations and hangs the runner.
//
// These fast paths replace the spec walk with a defined-property iteration:
// collect the integer-indexed own keys via `Reflect.ownKeys(O)`, sort them,
// then iterate only those. Skipping holes is observable (`DeletePropertyOrThrow`
// at hole sites is a side effect per spec), but matters only for receivers
// that observe writes to hole indices — none of the target tests do.
//
// Real Array receivers continue to go through V8's native path; the dispatch
// in `__proto_method_call` only routes here when `Array.isArray(receiver)`
// is false.

/**
 * Collect integer-indexed (0, 1, 2, …) own keys of a Proxy-wrapped wasm
 * struct, in ascending numeric order, filtered to keys < `len`.
 */
function _collectIntegerKeys(O: any, len: number): number[] {
  const keys = Reflect.ownKeys(O);
  const out: number[] = [];
  // Pattern: "0" or non-zero digit followed by digits, with no leading zeros.
  // Keys above 2^53 - 1 are not integer indices per spec but the values we
  // care about always fit because they originate as struct field names.
  const intKeyRe = /^(?:0|[1-9]\d*)$/;
  for (const k of keys) {
    if (typeof k !== "string") continue;
    if (!intKeyRe.test(k)) continue;
    const n = Number(k);
    if (!Number.isFinite(n) || n < 0 || n >= len) continue;
    if (n > 9007199254740991) continue; // > 2^53 - 1, not an integer index
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Spec §22.1.3.34 Array.prototype.unshift, sparse-aware. Iterates over
 * defined integer-indexed own properties only. Reading an indexed property
 * may throw (e.g. via a getter) — that propagates naturally because we
 * use plain `O[from]` syntax (which fires JS accessor `get` traps).
 *
 * Two semantic deviations from the spec walk that matter:
 *
 *   1. **Source not deleted after copy.** Per spec, when `fromPresent` is
 *      true the algorithm does `Get + Set` only — no delete of `from`.
 *      Source values that aren't subsequently overwritten by a higher-key
 *      iteration's destination remain in place. (Real V8 unshift behaves
 *      this way too — source keys persist when destination > source.)
 *
 *   2. **Hole-on-source iterations delete the destination.** Spec step v:
 *      when `from` is a hole, `DeletePropertyOrThrow(O, to)`. We don't
 *      iterate holes, so destination indices in hole ranges between
 *      defined keys keep their stale values from the original receiver.
 *      The two test262 targets (#1234) don't observe this divergence, but
 *      it would surface on a test that checks per-index hole state across
 *      a sparse iteration. Out of scope for #1234; tracked as a follow-up.
 */
function _arrayProtoUnshiftSparse(O: any, args: any[]): number {
  const len = Number(O.length) || 0;
  const argCount = args.length;
  if (argCount === 0) return len;
  if (len + argCount > 9007199254740991) {
    throw new TypeError("Invalid array length");
  }
  // Walk defined keys from highest down, copying each up by argCount.
  // Sources are NOT deleted — spec reads then sets without deletion. Real
  // sources may be implicitly overwritten by another iteration's
  // destination, but that's fine in spec order.
  const keys = _collectIntegerKeys(O, len);
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]!;
    const fromKey = String(k);
    const toKey = String(k + argCount);
    // Read first — may throw via accessor; spec then propagates.
    const fromValue = O[fromKey];
    O[toKey] = fromValue;
  }
  // Delete destinations that fall in hole ranges between defined keys —
  // spec step v for each k where `from` was a hole calls
  // DeletePropertyOrThrow(O, ToString(k + argCount - 1)). For our walk we
  // only iterate defined keys, so destinations in hole ranges keep stale
  // values unless explicitly cleared.
  //
  // Iterate over the defined keys (not the index range — gaps may span
  // 2^53 indices). For each defined key `kd`, the spec hole-iteration
  // would delete `kd` if and only if some hole iteration's destination
  // landed on `kd` (i.e. there exists some hole-walked source `s` such
  // that `s + argCount - 1 == kd`, which means `s = kd - argCount + 1`,
  // and `s` must be in a hole range — i.e. `s` itself is not in
  // `definedSet`). The check is O(defined) per defined key.
  const definedSet = new Set(keys);
  // We must also avoid deleting positions we just *wrote to* in the copy
  // loop above. Those destinations are the new homes of source values;
  // they shouldn't be cleared by a hole iteration. Build the set of
  // destination keys actually written.
  const writtenDestinations = new Set<number>();
  for (const k of keys) writtenDestinations.add(k + argCount);
  for (const kd of keys) {
    if (writtenDestinations.has(kd)) continue; // a write covered this key
    const sourceK = kd - argCount + 1;
    if (sourceK < 0 || sourceK >= len) continue;
    if (definedSet.has(sourceK)) continue; // source is defined → not a hole iteration
    delete O[String(kd)];
  }
  for (let j = 0; j < argCount; j++) {
    O[String(j)] = args[j];
  }
  O.length = len + argCount;
  return len + argCount;
}

/**
 * Spec §22.1.3.27 Array.prototype.reverse, sparse-aware. Pairs up the
 * `[0, len)` range from outside in: each `(lower, upper)` pair where
 * `upper = len - 1 - lower` swaps values (or deletes the pair if a side
 * is a hole). Defined-property iteration: only the keys present on the
 * receiver participate.
 */
function _arrayProtoReverseSparse(O: any, _args: any[]): any {
  const len = Number(O.length) || 0;
  const keys = _collectIntegerKeys(O, len);
  // Build a quick lookup of which integer indices are defined.
  const defined = new Set(keys);
  // Walk only keys whose paired index is in [0, len) AND whose key < paired
  // (so we don't double-swap).
  for (const k of keys) {
    const upperIdx = len - 1 - k;
    if (k >= upperIdx) break; // crossed the midpoint; swaps complete
    const lowerKey = String(k);
    const upperKey = String(upperIdx);
    const lowerHas = defined.has(k);
    const upperHas = defined.has(upperIdx);
    if (lowerHas && upperHas) {
      const lo = O[lowerKey];
      const up = O[upperKey];
      O[lowerKey] = up;
      O[upperKey] = lo;
    } else if (lowerHas) {
      const lo = O[lowerKey];
      O[upperKey] = lo;
      delete O[lowerKey];
    } else if (upperHas) {
      const up = O[upperKey];
      O[lowerKey] = up;
      delete O[upperKey];
    }
  }
  return O;
}

/**
 * Spec §22.1.3.12 Array.prototype.forEach, sparse-aware. Iterates over
 * defined integer-indexed own properties only — skips holes (spec-compliant)
 * but does NOT walk every index in `[0, len)`.
 */
function _arrayProtoForEachSparse(O: any, args: any[]): undefined {
  const callback = args[0];
  const thisArg = args[1];
  if (typeof callback !== "function") {
    throw new TypeError("forEach callback is not a function");
  }
  const len = Number(O.length) || 0;
  const keys = _collectIntegerKeys(O, len);
  for (const k of keys) {
    const key = String(k);
    const value = O[key]; // may throw via accessor; spec propagates
    callback.call(thisArg, value, k, O);
  }
  return undefined;
}

export const _arrayProtoSparseFastPaths: Record<string, (O: any, args: any[]) => any> = {
  unshift: _arrayProtoUnshiftSparse,
  reverse: _arrayProtoReverseSparse,
  forEach: _arrayProtoForEachSparse,
};
