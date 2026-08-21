---
id: 4583
title: "Pin the standalone IR cutover corpus and prove its exact denominator"
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: test
area: compiler, ir, tooling
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
depends_on: [4579]
required_by: [4584, 4586]
related: [3518, 4550, 4577, 4579]
---
# #4583 — Pin the standalone IR cutover corpus and prove its exact denominator

## Problem

#4579, "Instrument standalone IR physical-route cutover", records every
invocation that reaches a WasmGC generator. A parse, rewrite, or semantic
failure before code generation cannot emit that record, however, and the
collector's source and unit controls are lower bounds. A missing invocation or
partial corpus can therefore look like a smaller valid audit.

Routing must not switch on that evidence. The existing five-entry standalone
playground census first needs a content-addressed manifest, one attempt and one
completion per expected case, and exact per-case and aggregate reconciliation.

## Pinned scope

This issue observes exactly the existing five standalone playground sources
through the public `compile` route:

| Source | Bytes | All units | Terminal | Owned support | Unowned support | Derived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Calendar | 9,937 | 17 | 10 | 7 | 0 | 7 |
| Algorithms | 3,933 | 7 | 7 | 0 | 0 | 0 |
| Async | 2,266 | 8 | 6 | 2 | 0 | 12 |
| Builtins | 3,366 | 4 | 4 | 0 | 0 | 0 |
| Classes | 2,554 | 11 | 11 | 0 | 0 | 0 |
| **Total** | **22,056** | **47** | **38** | **9** | **0** | **19** |

#4588, "Prepare the compiler timer shim through exact IR ownership," preserves
the eight-unit Async inventory while reclassifying the exact compiler timer
shim from unowned support to a self-owned terminal. Source bytes and every
other case count remain unchanged; the current manifest digest is
`sha256:e25d80c90cdd5eb3c6a21672e6d9f3db754ddd4a068d54d5d37b5fee856eb0b7`.

Every case must report `standalone / compile / single / generateModule` and
exactly one source. These counts are the measured inventory denominator, not a
claim that the wider compiler is ready for IR-only generation.

## Scope

- Commit the exact source paths, byte lengths, SHA-256 digests, invocation
  identity, per-case inventory, aggregate inventory, and manifest digest.
- Write an attempt receipt before source verification or compilation.
- Write one completion for every attempt, including source drift, thrown
  compilation, failed compilation, and missing audit evidence.
- Correlate every row by manifest digest, run ID, and case ID.
- Extend the existing collector to reject missing, extra, duplicate, mixed,
  stale, failed, or count-drifted corpus evidence.
- Keep `--require-no-legacy` orthogonal at the checker API. The required
  package/CI gate now enables it with explicit floors of five successful cases,
  five sources, and 47 units against the raw audit stream after exact manifest
  reconciliation, without changing this manifest.

## Non-goals

- Switching any public route or changing compiler semantics.
- Editing prepared-IR, ABI, class, module-init, or code-generation ownership.
- Claiming that five playground files represent the full R9 denominator.
- Running broad benchmark or Test262 corpora.

## Acceptance criteria

- [x] The committed manifest validates its own digest and every source byte.
- [x] A normal run emits exactly five attempts and five successful completions.
- [x] Every completion matches its case's route, target, graph, generator,
      source identity, and exact inventory counts.
- [x] Totals reconcile to 5 cases, 5 sources, 2 classes, 47 units, 38 terminal
      units, 9 owned support units, 0 unowned support units, and 19 derived units.
- [x] Missing, extra, duplicate, mixed-run, stale-digest, source-drift,
      pre-codegen, failed-compilation, missing-audit, and count-drift controls
      all fail closed.
- [x] The same manifest is evaluated with `--require-no-legacy`; denominator
      validation remains pinned independently by explicit 5/5/47 floors.
- [x] Focused runner/collector tests, typecheck, and formatting pass.

## Completion evidence

- `pnpm run check:standalone-ir-cutover-corpus`: 5/5 attempts and completions,
  5/5 sources, 47/47 units, 38/38 terminal units, and 19/19 derived units.
- `vitest` focused collector/runner matrix: 22/22 tests passed.
- `pnpm run typecheck`: passed.
- Prettier and `git diff --check`: passed.
