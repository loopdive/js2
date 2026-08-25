---
id: 4533
title: "lodash: expand original QUnit fixture adapter and track remaining modular parity failures"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-21
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

# lodash upstream fixture coverage and remaining modular parity

## Current checkpoint (2026-08-21)

The original pinned `test/test.js` source now runs **62 unchanged callbacks**
(29 complete QUnit module slices) in both `lodash@4.18.1` and
`lodash-es@4.18.1`. The adapter reproduces the shared fixtures that those
callbacks use (`falsey`, `empties`, `lodashStable`, `realm`, numeric limits,
symbols, and the QUnit skip helper) instead of classifying them as unavailable
infrastructure. Both lanes compile and validate one Wasm module:

```text
lodash:    62 native, 51 Wasm passed, 11 Wasm failed
lodash-es: 62 native, 44 Wasm passed, 18 Wasm failed
deferred:  1,691 of 1,753 original registrations (not selected by this slice)
```

The earlier lodash module-init null-call and recursive/empty lodash-es report
defects are resolved on current main. The remaining failures are now ordinary
compiled-runtime parity findings (modular string/predicate/conversion paths),
not hidden setup failures; keep them attributable in the generated report.

## Problem (a) — lodash

The pinned lodash suite previously compiled **and validated**, then every test
was blocked by one init crash (2026-08-16, `a9b20d4c`, matching the npm-compat
card 0/11):

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

- [x] lodash `__module_init` completes; per-test results are recorded.
- [x] lodash-es lane surfaces a single, diagnosable compile/result record.
- [x] Shared upstream fixtures are explicit and covered by the two package
      lanes without changing the upstream callback source.
- [ ] Resolve the remaining 11 lodash and 18 lodash-es compiled-runtime
      mismatches, or split them into focused compiler/runtime issues.
