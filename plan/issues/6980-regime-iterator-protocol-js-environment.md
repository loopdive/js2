---
id: 6980
title: "Native regime in a JS environment: iterator / generator protocol defects (custom iterables, generator .return(), async generator methods)"
status: in-progress
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: compiler
language_feature: iterators, generators
goal: architecture
sprint: current
parent: 5385
related: [6708, 6979]
---

# #6980 — regime iterator / generator protocol in a JS environment

Surfaced by slice A of #6708 (default `semanticProviders: "native-first"`).
When the native regime is selected in a JS environment (exports read through
`wrapCompiledExports`), these `tests/equivalence/` rows fail:

- `issue-2033-custom-iterable-spread-destructure` — all eight custom-iterable spread / destructure rows
- `iterator-protocol-custom` — generator returned from `[Symbol.iterator]()` is itself
- `symbol-iterator-class` — bracket-access `[Symbol.iterator]`; object-literal computed key
- `issue-1454` — plain-array fast path; Map destructure; null/undefined throws; rest element
- `generator-return-method` — `return()` propagates the supplied value
- `issue-1388` — static async generator method, detached + iterator
- `yield-as-expression` — yield in template literal

Typical failure: "value is not iterable" on spread/destructuring of a user
object with `[Symbol.iterator]`.

## Acceptance criteria

- All rows above pass with `{ semanticProviders: "native-first" }` through
  `wrapCompiledExports`.
- Standalone output byte-identical or improved; equivalence gate reports no new
  regressions.
- Regression test `tests/issue-6980-regime-iterator-protocol.test.ts` covers
  each construct under native-first (JS environment) and `target: "standalone"`.

## Implementation notes

(filled in as root causes are confirmed)
