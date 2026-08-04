---
id: 4150
title: "`perf(benchmarks): finish Node parity and make trend data comparable`"
status: ready
created: 2026-08-04
updated: 2026-08-04
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [3898, 3899, 3900, 3902, 3904, 3929]
---

# #4150 — finish Node parity and make trend data comparable

## Handoff

Continue the benchmark-parity program that brought the published compiler lanes
much closer to, or ahead of, Node/V8. This issue is the durable takeover record
for the remaining compiler work and benchmark-page credibility fixes.

## Takeover point and branches

Start new implementation work from current `main`; all checkpoint branches
below are merged. Use them to recover reasoning, tests, and measured A/Bs:

- Primary compiler checkpoint:
  [`codex/benchmark-parity`](https://github.com/loopdive/js2/tree/codex/benchmark-parity)
  — PR #4062.
- Derived host-string scalarization:
  [`codex/4118-host-derived-strings`](https://github.com/loopdive/js2/tree/codex/4118-host-derived-strings)
  — PR #4066.
- Nested static-split scalarization:
  [`codex/4118-static-csv-splits`](https://github.com/loopdive/js2/tree/codex/4118-static-csv-splits)
  — PR #4067.
- Trend presentation checkpoint:
  [`codex/benchmark-trend-style`](https://github.com/loopdive/js2/tree/codex/benchmark-trend-style)
  — PR #4078.

Published benchmark provenance at handoff:

- benchmark source SHA:
  `0003182f6ad4606c8601342e72097ef2db64b583`
- refresh artifact commit:
  `fb4f9d41562e74432f6816cdc409c6ef9dbf3e7b`
- generated: `2026-08-03T05:14:11Z`
- history point: `2026-08-03T05:23:28.091Z`
- environment: Node `v25.7.0`, Linux x64, pnpm `10.30.2`,
  Binaryen `125.0.0`

## What landed

PRs #4062, #4066, and #4067 added ground-call folding, capture-free numeric
callback specialization, counted-push preallocation, i32 induction retention,
identity-array search specialization, host-derived string scalarization, and
nested static-split scalarization. PR #4078 changed trend styling to
transparent plots with a thin dashed V8 baseline and one filled primary Wasm
line.

The latest published run is not a compiler regression: versus the immediately
preceding history row, GC-native improved in 24/24 comparable benchmarks,
host-call in 28/28, and linear-memory in 3/3.

## Remaining latest-run parity gaps

| Benchmark | Primary lane | Slower than Node |
| --- | --- | ---: |
| `array/map-filter` | gc-native | 4.13× |
| `dom/set-attributes` | host-call | 3.31× |
| `dom/read-attributes` | host-call | 2.86× |
| `dom/modify-text` | host-call | 2.85× |
| `mixed/matrix-multiply` | gc-native | 2.75× |
| `string/concat-short` | gc-native | 1.30× |
| `string/trim` | gc-native | 1.20× |
| `string/concat-long` | gc-native | 1.18× |
| `dom/create-elements` | host-call | 1.14× (V8 baseline is unstable) |
| `string/indexOf` | gc-native | 1.12× |
| `string/includes` | gc-native | 1.10× |

Prioritize `array/map-filter`, `mixed/matrix-multiply`, and the three stable
DOM host-call gaps. Treat the sub-30% string gaps as secondary until runner
noise and comparability are fixed.

## Benchmark-page correctness work

1. **Legend colors are missing on `performance.html`.** The helper applies
   inline style objects with `Object.assign(e.style, v)`, while the legend
   passes a custom property (`--legend-color`). Set custom properties with
   `style.setProperty(...)` or assign `borderColor` directly. Verify both
   performance and npm-compat legends visually.
2. **The red delta is not a last-run delta.** The live page computes
   `(last - first) / first` and labels it as a regression. History spans corpus
   and timing-methodology changes, so labels such as map-filter `+1057%` are not
   comparable. In the actual latest run map-filter improved 30.0%,
   matrix-multiply 27.3%, sort-i32 31.8%, and trim 74.9%.
3. **Version the history.** Store source SHA, benchmark/corpus hash,
   timing-methodology version, Node version, runner identity, and lane
   configuration per history row. Break/segment a series when these change.
4. **Compare against a comparable baseline.** Prefer the prior compatible row
   or a rolling median, and show the comparison window explicitly. Do not join
   old and new benchmark definitions solely by name.
5. **Stabilize the V8 DOM allocation control.**
   `dom/create-elements` is bimodal in recent history (~0.03–0.25 ms); latest
   is 0.179 ms after 0.035 ms. It allocates 1,001 mock elements per call and
   is sensitive to V8 tiering/GC and hosted-runner scheduling. Use repeated
   fresh processes, stronger warmup, and a robust median; do not treat one V8
   outlier as compiler movement. `array/slice` was +24% versus one prior row
   but only +4.2% versus the previous-ten-run median.

## Acceptance

- Legend swatches visibly use the same colors/styles as their SVG series on
  both trend pages.
- Trend deltas never cross corpus/methodology boundaries and state the exact
  comparison window.
- Every published history point has enough provenance to decide whether
  comparison is valid.
- The DOM V8 control has a documented noise budget and reproducible
  fresh-process measurement.
- Remaining compiler gaps are addressed with focused positive and negative
  proof tests.
- Every performance claim records lane, harness, exact base SHA, candidate SHA,
  machine/runtime, sample count, and result denominator.
- Regression gates remain sound: inability to find a comparable baseline must
  be reported as unknown, not green.

## Key files

- `website/public/benchmarks/performance.html`
- `website/components/npm-compat-chart.js`
- `benchmarks/harness.ts` and `benchmarks/timing.ts`
- `benchmarks/suites/{arrays,dom,mixed,strings}.ts`
- `scripts/benchmark-lifecycle.mjs`
- `.github/workflows/benchmark-refresh.yml`
