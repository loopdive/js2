---
id: 4535
title: "three.js: MathUtils module validates but 0/18 tests pass in Wasm, all silently — including trivial clamp/euclideanModulo"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, testing
language_feature: modules
goal: npm-library-support
related: [3995]
files:
  - tests/dogfood/three-upstream-suite.mjs
  - tests/dogfood/upstream-suite-runner.mjs
---

# three.js MathUtils: one validated module, 18 uniform silent failures

## Problem

The three.js pinned slice (`test/unit/src/math/MathUtils.tests.js`, 18 QUnit
tests): the single generated module **compiles and validates** (138 KB), all
18 pass natively, and **0/18 pass in Wasm** — with `wasmError: null` on
every row (2026-08-16, `a9b20d4c`, matches the npm-compat card).

Two observations that shape the diagnosis:

1. **`clamp` and `euclideanModulo` fail too.** Those bodies are 1–2 lines of
   pure `Math.min/max` arithmetic. 18/18 uniform failure across trivial and
   non-trivial bodies points at a *shared* defect — the QUnit
   assert-adapter, the `runUpstreamTests` export path, or the module's
   shared prelude — not 18 independent math bugs.
2. **No error text.** The generic runner's status array comes back all-zero
   with empty error strings. The in-flight PR #4619 rewrites
   `upstream-suite-compile-worker.mjs` / `upstream-suite-runner.mjs` to a
   per-test entry point (`runUpstreamTest(index)`) with real error capture —
   after it lands, this suite should produce per-test messages for free.

## Reproduction

```bash
node --import tsx tests/dogfood/three-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Wait for / rebase on PR #4619** (upstream-suite runner error capture),
   then re-run — with real error text this issue may reduce to an existing
   bucket (typeof-on-boxed #4529, assert-shim mismatch, etc.). Do not
   hand-roll a parallel error-capture mechanism; #4619 already does it.
2. If #4619's text shows a shared prelude/adapter failure: reduce the QUnit
   `assert` object flow — the shim passes an `assert` object into each
   callback (`__upstreamTests[i].body(__qunitAssert)`); a single defect in
   calling method-on-parameter-object (`assert.ok(...)` where `assert` is a
   boxed parameter) would fail all 18 uniformly. Cross-check #4123
   (prototype method on parameter receiver returns null).
3. Reduce to `.tmp/` probe, fix at the identified compiler site, commit the
   reduction as `tests/issue-4535.test.ts`.
4. **Validation gates**: three slice 0/18 → ≥16/18 (record exact); the two
   sibling QUnit-style suites (webpack, stylelint — same generic runner)
   re-measured for collateral movement; equivalence green.

## Acceptance criteria

- [ ] Root cause named with per-test error evidence (post-#4619).
- [ ] three MathUtils slice ≥ 16/18, residual named.
- [ ] Reduction test committed.
