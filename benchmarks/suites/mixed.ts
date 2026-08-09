import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// #3898 — string-bearing loops must depend on the induction variable
// ---------------------------------------------------------------------------
//
// `mixed/text-search` called `includes`/`startsWith`/`endsWith`/`indexOf` with a
// constant receiver AND constant arguments, so the whole group was
// loop-invariant and TurboFan could hoist it out and run it once. The outer
// `csv.split("\n")` in `mixed/csv-parse` was loop-invariant for the same reason.
//
// Both now index a small table of distinct receivers with the loop counter.
// Varying the *position argument* instead was rejected for the same reason as in
// `suites/strings.ts`: `startsWith("The", p)` with p > 0 mismatches on the first
// character and returns early, which deletes work from both lanes rather than
// preserving it.
//
// ---------------------------------------------------------------------------
// #4118 follow-up — the accumulated VALUE has to vary, not just the receiver
// ---------------------------------------------------------------------------
//
// "Every variant keeps the original match outcome" preserved comparability but
// left the loop body loop-invariant in value: all four TEXT variants matched all
// four predicates, so `count` was 4 every iteration, and every CSV_DOC variant
// had 11 lines of 3 columns, so `sum` was 30 every iteration. See the long note
// in `suites/strings.ts` for how that collapsed a lane below the #3898 floor.
//
// `mixed/text-search` now folds in the `indexOf` RESULT rather than just the
// sign of it. That costs nothing — the index is already computed — and it varies
// per variant because the rearrangements move "jump". Two variants also end in
// "quickly!" so `endsWith("quickly.")` differs; the mismatch is on the final
// character, so the comparison still scans the full needle.

/** 4 rearrangements; all start with "The" and contain "jump" at differing offsets. */
const TEXT_VARIANTS = [
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. The five boxing wizards jump quickly.",
  "The quick brown fox jumps over the lazy dog. How vexingly quick daft zebras jump. Pack my box with five dozen liquor jugs. The five boxing wizards jump quickly.",
  "The five boxing wizards jump over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. The quick brown fox jumps quickly!",
  "The quick brown fox jumps over the lazy dog. The five boxing wizards jump. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump quickly!",
];

/** 4 header/row rearrangements; all 11 lines of 3 comma-separated columns. */
const CSV_DOC_VARIANTS = [
  "name,age,city\nAlice,30,Berlin\nBob,25,Munich\nCharlie,35,Hamburg\nDiana,28,Cologne\nEve,32,Frankfurt\nFrank,29,Stuttgart\nGrace,31,Leipzig\nHank,27,Dresden\nIvy,33,Bonn\nJack,26,Essen",
  "name,age,city\nBob,25,Munich\nCharlie,35,Hamburg\nDiana,28,Cologne\nEve,32,Frankfurt\nFrank,29,Stuttgart\nGrace,31,Leipzig\nHank,27,Dresden\nIvy,33,Bonn\nJack,26,Essen\nAlice,30,Berlin",
  "name,age,city\nCharlie,35,Hamburg\nDiana,28,Cologne\nEve,32,Frankfurt\nFrank,29,Stuttgart\nGrace,31,Leipzig\nHank,27,Dresden\nIvy,33,Bonn\nJack,26,Essen\nAlice,30,Berlin\nBob,25,Munich",
  "name,age,city\nDiana,28,Cologne\nEve,32,Frankfurt\nFrank,29,Stuttgart\nGrace,31,Leipzig\nHank,27,Dresden\nIvy,33,Bonn\nJack,26,Essen\nAlice,30,Berlin\nBob,25,Munich\nCharlie,35,Hamburg",
];

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function csvParse(): number {
  let total = 0;
  for (let iter = 0; iter < 1000; iter++) {
    const lines = CSV_DOC_VARIANTS[iter % 4]!.split("\n");
    let sum = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(",");
      // (#4118) cols.length is 3 for every row of every variant. Fold in the
      // last column's length too so the result varies — see the note at the top.
      sum += cols.length + cols[cols.length - 1]!.length;
    }
    total += sum;
  }
  return total;
}

function textSearch(): number {
  const needle = "jump";
  let total = 0;
  for (let iter = 0; iter < 10000; iter++) {
    const text = TEXT_VARIANTS[iter % 4]!;
    let count = 0;
    if (text.includes(needle)) count++;
    if (text.startsWith("The")) count++;
    if (text.endsWith("quickly.")) count++;
    const idx = text.indexOf(needle);
    // (#4118) Fold in the INDEX, not just its sign — see the note at the top.
    if (idx >= 0) count += idx;
    total += count;
  }
  return total;
}

/**
 * The `% MOD` fold is not decoration (#3898).
 *
 * Alternating `fib(29)` and `fib(30)` keeps the call dependent on the induction
 * variable. A constant `fib(30)` is correctly folded by the compiler's ground-
 * call pass, which would make this benchmark measure only the accumulator loop
 * and trip the physical plausibility guard once that loop becomes fast enough.
 *
 * The calls produce 514,229 and 832,040 and the loop runs 10,000 times, so a
 * plain sum still reaches 6.73e9 — past 2^31. The gc-native lane can infer i32
 * for the accumulator while JS and the host-call/linear lanes carry it in f64.
 * The cross-lane assertion caught that mismatch on the first corrected run.
 * Folding modulo a prime below 2^31 keeps every lane exact *and* in i32 range,
 * so the benchmark compares the same arithmetic everywhere instead of quietly
 * pitting wrapping i32 adds against f64 adds.
 */
const FIB_MOD = 1000000007;

function fibonacci(): number {
  function fib(n: number): number {
    if (n <= 1) return n;
    let a = 0,
      b = 1;
    for (let i = 2; i <= n; i++) {
      const t = a + b;
      a = b;
      b = t;
    }
    return b;
  }
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum = (sum + fib(29 + (i & 1))) % FIB_MOD;
  return sum;
}

function matrixMultiply(): number {
  const N = 50;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i++) {
    a.push(i);
    b.push(N * N - i);
    c.push(0);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += a[i * N + k]! * b[k * N + j]!;
      }
      c[i * N + j] = sum;
    }
  }
  return c[0]!;
}

function sieve(): number {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i++) isPrime.push(1);
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i++) {
    if (isPrime[i]) {
      for (let j = i * i; j < N; j += i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (isPrime[i]) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

/** Emit a variant table into a Wasm `source` from the array the JS lane uses. */
function variantTable(variants: readonly string[]): string {
  return `  const variants: string[] = [\n${variants.map((v) => `    ${JSON.stringify(v)}`).join(",\n")}\n  ];`;
}

export const mixedBenchmarks: BenchmarkDef[] = [
  {
    name: "mixed/csv-parse",
    iterations: 20,
    // 1000 outer iterations × (1 newline split + 10 comma splits).
    opsPerCall: 11000,
    minNsPerOp: 5,
    source: `
export function run(): number {
${variantTable(CSV_DOC_VARIANTS)}
  let total = 0;
  for (let iter = 0; iter < 1000; iter = iter + 1) {
    const lines = variants[iter % 4].split("\\n");
    let sum = 0;
    for (let i = 1; i < lines.length; i = i + 1) {
      const cols = lines[i].split(",");
      sum = sum + cols.length + cols[cols.length - 1].length;
    }
    total = total + sum;
  }
  return total;
}`,
    js: csvParse,
  },
  {
    name: "mixed/text-search",
    iterations: 20,
    // 10000 outer iterations × 4 search calls.
    opsPerCall: 40000,
    minNsPerOp: 2,
    source: `
export function run(): number {
${variantTable(TEXT_VARIANTS)}
  const needle = "jump";
  let total = 0;
  for (let iter = 0; iter < 10000; iter = iter + 1) {
    const text = variants[iter % 4];
    let count = 0;
    if (text.includes(needle)) count = count + 1;
    if (text.startsWith("The")) count = count + 1;
    if (text.endsWith("quickly.")) count = count + 1;
    const idx = text.indexOf(needle);
    if (idx >= 0) count = count + idx;
    total = total + count;
  }
  return total;
}`,
    js: textSearch,
  },
  {
    name: "mixed/fibonacci",
    iterations: 50,
    // 10,000 induction-dependent fib calls; a constant argument is ground-folded.
    opsPerCall: 10000,
    source: `
function fib(n: number): number {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i = i + 1) {
    const t = a + b;
    a = b;
    b = t;
  }
  return b;
}

export function run(): number {
  let sum = 0;
  for (let i = 0; i < 10000; i = i + 1) {
    sum = (sum + fib(29 + (i & 1))) % 1000000007;
  }
  return sum;
}`,
    js: fibonacci,
  },
  {
    name: "mixed/matrix-multiply",
    iterations: 50,
    // 50³ multiply-accumulates.
    opsPerCall: 125000,
    source: `
export function run(): number {
  const N = 50;
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < N * N; i = i + 1) {
    a.push(i);
    b.push(N * N - i);
    c.push(0);
  }
  for (let i = 0; i < N; i = i + 1) {
    for (let j = 0; j < N; j = j + 1) {
      let sum = 0;
      for (let k = 0; k < N; k = k + 1) {
        sum = sum + a[i * N + k] * b[k * N + j];
      }
      c[i * N + j] = sum;
    }
  }
  return c[0];
}`,
    js: matrixMultiply,
  },
  {
    name: "mixed/sieve",
    iterations: 20,
    // One fill pass + one count pass over N = 100000.
    opsPerCall: 200000,
    source: `
export function run(): number {
  const N = 100000;
  const isPrime: number[] = [];
  for (let i = 0; i < N; i = i + 1) {
    isPrime.push(1);
  }
  isPrime[0] = 0;
  isPrime[1] = 0;
  for (let i = 2; i * i < N; i = i + 1) {
    if (isPrime[i] === 1) {
      for (let j = i * i; j < N; j = j + i) {
        isPrime[j] = 0;
      }
    }
  }
  let count = 0;
  for (let i = 0; i < N; i = i + 1) {
    if (isPrime[i] === 1) count = count + 1;
  }
  return count;
}`,
    js: sieve,
  },
];
