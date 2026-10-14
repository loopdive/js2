---
id: 6983
title: "Native regime in a JS environment regresses acorn, lit, prettier on npm-compat versus the host lane"
status: done
assignee: ttraenkler/opus-6983-npm
created: 2026-10-14
updated: 2026-10-14
completed: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: compiler, optimizer
language_feature: compiler-internals
goal: architecture
sprint: current
parent: 5385
related: [6708, 6749, 6979]
# 2026-10-14: +3 LOC / +1 per pipeline — one import plus one
# `funnelRepeatedReturnTails(mod)` call at the end of each finalize pipeline
# (single-module and multi-module); the pass itself lives in
# src/codegen/helpers/return-tail-funnel.ts.
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #6983 — native-first regime npm-compat parity (S6 evidence item 3)

The dashboard refresh of 2026-10-14T15:10Z (`perf.lanes.jsHostNative` in
`benchmarks/results/npm-compat.json`) shows three packages that are
`measured` on the host-assisted lane but fail on the `js-host-native` lane
(`semanticProviders: "native-first"`). #6708 S6 evidence item 3 requires that
the regime not regress any package from `measured` to an error state.

| package | host lane | regime lane | diagnostic |
|---|---|---|---|
| acorn | measured | runtime-error | `RuntimeError: illegal cast` |
| lit | measured | runtime-error | `[object WebAssembly.Exception]` reaches the host |
| prettier | measured | optimization-error | `wasm-opt -O4` "unexpected expr type / UNREACHABLE executed"; no-flatten retry times out |

lodash-es (regime `optimization-error`, same wasm-opt crash) is in scope if it
shares the root cause.

## Acceptance criteria

- acorn, lit, prettier `measured` on a local
  `generate-npm-compat-report.mjs --only <pkg> --perf-only --lane js-host-native` run.
- `node scripts/equivalence-gate.mjs`: no new equivalence regressions.
- A focused regression test per root cause (native-first and standalone).

## Root causes and measurements

Measured locally on macOS, upstream main `dd15b6d00c`, with
`JS2WASM_EVAL_ENGINE=interpreter node --import tsx scripts/generate-npm-compat-report.mjs --only <pkg> --perf-only --lane js-host-native`.

| package | before (this machine) | after | ratio after |
|---|---|---|---|
| acorn | runtime-error `RuntimeError: illegal cast` | measured | 0.064 |
| lit | measured (ratio 0.00086) — already fixed on main | measured | 0.00086 |
| prettier | optimization-error (retry without flatten timed out, 600 s) | measured, -O4 with `flatten` omitted, `optimizationVerified: true` | 0.084 |

### acorn — host object reached the closure-bag registry walk

Trap site: `__closure_bag_lookup` ← `__extern_get` ← `getOptions`, on the
SECOND `parse` only (the first passes at -O0 and -O4). The `__extern_get`
prototype-cache arm (#6946, `receiverHasNoOwnKeyGuard` in
`object-runtime.ts`) is gated on the hashed key's "populated" flag, which the
first call sets. Its own-key guard calls `__closure_bag_lookup(receiver)` for
every receiver (the `i32.and` evaluates both operands). With the JS value
bridge the receiver can be a HOST object — acorn's options object — and the
lookup's registry walk did `ref.cast eq` on it: a host anyref is not `eq`, so
"illegal cast". Fix (`closure-props.ts`, `hostReceiverMiss`): when
`jsValueBoundary(ctx)`, a non-`eq` receiver answers the miss (null bag) before
the cast. Host-free modules emit nothing new. Test:
`tests/issue-6983-closure-bag-host-receiver.test.ts` (fails on base, native-first).

### lit — stale dashboard row, not reproducible

The 15:10Z refresh marks `lit` (and react-dom) as `stalePackages`: its row was
carried forward from 2026-10-06T09:42Z ("measurement worker did not produce a
partial report"). On current main the regime lane measures lit both with and
without this change. Why the CI worker produced no lit report is a refresh
pipeline question, not a regime defect, and is not addressed here.

### prettier — Binaryen code-folding is superlinear on `__extern_set`

The regime binary uses standardized EH (`try_table`), so -O4 hits the known
Flatten abort and the optimizer retries with `--skip-pass=flatten` (#4586).
That retry took ~830 s (> 600 s limit). `--debug` pass timings: `code-folding`
alone 675 s. Extracting single functions (`--extract-function`) pins it on
`__extern_set` (138k WAT lines, 4,808 `return`s, 4,793 of them preceded by the
same `i32.const 1|2; global.set $setResult` status write): 590 s for
code-folding on that one function. The host lane has no native
`__extern_set`, and no `try_table`, so it never hits this. The standalone
lanes of prettier hit the same timeout and fell back to -O2.

Fix (`src/codegen/helpers/return-tail-funnel.ts`, called last in both finalize
pipelines): in a void function, an `i32.const c; global.set G; return` exit
that repeats at least 64 times becomes `br` to one shared exit block per
(G, c), with every branch that leaves the original body shifted past the new
blocks. This is the shape code-folding would produce, built in linear time.
Result on the prettier regime binary: `wasm-opt -O4 --skip-pass=flatten`
832 s → 154 s, code-folding 675 s → 2.8 s, unoptimized binary 19 KB smaller.
Functions below the threshold are untouched (byte-identical). Tests:
`tests/issue-6983-return-tail-funnel.test.ts` (transform semantics incl.
outward branches, below-threshold byte identity, compiled `__extern_set` in
native-first and standalone, -O4 success on a dispatcher-shaped function). A
small synthetic does NOT reproduce the 600 s blowup (it needs prettier's arm
structure), so the timing evidence is the prettier measurement above.

### Validation

- `node scripts/equivalence-gate.mjs` (run with `--configLoader=runner`
  because the sandbox cannot write vite's temp config into the shared
  node_modules): "22 failing, 1748 passing, 22 known-failures in baseline …
  ✓ No new equivalence regressions."
- Byte identity, A/B against base on the 13 playground examples: standalone
  and host lanes identical; native-first changes in every module (the
  `__closure_bag_lookup` arm is always present there).

### lodash-es — different root cause, left out

With the funnel applied lodash-es -O4 (no flatten) still takes 1,060 s, but
the time is in `coalesce-locals` (590 s + 169 s), not code-folding; the
largest single contributor is `__runtime_eval_pull_globals` (405k WAT lines,
46 s for coalesce-locals alone when extracted). Not a regression (host lane is
runtime-error) and not this root cause; needs its own issue.
