// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2720 — non-Unicode (legacy) case folding for the standalone regex engine.
 *
 * The pure-WasmGC matcher works on UTF-16 code units. Under the `i` flag WITHOUT
 * `u`/`v`, §22.2.2.9.3 Canonicalize folds each code unit through the Unicode
 * default UPPERCASE mapping — not ASCII-only — so `/Ä/i` matches `ä`, `/Σ/i`
 * matches `σ`/`ς`, Cyrillic case pairs match, etc. (`u`/`v` mode uses simple
 * case folding and is already handled at parse time by the host-oracle in
 * `unicode.ts`; this module is the NON-unicode arm only.)
 *
 * Following the same "host as spec oracle" pattern as #1911/#1912, the
 * canonicalization equivalence classes are computed ONCE AT COMPILE TIME from
 * the host's `String.prototype.toUpperCase` (whose Unicode tables the spec
 * Canonicalize is defined against) and the fold is desugared into plain unit
 * CLASS ranges. The emitted module stays pure Wasm with zero runtime tables.
 *
 * Legacy Canonicalize(ch), ch a UTF-16 code unit (§22.2.2.9.3, IgnoreCase,
 * non-Unicode):
 *   1. let u = the uppercase mapping of the single-code-unit string of `ch`.
 *   2. if u is not a single code unit, return ch.   (e.g. ß → "SS")
 *   3. let cu = u's single code unit.
 *   4. if ch ≥ 128 and cu < 128, return ch.         (ASCII-guard: ſ→S, K→K stay)
 *   5. return cu.
 * Two code units are `i`-equivalent iff they Canonicalize to the same value.
 */

/** §22.2.2.9.3 legacy (non-Unicode) Canonicalize of a single UTF-16 code unit. */
function canonicalizeLegacy(ch: number): number {
  const u = String.fromCharCode(ch).toUpperCase();
  if (u.length !== 1) return ch;
  const cu = u.charCodeAt(0);
  // A non-ASCII unit whose uppercase is ASCII does NOT fold to it (so `ſ`
  // (U+017F) and the Kelvin sign `K` (U+212A) match only themselves).
  if (ch >= 128 && cu < 128) return ch;
  return cu;
}

/** unit → its full (size > 1) equivalence set, ascending. Singletons absent. */
let equivMap: Map<number, number[]> | null = null;
/** Ascending list of every code unit that has a non-trivial equivalence set. */
let casedUnits: number[] | null = null;

/** Build the BMP (0x0000..0xFFFF) equivalence classes once per process. The
 *  ~64k `toUpperCase` probes run only when a non-Unicode `/i` pattern compiles,
 *  and the result is cached for every subsequent fold. */
function ensureBuilt(): void {
  if (equivMap !== null) return;
  const byCanon = new Map<number, number[]>();
  for (let ch = 0; ch <= 0xffff; ch++) {
    const c = canonicalizeLegacy(ch);
    let arr = byCanon.get(c);
    if (arr === undefined) {
      arr = [];
      byCanon.set(c, arr);
    }
    arr.push(ch); // ascending, since ch ascends
  }
  const m = new Map<number, number[]>();
  const cased: number[] = [];
  for (const arr of byCanon.values()) {
    if (arr.length <= 1) continue;
    for (const u of arr) {
      m.set(u, arr);
      cased.push(u);
    }
  }
  cased.sort((a, b) => a - b);
  equivMap = m;
  casedUnits = cased;
}

/** Coalesce single-unit and range entries into sorted, merged inclusive ranges. */
function coalesce(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1] + 1) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/** Sorted, de-duplicated code-unit list → coalesced inclusive ranges. */
export function unitsToRanges(units: number[]): Array<[number, number]> {
  return coalesce(units.map((u) => [u, u] as [number, number]));
}

/**
 * The legacy-canonicalization equivalence class of a single code unit (always
 * includes `code` itself). Size 1 ⇒ no case partners (emit a plain CHAR);
 * size > 1 ⇒ desugar to a CLASS over the returned units.
 */
export function foldCharUnitsLegacy(code: number): number[] {
  ensureBuilt();
  const eq = equivMap!.get(code);
  return eq !== undefined ? eq : [code];
}

/**
 * Expand a class's inclusive ranges with every legacy-canonicalization case
 * partner of any member, then coalesce. For each cased unit that falls inside
 * the input ranges, its whole equivalence set is added (so `[À-Ý]/i` also
 * matches `à-ý`, `[Σ]/i` also matches `σ`/`ς`, …). Folding happens BEFORE the
 * CLASS op applies negation, so `[^a]/i` correctly excludes both `a` and `A`.
 */
export function foldClassRangesLegacy(ranges: Array<[number, number]>): Array<[number, number]> {
  ensureBuilt();
  const member = (u: number): boolean => ranges.some(([lo, hi]) => u >= lo && u <= hi);
  const extra: Array<[number, number]> = [];
  for (const u of casedUnits!) {
    if (member(u)) {
      for (const p of equivMap!.get(u)!) extra.push([p, p]);
    }
  }
  return coalesce([...ranges, ...extra]);
}
