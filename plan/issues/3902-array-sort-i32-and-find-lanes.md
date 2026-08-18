---
id: 3902
title: "perf: array/sort-i32 host-call takes 774 ms (1,586× JS) and has no gc-native lane at all; array/find's gc-native lane is disabled by a stale skip"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: array-methods
goal: performance
sprint: 78
horizon: l
es_edition: multi
related: [3903, 3898, 3512, 3912]
---

<!--
coercion-sites-allow (#3902) — REMOVED by #3912, as #3902 itself instructed.

The allowance covered ONE detection lookup in `src/codegen/array-methods.ts`:

    const numToStrExisting = ctx.funcMap.get("number_toString");

which asked whether `number_toString` currently resolved to the JS-host import,
so `compileArrayDefaultToStringSort` could fall back to all-host string
comparison instead of `ref.cast`-ing a host-owned JS string to `$AnyString`
(the `illegal cast` trap that made the gc-native lane vanish from the
benchmark page).

#3912 gated `number_toString` on `usesNativeNumberFormat` (wasi || standalone
|| nativeStrings), so the helper can no longer be a host import while
`ctx.nativeStrings` is on. The probe became dead code and was deleted along
with this allowance; `native` is now plain
`ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0`.
-->


# #3902 — `array/sort-i32` is the worst number on the perf page; `array/find` has no fast lane

## Status: done (2026-07-31)

## Problem A — `array/sort-i32`: 774 ms, and no gc-native lane

From `benchmarks/results/latest.json` (2026-07-31):

| strategy    | avgMs per `run()` | vs JS      |
| ----------- | ----------------- | ---------- |
| `js`        | 0.487969          | 1×         |
| `host-call` | **773.937268**    | **1,586×** |
| `gc-native` | **absent**        | lane fails |

This is by a wide margin the worst entry on
`https://js2.loopdive.com/benchmarks/performance.html` — three-quarters of a
second to sort 10,000 integers, against 0.49 ms in JS. It is also the only
benchmark where a whole strategy silently vanishes from the chart.

The benchmark (`benchmarks/suites/arrays.ts:105-117`):

```ts
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) arr.push((i * 37 + 13) % 10000);
  arr.sort();
  return arr[0];
}
```

Two separate things to establish:

1. **Why is host-call 774 ms?** 10,000 elements is ~130,000 comparisons for an
   O(n log n) sort. 774 ms ÷ 130,000 = **~6 µs per comparison**, which is far
   beyond even a host round-trip per compare. Either the sort is O(n²)
   (~50,000,000 comparisons → ~15 ns each, which *is* consistent with a host
   boundary crossing per compare), or each comparison boxes both operands
   through `externref`. **Check the algorithm first** — the numbers point at
   an insertion/bubble sort more than at boxing.
2. **Why does the gc-native lane not exist?** The harness silently downgrades a
   failing strategy to "skipped" (`benchmarks/harness.ts:168-177`, and again
   at calibration and mid-loop). The stderr line is printed but not recorded,
   so the public chart just shows one fewer bar. Reproduce with
   `npx tsx benchmarks/run.ts --suite arrays --filter sort-i32` and capture the
   actual message.

Also note a **semantic mismatch** between the two lanes, which must be fixed
or documented either way: the JS baseline calls `arr.sort((a, b) => a - b)`
(numeric compare) while the Wasm source calls bare `arr.sort()` (spec default
= **lexicographic string** compare). These are different algorithms producing
different results. If our `sort()` is doing the spec-correct string conversion
of 10,000 numbers, that alone could explain a large constant factor — and it
means the benchmark is not comparing like with like. Fix the benchmark to use
the same comparator on both sides, then re-measure before optimising.

## Problem B — `array/find` has its fast lane switched off by a stale comment

`benchmarks/suites/arrays.ts:231`:

```ts
skip: ["gc-native"], // find with undefined check may not work in fast mode
```

"may not work" is a guess, not a finding. The consequence is that `array/find`
publishes only a `host-call` bar (0.442203 ms vs JS 0.223464 ms = **1.98×
slower**), and the lane that would likely win is never run. Every other array
benchmark's gc-native lane beats JS by 1.7-2.8×, so there is a good chance
this bar is misleading purely because of a two-year-old TODO.

**Task**: remove the skip, run it, and find out. If it genuinely fails,
replace the comment with the actual error and file a real issue for it. If it
works, delete the skip and publish the number.

## Scope

1. Fix the sort comparator mismatch in `benchmarks/suites/arrays.ts` (both
   lanes use the same comparison).
2. Reproduce and report the gc-native `sort-i32` failure; fix it if it is in
   scope, otherwise file a precise follow-up.
3. Establish whether `sort` is O(n²) and/or boxing per comparison. Fix the
   dominant cost. A monomorphic numeric sort over an `(array f64)` /
   `(array i32)` should not need to leave Wasm at all.
4. Un-skip `array/find` gc-native; publish or explain.
5. **Harness**: a strategy that fails should not disappear silently. Record
   the failure in the results JSON (e.g. `{strategy, status: "failed", error}`)
   so the page can render "lane failed" instead of omitting the bar. A missing
   bar currently reads as "not applicable", which is not what happened.

## Acceptance criteria

1. `array/sort-i32` host-call improves by **≥50×** against the current
   773.94 ms (target ≤15 ms), measured with
   `npx tsx benchmarks/run.ts --suite arrays --filter sort-i32`.
2. `array/sort-i32` has a **working gc-native lane** that beats the JS
   baseline, or the issue documents precisely why it cannot and links a
   follow-up.
3. `array/find` has a working gc-native lane, or the stale comment is replaced
   with the real error and a linked issue.
4. Failed strategies appear in `benchmarks/results/latest.json` with an error
   string rather than being omitted.
5. No equivalence-test regressions; no test262 regressions in
   `built-ins/Array/prototype/sort` or `.../find`.

## Non-goals

- The general `host-call` string-boundary cost (#3903).
- Rewriting `sort` as a self-hosted timsort — that is the separate
  self-hosted-stdlib track. Fix the measured dominant cost here.

---

## Findings (2026-07-31)

### It was BOTH causes, and they were roughly equal and multiplicative

The issue asked whether the 774 ms was the comparator mismatch, an O(n²)
algorithm, or per-comparison boxing. Measured answer: **the comparator mismatch
and the O(n²) algorithm each account for a ~55× factor, and they compound.**
Boxing is real but it is a *component of* the comparator-mismatch factor, not a
separate one.

The attribution comes from a 2×2 sweep (old compiler vs new, bare `sort()` vs
`sort((a,b)=>a-b)`), n = 10,000, `optimize: 4`, median of 5. Numbers are from
the dev container with six agents live, so they run ~2.5× the published figures
— read the ratios, not the absolutes:

| variant                       | lane        | BEFORE            | AFTER    |
| ----------------------------- | ----------- | ----------------- | -------- |
| `arr.sort()` (ToString order) | `host-call` | 1982 ms           | 32.9 ms  |
| `arr.sort()` (ToString order) | `gc-native` | **`illegal cast`** | 30.9 ms  |
| `arr.sort((a,b)=>a-b)`        | `host-call` | 36.6 ms           | 0.667 ms |
| `arr.sort((a,b)=>a-b)`        | `gc-native` | 55.9 ms           | 0.604 ms |
| (JS baseline, same box)       | `js`        | 2.0–2.7 ms        | 1.1–1.7 ms |

Read the table two ways:

- **Hold the algorithm, change the comparator** (row 1 → row 3, both insertion
  sort): 1982 ms → 36.6 ms = **54×**. That is the comparator mismatch. The
  default comparator is ToString (§23.1.3.30), so every one of the ~25,000,000
  comparisons called `number_toString` *and* `string_compare` — two host-import
  crossings per compare, with a JS string materialised each time. This is where
  "boxing" shows up, and it is genuinely enormous.
- **Hold the comparator, change the algorithm** (BEFORE → AFTER within a row):
  60× on the default sort, 55× on the comparator sort. That is the O(n²).

So the headline 774 ms was ≈ `55 × 55` of avoidable work over a numeric merge
sort. The issue's arithmetic in the problem statement was right: 774 ms is not
6 µs × 130,000 comparisons, it is ~15–30 ns × ~25,000,000 comparisons, i.e.
`n²/4` for a pseudo-random permutation of 10,000 elements.

Note the pre-existing `gc-native` row: 55.9 ms, *slower* than `host-call`'s
36.6 ms. A `call_ref` comparison in fast mode was more expensive than a host
call. After the fix, gc-native is the faster of the two (0.604 vs 0.667 ms), as
it should be.

### The gc-native lane failure — verbatim error and root cause

```
[gc-native skipped (runtime): illegal cast]
```

(`RuntimeError: illegal cast`, thrown from the harness's warmup call, printed to
stderr by `benchmarks/harness.ts` and then returned as `null`, which is why the
bar simply vanished from the chart.)

Root cause is a **gate mismatch between two adjacent helper registrations** in
`src/codegen/declarations/import-collector.ts`:

```ts
const needsNativeNumberToString =
  state.primitiveNeeded.has("number_toString") && (ctx.wasi || ctx.standalone);   // ← line ~1382
...
if (state.primitiveNeeded.has("string_compare") && !ctx.nativeStrings) { … }      // ← line ~1442
```

`string_compare` is gated on `ctx.nativeStrings`; `number_toString` is gated on
`ctx.wasi || ctx.standalone`. `fast: true` sets `nativeStrings` (see
`create-context.ts` — `nativeStrings ??= fast || wasi || standalone || …`) but
sets neither `wasi` nor `standalone`. So in the **entire gc-native lane** the
module gets the *native* `__str_compare` **and** the *JS-host*
`env.number_toString`. `compileArrayDefaultToStringSort`'s native branch then
emitted

```wat
call $number_toString      ;; → a genuine JS string (externref)
any.convert_extern
ref.cast (ref $AnyString)  ;; ← traps: a host-owned extern is not an internal GC ref
```

Confirmed by reading the emitted WAT: `call 0` is import #0, `env.number_toString`.

**Fix applied here** is deliberately narrow: detect that `number_toString`
resolved to an *import* (index below the imported-function count) and, when it
did, fall back to the all-host string comparison for the default sort —
`cmpStrType = externref`, plus a late `string_compare` import (which
`nativeStrings` mode had skipped). Correct ToString ordering, and no new class
of dependency, since the module already imports `number_toString` in exactly
this configuration.

**Follow-up (not done here):** making `number_toString` native whenever
`ctx.nativeStrings` is on. That is the real fix, but it changes number
formatting for *every* fast-mode program (`String(n)`, template literals,
`.toFixed`, `.join()` on a `number[]`, …) and pulls the self-hosted Ryū
formatter into every such module, so it needs its own issue and its own
conformance run. It is not hypothetical: the same mismatch makes
`(3).toString()` fail in fast mode with `dereferencing a null pointer`, and
`[1,2].join(",")` on a `number[]` fail with `illegal cast`. Both reproduce on
`main` today and are independent of sort.

### `array/find` — the stale skip was simply wrong

`skip: ["gc-native"], // find with undefined check may not work in fast mode`
removed; the lane runs, produces correct results, and is the **fastest of the
three**:

```
array/find ... js: 1.122ms | host-call: 0.875ms | gc-native: 0.646ms
```

The bar the comment suppressed for two years was the `host-call` one at ~2× JS,
so `array/find` was published as a loss when the lane that would have led was
never run. No follow-up issue needed.

Incidental finding while running it: the `linear-memory` lane for `array/find`
fails module validation —
`Compiling function #50:"run" failed: local.set[0] expected type i32, found local.get of type f64`.
That is a real linear-backend typing bug, unrelated to this issue and not fixed
here.

### What changed

- **`src/codegen/merge-sort.ts` (new)** — `emitStableMergeSort`, a shared stable
  bottom-up merge sort emitted inline at the call site, parameterised by a
  `buildCompareGtZero(pushLeft, pushRight)` callback. Extracted into its own
  module rather than added to `array-methods.ts` because the latter is a
  god-file under the `check:loc-budget` gate.
- **`src/codegen/array-methods.ts`** — both `compileArrayDefaultToStringSort`
  and `tryCompileComparatorSort` dropped their private copies of the same
  insertion sort and now call the shared emitter; plus the `number_toString`
  import-detection fix described above.
- **`benchmarks/suites/arrays.ts`** — `sort-i32` Wasm source uses the same
  numeric comparator as the JS baseline; `array/find`'s `skip` removed.
- **`tests/issue-3902-sort-merge.test.ts` (new)** — 14 cases pinning total
  order, stability, in-placeness, the merge-sort-specific edge cases
  (lengths 0/1/2/3, non-power-of-two length with an odd pass count → the
  copy-back branch), and the gc-native default-sort trap.

### Design notes on the merge sort (why it is shaped this way)

- **Stability is load-bearing** (§23.1.3.30 requires it since ES2019, and the
  insertion sort it replaces had it). The merge takes from the LEFT run whenever
  `cmp(left, right) <= 0`.
- **Scratch buffer is seeded with `data[0]` via `array.new`, not
  `array.new_default`.** The element type reaching the comparator sort can be a
  non-nullable `(ref $T)` (struct-element arrays — #1967 widened the gate), and
  a non-nullable ref is not defaultable, so `array.new_default` would emit
  invalid Wasm. `data[0]` is always a valid element of the exact element type,
  and the `len < 2` early-out guarantees index 0 exists.
- **Ping-pong with a parity flag, not a per-pass copy-back.** Each pass merges
  `src` into `dst` then swaps; a single `array.copy` at the end restores the
  scratch into the caller's backing array iff an odd number of passes ran. The
  array *object* is never replaced, so `sort()` stays in-place and aliases /
  `vec.data` stay valid — `const out = arr.sort(cmp); out.push(9)` must still be
  visible through `arr`, and there is a test for exactly that.
- **Emitted inline, not as a module helper.** Same reason the insertion sort was
  inline: the comparator closure local must stay in scope for the `call_ref`, and
  threading a closure through a module-level helper is a bigger change than this
  issue warrants.
- **The default sort now pays TWO `number_toString` calls per comparison**
  instead of one (the insertion sort could hoist the right operand — it was
  always the same `key`). That is a 2× regression on a factor that shrank by
  ~190×, so it nets out to ~94× fewer host calls. Caching each element's string
  in a parallel array would remove the remaining `n·log n → n` factor and is the
  obvious next step if the default ToString sort ever becomes hot; it needs an
  array type for the string element, which is why it is not done here.

### Acceptance criteria

1. ✅ **≥50× on `array/sort-i32` host-call.** 1982 ms → 0.62–0.99 ms measured
   through `npx tsx benchmarks/run.ts --suite arrays --filter sort-i32`
   (>1,000×, against a ≥50× / ≤15 ms bar). Attribution above.
2. ✅ **`array/sort-i32` has a working gc-native lane that beats the JS
   baseline.** `js: 1.248ms | host-call: 0.622ms | gc-native: 1.027ms` on the
   loaded dev box; both Wasm lanes now beat JS, where before gc-native did not
   exist at all.
3. ✅ **`array/find` has a working gc-native lane.** It is the fastest lane; the
   stale comment is deleted, not replaced.
4. ⚠️ **Failed strategies recorded in the results JSON — NOT done in this
   change-set, by coordination.** The identical harness change was needed by
   #3904 and was landed there first (`benchmarks/harness.ts` `status: "failed"`
   / `error` / `failedPhase`, plus the `report.ts`,
   `scripts/benchmark-lifecycle.mjs` and `perf-benchmark-chart.js` consumers).
   Duplicating it here would have produced a guaranteed conflict on the same
   hunks. This change-set touches only `benchmarks/suites/arrays.ts`.
5. ✅ **No equivalence-test regressions.** `tests/equivalence/sort-nonnumeric`,
   `array-prototype-methods`, `array-zero-arg-methods`, `array-push-pop`,
   `array-of-structs`, plus `issue-1816` / `issue-1993` / `issue-1361` /
   `issue-2379` / `issue-2502` / `issue-1589` and
   `tests/array-methods` / `array-prototype-methods` /
   `functional-array-methods` all pass. `tests/fast-arrays.test.ts > array find`
   fails identically on `main` (a `number | undefined` type error in the test's
   own fixture) — pre-existing, verified by stashing. test262 was not run
   locally: the submodule is not checked out in this worktree and CI owns the
   conformance gate.
