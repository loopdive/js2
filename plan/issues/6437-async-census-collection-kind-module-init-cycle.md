---
id: 6437
title: "tests/async-census.test.ts fails at collect time with a module-init cycle: `Cannot read properties of undefined (reading 'MAP')` in collections-brand.ts"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: correctness
related: [3324]
origin: "found in passing while validating #6414 (2026-09-12) — reproduces on unmodified upstream/main, unrelated to that PR"
---

## Problem

`tests/async-census.test.ts` does not fail an assertion — it fails to **collect**,
so all of its tests are lost:

```
TypeError: Cannot read properties of undefined (reading 'MAP')
 ❯ src/codegen/collections-brand.ts:100:24
    99| const KIND_OF: Record<CollectionClass, number> = {
   100|   Map: COLLECTION_KIND.MAP,
 ❯ src/codegen/expressions/calls.ts:36:1
```

`KIND_OF` is a module-level constant that reads `COLLECTION_KIND` while the
declaring module has not finished initializing — a circular-import ordering bug,
the same family as
[#3324](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3324-boolToStringEmitter-module-init-cycle)
(`Cannot access 'boolToStringEmitter' before initialization`), which was fixed
for a different entry point.

The trigger is the entry point: `tests/async-census.test.ts` imports
`../src/codegen/async-cps.js` **directly**, without first importing
`../src/index.js`. Several sibling tests carry an explicit comment saying to
"import the top compiler entry first so the codegen module graph initializes in
the correct order" (e.g. `tests/issue-2906-async-multiawait.test.ts`) — that
workaround is load-bearing and undocumented outside those comments, which is the
real defect: any new test that imports a codegen module directly hits this.

## Reproduce

On a clean checkout of `upstream/main`:

```bash
node node_modules/vitest/vitest.mjs run tests/async-census.test.ts
# Test Files  1 failed (1) — Tests  no tests
```

Verified on `e8a778638f` (2026-09-12), both with and without an unrelated
`src/codegen/async-frame.ts` edit in the tree.

## Acceptance criteria

1. `node node_modules/vitest/vitest.mjs run tests/async-census.test.ts` collects
   and passes with no other file loaded first.
2. The fix is in the module graph (e.g. make `KIND_OF` lazy, or break the
   `calls.ts` → `collections-brand.ts` → … cycle), **not** an added
   `import "../src/index.js"` line in the test — that only moves the trap to the
   next test that forgets it.
3. A note in the relevant module explaining which edge of the cycle is load-bearing.
