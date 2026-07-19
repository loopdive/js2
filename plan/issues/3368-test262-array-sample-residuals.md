---
id: 3368
title: "Test262 array sample: close the 17 project-runner residuals"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, test262-runner
language_feature: array-literals, spread, object-spread
goal: test262-conformance
assignee: codex/root
related: [3362, 3367]
files:
  - src/codegen/literals.ts
  - src/codegen/object-ops.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/type-coercion.ts
  - src/runtime.ts
  - tests/issue-3368.test.ts
oracle-ratchet-allow:
  # This source-order proof resolves one identifier to its declaration; it does
  # not query or expose a TypeScript type.
  - src/codegen/object-ops.ts
---

# #3368 — close the Test262 array-sample residuals

## Problem

On the deterministic first 50 sorted paths under
`language/expressions/array`, the project runner passes 33/50. The remaining
17 failures fall into three observable groups:

1. array exotic/prototype behavior (10 paths): dense literal own-index
   presence and inherited `Array.prototype.toString` identity;
2. iterable array spread (four paths): assignment-expression spread identity,
   a single custom iterable, and an invalid `@@iterator` result;
3. object spread (three paths): getter side effects, symbol-key ownership, and
   symbol/object value preservation across overrides.

## Acceptance criteria

- Add permanent regression coverage for all 17 exact paths.
- Fix the underlying compiler/runtime behavior without adding Test262 skips or
  harness-only expected-pass exceptions.
- The project runner passes all 50 paths in the deterministic sample.
- Re-run the original harness to ensure its measured 17/50 baseline does not
  regress because of runner integration changes.

## Implementation summary

- Dense array literals now answer statically provable own-index checks without
  confusing numeric backing-array slots with holes.
- Array and tuple prototype-value reads expose the canonical host
  `Array.prototype.toString`, preserving inherited method identity.
- Object spread preserves symbol-keyed values and ownership, and deleted
  WasmGC struct fields remain absent when the host proxy enumerates them.
- Array spread rejects null/non-callable `@@iterator` methods, avoids
  contextual empty-tuple truncation, and keeps a stable refreshed host array
  for each WasmGC array crossing so assignment identity survives.

## Verification

- Permanent 17-path regression suite: all four focused groups pass.
- Exact deterministic first-50 project-runner sample: **50/50**, up from
  **33/50**.
- Original-harness first-50 sample: **25/50**, up from **17/50**. Its pass
  count improved by eight, although raw-harness-only compiler/runtime gaps
  remain outside this issue's project-runner residual scope.
- Existing focused suites: 56 tests passed across `issue-1997`, `issue-2746`,
  `issue-1467`, `issue-1998`, `issue-2836`, and the FYI runner; seven skipped.
  Four additional `issue-851` cases remain non-runnable on this checkout due
  to their pre-existing hard-coded `/workspace/test262` path.
- `pnpm typecheck` passes.
