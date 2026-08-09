import type { BenchmarkDef } from "../harness.js";

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function pushPop(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i++) arr.push(i);
  let count = 0;
  while (arr.length > 0) {
    arr.pop();
    count++;
  }
  return count;
}

function sortI32(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push((i * 37 + 13) % 10000);
  arr.sort((a, b) => a - b);
  return arr[0]!;
}

function sortF64(): void {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(Math.sin(i));
  arr.sort((a, b) => a - b);
}

function mapFilter(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  const mapped = arr.map((x) => x * 2);
  const filtered = mapped.filter((x) => x % 3 === 0);
  return filtered.length;
}

function reduceSum(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i++) arr.push(i);
  const sum = arr.reduce((acc, x) => acc + x, 0);
  return sum;
}

function indexOfSearch(): number {
  // (#3898) Filled with a PERMUTATION, not with `i`. When `arr[i] === i` the
  // whole search collapses to the identity `arr.indexOf(x) === x`, which the
  // wasm lanes proved and constant-folded — they reported ~11 ns/op for a scan
  // of ~5000 elements. 7919 is prime and coprime to 10000, so `i * 7919 % 10000`
  // is a bijection on [0, 10000): every target still exists exactly once, at a
  // position that is not derivable from its value.
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push((i * 7919) % 10000);
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += arr.indexOf(i * 10);
  return sum;
}

function sliceSplice(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const sliced = arr.slice(100, 500);
    total += sliced.length;
  }
  return total;
}

function reverseArr(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  for (let i = 0; i < 1000; i++) arr.reverse();
  return arr[0]!;
}

function forEachSum(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let sum = 0;
  arr.forEach((x) => {
    sum += x;
  });
  return sum;
}

function findElement(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let sum = 0;
  for (let i = 0; i < 100; i++) {
    const found = arr.find((x) => x === 5000);
    if (found !== undefined) sum += found;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const arrayBenchmarks: BenchmarkDef[] = [
  {
    name: "array/push-pop",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i = i + 1) {
    arr.push(i);
  }
  let count = 0;
  while (arr.length > 0) {
    arr.pop();
    count = count + 1;
  }
  return count;
}`,
    js: pushPop,
  },
  {
    name: "array/sort-i32",
    iterations: 20,
    // (#3902) The Wasm source used to call bare `arr.sort()` while the JS
    // baseline called `arr.sort((a, b) => a - b)`. Those are DIFFERENT
    // algorithms: the spec default comparator is ToString/lexicographic
    // (§23.1.3.30), so the Wasm lane was stringifying 10,000 numbers and
    // ordering them as "1","10","100","2" while JS did a plain numeric sort.
    // The published 1,586× gap was therefore partly a measurement artifact.
    // Both lanes now use the same numeric comparator.
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push((i * 37 + 13) % 10000);
  }
  arr.sort((a: number, b: number): number => a - b);
  return arr[0];
}`,
    js: sortI32,
  },
  {
    name: "array/map-filter",
    iterations: 50,
    // 10000 pushes + 10000 map visits + 10000 filter visits.
    opsPerCall: 30000,
    // No per-benchmark floor: measured 2026-08-04 at 4.4 ns/op (js) and 18.3
    // (host-call / gc-native). A quarter of the honest cost is ~1.1 ns, i.e.
    // essentially the universal 1 ns bound, so that bound is the right and only
    // floor here. This lane is genuinely ~4.2x slower than js and stable across
    // 14 consecutive runs (4.0x-5.1x) — it is a real gap, not a collapsed loop.
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  const mapped = arr.map((x: number): number => x * 2);
  const filtered = mapped.filter((x: number): boolean => x % 3 === 0);
  return filtered.length;
}`,
    js: mapFilter,
  },
  {
    name: "array/reduce",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 100000; i = i + 1) {
    arr.push(i);
  }
  return arr.reduce((acc: number, x: number): number => acc + x, 0);
}`,
    js: reduceSum,
  },
  {
    name: "array/indexOf",
    iterations: 50,
    // 1000 `indexOf` calls (the pushes that build the array are setup).
    opsPerCall: 1000,
    // `arr.indexOf(i * 10)` on [0..9999] finds at index i*10, so each call scans
    // ~5000 elements on average. Measured 2026-08-04: js 3939 ns/op, but
    // host-call and gc-native both reported ~12.7 ns/op — 310x faster than js
    // and ~0.0025 ns per element scanned, which is physically impossible. The
    // wasm lanes fold the whole search away (the array is a compile-time
    // constant sequence), and the page published that as a 310x speedup.
    //
    // 12.7 clears the universal 1 ns bound, so only a per-benchmark floor
    // catches it — the same reason `string/indexOf` carries one. 25 ns/op means
    // 200 elements/ns, comfortably impossible, while still allowing a wasm lane
    // to be 150x faster than js before tripping. Deliberately loose: a floor
    // that fires on a fast machine is worse than one that misses a mild
    // collapse.
    minNsPerOp: 25,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push((i * 7919) % 10000);
  }
  let sum = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    sum = sum + arr.indexOf(i * 10);
  }
  return sum;
}`,
    js: indexOfSearch,
  },
  {
    name: "array/slice",
    iterations: 100,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 1000; i = i + 1) {
    arr.push(i);
  }
  let total = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const sliced = arr.slice(100, 500);
    total = total + sliced.length;
  }
  return total;
}`,
    js: sliceSplice,
  },
  {
    name: "array/reverse",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  for (let i = 0; i < 1000; i = i + 1) {
    arr.reverse();
  }
  return arr[0];
}`,
    js: reverseArr,
  },
  {
    name: "array/forEach",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  arr.forEach((x: number): void => {
    sum = sum + x;
  });
  return sum;
}`,
    js: forEachSum,
  },
  {
    name: "array/find",
    iterations: 50,
    source: `
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) {
    arr.push(i);
  }
  let sum = 0;
  for (let i = 0; i < 100; i = i + 1) {
    const found = arr.find((x: number): boolean => x === 5000);
    if (found !== undefined) sum = sum + found;
  }
  return sum;
}`,
    js: findElement,
    // (#3902) The `skip: ["gc-native"], // find with undefined check may not
    // work in fast mode` guard that lived here was a guess, never a finding.
    // Removing it and running the lane: it works, and it is the fastest lane of
    // the three. The bar it suppressed was the host-call one at ~2× slower than
    // JS, which made `array/find` read as a loss.
  },
];
