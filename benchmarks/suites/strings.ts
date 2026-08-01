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
// harness compares it against the Wasm `run()` return value (see `harness.ts`)
// — a cross-lane assertion that would have caught this bug.

// ---------------------------------------------------------------------------
// Variant tables — shared verbatim by both lanes
// ---------------------------------------------------------------------------

/** 8 rotations of the same 8 comma-separated fields; all 49 chars, 8 fields. */
const CSV_VARIANTS = [
  "alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel",
  "bravo,charlie,delta,echo,foxtrot,golf,hotel,alpha",
  "charlie,delta,echo,foxtrot,golf,hotel,alpha,bravo",
  "delta,echo,foxtrot,golf,hotel,alpha,bravo,charlie",
  "echo,foxtrot,golf,hotel,alpha,bravo,charlie,delta",
  "foxtrot,golf,hotel,alpha,bravo,charlie,delta,echo",
  "golf,hotel,alpha,bravo,charlie,delta,echo,foxtrot",
  "hotel,alpha,bravo,charlie,delta,echo,foxtrot,golf",
];

/** 8 rotations of the pangram; all 43 chars, each contains "fox" exactly once. */
const REPLACE_VARIANTS = [
  "the quick brown fox jumps over the lazy dog",
  "quick brown fox jumps over the lazy dog the",
  "brown fox jumps over the lazy dog the quick",
  "fox jumps over the lazy dog the quick brown",
  "jumps over the lazy dog the quick brown fox",
  "over the lazy dog the quick brown fox jumps",
  "the lazy dog the quick brown fox jumps over",
  "lazy dog the quick brown fox jumps over the",
];

/** 8 distinct mixed-case phrases, all 23 chars. */
const CASE_VARIANTS = [
  "Hello World Test String",
  "World Test String Hello",
  "Test String Hello World",
  "String Hello World Test",
  "Alpha Bravo Charlie Del",
  "Bravo Charlie Del Alpha",
  "Charlie Del Alpha Bravo",
  "Del Alpha Bravo Charlie",
];

/**
 * 8 distinct receivers that all start with "hello" and all end with
 * "benchmarking".
 *
 * `startsWith`/`endsWith` are the one pair where the position argument is the
 * wrong lever: `s.startsWith("hello", i % 3)` does vary, but 2 of every 3 calls
 * then mismatch on the first character and return early, silently deleting
 * two-thirds of the benchmark's work in BOTH lanes. Varying the receiver keeps
 * all 20,000 comparisons full-length and matching, exactly as before.
 */
const STARTS_ENDS_VARIANTS = [
  "hello world, this is a test string for benchmarking",
  "hello world, this is a alpha test string for benchmarking",
  "hello world, this is a bravo test string for benchmarking",
  "hello world, this is a charlie test string for benchmarking",
  "hello world, this is a delta test string for benchmarking",
  "hello world, this is a echo test string for benchmarking",
  "hello world, this is a foxtrot test string for benchmarking",
  "hello world, this is a golf test string for benchmarking",
];

/** 8 distinct paddings of "hello world"; all trim to 11 chars. */
const TRIM_VARIANTS = [
  "   hello world   ",
  "  hello world    ",
  " hello world     ",
  "    hello world  ",
  "     hello world ",
  "      hello world",
  "hello world      ",
  "\thello world\t   ",
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
    sum = sum + REPLACE_VARIANTS[i % 8]!.replace("fox", "cat").length;
  }
  return sum;
}

function caseConvert(): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    const s = CASE_VARIANTS[i % 8]!;
    sum = sum + s.toLowerCase().length;
    sum = sum + s.toUpperCase().length;
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
    minNsPerOp: 10,
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
    minNsPerOp: 10,
    source: `
export function run(): number {
${variantTable(REPLACE_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    sum = sum + variants[i % 8].replace("fox", "cat").length;
  }
  return sum;
}`,
    js: replaceAll,
  },
  {
    name: "string/case-convert",
    iterations: 100,
    opsPerCall: 2000,
    minNsPerOp: 5,
    source: `
export function run(): number {
${variantTable(CASE_VARIANTS)}
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    const s = variants[i % 8];
    sum = sum + s.toLowerCase().length;
    sum = sum + s.toUpperCase().length;
  }
  return sum;
}`,
    js: caseConvert,
  },
  {
    name: "string/substring",
    iterations: 100,
    opsPerCall: 10000,
    // This floor was briefly lowered 3 -> 1, on the theory that our
    // `__str_substring` is an O(1) slice view (#3901) that Binaryen may
    // legitimately scalar-replace down to near-nothing. That lowering was made
    // against a lane Binaryen had *eliminated* (it accumulated only
    // `.length`, which is derivable from the arguments, so the call was
    // strength-reduced away and clocked 2.394 ns/op). Once the loop was fixed to
    // consume the slice's CONTENT, the honest costs measured on 2026-08-01 are
    // 10.3-13.7 ns/op (js) and 110-114 ns/op (gc-native) — nowhere near 3 ns.
    // So restore 3: it is ~3.4x below the cheaper of the two lanes, which is the
    // "roughly a quarter of the honest cost" margin `minNsPerOp` documents, and
    // a floor of 1 would be the loosest guard in this file for no measured
    // reason.
    minNsPerOp: 3,
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
