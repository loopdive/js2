---
id: 1934
title: "Decompose runtime.ts resolveImport — 5,000-line function, 188 name checks, into per-domain handler tables"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
task_type: refactor
area: runtime
language_feature: compiler-internals
goal: maintainability
---
# #1934 — Decompose resolveImport into domain tables

## Problem

`resolveImport` (`src/runtime.ts:4600-9610`) is a single **~5,000-line
function**; its `"builtin"` case alone is ~4,190 lines carrying **188
distinct `if (name === ...)` checks**, with Promise combinators, JSON, Date,
Object.*, Reflect.* interleaved in one switch arm. Linear if-chains give
O(n) dispatch; review and merge-conflict cost is the real tax (runtime.ts is
a top-churn file).

Compounding issues found during review:
- A **test262 harness shim** (`Test262Error`, `assert_*`, `verifyProperty`
  stubs) is embedded as a template string inside the production eval handler
  (`runtime.ts:5250-5320`) — test infrastructure shipped in the production
  runtime.
- Three coexisting ToPrimitive walkers (`_toPrimitive` :2092,
  `_toPrimitiveSync` :2280, `_hostToPrimitive` :2347) with #1716 comments
  papering over divergence; a full JS-side JSON.stringify reimplementation
  (:2719-3100) beside the host fast path.

## Proposed approach

1. Split the `"builtin"` arm into per-domain modules under `src/runtime/`
   (`promise.ts`, `json.ts`, `date.ts`, `object-reflect.ts`, `string.ts`,
   `math.ts`, …), each exporting
   `Record<string, (ctx: InstanceState) => Function>`; `resolveImport` does
   one map lookup. `src/runtime/builtins.ts` already seeds this pattern.
2. Move the test262 shim behind a build/option flag (`runtimeTest262Shim`),
   excluded from production bundles.
3. Unify the three ToPrimitive walkers into one (parameterized by
   sync/host), as its own PR within this issue.
4. Keep behavior identical: the equivalence suite + test262 js-host lane are
   the oracle; do the move in mechanical, per-domain PRs.

## Acceptance criteria

- No function in runtime.ts over ~300 lines; dispatch is table lookup.
- Production bundle excludes the test262 shim (size check in test).
- One ToPrimitive implementation; #1716 divergence comments resolved.
- Equivalence + test262 green per PR.

## Source

Compiler quality review 2026-06. Coordinate with #1933 (instance state) —
doing #1934 first makes #1933 mechanical.
