---
horizon: m
id: 4001
title: "compileMulti recompiles and re-emits the whole graph initializer once per source (quadratic)"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: critical
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler, codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2965, 3672, 3782, 3872]
---

# #4001 — the graph initializer was compiled and emitted once per source file

## Problem

Compiling the real ESLint `linter.js` graph did not finish. Measured on this
branch's base (`bd1086b3`), 4-core / 16 GB container:

```sh
node --max-old-space-size=6144 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/eslint/lib/linter/linter.js \
  '{"allowJs":true,"target":"gc","platform":"node"}'
```

still running at **25 min** with RSS oscillating between 1.0 and 2.8 GB, no
structured report. Two independent runs behaved the same.

This directly contradicts the closing measurement in #3672 (10.6 s, structured
report, one hard codegen error). That measurement was **correct when taken**:
the compile aborted early at `inherited class callable LazyLoadingRuleMap_has`.
#3672's own follow-up fixed that abort and advanced the frontier — which pushed
the compile into the full-codegen regime for the first time and exposed the
scaling defect underneath. The old number is a budget on an early abort, exactly
as that issue warned; it is not evidence that the compiler is fast here.

## Root cause

`ctx.moduleInitStatements` is **graph-global** state on the one shared codegen
context, and `collectDeclarations` runs over *every* source file before the
first body compiles. So by the time the per-source loop in `generateMultiModule`
starts, the list already holds the whole program's top-level statements.

That loop calls `compileDeclarations(ctx, sf)` once per source, and each call:

1. compiles the **entire** accumulated initializer (pass 1, for closure/setup
   discovery),
2. compiles the function bodies belonging to `sf`,
3. compiles the **entire** accumulated initializer again (pass 2, #2965, so call
   sites see the final inlinable-function registry),
4. `mintDefinedFunc`s a **fresh full-size `__module_init`** and pushes it into
   `ctx.mod.functions`.

Only the last iteration's function is ever reachable — via `startFuncIdx`, or
via the `__module_init` export, whose earlier duplicates #3505 already had to
filter out at export time. The other n−1 were dead on arrival but still
retained, and still walked by every later fixup, validation and emit pass.

So for an n-source graph the compiler did `2n` full compiles of the program's
top-level code and retained `n` full copies of it. The `__module_init` bodies
are **not** per-source slices — each is the whole graph's initializer.

The redundancy was visible in the code but read as per-source work: #3782's
comment ("`compileDeclarations` recompiles the one accumulated module
initializer for every source file") describes it exactly, and added a
graph-level order-state reset to make the repetition *safe* rather than remove
it.

## Measurement

Added `src/compile-profile.ts`: an env-gated phase profiler
(`JS2WASM_COMPILE_PROFILE=1` for a table on exit, `=stream` to print each phase
as it closes). Streaming matters here — `--cpu-prof` only writes on process
exit, which is no help when the run does not terminate. Phases are a stack, so
self time is wall time minus direct children, and any phase still open at exit
is reported as `OPEN AT EXIT`.

**Where the ESLint time went.** Everything before body compilation totals ~6 s
(analyze 3.7 s, import-collect 1.1 s, collect-declarations 0.6 s, all other
whole-graph scans <0.4 s each). Per-source body compilation then took 12–121 s
*each*, for 146 sources, with heap climbing monotonically — the run never got
past the first handful.

**Synthetic confirmation** (`N` modules, 4 top-level statements each):

| N sources | before | after | emitted `__module_init` before → after |
| --------- | ------ | ----- | -------------------------------------- |
| 10        | 1.38 s | 1.45 s | 11 → 1 |
| 40        | 2.12 s | 1.62 s | 41 → 1 |
| 80        | 3.69 s | —      | 81 → 1 |
| 120       | 6.23 s | 2.11 s | 121 → 1 |

Before: 12× the sources cost 4.5× the time. After: 1.45×. At N=120 the profiler
attributes **59.4 % of total compile time** (3.81 s of 6.42 s) to 242
`module-init-pass{1,2}` phases, every one of them compiling the identical
480-statement list. Binary size for an 8× source increase grew **29×** before
and under 2× after.

## Fix

`compileDeclarations` takes a `ModuleInitMode`, and the multi-source loop
assigns it by position:

- **first source → `"discover"`** — pass 1 only. Pass 1 exists to populate
  `closureMap` for module-level arrow functions before any body compiles; since
  it already compiles the complete statement list, one run establishes that for
  the whole graph.
- **sources in between → `"skip"`** — bodies only. Both passes were pure waste.
- **last source → `"full"`** — pass 2 and the injection. This is the pass that
  sees the final inlinable-function registry and becomes the emitted
  initializer, which is precisely the one the old code kept anyway.

Single-source compiles default to `"full"` and are untouched.

The #2965/#3872 order-state snapshot and the #3782 graph-level reset are both
retained unchanged — this reduces how many times the initializer is compiled, it
does not change what any one compile sees.

## Result

The real ESLint `linter.js` graph now **completes**: 238 s wall, exit 0, peak
heap 1.07 GB, structured report emitted — versus not finishing in 25 min. Two
runs, one solo (238 s) and one under concurrent test-suite load on the same
4-core box (240 s), so the figure is not contention-inflated.

It still stops at a hard codegen error, so this remains a budget on a compile
that aborts at the frontier — stated here rather than papered over. The frontier
has moved again, to:

```text
Codegen error: module TDZ global minimatch was observed before its value global
```

which is a different defect class (module-TDZ ordering across the resolved
graph) and is **not** reached on the base commit at all, because the compile
never got that far. It needs its own issue.

Post-fix phase attribution (146 sources, `--target gc`, `platform: node`):

| phase                                                    | self     | share  |
| -------------------------------------------------------- | -------- | ------ |
| `module-init-pass1` (the one remaining full init compile) | 119.79 s | 51.0 % |
| `bodies/code-path-analysis/code-path-state.js`           | 21.88 s  | 9.3 %  |
| `bodies/@eslint-community/eslint-utils/index.mjs`        | 18.22 s  | 7.7 %  |
| `bodies/languages/js/source-code/source-code.js`         | 13.58 s  | 5.7 %  |
| `bodies/code-path-analysis/code-path-analyzer.js`        | 12.17 s  | 5.1 %  |
| `analyze` (TypeScript parse/bind/check)                  | 4.37 s   | 1.8 %  |

## Follow-up (not fixed here)

- **The single remaining init compile is still 51 % of the compile** — 120 s for
  801 statements, ~150 ms per statement. That is now a constant-factor problem
  in one pass rather than a quadratic one, but it is the obvious next target.
- **`module TDZ global minimatch was observed before its value global`** — the
  new frontier, newly reachable. Needs its own issue and a reduced repro.
- **`result.importObject` omits `string_constants`**, so a multi-source module
  that imports it cannot be instantiated through the convenience path. This is
  pre-existing on `main` and is why `tests/multi-file.test.ts` is 9 failed /
  1 passed on an unmodified checkout. Unrelated to this change; the tests here
  backfill declared-but-unprovided imports so the assertions are not silently
  disabled by it.

## Verification

- `tests/issue-4001-module-init-graph-scaling.test.ts` — 5 passed / 5 attempted.
  Non-vacuity confirmed by running it against the unmodified base: the two
  structural guards go red (`expected 3 to be 1` initializers for a 2-source
  graph; `binary grew 29.0x for 8x the sources`). The three behavioural guards
  pass on both sides by design — they are the "this must not change" half.
- **Behavioural A/B against the base commit.** Six multi-source graphs compiled,
  instantiated and run on both sides — cross-file init, module-level arrow
  closures, classes with static state, `defineProperty`/`freeze` order
  sensitivity, cross-module init ordering, and mutable module state. All six
  return identical values (`84`, `9`, `30`, `50`, `1234`, `15`), each matching
  the JS-semantics answer. Emitted **bytes** legitimately differ — the base
  emits n−1 dead initializers — so behaviour, not the byte image, is the oracle.
- **Full equivalence suite, both sides.** Run on this branch and again at the
  base commit `bd1086b3` in a separate worktree (so no mid-run file swapping
  could contaminate either): **12 failed / 201 passed test files, 32 failed /
  1611 passed / 3 todo tests — on BOTH**, and `diff` of the sorted failing-test
  lists is **empty**. All 32 are pre-existing in this container (TDZ, null
  dereference guards, delete-sentinel, Reflect, yield-as-expression, …).
- Multi-source suite (`multi-file`, `issue-2138-multi-module-ir-overlay`,
  `issue-3493`, `issue-3495`, `issue-3505`, `standalone-multimodule-to-primitive-fills`,
  `issue-3369-project-runner`, `issue-3520-legacy-unit-projection`):
  **12 failed / 24 passed with the change, and 12 failed / 24 passed on the
  unmodified base — the same 12 test names.** No regression; those failures are
  the pre-existing `string_constants` and test262-fyi-submodule gaps above.
