---
id: 5339
title: "hono helper/dev: the whole test module fails before any test runs (0/8) — and the harness reports it with a null wasmError"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`src/helper/dev/index.test.ts` is **0/8** in the hono upstream suite. All
eight tests fail with a **null** per-test `wasmError` — the file dies as a
unit, before any `it()` body executes. This file also used to strand the
*whole* suite silently (fixed in #5326 by the per-file watchdog), so it has
already cost this effort once.

Measured on a clean detached worktree at main `c9a8b48616`. hono overall
244/324.

## Evidence

- Eight entries in `tests/dogfood/report/hono-upstream-suite.json` for this
  file, all `status: "failed"`, all `wasmError: null`.
- **Reporting trap, load-bearing here:** for a whole-module failure the
  message is *not* on the tests. Look in `report.compile.details[N]` for this
  file — `errors[0]` (codegen/compile error), or `validationError` (module
  emitted but does not validate), or `runtimeError` (throws inside
  `__module_init`). Four agents have misread "wasmError: null" as "no error".
- Run alone through `compileAndRunUpstreamModule`, the file settled with
  `native 0/0, wasm undefined` — **zero tests registered on the native lane
  too**. So the first thing to establish is whether this is a compiler failure
  at all, or the harness's transform of this file (it uses `showRoutes` /
  `inspectRoutes`, which print; the test may stub `console.log`, and a stub
  that is never restored is exactly what #5326's swallowed-stdout bug was).

## Acceptance criteria

1. The report names the actual failure for this file (no more null-only
   record), **and** either the file passes ≥ 6/8 or the issue is re-filed with
   the confirmed root cause and a repro if it is a harness problem rather than
   a compiler one.
2. If a compiler fix: regression test under `tests/` failing on the parent,
   passing with the fix, untyped `.js` two-file fixtures, plus an anti-vacuity
   control.
3. A/B at one HEAD, 17 suites, per test file — hono improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. **Get the real error first.** After a suite run, print
   `report.compile.details.find(d => d.file.includes("helper/dev"))` in full.
   Three branches:
   - `success: false` → codegen error; go to step 3.
   - `validates: false` → invalid Wasm; the new required gate
     (`check:dogfood-validation`) should also catch this class — confirm it
     does, then go to step 3.
   - `success && validates` with `runtimeError` → `__module_init` threw; go
     to step 2.
2. **If it throws at init**: compile the generated entry
   (`.hono-upstream-suite-generated/src/helper/dev/index.ts`) directly,
   instantiate, and call `instance.exports.__module_init()` with the suspect
   host function monkey-patched to log — this is how the axios `beforeEach`
   blocker (#5295) was found in minutes. Also check whether the **native**
   lane registers zero tests: if native is also 0/0, the transform or the
   file's own `console.log` stubbing is the problem, and the fix is in
   `tests/dogfood/hono-upstream-suite.mjs` / `upstream-suite-runner.mjs`, not
   `src/`.
3. **If it is a compiler error**: reduce with a negative control via a
   standalone `.mjs` (model `.tmp/markedbisect/globalset.mjs`; sanity-check
   with a deliberately-false assertion). The file's distinctive ingredients
   are `new Hono().use(...).get(...).post(...)` **method chaining on a class
   instance across many calls**, `inspectRoutes(app)` returning an array of
   object literals compared with `toEqual`, and `showRoutes` writing to
   `console.log`. Ablate those in that order.
4. Fix at the site; prefer a subsystem module over a god-file allowance.
5. Regression test, A/B.

## Dispatch

Model: **opus**. The failure mode is not yet known (could be codegen,
validation, init-throw, or harness), so the agent must branch on evidence
rather than follow a fixed recipe.
