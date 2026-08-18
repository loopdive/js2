---
id: 3924
title: "linear backend: the bump arena is never reclaimed across calls — 4 benchmarks trap with memory access out of bounds; all 4 pass with allocator: arena-reset"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-08-09
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: memory-management
goal: performance
sprint: 78
horizon: m
es_edition: n/a
related: [3908, 3935, 3904]
---

# #3924 — linear bump arena is never reclaimed between invocations

## Status: done — sound opt-in exported-call reclamation implemented

## Problem

Four benchmarks' linear lanes trapped with `memory access out of bounds` partway
through a run. The lowering was correct: each call allocated into the same
monotonically advancing arena until the Wasm memory-growth limit was exhausted.

`string/concat-short` is deliberately not part of this fix. It exhausts memory
inside its first call through quadratic concatenation intermediates, so a
between-call reset cannot help it; that separate problem remains #3935.

## Decision

Implement the backend-side option, while preserving the existing default as an
exact kill switch:

- `allocator: "bump"` and an omitted allocator remain byte-identical and
  monotonic.
- `allocator: "arena-reset"` now inserts automatic resets only for a module
  whose complete exported interface and module state prove that no arena
  pointer can remain live across host calls.
- Eligibility is module-wide. Every exported parameter/result and every module
  global must be primitive. One aggregate boundary or heap-backed global keeps
  all exports monotonic; explicit `__arena_reset` / `__arena_used` management
  exports remain available to a lifetime-aware embedder.
- Resets live in host-entry wrappers and happen immediately before a call.
  Internal calls still target the original function, so they cannot rewind a
  live caller's arena. The previous completed call's memory remains valid until
  the next eligible host call starts.

This is an opt-in call-arena policy, not a tracing collector and not intra-call
reclamation. Benchmark or application embedders must select `arena-reset` when
their calls have the documented independent-task lifetime.

## Implementation Summary

- Added `src/codegen-linear/export-arena.ts` as the final heap-layout and
  exported-call arena policy pass.
- Wired both single- and multi-source linear codegen through that pass.
- Added conservative TypeScript-checker proofs for primitive export boundaries
  and primitive module globals.
- Appended same-signature host-entry wrappers which call `__arena_reset`, forward
  arguments, and call the original user function without changing internal
  function-map targets.
- Updated the public compiler option, CLI help, and ADR-0017 lifetime contract.
- Added ten issue regressions covering bounded repeated allocation, persistent
  primitive globals, internal exported calls, aggregate-boundary fallback,
  heap-global fallback, byte-identical bump output, the four stock benchmarks,
  and the #3935 negative control.

## Exact A/B

Both sides used the stock benchmark definitions and the harness-equivalent
linear lane: `fast: true`, `target: "linear"`, `optimize: 4`, one instance per
benchmark, then exactly `warmup + iterations` direct `run()` calls. Trap indices
below are zero-based.

- Base: `517aa2d0debef17373eeadf36d42a775e4c6ddce`, allocator omitted (default bump)
- Candidate implementation: `8acb392fa3603f77a9cade1748d0946d779501a0`, `allocator: "arena-reset"`

| benchmark | intended calls | base | candidate | final correct value | base/candidate pages |
| --- | ---: | --- | --- | ---: | ---: |
| `string/split` | 55 | 5 completed; trap at 5 | 55/55 completed | 75000 | 256 / 50 |
| `array/map-filter` | 55 | 28 completed; trap at 28 | 55/55 completed | 3334 | 255 / 10 |
| `mixed/csv-parse` | 25 | 6 completed; trap at 6 | 25/25 completed | 97000 | 256 / 42 |
| `mixed/sieve` | 25 | 7 completed; trap at 7 | 25/25 completed | 9592 | 241 / 33 |

The candidate re-run with explicit `allocator: "bump"` reproduced every base
trap point, result, and page count. The focused binary test additionally proves
that omitted/default and explicit bump outputs are byte-identical.

Controls behaved as required:

- `string/concat-short`: base and candidate both trap at call 0 (#3935 remains).
- `mixed/fibonacci`: base and candidate both complete 55/55 with `320399944`
  and one memory page.

## Test Results

- `pnpm exec vitest run tests/issue-3924-linear-arena-reclaim.test.ts tests/linear-string-data-layout.test.ts tests/c-abi.test.ts` — 58/58 passed.
- `pnpm run typecheck` — passed.
- Prettier, Biome lint, and `git diff --check` — passed on changed files.
- `check:ir-only -- --policy=hybrid`, `check:ir-fallbacks`, `check:loc-budget`,
  `check:func-budget`, `check:oracle-ratchet`, `check:verdict-oracle`,
  `check:coercion-sites`, `check:stack-balance`, `check:codegen-fallbacks`,
  `check:any-box-sites`, `check:dead-exports`, and
  `check:test262-hard-errors` — passed.
- `check:linear-ir` reports existing baseline drift (`8 → 6` compiled, +2
  `illegal:instr-vec.set_length`, +2 `select:string-builder-candidate`) on both
  the untouched base worktree and the candidate. Its unrelated baseline was
  not changed.

## Provenance

`issue-3908-linear-validation`'s 26-lane inventory ran each lane for
`warmup + iterations` calls rather than once. That methodology exposed this
between-call lifetime bug and separates it cleanly from #3935's call-0
intra-call exhaustion.
