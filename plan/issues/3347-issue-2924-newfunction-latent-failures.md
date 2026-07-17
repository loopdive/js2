---
id: 3347
title: "tests/issue-2924.test.ts: 2 pre-existing failures on pristine main — new Function('return')() + no-arg new Function() standalone return-undefined shapes"
status: ready
sprint: Backlog
priority: medium
horizon: l
feasibility: hard
model: fable
task_type: bug
area: codegen
language_feature: new-function
created: 2026-07-17
related: [3008, 1584, 2924, 2960]
origin: "found by opus-3 2026-07-17 while verifying the #745 value-rep cluster; latent red unnoticed because per-issue test files aren't in required CI"
---

# #3347 — new Function latent failures on main (tests/issue-2924.test.ts)

## Problem

Two cases in `tests/issue-2924.test.ts` FAIL on pristine `upstream/main`
(verified in isolation via `git show upstream/main:tests/issue-2924.test.ts`):

1. **acceptance 5**: `new Function("return")()` should === undefined via a
   REAL callable.
2. **no-arg** `new Function()` → `function anonymous() {}` (callable,
   returns undefined).

Both are standalone return-undefined shapes. **Latent red** — unnoticed
because per-issue `tests/issue-*.test.ts` files are not uniformly wired into
required CI (the **#3008** class; the #3008 detector should surface this once
it lands).

Not caused by any 2026-07-17 work — #2948's PR #3227 deliberately did NOT
touch this file to avoid entangling with the pre-existing red.

## Fix

Root fix is **interpreter-ladder / new Function** territory (`new Function`
body compilation of `return`-only and empty bodies to real callables that
return undefined) — see #1584 (interpreter) and #2960 (loud dynamic
eval/new Function). NOT a drained-budget quick fix; scoped hard/L.

## Acceptance
- `new Function("return")()` and no-arg `new Function()` both produce a
  real callable returning undefined, standalone; the 2 test cases pass.
- Confirm no regression to the other issue-2924 acceptance cases.
