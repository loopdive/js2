---
id: 4533
title: "lodash: module init calls a null host function (0/11); lodash-es lane fails compile silently with a recursive report"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, testing
language_feature: modules
goal: npm-library-support
related: [3996, 3995]
files:
  - tests/dogfood/lodash-upstream-suite.mjs
  - src/runtime/host-call-abi.ts
---

# lodash 0/11: `__module_init` invokes null; lodash-es lane can't say why it fails

## Problem (a) — lodash

The pinned lodash suite's single test module compiles **and validates**, then
every test is blocked by one init crash (2026-08-16, `a9b20d4c`, matches the
npm-compat card 0/11):

```text
module init: TypeError: null is not a function
    at invoke (src/runtime/host-call-abi.ts:24)
    at __module_init (wasm-function[286])
```

The #3996-era emit failure (`local index out of range` at `__cb_6`) is gone;
this is its runtime successor: during module init a host-call slot is
invoked before it is populated (or was never populated). lodash's UMD entry
runs a large IIFE at module scope — the first dynamic callable it reaches
through the host-call ABI is null.

## Problem (b) — lodash-es lane

The lodash-es variant reports 0 succeeded / 0 validated / `binaryBytes: 0`
with an **empty error string**, and the written report nests
`compile.details` recursively (details[0].details[0]… same object shape,
many levels deep). Two harness defects in
`tests/dogfood/lodash-upstream-suite.mjs` when `packageName: "lodash-es"`:
the compile failure text is dropped, and the report builder feeds its own
output back into itself. The dashboard card shows 0/11 with no diagnosable
cause — indistinguishable from problem (a) when it is actually a different,
unnamed failure.

## Reproduction

```bash
node --import tsx tests/dogfood/lodash-upstream-suite.mjs --json          # (a)
node --import tsx --input-type=module -e "
import { runHarness } from './tests/dogfood/lodash-upstream-suite.mjs';
console.log(JSON.stringify(await runHarness({ quiet: true, packageName: 'lodash-es' })).length;" # (b)
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **(b) first — it is cheap and unblocks diagnosis**: in the lodash harness,
   fix the lodash-es report assembly (stop nesting `details` into itself;
   surface the compile error/stderr string). Re-run; record lodash-es's real
   failure in this file. It may be identical to (a) or a distinct compile
   error — do not assume.
2. **(a)**: identify the null slot — wrap `invoke` in
   src/runtime/host-call-abi.ts locally to log the slot index/name on null,
   run the harness, correlate with the generated module's import/export
   tables. Suspect family: a callable reached through
   `wasmClosureDynamicDispatch` whose function-table entry is only installed
   by a later `setExports` phase — an init-ordering defect (module init
   running before the host finished wiring bridge exports), or a callable
   the dead-import eliminator dropped while the init path still references
   its slot (#4435 saw the same "empty marshaled status" family in marked).
3. **Reduce** whatever step 2 names into a `.tmp/` probe (module-scope IIFE
   that calls a function value defined later / via `Function('return this')`
   — lodash's root detection — are prime candidates).
4. **Validation gates**: lodash harness init completes and the 11 tests
   report real statuses (record the number here — passing is not implied);
   lodash-es lane reports a non-empty, single-level compile record;
   equivalence green.

## Acceptance criteria

- [ ] lodash `__module_init` completes; per-test results recorded.
- [ ] lodash-es lane surfaces its real compile error (no recursive report,
      no empty error string).
- [ ] Reduction test for the null-slot init shape.
