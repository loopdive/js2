---
id: 4760
title: "ES2015 Promise.prototype.then Test262 residuals"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: promises, runtime, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src/codegen
  - src/runtime
  - tests
  - plan/issues/4760-es2015-promise-then-residuals.md
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
---

# #4760 — ES2015 Promise.prototype.then Test262 residuals

## Problem

The authoritative host run `20260826-180615` at the pre-integration head
`39f279650` (source JSONL:
`/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl`)
contains 16 non-passing `test/built-ins/Promise/prototype/then/` rows: 14
runtime failures and two Wasm compile errors. The implementation branch starts
from exact integration checkpoint `3fb21eb37899fa8e56abca97d2e82ce58cf7edc7`.
The observable groups include constructor/capability validation, poisoned
thenables, reaction-handler scheduling, async completion, and the builtin
length descriptor. Solo runs show these are distinct operations rather than a
single Promise.prototype.then defect.

## Implementation plan

1. Rerun all 16 exact paths individually in host and standalone modes and
   classify stable failures by specification operation and error signature.
2. Start with the largest coherent family confirmed by solo runs, reduce it to
   a minimal issue regression, and identify the owning promise/runtime path.
3. Implement the narrow shared fix with positive controls for settlement order,
   rejection propagation, constructor validation, and asynchronous completion
   as applicable. Do not make the Test262 harness accept synchronous behavior.
4. Rerun all 16 pins to detect adjacent fixes and regressions. Record unrelated
   compile/ABI rows as explicit follow-up handoffs rather than conflating them.
5. Run both targets, TypeScript 5/7, formatting, lint, budgets, and issue gates.
   Commit a clean branch tip for integration into the sole successor draft PR
   #5010 and update this issue with exact denominators.

## Solo confirmation and disposition

Every row below was run as a fresh process through
`scripts/harness-flip-probe.ts`, with `control-must-pass.js -> pass` and
`control-must-fail.js -> fail` before the row. `process_crash` means the
compiled host process terminated before the probe could emit a JSONL row; its
signature was captured from stderr. The standalone S25 row was rerun after
building the isolated QuickJS adapter, so it is not the earlier missing-cache
instrumentation result.

| Test262 path | Host solo | Standalone solo | Disposition |
| --- | --- | --- | --- |
| `test/built-ins/Promise/prototype/then/ctor-throws.js` | `fail`: expected Test262Error, no throw | `fail`: descriptor TypeError while setting up throw | constructor/species and standalone descriptor handoff |
| `test/built-ins/Promise/prototype/then/resolve-pending-fulfilled-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/resolve-settled-rejected-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/capability-executor-not-callable.js` | `compile_error`: `extern.convert_any` anyref/externref mismatch | same compile error | ABI/compiler handoff |
| `test/built-ins/Promise/prototype/then/ctor-null.js` | `fail`: expected TypeError, no throw | `fail`: expected TypeError, no throw | constructor/species handoff |
| `test/built-ins/Promise/prototype/then/resolve-pending-rejected-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/rxn-handler-rejected-invoke-nonstrict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/S25.4.5.3_A1.1_T2.js` | `fail`: `p.then.length` was 0, expected 2 | `fail`: `p.then` was not a Function | builtin descriptor/standalone method handoff |
| `test/built-ins/Promise/prototype/then/deferred-is-resolved-value.js` | `fail`: returned Promise did not equal object | `fail`: returned object did not equal object identity | custom constructor/return identity handoff |
| `test/built-ins/Promise/prototype/then/capability-executor-called-twice.js` | `compile_error`: `extern.convert_any` anyref/externref mismatch | same compile error | ABI/compiler handoff |
| `test/built-ins/Promise/prototype/then/ctor-custom.js` | `fail`: constructor count 0, expected 1 | `fail`: constructor count 0, expected 1 | constructor/species handoff |
| `test/built-ins/Promise/prototype/then/rxn-handler-fulfilled-invoke-strict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/rxn-handler-rejected-invoke-strict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/ctor-poisoned.js` | `fail`: expected Test262Error, no throw | `fail`: expected Test262Error, no throw | constructor/species handoff |
| `test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/rxn-handler-fulfilled-invoke-nonstrict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |

The selected semantic family is the four poisoned-thenable rows (4/16): a
host `Promise.prototype.then` callback returned an opaque WasmGC object, so
native V8 could not perform `Get(result, "then")`. The fix adds a Promise
reaction return bridge that reuses the live thenable mirror and preserves
throwing accessors by shape-gating the probe. The four corresponding
non-thenable rows are identity/settlement controls (4/4 pass in each lane).

The remaining 12 rows are explicitly out of scope for this branch: five
constructor/species or custom-return rows, four host-only callback-bridge
process crashes, the host/standalone builtin descriptor row, and two
`extern.convert_any` ABI/compiler rows. They should be integrated as separate
follow-ups rather than hidden behind this runtime boundary change.

## Acceptance

- All 16 baseline rows have isolated, reproducible dispositions in both lanes.
- The implemented semantic cluster passes in host and standalone modes with
  exact regressions and controls.
- No timeout increase, filter exemption, skip, or oracle-only workaround.
