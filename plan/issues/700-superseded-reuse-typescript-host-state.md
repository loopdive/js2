---
id: 700
title: "Reuse TypeScript Program and checker state across incremental builds"
status: in-review
created: 2026-03-20
updated: 2026-07-26
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: checker, compiler
goal: performance
sprint: current
files:
  - scripts/test262-worker.mjs
  - src/checker/multi-file-paths.ts
  - src/checker/language-service.ts
  - src/compiler.ts
  - src/index.ts
  - tests/issue-700-test262-language-service.test.ts
  - tests/issue-1119.test.ts
  - tests/issue-973-repro.test.ts
  - tests/issue-973.test.ts
  - tests/issue-incremental.test.ts
  - tests/typescript-diagnostic-failures.test.ts
loc-budget-allow:
  - src/compiler.ts
---

# #700 — Reuse TypeScript Program and checker state across incremental builds

## Status: in review

The core Language Service landed in
[PR #3645](https://github.com/loopdive/js2/pull/3645). The authoritative
Test262 CI integration is in
[PR #3650](https://github.com/loopdive/js2/pull/3650).

The original issue proposed an explicit `reuseHost` option on
`compile()`/`compileSource()`. It was closed as superseded after
`createIncrementalCompiler()` and persistent compiler-pool workers landed.
Subsequent profiling showed that the underlying optimization was not actually
complete: the incremental path cached parsed library files but still created a
fresh TypeScript `Program` and `TypeChecker` for every build.

## Problem

The TypeScript frontend dominates compilation time for small and medium inputs:

| Input           | TypeScript parse + check | Total compilation | Frontend share |
| --------------- | -----------------------: | ----------------: | -------------: |
| Fibonacci       |                 185.3 ms |          193.4 ms |          95.8% |
| Built-ins-heavy |                 195.8 ms |          276.0 ms |          70.9% |

Caching only immutable library `SourceFile` objects reduced some repeated
parsing, but each call still rebuilt the user-source Program, checker, symbols,
and diagnostics. This limited the old incremental wrapper to roughly a 4–7%
improvement.

## Implementation

PR #3645 replaces per-build `ts.createProgram` construction with a persistent,
versioned TypeScript Language Service:

1. A versioned `SourceSnapshot` computes the exact common-prefix/common-suffix
   `TextChangeRange`, allowing TypeScript to incrementally update the mutable
   source AST.
2. An unchanged source keeps the same Program, checker, source file, and
   diagnostic caches.
3. Source text, filename, and ScriptKind changes increment the document and
   project versions.
4. Compiler-option and ambient-library changes recreate the Language Service
   because TypeScript does not include the host-selected default library name
   in its project-structure reuse key.
5. A shared `DocumentRegistry` and immutable library snapshots avoid duplicating
   the large standard-library ASTs between compiler instances.
6. Mutable user-document versions include a per-service namespace, preventing
   two compiler instances using the same virtual filename from aliasing
   different source text.
7. JavaScript, JSX, TypeScript, and TSX inputs retain their correct ScriptKind
   and `allowJs`/JSX compiler settings.
8. `createIncrementalCompiler()` exposes both `compile()` and `compileMulti()`.
   The multi-file service owns a versioned snapshot per normalized virtual path,
   preserving unchanged dependency ASTs while invalidating edits, additions,
   removals, renames, root ordering, and entry-file changes.
9. The one-shot and incremental project hosts share path normalization,
   extension probing, bare-specifier mapping, ScriptKind selection, and module
   resolution. Both retain the compiler's dependency-first, entry-last module
   initialization order.
10. The authoritative Test262 unified worker routes its literal JavaScript
    harness lane, synthetic TypeScript lane, and JavaScript fixture graphs
    through the persistent compiler. The worker keeps a compatibility fallback
    to `compileMulti()` for older bundles without the new method.
11. The worker no longer recreates the compiler on a fixed 100-compilation
    interval. TypeScript releases removed documents as the Language Service
    Program changes, and the wrapper retains only the current source/project
    graph, so the reset merely introduced periodic cold frontend builds.
    Thrown compiler failures still replace the service immediately; explicit
    GC and whole-worker contamination/recycle safeguards remain active.

The nine-line `src/compiler.ts` growth is the intentional orchestration seam
that selects the persistent project service while preserving the existing
one-shot analyzer path and its exact options. Moving this decision into the
checker would couple one-shot analysis to Language Service lifecycle rather
than reducing subsystem complexity. Issue #700 therefore grants only the
file-level LOC allowance; the per-function budget needs no allowance.

## Performance evidence

Median local measurements after warm-up:

| Input           |                  Edited rebuild |              Unchanged rebuild |
| --------------- | ------------------------------: | -----------------------------: |
| Fibonacci       |  208.2 ms → 79.0 ms (**2.64×**) | 208.2 ms → 33.4 ms (**6.24×**) |
| Built-ins-heavy | 250.3 ms → 114.4 ms (**2.19×**) | 250.3 ms → 61.4 ms (**4.08×**) |

Edited builds still run the existing IR and code-generation pipeline. Unchanged
builds obtain the larger gain because the full TypeScript frontend result can
be reused.

The Test262 integration was measured separately rather than extrapolating the
microbenchmarks. One-worker, non-authoritative original-harness smoke runs
produced byte-for-byte identical verdict sets against the pre-integration
`origin/main` control (`52c498db4`):

| Lane       | Records | Control | Language Service | Result split      |
| ---------- | ------: | ------: | ---------------: | ----------------- |
| Host / GC  |     100 | 43.03 s |          44.45 s | 68 pass / 32 fail |
| Standalone |      20 |  9.03 s |           8.45 s | 12 pass / 8 fail  |

These single-run wall timings are mixed compile-and-execute measurements and do
not demonstrate a reliable Test262 throughput improvement. The combined point
estimate is 52.06 s → 52.90 s (about 1.6% slower), so the evidence currently
says "approximately unchanged, if anything slightly slower" rather than
"faster." The integration removes the bypass and makes frontend reuse
available; a larger repeated CI measurement is still required before claiming
an end-to-end Test262 speedup.

The fixed 100-compilation reset was also measured with the maintained Test262
runner on CI shard 1/57 (836 Vitest cases, four unified workers), alternating
the exact pre-removal commit and the reset-free workspace:

| Run order | Fixed reset | Reset-free |
| --------- | ----------: | ---------: |
| First     |    226.39 s |   245.74 s |
| Repeat    |    207.19 s |   183.16 s |
| Mean      |    216.79 s |   214.45 s |

The reset-free mean is 2.34 s (1.1%) faster, but the pair-to-pair reversal and
large run variance make the honest conclusion "approximately unchanged." The
mean sum of per-case compile timings was also effectively identical:
682,101 ms with the reset versus 681,904 ms without it (0.03% lower).

## Correctness and isolation

The implementation adds or strengthens coverage for:

- unchanged Program/checker/source-file identity
- source-edit invalidation and stale-diagnostic removal
- browser-to-Node ambient-library invalidation
- filename and ScriptKind changes
- simultaneous compiler instances with the same virtual filename
- JavaScript-mode byte parity with standalone compilation
- byte-for-byte isolation across 100 unrelated sequential sources
- literal-harness JavaScript parity across source replacements
- recovery from a syntax-error harness to a subsequent clean harness
- consecutive host and standalone original-harness jobs in one unified worker
- unchanged dependency AST identity across multi-file entry edits
- unchanged whole-project Program identity
- edited dependency byte parity with one-shot `compileMulti()`
- add/remove/re-add and entry-file invalidation
- simultaneous project-service isolation on identical virtual paths
- consecutive changing JavaScript fixture graphs in one unified worker
- absence of the obsolete fixed-interval cold-recreation path
- exact Test262 pass-set and terminal-status parity across the fixed-reset
  boundary on a complete CI shard
- hard TypeScript diagnostics on the asynchronous incremental API

Existing incremental tests were also corrected to await `compiler.compile()`;
several had previously asserted properties on unresolved Promises.

## Approaches rejected

- **Raw `oldProgram` hand-off:** previously caused stale checker state and
  cross-compilation poisoning in long-lived worker pools. Language Service
  versioning owns invalidation instead.
- **One DocumentRegistry per compiler:** correct but duplicated the large
  standard-library AST in every compiler instance and exhausted the default
  worker heap under broad suites. A shared registry plus service-scoped mutable
  document versions preserves isolation without that memory cost.
- **Standalone `vitest run` as the test262 gate:** invalid for this repository
  because test262 requires its Phase-1 precompile cache. The direct invocation
  produced cache misses rather than meaningful compiler failures.

## Validation

- `pnpm exec tsc --noEmit --pretty false`
- focused Biome lint over all seven changed files
- focused incremental and multi-file Vitest suites: 9 files, 52 tests passed
- Test262 integration suite: 10 tests passed
- 14 exact Test262 fixture-negative paths passed in both host and standalone
  FYI lanes
- existing unified-worker oracle sample: 50/50 records passed
- Test262 original-harness A/B: 100/100 host and 20/20 standalone verdicts
  identical to the `52c498db4` control
- maintained Test262 CI shard 1/57 A/B, repeated with four workers: all 836
  file/strict-mode/status tuples identical; 526/836 raw cases and 523/761
  canonical tests passed in every run
- shard wall-time A/B: fixed reset 226.39 s and 207.19 s (216.79 s mean);
  reset-free 245.74 s and 183.16 s (214.45 s mean, 1.1% faster but within
  observed variance)
- repository pre-push typecheck, lint, formatting, and committed-issue integrity
  gates

## Files changed

- `scripts/test262-worker.mjs`
- `src/checker/multi-file-paths.ts`
- `src/checker/language-service.ts`
- `src/compiler.ts`
- `src/index.ts`
- `tests/issue-700-test262-language-service.test.ts`
- `tests/issue-1119.test.ts`
- `tests/issue-973-repro.test.ts`
- `tests/issue-973.test.ts`
- `tests/issue-incremental.test.ts`
- `tests/typescript-diagnostic-failures.test.ts`

## Resolution

PR #3645 is merged. Merge PR #3650, then transition this issue from
`in-review` to `done`.
