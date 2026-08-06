// #4150 — `__str_split` cuts its input in ONE pass over the characters.
//
// It used to scan every character twice: a count pass to size the result array
// exactly, then a fill pass. #3901 chose that to avoid "doubling, array.copy
// and slack"; the single-pass version reinstates growth-with-slack, which is
// free because the vec struct's field 0 is the LOGICAL length and every
// consumer bounds by it, while rescanning is not free.
//
// That makes this a test about a data-representation change — the returned vec
// may now have a backing array LARGER than its length — so it pins observable
// behaviour rather than internals: piece count, each piece's contents, and the
// interaction with `limit`. The corpus deliberately covers what growth-with-
// slack could plausibly break: results that cross the initial capacity of 8
// (forcing a doubling and an `array.copy` mid-scan), results of exactly 8, and
// the empty/`limit === 0` cases that must produce a zero-length vec whose
// backing array is NOT zero-length.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Run `body` in a fast-mode (native-strings) module and return its number.
 * The gc-native lane is the one that uses `__str_split`; the host lane routes
 * `split` to a JS import and would not exercise this code at all.
 *
 * Imports are built for real rather than passed `{}`: a fast-mode module is
 * host-free for STRINGS, but the checksum folds still pull the numeric
 * box/unbox union helpers.
 */
async function runFast(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, {
    fileName: "t.ts",
    fast: true,
  } as never);
  expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
  const imp = buildImports(r.imports!, undefined, r.stringPool) as never as {
    env: Record<string, Function>;
    "wasm:js-string": Record<string, Function>;
    string_constants: Record<string, WebAssembly.Global>;
    string_constants16: Record<string, WebAssembly.Global>;
  };
  const { instance } = await WebAssembly.instantiate(r.binary!, {
    env: imp.env,
    "wasm:js-string": imp["wasm:js-string"],
    string_constants: imp.string_constants,
    string_constants16: imp.string_constants16,
  } as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).test!();
}

const lit = (xs: readonly (string | number)[]): string => `[${xs.map((x) => JSON.stringify(x)).join(",")}]`;

/**
 * Fold piece count, each piece's length and each piece's first code unit into
 * one checksum. Comparing a single number keeps the whole cross-product in one
 * wasm call; comparing CONTENTS (not just counts) is what makes a wrong cut
 * detectable, since a mis-sliced piece keeps the count intact.
 */
function hostChecksum(strs: readonly string[], seps: readonly string[], lims: readonly number[]): number {
  let h = 0;
  for (const s of strs) {
    for (const sep of seps) {
      for (const lim of lims) {
        const parts = lim < 0 ? s.split(sep) : s.split(sep, lim);
        h = (h * 31 + parts.length) | 0;
        for (const p of parts) {
          h = (h * 31 + p.length) | 0;
          h = (h * 31 + (p.length > 0 ? p.charCodeAt(0) : 999)) | 0;
        }
      }
    }
  }
  return h;
}

function wasmChecksumSource(strs: readonly string[], seps: readonly string[], lims: readonly number[]): string {
  return `
  const STRS: string[] = ${lit(strs)};
  const SEPS: string[] = ${lit(seps)};
  const LIMS: number[] = ${lit(lims)};
  let h = 0;
  for (let a = 0; a < STRS.length; a = a + 1) {
    for (let b = 0; b < SEPS.length; b = b + 1) {
      for (let c = 0; c < LIMS.length; c = c + 1) {
        const lim = LIMS[c];
        const parts = lim < 0 ? STRS[a].split(SEPS[b]) : STRS[a].split(SEPS[b], lim);
        h = (h * 31 + parts.length) | 0;
        for (let d = 0; d < parts.length; d = d + 1) {
          const p = parts[d];
          h = (h * 31 + p.length) | 0;
          h = (h * 31 + (p.length > 0 ? p.charCodeAt(0) : 999)) | 0;
        }
      }
    }
  }
  return h;`;
}

const SEPS = [",", "\n", "", "a", "ab", "XX", ",,", "z", " ", "aa"] as const;
// -1 is the unbounded sentinel the helper receives for an absent `limit`.
const LIMS = [-1, 0, 1, 2, 3, 5, 100] as const;

const FIXED = [
  "",
  "a",
  "abc",
  "a,b,c",
  ",a,,b,", // leading, trailing and consecutive separators
  ",,,",
  "name,age,city",
  "a\nb\nc",
  "aaa",
  "abab",
  "aXXbXXc", // multi-char separator
  "xyz", // separator absent entirely
  "  spaced  out  ",
  "trail,",
  ",lead",
  "a,,,,b",
  "The quick brown fox",
  "\n\n",
  "ab",
  "aab",
  "MIXED,case,Str",
  // Growth: initial capacity is 8, so these cross it and force a doubling
  // (and an array.copy of the pieces already written) mid-scan.
  "1,2,3,4,5,6,7,8", // exactly 8 pieces — the boundary, no growth
  "1,2,3,4,5,6,7,8,9", // 9 pieces — one doubling
  "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17", // 17 pieces — two doublings
  "a,".repeat(40), // 41 pieces — several doublings
] as const;

describe("#4150 — single-pass __str_split", () => {
  it("matches the host across separators, limits and growth boundaries", async () => {
    const got = await runFast(wasmChecksumSource(FIXED, SEPS, LIMS));
    expect(got).toBe(hostChecksum(FIXED, SEPS, LIMS));
  });

  it("matches the host over a seeded random corpus", async () => {
    // Deterministic LCG so a failure is reproducible from the test alone.
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alpha = "ab,\nX ";
    const strs: string[] = [];
    for (let k = 0; k < 120; k++) {
      let s = "";
      const len = Math.floor(next() * 24);
      for (let i = 0; i < len; i++) s += alpha[Math.floor(next() * alpha.length)];
      strs.push(s);
    }
    const got = await runFast(wasmChecksumSource(strs, SEPS, LIMS));
    expect(got).toBe(hostChecksum(strs, SEPS, LIMS));
  });

  it("a zero-length result still reports length 0 (limit 0, capacity is not length)", async () => {
    // The backing array is allocated at capacity 8 before anything is written,
    // so a vec that reports its ARRAY size rather than its length field would
    // answer 8 here.
    expect(await runFast(`return "a,b,c".split(",", 0).length;`)).toBe(0);
  });

  it("a result smaller than the initial capacity reports its own length", async () => {
    expect(await runFast(`return "a,b,c".split(",").length;`)).toBe(3);
    expect(await runFast(`return "".split(",").length;`)).toBe(1);
    expect(await runFast(`return "xyz".split(",").length;`)).toBe(1);
  });

  it("a result past the initial capacity is complete after the doubling", async () => {
    expect(await runFast(`return "1,2,3,4,5,6,7,8,9,10,11,12".split(",").length;`)).toBe(12);
    // Reading the LAST piece proves the array.copy carried the earlier ones and
    // the write index kept up — a count-only check would pass on a lost copy.
    expect(await runFast(`return "1,2,3,4,5,6,7,8,9,10,11,12".split(",")[11].charCodeAt(0);`)).toBe("1".charCodeAt(0));
    expect(await runFast(`return "1,2,3,4,5,6,7,8,9,10,11,12".split(",")[0].charCodeAt(0);`)).toBe("1".charCodeAt(0));
    expect(await runFast(`return "a,b,c,d,e,f,g,h,i,j".split(",")[9].charCodeAt(0);`)).toBe("j".charCodeAt(0));
  });
});
