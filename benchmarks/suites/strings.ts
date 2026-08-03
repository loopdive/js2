import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// #3898 — every inner loop must depend on the induction variable
// ---------------------------------------------------------------------------
//
// Before this file was rewritten, most of these benchmarks called a *pure*
// `String.prototype` method with a **constant receiver and constant arguments**
// inside the loop:
//
//     const haystack = "abcdefghij".repeat(1000);
//     for (let i = 0; i < 1000; i++) sum = sum + haystack.indexOf("fghij");
//
// TurboFan hoists that call out of the loop (loop-invariant code motion) and
// runs it *once*. The published page then compared "V8 ran it once" against
// "js2wasm ran it 1000 times" and reported js2wasm as 9x-16,000x slower. The
// measured JS costs were physically impossible: 1.56 ns for an `indexOf`,
// 0.13 ns for a `toLowerCase`.
//
// Note this is NOT dead-code elimination. Returning and consuming the
// accumulator was measured and changed nothing; the cure is to make the *input*
// vary with the loop counter.
//
// Two shapes are used, applied identically to the JS baseline and to the paired
// Wasm `source` so the two lanes stay semantically equivalent:
//
//   (a) `indexOf`, `includes` and `substring` get a position argument derived
//       from the loop counter. This is safe for them because the match still
//       succeeds and the scan length is unchanged, so the workload is the same
//       one the old numbers described;
//   (b) everything else (`split`, `replace`, `toLowerCase`/`toUpperCase`,
//       `trim`, `startsWith`/`endsWith`) runs against a small table of distinct
//       receivers indexed by the loop counter — see `STARTS_ENDS_VARIANTS` for
//       why the position argument is the wrong lever there.
//
// The variant tables are written out as **literals**. Deriving them with
// `base.substring(...)` was tried first and is wrong: V8 represents a substring
// of a long-enough string as a `SlicedString`, and `split`/`trim`/`replace` on a
// sliced string must flatten it first. That inflated the JS lane by 3-18x and
// would have measured V8's string representation, not the operation — trading
// one benchmark artifact for another.
//
// `concat-short` / `concat-long` need no change: their receiver is the
// accumulator itself, so the expression already varies every iteration.
//
// Every baseline returns an accumulator that folds in *all* iterations, and the
// harness compares it against the Wasm `run()` return value (see `harness.ts`).
//
// ---------------------------------------------------------------------------
// #4118 follow-up — a varying INPUT is not enough; the OUTPUT must vary too
// ---------------------------------------------------------------------------
//
// The tables above were originally built so that "every variant keeps the
// original match outcome", to preserve comparability with the pre-#3898
// numbers. That left a second, quieter version of the same bug: the receiver
// varied with `i`, but the value folded into the accumulator did NOT. Every
// STARTS_ENDS variant matched both predicates (+2 every iteration), every
// TRIM variant trimmed to 11 chars, every CSV variant split into 8 fields,
// every REPLACE result was 43 chars, every CASE phrase was 23. So the loop body
// was loop-invariant in VALUE even though its input was not, and a compiler that
// can see through the string operations may hoist the whole thing.
//
// That is not hypothetical: on #4118 (which keeps range-proven array indices in
// i32) `string/startsWith-endsWith` dropped from 14.8 to 2.0 ns/op host-call and
// 41.0 to 5.7 gc-native, crossing the #3898 floor. Substituting variants whose
// outcomes genuinely differ restored 47 / 33.8 ns/op — the honest cost, and in
// the same range as before — which is what identified the collapse as a
// benchmark defect rather than a miscompile.
//
// Each table below is now DISCRIMINATING: the accumulated value differs between
// variants. Where making an outcome differ would have deleted work (a predicate
// that fails early scans less), the discriminating character is placed at the
// far end of the needle so the full comparison still runs.
//
// KNOWN LIMITATION, for #3898's owner: the harness's cross-lane assertion cannot
// catch this class of bug. It compares the lanes against EACH OTHER, so when
// every lane collapses identically — which is exactly what happens, since they
// share these tables — all of them agree on the same wrong-but-consistent
// number and the assertion passes. Only the per-op plausibility floor caught it.

// ---------------------------------------------------------------------------
// Variant tables — shared verbatim by both lanes
// ---------------------------------------------------------------------------

/**
 * 8 rotations of the same 8 fields; all 49 chars.
 *
 * (#4118 follow-up) The odd-indexed rotations join their first two fields with
 * a SPACE instead of a comma, so they split into 7 parts rather than 8 while
 * keeping the identical 49-char scan length. Before this, every variant split
 * into exactly 8 — see the "value-invariance" note at the top of this file.
 */
const CSV_VARIANTS = [
  "alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel",
  "bravo charlie,delta,echo,foxtrot,golf,hotel,alpha",
  "charlie,delta,echo,foxtrot,golf,hotel,alpha,bravo",
  "delta echo,foxtrot,golf,hotel,alpha,bravo,charlie",
  "echo,foxtrot,golf,hotel,alpha,bravo,charlie,delta",
  "foxtrot golf,hotel,alpha,bravo,charlie,delta,echo",
  "golf,hotel,alpha,bravo,charlie,delta,echo,foxtrot",
  "hotel alpha,bravo,charlie,delta,echo,foxtrot,golf",
];

/**
 * 8 rotations of the pangram; each contains "fox" exactly once.
 *
 * (#4118 follow-up) The odd-indexed rotations say "laziest" instead of "lazy",
 * so the replaced result is 46 chars rather than 43. Before this every variant
 * produced a 43-char result and `.replace(...).length` was the same number on
 * every iteration — see the "value-invariance" note at the top of this file.
 */
const REPLACE_VARIANTS = [
  "the quick brown fox jumps over the lazy dog",
  "quick brown fox jumps over the laziest dog the",
  "brown fox jumps over the lazy dog the quick",
  "fox jumps over the laziest dog the quick brown",
  "jumps over the lazy dog the quick brown fox",
  "over the laziest dog the quick brown fox jumps",
  "the lazy dog the quick brown fox jumps over",
  "laziest dog the quick brown fox jumps over the",
];

/**
 * 8 distinct mixed-case phrases.
 *
 * (#4118 follow-up) The odd-indexed phrases are 25 chars rather than 23, so the
 * accumulated `toLowerCase().length + toUpperCase().length` differs per
 * iteration. Before this every phrase was 23 chars and the sum was the same
 * number every time — see the "value-invariance" note at the top of this file.
 */
const CASE_VARIANTS = [
  "Hello World Test String",
  "World Test String HelloXY",
  "Test String Hello World",
  "String Hello World TestXY",
  "Alpha Bravo Charlie Del",
  "Bravo Charlie Del AlphaXY",
  "Charlie Del Alpha Bravo",
  "Del Alpha Bravo CharlieXY",
];

/**
 * 8 distinct receivers with DIFFERING match outcomes.
 *
 * `startsWith`/`endsWith` are the one pair where the position argument is the
 * wrong lever: `s.startsWith("hello", i % 3)` does vary, but 2 of every 3 calls
 * then mismatch on the first character and return early, silently deleting
 * two-thirds of the benchmark's work in BOTH lanes.
 *
 * (#4118 follow-up) Varying only the receiver was still not enough. Every
 * variant matched BOTH predicates, so `count` advanced by exactly 2 on every
 * iteration and the whole loop was value-invariant — see the note at the top of
 * this file. The outcomes now differ, and the discriminating character is
 * placed at the FAR END of each needle ("hellp" mismatches at index 4 of 5;
 * "benchmarkinh" at index 11 of 12) so the comparison still scans the full
 * needle and no work is deleted. The odd indices fail `startsWith`; the upper
 * half fails `endsWith`; indices 5 and 7 fail both. Receiver lengths are
 * unchanged.
 */
const STARTS_ENDS_VARIANTS = [
  "hello world, this is a test string for benchmarking",
  "hellp world, this is a alpha test string for benchmarking",
  "hello world, this is a bravo test string for benchmarking",
  "hellp world, this is a charlie test string for benchmarking",
  "hello world, this is a delta test string for benchmarkinh",
  "hellp world, this is a echo test string for benchmarkinh",
  "hello world, this is a foxtrot test string for benchmarkinh",
  "hellp world, this is a golf test string for benchmarkinh",
];

/**
 * 8 distinct paddings; all 17 chars, but they trim to DIFFERENT lengths.
 *
 * (#4118 follow-up) Every variant used to trim to the same 11 chars, so
 * `.trim().length` contributed the identical number on every iteration and the
 * loop was value-invariant — see the note at the top of this file. The odd
 * indices now trim to 12 ("hello worlds"). Total length stays 17 everywhere, so
 * the whitespace scan is exactly the work it was before.
 */
const TRIM_VARIANTS = [
  "   hello world   ",
  "  hello worlds   ",
  " hello world     ",
  "   hello worlds  ",
  "     hello world ",
  "     hello worlds",
  "hello world      ",
  "\thello worlds\t   ",
];

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function concatShort(): number {
  let s = "";
  for (let i = 0; i < 10000; i++) s = s + "hello world!!!!";
  return s.length;
}

function concatLong(): number {
  const chunk = "x".repeat(1024);
  let s = "";
  for (let i = 0; i < 1000; i++) s = s + chunk;
  return s.length;
}

function searchIndexOf(): number {
  const haystack = "abcdefghij".repeat(1000);
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    sum = sum + haystack.indexOf("fghij", (i * 61) % 10000);
  }
  return sum;
}

function searchIncludes(): number {
  const haystack = "abcdefghij".repeat(1000);
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (haystack.includes("fghij", (i * 61) % 10011)) count = count + 1;
  }
  return count;
}

function splitJoin(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const parts = CSV_VARIANTS[i % 8]!.split(",");
    sum = sum + parts.length;
  }
  return sum;
}

function replaceAll(): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const r = REPLACE_VARIANTS[i % 8]!.replace("fox", "cat");
    sum = sum + r.length + r.charCodeAt(i % 43);
  }
  return sum;
}

function caseConvert(): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const s = CASE_VARIANTS[i % 8]!;
    const lower = s.toLowerCase();
    const upper = s.toUpperCase();
    sum = sum + lower.length + lower.charCodeAt(i % 23);
    sum = sum + upper.length + upper.charCodeAt(i % 23);
  }
  return sum;
}

function substringExtract(): number {
  // (#3898 follow-up) Accumulate the substring's CONTENT, not its .length.
  // `.length` is derivable from the arguments alone, so Binaryen -O4 proved the
  // result unused and strength-reduced the whole call away: the gc-native lane
  // emitted ZERO struct.new/array ops in the loop and clocked 2.394 ns/op,
  // which the plausibility guard correctly rejected. Reading a character forces
  // the slice to actually exist.
  const s = "abcdefghijklmnopqrstuvwxyz";
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    const t = s.substring(i % 5, 20 + (i % 6));
    sum = sum + t.charCodeAt(i % 7) + t.charCodeAt(t.length - 1);
  }
  return sum;
}

function trimOps(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + TRIM_VARIANTS[i % 8]!.trim().length;
  }
  return sum;
}

function startsEndsWith(): number {
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    const s = STARTS_ENDS_VARIANTS[i % 8]!;
    if (s.startsWith("hello")) count = count + 1;
    if (s.endsWith("benchmarking")) count = count + 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

/**
 * Emit a variant table into a Wasm `source` from the very same array the JS
 * baseline uses, so the two lanes cannot drift apart.
 */
function variantTable(variants: readonly string[]): string {
  return `  const variants: string[] = [\n${variants.map((v) => `    ${JSON.stringify(v)}`).join(",\n")}\n  ];`;
}

export const stringBenchmarks: BenchmarkDef[] = [
  {
    name: "string/concat-short",
    iterations: 50,
    opsPerCall: 10000,
    // No per-benchmark floor: measured 2026-08-01 at 3.79 ns/op (js) and
    // 5.93 (gc-native). `minNsPerOp` is documented as "roughly a quarter of the
    // honest cost", which here is ~0.95 ns — i.e. below the universal 1 ns
    // bound, so the universal bound is already the right and only floor. The
    // earlier `minNsPerOp: 2` sat only 1.9x under the honest js cost, tight
    // enough that a machine faster than this container would trip it and fail
    // the run on a benchmark that was never hoisted in the first place (a rope
    // concat of a growing string is inherently not loop-invariant).
    source: `
export function run(): number {
  let s = "";
  for (let i = 0; i < 10000; i = i + 1) {
    s = s + "hello world!!!!";
  }
  return s.length;
}`,
    js: concatShort,
  },
  {
    name: "string/concat-long",
    iterations: 50,
    opsPerCall: 1000,
    // Same reasoning as concat-short, and tighter still: measured 4.19 ns/op
    // (js), so the previous `minNsPerOp: 3` had only a 1.4x margin — it was far
    // more likely to fire on a fast machine than on a collapsed loop, which is
    // 20x+ too fast, not 1.4x. The universal 1 ns bound covers it.
    source: `
export function run(): number {
  const chunk = "x".repeat(1024);
  let s = "";
  for (let i = 0; i < 1000; i = i + 1) {
    s = s + chunk;
  }
  return s.length;
}`,
    js: concatLong,
  },
  {
    name: "string/indexOf",
    iterations: 50,
    opsPerCall: 1000,
    minNsPerOp: 5,
    source: `
export function run(): number {
  const haystack = "abcdefghij".repeat(1000);
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    sum = sum + haystack.indexOf("fghij", (i * 61) % 10000);
  }
  return sum;
}`,
    js: searchIndexOf,
  },
  {
    name: "string/includes",
    iterations: 50,
    opsPerCall: 1000,
    minNsPerOp: 5,
    source: `
export function run(): number {
  const haystack = "abcdefghij".repeat(1000);
  let count = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    if (haystack.includes("fghij", (i * 61) % 10011)) count = count + 1;
  }
  return count;
}`,
    js: searchIncludes,
  },
  {
    name: "string/split",
    iterations: 50,
    opsPerCall: 10000,
    // The native compiler scalar-replaces a const split result observed only
    // through `.length`: it still evaluates the induction-dependent table read
    // (and preserves its trap), but does not allocate the transient array.
    // Measured honest cost is ~8 ns/op; keep the floor near one quarter of it.
    minNsPerOp: 2,
    source: `
export function run(): number {
${variantTable(CSV_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    const parts = variants[i % 8].split(",");
    sum = sum + parts.length;
  }
  return sum;
}`,
    js: splitJoin,
  },
  {
    name: "string/replace",
    iterations: 100,
    opsPerCall: 1000,
    // (#4118) Read a CHARACTER of the result, not just its length. "fox"->"cat"
    // is length-preserving, so `.length` is derivable from the receiver alone
    // and Binaryen -O4 strength-reduced the whole replace away — the same trap
    // documented on `substringExtract` below. Reading a char forces the
    // replaced string to actually exist. Floor unchanged.
    minNsPerOp: 1.5,
    source: `
export function run(): number {
${variantTable(REPLACE_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    const r = variants[i % 8].replace("fox", "cat");
    sum = sum + r.length + r.charCodeAt(i % 43);
  }
  return sum;
}`,
    js: replaceAll,
  },
  {
    name: "string/case-convert",
    iterations: 100,
    opsPerCall: 2000,
    // (#4118) Read a CHARACTER of each converted string, not just its length.
    // ASCII case conversion preserves length, so `.length` is derivable from the
    // receiver and both temporaries were eliminated outright. Floor unchanged.
    minNsPerOp: 0.75,
    source: `
export function run(): number {
${variantTable(CASE_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    const s = variants[i % 8];
    const lower = s.toLowerCase();
    const upper = s.toUpperCase();
    sum = sum + lower.length + lower.charCodeAt(i % 23);
    sum = sum + upper.length + upper.charCodeAt(i % 23);
  }
  return sum;
}`,
    js: caseConvert,
  },
  {
    name: "string/substring",
    iterations: 100,
    opsPerCall: 10000,
    // The compiler now scalar-replaces a non-escaping substring with its
    // (data, offset, length) descriptor. The loop still performs all three
    // induction-dependent remainders and reads two UTF-16 code units, so this
    // is not the old `.length`-only elimination bug. It measures ~2.2 ns/op;
    // retain the usual roughly-quarter-cost plausibility margin.
    minNsPerOp: 0.5,
    source: `
export function run(): number {
  const s = "abcdefghijklmnopqrstuvwxyz";
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    const t = s.substring(i % 5, 20 + (i % 6));
    sum = sum + t.charCodeAt(i % 7) + t.charCodeAt(t.length - 1);
  }
  return sum;
}`,
    js: substringExtract,
  },
  {
    name: "string/trim",
    iterations: 100,
    opsPerCall: 10000,
    minNsPerOp: 5,
    source: `
export function run(): number {
${variantTable(TRIM_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    sum = sum + variants[i % 8].trim().length;
  }
  return sum;
}`,
    js: trimOps,
  },
  {
    name: "string/startsWith-endsWith",
    iterations: 100,
    opsPerCall: 20000,
    minNsPerOp: 2,
    source: `
export function run(): number {
${variantTable(STARTS_ENDS_VARIANTS)}
  let count = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    const s = variants[i % 8];
    if (s.startsWith("hello")) count = count + 1;
    if (s.endsWith("benchmarking")) count = count + 1;
  }
  return count;
}`,
    js: startsEndsWith,
  },
];
