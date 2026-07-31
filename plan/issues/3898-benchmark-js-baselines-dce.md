---
id: 3898
title: "perf-bench: string benchmarks on performance.html measure V8's loop-invariant hoisting, not string speed — several 'Wasm is slower' bars are artifacts"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [1009, 1949, 3899, 3900, 3901]
---

# #3898 — the perf-page string benchmarks measure V8's LICM, not string performance

## Status: open — **measured and confirmed**, root cause identified

## Problem

`https://js2.loopdive.com/benchmarks/performance.html` renders
`benchmarks/results/latest.json`. Several JS baselines in that file report
times that are **physically impossible**, so the published "Wasm is N× slower
than JS" bars for those benchmarks are not measuring what the page claims.

From the 2026-07-31 run, `avgMs` per `run()` call:

| Benchmark             | JS avgMs   | work claimed per call                  | implied per-op cost |
| --------------------- | ---------- | -------------------------------------- | ------------------- |
| `string/indexOf`      | 0.0015575  | 1000 × `indexOf` over a 10,000-char haystack | **1.56 ns**   |
| `string/includes`     | 0.0017079  | 1000 × `includes` over 10,000 chars    | **1.71 ns**         |
| `string/substring`    | 0.0024751  | 10,000 × `substring(5, 20)`            | **0.25 ns**         |
| `string/case-convert` | 0.00025358 | 2000 × `toLowerCase`/`toUpperCase`     | **0.13 ns**         |

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
