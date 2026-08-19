---
id: 3898
title: "perf-bench: string benchmarks on performance.html measure V8's loop-invariant hoisting, not string speed — several 'Wasm is slower' bars are artifacts"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-08-01
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: performance
sprint: 78
horizon: m
es_edition: n/a
related: [1009, 1949, 3899, 3900, 3901, 3904, 3907]
---

# #3898 — the perf-page string benchmarks measure V8's LICM, not string performance

## Status: DONE — benchmarks corrected, baselines re-derived on current main (2026-08-01)

**Jump to [Results](#results--re-derived-on-current-main-2026-08-01) for the
corrected numbers.** Headline: `string/indexOf` and `string/includes` collapse
from ~10x slower to **parity** (1.2x), `case-convert` collapses from 134x to
**2.2x**, and `string/substring` is a **genuine 10.7x deficit** — it does _not_
reverse.

> **An earlier revision of this issue claimed `string/substring` reverses to
> "3.61x faster". That claim is retracted.** It was measured against a
> gc-native lane that Binaryen had eliminated, and it was never re-measured
> after the lane was fixed. The honest figure is **10.72x slower**. See
> [The substring figure](#the-substring-figure--retracted-and-re-derived).

## Problem

`https://js2.loopdive.com/benchmarks/performance.html` renders
`benchmarks/results/latest.json`. Several JS baselines in that file report
times that are **physically impossible**, so the published "Wasm is N× slower
than JS" bars for those benchmarks are not measuring what the page claims.

From the 2026-07-31 run, `avgMs` per `run()` call:

| Benchmark             | JS avgMs   | work claimed per call                        | implied per-op cost |
| --------------------- | ---------- | -------------------------------------------- | ------------------- |
| `string/indexOf`      | 0.0015575  | 1000 × `indexOf` over a 10,000-char haystack | **1.56 ns**         |
| `string/includes`     | 0.0017079  | 1000 × `includes` over 10,000 chars          | **1.71 ns**         |
| `string/substring`    | 0.0024751  | 10,000 × `substring(5, 20)`                  | **0.25 ns**         |
| `string/case-convert` | 0.00025358 | 2000 × `toLowerCase`/`toUpperCase`           | **0.13 ns**         |

A single `indexOf` scan over 10 KB cannot complete in 1.56 ns — that is under
5 clock cycles at 3 GHz for a 10,000-character search.

## Root cause — confirmed by measurement, and it is NOT dead-code elimination

The obvious hypothesis is "the baselines return `void` and discard their
accumulator, so V8 DCEs the loop." **That hypothesis is wrong**, and acting on
it would produce a fix that changes nothing. Measured with
`.tmp/dce-probe.mjs` (each shape run as `(): void` with the result discarded,
vs. the identical body returning its accumulator into a global sink):

```
name               void(ms)   returned(ms)     ratio
indexOf            0.005123       0.003865      0.75
includes           0.003381       0.003639      1.08
substring          0.005635       0.008097      1.44
caseConvert        0.000674       0.000714      1.06
```

Returning and consuming the result changes nothing. The work is still gone.

The actual cause is **loop-invariant code motion**. Every one of these
benchmarks calls a pure `String.prototype` method with a **constant receiver
and constant arguments** inside the loop:

```ts
const haystack = "abcdefghij".repeat(1000);
for (let i = 0; i < 1000; i++) sum = sum + haystack.indexOf("fghij");
//                                        ^^^^^^^^^^^^^^^^^^^^^^^^^ same value every iteration
```

TurboFan hoists the call out of the loop and runs it **once**, then multiplies.
Confirmed by varying the argument so hoisting is impossible
(`.tmp/dce-probe2.mjs`):

```
invariant  0.004654      // haystack.indexOf("fghij")           — hoisted, ~1 scan
varying    0.029199      // haystack.indexOf("fghij", i*7%5000) — 6.3× more, ~29 ns/scan
subInv     0.008959      // s.substring(5, 20)                  — hoisted
subVar     0.108931      // s.substring(i%5, 20)                — 12.2× more, ~10.9 ns/call
ccInv      0.001032      // s.toLowerCase()/.toUpperCase(), result consumed — still ~0.5 ns/call
```

With a varying argument the per-op costs land at realistic values (29 ns for a
10 KB scan, 10.9 ns for a 15-char substring copy). With the constant argument
the loop collapses. `ccInv` shows `toLowerCase`/`toUpperCase` stay hoisted even
when the result is consumed, because the receiver is a literal.

So on these four benchmarks the page compares **"V8 hoisted the call and ran
it once"** against **"js2wasm ran it 1000 times"**.

## Consequence — the numbers may flip, not just shrink

For `string/indexOf`, the gc-native lane measures 0.0149466 ms per `run()` =
**14.9 ns per scan**. An honest JS baseline costs **29 ns per scan**. If
js2wasm is not itself hoisting, gc-native is roughly **2× faster than JS** on
this workload — while the public page currently shows it **9.6× slower**. The
same reversal is plausible for `substring` (5.2 ns gc-native vs 10.9 ns honest
JS).

This is not a small correction. The page is likely understating js2wasm on
exactly the benchmarks it flags as worst.

## Which benchmarks are affected

**Confirmed invalid** (JS baseline is hoisted; must be fixed before any
conclusion is drawn): `string/indexOf`, `string/includes`, `string/substring`,
`string/case-convert`.

**Confirmed valid** (JS per-op costs are realistic — 10-31 ns — so real work
is happening): `string/trim`, `string/startsWith-endsWith`, `string/split`,
`string/replace`, `mixed/csv-parse`, and the array/mixed numeric benchmarks.

**Needs checking**: `mixed/text-search` — its baseline consumes its result and
reports ~21 ns per iteration for 4 string ops, which is low enough to suspect
partial hoisting even though it is clearly not fully collapsed.

## Acceptance criteria

1. Every string benchmark's inner loop uses an input that **varies with the
   loop induction variable**, in **both** the JS baseline and the paired Wasm
   `source` string, so neither engine can hoist. The two lanes must remain
   semantically equivalent — same operation, same number of executions, same
   accumulated result.
2. Baselines return their accumulator and the harness sinks it
   (`benchmarks/harness.ts` / `benchmarks/timing.ts`). This is not sufficient
   on its own (see above), but it removes the weaker DCE risk and lets the
   harness assert the two lanes agree.
3. Add a **cross-lane result assertion**: after warmup, compare the JS
   baseline's return value against the Wasm `run()` return value and fail the
   benchmark loudly if they differ. That is what would have caught this.
4. Add a **plausibility guard** to `benchmarks/report.ts`: flag any lane whose
   implied per-operation cost is below ~1 ns and refuse to publish it as a
   valid comparison. A benchmark that reports the impossible should not
   silently reach the public page.
5. Re-run `npx tsx benchmarks/run.ts`, regenerate `latest.json`/`history.json`,
   and record the corrected ratios in this issue — explicitly stating which of
   the 14 currently-"slower than JS" entries survive, which shrink, and which
   **reverse**.
6. `.tmp/dce-probe.mjs` and `.tmp/dce-probe2.mjs` are scratch; promote the
   varying-vs-invariant check into a real regression test if it is cheap to do.

## Notes

- Do **not** equalise the lanes by making the Wasm source discard its result
  or by adding hoisting to js2wasm to match. Fix the benchmark inputs. If we
  later want to measure LICM, that is a separate, honestly-labelled benchmark.
- js2wasm has its own LICM pass (#1200). Once the inputs vary, check whether
  js2wasm hoists them too — if it does, the comparison stays fair; if it does
  not, that is a real optimisation opportunity, but it must not be conflated
  with string-kernel cost.
- This is the concrete, data-driven follow-up to the analysis-only #1009, and
  it invalidates the specific ratios quoted in #1949 (`string/split 4.9×`,
  `case-convert 115×`) as gate inputs until re-derived.
- **This issue gates #3899, #3900 and #3901.** Those three must re-measure
  against corrected baselines before claiming a win.

---

## Implementation

### What changed

| File                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benchmarks/suites/strings.ts`               | Every inner loop now depends on the induction variable. `indexOf`/`includes`/`substring` take a position argument derived from the counter; `split`/`replace`/`toLowerCase`/`toUpperCase`/`trim`/`startsWith`/`endsWith` index an 8-entry table of distinct receivers. All baselines return an accumulator folding in every iteration.                                                                                                                                                |
| `benchmarks/suites/mixed.ts`                 | Same treatment for `mixed/text-search` (was fully loop-invariant) and the outer `csv.split("\n")` in `mixed/csv-parse`. All baselines return accumulators. `mixed/fibonacci` folds modulo a prime — see the i32-overflow finding below.                                                                                                                                                                                                                                               |
| `benchmarks/harness.ts`                      | `BenchmarkDef.js` returns `number \| void`; new `opsPerCall` / `minNsPerOp` fields; new `nsPerOp` / `implausible` result fields. **Cross-lane assertion**: after warmup, each Wasm lane's `run()` return value is compared against the JS baseline's; a mismatch prints a banner, sets a non-zero exit code, and records the lane as a `status: "failed"` row with `failedPhase: "cross-lane"` (#3904's taxonomy).                                                                    |
| `benchmarks/timing.ts`                       | `timeBenchmarkBatch` sinks the return value instead of discarding it.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `benchmarks/report.ts`                       | **Plausibility guard** `flagImplausibleLanes()`: any _measured_ lane below `max(1 ns, minNsPerOp)` per operation is marked `implausible`, excluded from the speedup columns (`⚠ implausible`), listed in a warning section at the top of the report, and sets a non-zero exit code. Failed lanes (#3904) are exempt. New "Cost per operation (ns)" table.                                                                                                                             |
| `website/components/perf-benchmark-chart.js` | Renders an `implausible` lane as a named **"unverified"** bar instead of a speedup number, so an impossible measurement cannot reach the public page as a ratio. Closes the page-side half of AC 4.                                                                                                                                                                                                                                                                                   |
| `tests/issue-3898.test.ts`                   | 18 tests: the guard flags the historical impossible numbers, the universal floor alone would have missed `string/indexOf`, the guard exempts a failed row, the report keeps all three lane states apart, a cross-lane mismatch produces a `"cross-lane"` failed row, every def declares `opsPerCall`, every baseline returns a finite accumulator, no baseline is fast enough to be impossible, and Wasm `run()` matches the JS baseline for the four benchmarks named invalid above. |
| _(not changed)_ `benchmarks/results/*`       | **Deliberately not committed** — auto-generated and auto-committed by `benchmark-refresh.yml`. See caveat 2 in Results.                                                                                                                                                                                                                                                                                                                                                               |

### Two design decisions that are load-bearing

**1. Variant tables are written as literals, not derived with `substring`.**
The first attempt built them as `base.substring(0, base.length - v * step)`.
That is wrong: V8 represents a substring of a long-enough string as a
`SlicedString`, and `split`/`trim`/`replace` must flatten one before operating.
It inflated the JS lane by 3-18x (`string/split` js went 0.248 ms → 4.426 ms)
and would have traded one benchmark artifact for another — measuring V8's string
representation instead of the operation. Flat literals give
`string/split` js 0.632 ms.

**2. `startsWith`/`endsWith` vary the receiver, not the position.**
`s.startsWith("hello", i % 3)` does defeat hoisting, but 2 of every 3 calls then
mismatch on the first character and return early — silently deleting two-thirds
of the work from **both** lanes. The 8 receivers in `STARTS_ENDS_VARIANTS` all
start with `"hello"` and end with `"benchmarking"`, so all 20,000 comparisons
stay full-length and matching and the accumulated result is unchanged from the
pre-#3898 workload. Same reasoning for `mixed/text-search`.

`indexOf`/`includes`/`substring` keep the position-argument form because the
match still succeeds there and the scan length is unchanged.

### The universal 1 ns floor was not enough (AC 4)

AC 4 asks to flag anything under ~1 ns/op. That floor alone would **not** have
caught this bug: the hoisted `string/indexOf` baseline reported **1.5575 ns/op**,
which clears 1 ns, yet the honest cost is ~30 ns. So the guard is
`max(MIN_PLAUSIBLE_NS_PER_OP, def.minNsPerOp)` — a universal physical bound plus
a per-benchmark floor set to roughly a quarter of the honest measured cost. A
collapsed loop is 20x+ too fast, not 4x, so the margin is safe against a faster
machine. `tests/issue-3898.test.ts` pins both halves, including an explicit test
that the universal floor alone misses `string/indexOf`.

### Finding: the cross-lane assertion caught a real compiler defect on its first run

```
!! CROSS-LANE MISMATCH in "mixed/fibonacci" [gc-native]
   js baseline returned 8320400000, wasm run() returned -269534592.
```

`fib(30)` is 832,040 and the loop runs 10,000 times, so the sum reaches 8.32e9 —
past 2^31. **The gc-native (fast-mode) lane infers i32 for the accumulator and
wraps**, while JS, host-call and linear-memory all carry it in f64. That lane was
therefore comparing wrapping i32 adds against f64 adds, and had been doing so
silently: the old JS baseline discarded its result, so nothing ever compared the
two. Worked around here by folding modulo 1000000007 (keeps every lane exact and
in i32 range).

**The underlying compiler bug was filed and fixed as #3907**, which removed fast
mode's blanket i32 narrowing. The assertion also later caught `array/reduce`
returning 704,982,704 against JS's 4,999,950,000 — a second wrong number that had
been published as a win. Two wrong published numbers, from one guard, on its
first runs. That is the argument for the guard.

Note that #3907 is also why every ratio in this issue had to be re-derived:
gc-native now performs f64 arithmetic where it previously wrapped to 32 bits.

---

## Results — re-derived on current main (2026-08-01)

The first pass at this issue was measured before ~200 commits landed, including
**#3907** (removed fast mode's blanket i32 narrowing, so gc-native now does f64
arithmetic where it previously did 32-bit) and **#3899/#3900/#3901/#3903**,
which optimised the very kernels these benchmarks exercise. **Every number below
was re-measured; none was carried forward.**

### Methodology — same compiler, both benchmark definitions

The naive "before" column (the ratios published on the page) confounds two
different things: the benchmark artifact and 200 commits of compiler drift. So
both the **old (loop-invariant) defs** and the **new (varying-input) defs** were
run against the **same** build of current main, via a scratch driver that writes
nothing into `benchmarks/results`. Median of 5 repetitions, `js` and `gc-native`
lanes, Node v22.22.2, linux x64, 4 cores at load ~3.3.

The delta between the two columns is therefore **purely** the benchmark fix.

### Noise floor — 1.05x, not 1.8x

Four benchmarks are semantically unchanged by #3898 (they gained only a `return`
statement; the work inside the loop is byte-identical). They are the controls:

| Unchanged benchmark     | old defs     | new defs     | drift     |
| ----------------------- | ------------ | ------------ | --------- |
| `mixed/matrix-multiply` | 4.19x slower | 4.19x slower | **1.00x** |
| `string/concat-short`   | 1.53x slower | 1.56x slower | 1.02x     |
| `string/concat-long`    | 2.87x slower | 2.82x slower | 1.02x     |
| `mixed/sieve`           | 1.10x slower | 1.03x slower | 1.07x     |

**The noise floor on this run is ~1.05x.** The previous pass quoted ~1.8x
because it ran at load ~13 on the same 4 cores; at load ~3.3 the controls barely
move, so changes above ~1.1x below are real signal rather than contention.

### gc-native vs JS — every benchmark, both definitions, one compiler

| Benchmark                    | old (hoisted) defs | new (#3898) defs  | range over 5 reps         | verdict                             |
| ---------------------------- | ------------------ | ----------------- | ------------------------- | ----------------------------------- |
| `string/indexOf`             | 10.29x slower      | **1.21x slower**  | 1.19–1.28x                | **artifact was ~8.5x** — now parity |
| `string/includes`            | 8.79x slower       | **1.18x slower**  | 1.16–1.21x                | **artifact was ~7.4x** — now parity |
| `string/case-convert`        | 134.28x slower     | **2.18x slower**  | 2.15–2.25x                | **artifact + #3900** — near parity  |
| `string/substring`           | 6.76x slower       | **10.72x slower** | 9.66–10.77x               | **worse, not reversed**             |
| `string/split`               | 3.45x slower       | 5.17x slower      | 4.89–5.43x                | real deficit, was understated       |
| `string/replace`             | 1.02x faster       | 1.96x slower      | 1.92–2.24x                | old defs flattered wasm             |
| `string/trim`                | 1.27x faster       | 3.33x slower      | 2.99–3.44x                | old defs flattered wasm             |
| `string/startsWith-endsWith` | 1.18x slower       | 1.13x slower      | 1.11–1.23x                | unchanged                           |
| `mixed/csv-parse`            | 1.75x slower       | 1.89x slower      | 1.76–2.03x                | unchanged                           |
| `mixed/text-search`          | 2.49x slower       | 2.69x slower      | 2.54–2.74x                | unchanged                           |
| `mixed/fibonacci`            | 1.29x faster       | 1.24x faster      | 1.22–1.25x                | wasm wins                           |
| `string/concat-short`        | 1.53x slower       | 1.56x slower      | 1.54–1.70x                | control                             |
| `string/concat-long`         | 2.87x slower       | 2.82x slower      | 2.81–2.97x                | control                             |
| `mixed/matrix-multiply`      | 4.19x slower       | 4.19x slower      | 3.97–4.28x                | control                             |
| `mixed/sieve`                | 1.10x slower       | 1.03x slower      | 1.04x faster–1.13x slower | control                             |

**Two benchmarks got _better_ than the page claims and two got _worse_.** The
correction is not uniformly favourable to js2wasm, which is the point: the fix
was to the measurement, not to the score.

### The impossible baselines still reproduce on current main

This issue is not stale. Running the **old** definitions against **today's**
compiler still produces physically impossible JS baselines:

| Benchmark             | js ns/op with old defs | originally reported | honest cost (new defs) |
| --------------------- | ---------------------- | ------------------- | ---------------------- |
| `string/case-convert` | **0.275**              | 0.13                | 27.59                  |
| `string/substring`    | **0.541**              | 0.25                | 10.47                  |
| `string/indexOf`      | **1.647**              | 1.56                | 20.32                  |
| `string/includes`     | **1.879**              | 1.71                | 20.88                  |

A 10,000-character `indexOf` scan in 1.647 ns is under 5 clock cycles at 3 GHz.
Without this change the page keeps publishing it.

### Per-operation costs (new defs, full-suite run, all four lanes)

| Benchmark                    | ops/call | JS    | Host-call | GC-native |
| ---------------------------- | -------- | ----- | --------- | --------- |
| `string/concat-short`        | 10000    | 3.82  | 6.27      | 7.23      |
| `string/concat-long`         | 1000     | 4.85  | 10.64     | 12.81     |
| `string/indexOf`             | 1000     | 21.46 | 82.79     | 25.01     |
| `string/includes`            | 1000     | 20.71 | 115.22    | 25.25     |
| `string/split`               | 10000    | 41.20 | 1116.92   | 216.08    |
| `string/replace`             | 1000     | 56.46 | 284.60    | 112.57    |
| `string/case-convert`        | 2000     | 35.34 | 128.18    | 62.28     |
| `string/substring`           | 10000    | 11.41 | 197.12    | 111.70    |
| `string/trim`                | 10000    | 27.13 | 144.81    | 82.61     |
| `string/startsWith-endsWith` | 20000    | 24.98 | 116.98    | 28.84     |
| `mixed/csv-parse`            | 11000    | 88.50 | 589.14    | 90.29     |
| `mixed/text-search`          | 40000    | 11.93 | 127.73    | 32.22     |
| `mixed/fibonacci`            | 10000    | 22.63 | 18.39     | 17.69     |
| `mixed/matrix-multiply`      | 125000   | 1.79  | 7.89      | 7.67      |
| `mixed/sieve`                | 200000   | 22.72 | 9.69      | 10.20     |

Every JS baseline now lands in a physically possible range. The corrected
`string/indexOf` cost of ~21 ns/op is the same order as the ~29 ns predicted
from `.tmp/dce-probe2.mjs` in the original analysis.

### The substring figure — retracted and re-derived

The previous revision claimed `string/substring` **reverses**, "20.29x slower →
3.61x faster". **That is withdrawn and replaced.** The number was measured
against a gc-native lane Binaryen had _eliminated_: the loop accumulated
`s.substring(a, b).length`, and `.length` is derivable from the arguments alone,
so the substring call was strength-reduced away entirely (2.394 ns/op, zero
`struct.new` and zero array ops in the emitted loop). This issue's own
plausibility guard is what caught it — on this issue's own branch.

The benchmark now consumes the slice's **content** (`charCodeAt` at two
positions) rather than its `.length`, so the slice must exist. Re-measured over
8 repetitions on current main:

```
rep0: js 13.71  gc 111.71     js  min 10.31  max 13.71
rep1: js 10.49  gc 110.23     gc  min 110.17 max 114.14
rep2: js 10.59  gc 110.87
...                           ratio: 10.6x slower, stable to ±0.5x
```

**The honest figure is `string/substring` 10.72x slower (range 9.66–10.77x).**
It is not a reversal; it is one of the larger _real_ deficits in the suite, and
it got _worse_ relative to the old hoisted defs (6.76x), not better.

Consequently `minNsPerOp` for this benchmark is **restored from 1 to 3**. The
3 → 1 lowering was justified by the 2.394 ns/op observation, i.e. by the
eliminated lane; with both lanes now measuring ≥10 ns/op, a floor of 1 was
simply the loosest guard in the file. 3 ns is ~3.4x under the cheaper lane,
matching the "roughly a quarter of the honest cost" margin the field documents.

`string/concat-short` and `string/concat-long` went the other way — their floors
(2 and 3) sat only 1.9x and **1.4x** under their honest js costs (3.79 and 4.19
ns/op). A collapsed loop is 20x+ too fast, not 1.4x, so those floors were far
likelier to fire on a machine faster than this container than on a real bug.
Both now rely on the universal 1 ns bound, which is what a quarter of their
honest cost works out to anyway.

### What this means for #3899 / #3900 / #3901

- **`string/case-convert` is no longer catastrophic.** It reads 134x slower with
  the old defs and **2.18x** with honest ones. The previous pass measured 127x
  on the older compiler, so #3900's landing accounts for most of the remaining
  move. The "16,598x" that motivated this issue was almost entirely artifact.
- **`string/indexOf` (1.21x) and `string/includes` (1.18x) are at parity.**
  Their 9.3x/7.9x headline deficits were ~85% artifact. Optimisation work
  targeting them should be re-justified.
- **`string/substring` (10.7x) is now the largest real string deficit**, followed
  by `string/split` (5.2x) and `string/trim` (3.3x). These are the valuable
  targets, and `substring` was previously mis-labelled a win.
- The `host-call` lane remains 3x–27x slower than JS and is separately invalid
  for the loader reason recorded below. Do not use that column.

### Caveats and residual risk

1. Ratios only; absolute milliseconds are contention-dependent. The controls put
   the noise floor at ~1.05x on this run.
2. **No benchmark artifact is committed by this change.** `latest.json`,
   `latest.md` and `history.json` are auto-generated and auto-committed on every
   push to `main` by `benchmark-refresh.yml`'s `promote-benchmarks` job. Hand-
   committing a locally-measured copy would both conflict with that job and
   publish contended 4-core numbers to the public page — the opposite of this
   issue's purpose. The validation run went to a scratch directory; the numbers
   live here instead.
3. `mixed/matrix-multiply`'s js lane measures **1.79 ns/op** against the
   universal 1 ns floor — a 1.8x margin. Its "operation" is a single scalar
   multiply-add, which a modern superscalar core can legitimately retire in
   under a nanosecond, so `MIN_PLAUSIBLE_NS_PER_OP` (calibrated for string
   operations that touch many characters) is arguably the wrong bound for it.
   Nothing trips today. A follow-up should either drop `opsPerCall` there or let
   `minNsPerOp` _override_ the universal floor rather than only raise it.
4. `array/*` and `dom/*` baselines still return `void`, so they get no
   cross-lane assertion and no `opsPerCall`. This is deliberate scope control,
   not an oversight: `array/reduce` is exactly where the cross-lane assertion
   found a wrong published number last time (#3907), so converting those suites
   is likely to surface further real defects that each need their own fix. It
   should be its own issue rather than an unbounded tail on this one.
5. Since the previous pass, `array/sort-i32` and `array/find` **do** now have
   working gc-native lanes (they did not before, per #3902), so the old "no
   gc-native lane" rows are gone.

### Validation

- Full-suite run (strings + arrays + dom + mixed, all four strategies) through
  `saveResults` into a scratch directory: **exit code 0** — no lane flagged
  implausible, and **zero cross-lane mismatches**.
- The only failed lanes are 21 `linear-memory` rows (16 compile failures, 5
  runtime traps), all recorded as `status: "failed"` rows by #3904's taxonomy
  and correctly exempted from the plausibility guard.

---

## Follow-up finding: the `host-call` column is separately invalid (loader tax)

Reported by #3903 after this issue's fix landed, and **independently reproduced
here**. It does **not** affect the conclusions above, but it does invalidate the
`host-call` column, so it is recorded here rather than left implicit.

### Cause

`benchmarks/run.ts` is executed via `npx tsx`. tsx transpiles with esbuild's
`keepNames`, which emits

```js
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
```

and wraps **every** function literal in it. A closure allocated inside a hot
function body therefore pays a full `Object.defineProperty` per allocation.
Measured locally with `.tmp/keepnames-probe.mts` (identical source, Node
v22.22.2):

|                                        | closure-in-loop | no closure |
| -------------------------------------- | --------------- | ---------- |
| esbuild, no `--keep-names`, plain node | 4.61 ns/iter    | 1.48       |
| esbuild `--keep-names`, plain node     | 543.72 ns/iter  | 1.71       |
| `npx tsx`                              | 524.54 ns/iter  | 1.49       |

`--keep-names` alone reproduces it, so it is the transform and not the loader —
a **118x** amplification on closure allocation.

### Why it lands on exactly one lane

The `host-call` lane crosses into `src/runtime.ts` host-import shims, which
allocated closures inside their per-call bodies. `gc-native` makes no host calls,
and the JS baselines in this file allocate no closures in any hot body. So the
tax is almost perfectly selective.

### Measured impact (strings suite, median of 3 bundled runs vs the committed tsx run)

Bundling with the same recipe `build:compiler-bundle` uses
(`esbuild --bundle --platform=node --format=esm`, no `--keep-names`) and running
under plain node:

| Lane            | inflation under tsx                     |
| --------------- | --------------------------------------- |
| `js`            | 0.83x – 2.12x (no consistent direction) |
| `gc-native`     | 0.99x – 1.57x                           |
| **`host-call`** | **2.35x – 4.72x**                       |

Published `host-call` vs JS ratios are overstated by **2.3x – 3.6x**:

| Benchmark                    | published      | actual (bundled) |
| ---------------------------- | -------------- | ---------------- |
| `string/substring`           | 109.42x slower | 30.67x slower    |
| `string/split`               | 108.11x slower | 46.92x slower    |
| `string/indexOf`             | 35.75x slower  | 10.27x slower    |
| `string/includes`            | 35.23x slower  | 10.49x slower    |
| `string/startsWith-endsWith` | 35.03x slower  | 14.08x slower    |
| `string/trim`                | 20.70x slower  | 7.81x slower     |
| `string/case-convert`        | 17.19x slower  | 6.23x slower     |
| `string/replace`             | 15.19x slower  | 6.41x slower     |

The `host-call` ns/op column in the per-operation table above is inflated by the
same factors and should be read as an upper bound only.

### The gc-native-vs-JS conclusions are NOT affected

**Historical note (2026-07-31 measurement, superseded).** The table below was
taken on the older compiler and its `substring` and `case-convert` rows carry
the retracted figures — `substring` does **not** reverse (see
[The substring figure](#the-substring-figure--retracted-and-re-derived)) and
`case-convert` is now 2.18x, not ~100x. It is kept only for what it was measuring:
the **drift between the tsx loader and a plain bundle**, which is the last column
and is unaffected by the retraction.

| Benchmark                    | tsx          | bundled      | drift |
| ---------------------------- | ------------ | ------------ | ----- |
| `string/substring`           | (retracted)  | (retracted)  | 1.14x |
| `string/case-convert`        | (superseded) | (superseded) | 1.17x |
| `string/indexOf`             | 1.84x slower | 1.15x slower | 1.60x |
| `string/includes`            | 1.13x slower | 1.28x slower | 1.13x |
| `string/split`               | 8.83x slower | 5.88x slower | 1.50x |
| `string/replace`             | 3.30x slower | 3.99x slower | 1.21x |
| `string/trim`                | 4.06x slower | 4.65x slower | 1.14x |
| `string/startsWith-endsWith` | 5.64x slower | 6.21x slower | 1.10x |

The point that survives is the **loader tax is nearly lane-selective**: `js` and
`gc-native` move together under the bundle (drift ≤1.60x), so the gc-native-vs-JS
ratio that gates #3899/#3900/#3901 holds, while `host-call` inflates 2.3x–4.7x.
The 2026-08-01 re-derivation above was itself run under `tsx`, so it carries the
same caveat and the same conclusion.

### Not fixed here

The fix — running the harness from a plain `esbuild --bundle` artifact instead of
the `tsx` dev loader — changes how `benchmark-refresh.yml` invokes the suite and
belongs with #3903, not in this issue's scope. Until then the harness will keep
silently taxing any closure allocated in a hot runtime body. #3903 has removed
the current exposure in `src/runtime.ts`, but the amplifier remains.

## Test Results (2026-08-01, current main)

- `npx vitest run tests/issue-3898.test.ts` — **18 passed** (12 original + 6 new
  covering the #3898 x #3904 seams).
- `npx vitest run tests/issue-3904.test.ts tests/benchmark-lifecycle.test.ts` —
  **36 passed**; both feature sets coexist.
- `npx tsc --noEmit` — clean.
- Full-suite run (all 4 suites, all 4 strategies) into a scratch dir — no
  cross-lane mismatch, no implausible lane, **exit 0**.

## Merge note — #3898 x #3904 (PR #3916)

#3904 landed failed-strategy recording in the same two files. The two changes are
complementary and **both survive**:

- `BenchmarkResult` carries both #3898's `opsPerCall`/`nsPerOp`/`minNsPerOp`/
  `implausible` and #3904's `status`/`error`/`failedPhase`.
- `flagImplausibleLanes` **exempts** failed rows. They carry `medianMs === 0`, so
  an unguarded guard computes 0 ns/op and reports every broken lane as a hoisted
  one — turning "gc-native did not compile" into the wrong diagnosis.
- A **cross-lane mismatch is now recorded as a failed row** (`failedPhase:
"cross-lane"`) instead of being dropped. Under #3904 an _absent_ row means
  "deliberately not applicable", which is the opposite of what a mismatch is.
- The report keeps three states apart: `—` not applicable, `FAILED` ran and
  broke, `⚠` measured but impossible.
- `extraEnv` stays deleted (#3904 removed it as a dead trap).

The page-side half of AC 4 is also closed: `perf-benchmark-chart.js` now renders
an `implausible` lane as a named **"unverified"** bar rather than a speedup
number, alongside #3904's "failed" bar. If the _JS baseline_ is implausible it is
the denominator of every bar in that chart, so all of them are marked unverified.
