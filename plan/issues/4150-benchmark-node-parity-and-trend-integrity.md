---
id: 4150
title: "`perf(benchmarks): finish Node parity and make trend data comparable`"
status: ready
created: 2026-08-04
updated: 2026-08-12
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
# The host-import wrapper work is arity SPECIALIZATION: the same guard body
# repeated across five fixed signatures, and the extern_class method shim's
# ordinary case inlined per arity. That repetition IS the optimization — the
# measured regression when the arms were collapsed into a shared callee is
# recorded in the commit — and it has to sit inside buildImports/resolveImport,
# which own the closures being specialized.
loc-budget-allow:
  - src/runtime.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
# `<anonymous>#83` is the depth-guard wrapper block inside buildImports. The
# gate keys anonymous functions positionally, so this entry is brittle by
# nature — if it stops matching after an unrelated edit to buildImports, the
# right response is to re-read the gate's own output for the new key, not to
# widen the allowance.
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#83
---

# #4150 — finish Node parity and make trend data comparable

## Handoff

Continue the benchmark-parity program that brought the published compiler lanes
much closer to, or ahead of, Node/V8. This issue is the durable takeover record
for the remaining compiler work and benchmark-page credibility fixes.

### 2026-08-12 remainder fast-path handoff

Numeric `%` now has three AOT outcomes shared by the legacy and IR frontends:
proven signed-i64 operands emit direct `i64.rem_s`; unknown operands emit
finite/integral/range and trap guards with exact `__fmod` fallback; and a
negative proof (fractional, out-of-range, or zero-divisor constants) emits only
the exact helper. `JS2WASM_INLINE_REMAINDER_FAST_PATH=0` is the comparison and
rollback switch. The IR primitive additions require the narrow `nodes.ts` and
`verify.ts` LOC allowances above; the lowering itself lives in focused
remainder modules rather than growing compiler drivers.

On the v8x mixed kernel (20,000 calls × 512 rounds, js2wasm O4 followed by
`wasm-opt -O4`), the matched five-process median moved from 22,839.8 to
16,521.7 ns/call: 1.4× faster, or 27.7% less elapsed time. The optimized Wasm
contains one guard-free statically proven remainder and four guarded dynamic
remainders per round instead of five unconditional helper calls.

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

---

## Suspension RESOLVED — 2026-08-04

PR #4106 was suspended mid-flight and handed over; it now has an owner again
and the two open items below are closed. The original handover is kept because
its "Traps for whoever picks this up" section is still live guidance.

- **Branch**: `claude/js2-cross-frame-capture-slot` (lives on the fork,
  `ttraenkler/js2` — NOT on `loopdive/js2`)
- **PR**: <https://github.com/loopdive/js2/pull/4106>
- The suspending session's checkout (`/home/user/js2-up`) and its `.tmp/`
  probes (`propfn-min.mjs`, `propfn-gc.mjs`, `run262.mjs`, `gap.py`) are gone
  with that container. Nothing depends on them; the #4149 and #4154 repros
  were re-created and are now committed as real tests.

### The decision that needed a human: taken — fix #4154, do not use the valve

The merge queue had parked this PR on the #3189 uncatchable-trap ratchet
(`illegal_cast` 48 → 50), resolved at the time with a **`trap-growth-allow`
valve** in
`plan/issues/4149-standalone-aliased-property-function-call-null.md` plus a
follow-up issue (#4154) for the real fix.

**The operator chose the strictly-better outcome: #4154 is fixed in this same
PR and the valve is removed.** The prediction in the original handover held —
each test's remaining assertion is exactly the `assert.throws(TypeError, …)`
that a catchable throw satisfies, so both files are expected to flip
`fail` → **pass** instead of `fail` → `fail`, and `illegal_cast` should not
grow. Details and the measured root cause are in
`plan/issues/4154-private-brand-check-uncatchable-illegal-cast.md`; the
regression test is `tests/issue-4154-private-brand-check-typeerror.test.ts`.

### `src/runtime.ts` merge conflict (resolved, worth knowing)

Merging `origin/main` conflicted in exactly one hunk, in
`__extern_method_call`'s `typeof fn !== "function"` recovery. Both sides were
fixing the *same* root cause — a closure materialized while the module's
`start` was running, before `setInstance` wired `callbackState` — but catching
**different symptoms**, so the resolution keeps **both arms**:

| side | guard | symptom it catches |
| --- | --- | --- |
| `origin/main` | `_isWasmStruct(obj)` | the cached host view MISSES the field; re-reads it via `_resolveHostField` |
| this branch (#4149) | `_isWasmStruct(fn)` | the field READ fine, but the value is a RAW closure struct that was stored unwrapped |

Taking either side alone would silently drop the other's fix.

### What is done and verified

Six commits of compiler work, three of them perf (#4150) and three the acorn
chain (#4139/#4144/#4149), plus the tests and budget/valve declarations.
`tests/issue-4150-fmod-integral-fast-path.test.ts` and
`tests/issue-4150-split-single-pass.test.ts` are committed and green, and were
mutation-checked to confirm they have teeth.

Equivalence suite run in three batches (212 files) plus targeted re-runs; every
failure reproduces with identical counts at the pre-change commit. Full list of
known-pre-existing failures is in the PR body — do not re-investigate them.

### Traps for whoever picks this up

1. **Do not quote a ratio-vs-node from a single run on this box.** Absolute
   numbers here run ~1.5–2× the published environment and several node
   baselines are bimodal (V8 hoists loop-invariant work in some runs, not
   others). `mixed/csv-parse` has *beaten* node in 18 of 220 historical runs.
   Use `benchmarks/results/history.json` medians. An earlier version of this
   PR's own description got this wrong and had to be rewritten — the failure
   mode is the one §2/§5 of this issue already describes.
2. **PR #4088 merged at `77f080d0`, the three-defect state, not its five.** Its
   description lists five fixes; two (`2ef595b7` fnctor-twin, `659c0bf9`
   stack-balance tee) never reached `main` and are carried by #4106. If #4106
   is closed without merging, those two are lost again — re-check before
   abandoning the branch.
3. **The auto-park bot mis-parsed the batch.** Its comment named
   "(#4139, #4144, #4106)" as merge-group members; #4139 and #4144 are not PRs
   (`GET /pulls/4139` → 404) — the bot pulled issue refs out of this PR's own
   title. There was no batch. Worth fixing in the bot; noted on the PR.
4. **Benchmark runs dirty the tree.** `benchmarks/run.ts` writes
   `benchmarks/results/` and `public/benchmarks/results/`; both contain TRACKED
   files. `git checkout -- benchmarks/results public/benchmarks/results` after
   a run, and do not `rm -rf` the public dir (I did once and had to restore).

### Remaining #4150 work not attempted

`string/case-convert` is near its structural floor and I deliberately left it —
reasoning and the scaling measurement are in the PR body. The DOM
benchmark-definition mismatch (`modify-text` does 10× the writes of its wasm
source plus a concat; `read-attributes` tests `!== null` vs `.length > 0`) is
diagnosed but unfixed; those two published rows compare different programs.
The remaining P4 from the DOM investigation — caching `declared_global` reads
in a module-level wasm global, ~1/3 of `modify-text`'s crossings — is untouched.
