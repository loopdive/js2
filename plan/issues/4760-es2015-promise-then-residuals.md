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
  - src/codegen/class-bodies.ts
  - src/codegen/expressions.ts
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::_safeSet
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
| `test/built-ins/Promise/prototype/then/ctor-throws.js` | `fail`: expected Test262Error, no throw | `fail`: descriptor TypeError while setting up throw | fixed in host (`1/1`); standalone descriptor handoff |
| `test/built-ins/Promise/prototype/then/resolve-pending-fulfilled-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/resolve-settled-rejected-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/capability-executor-not-callable.js` | `compile_error`: `extern.convert_any` anyref/externref mismatch | same compile error | ABI/compiler handoff |
| `test/built-ins/Promise/prototype/then/ctor-null.js` | `fail`: expected TypeError, no throw | `fail`: expected TypeError, no throw | fixed in host (`1/1`); standalone native-`$Promise` handoff |
| `test/built-ins/Promise/prototype/then/resolve-pending-rejected-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/rxn-handler-rejected-invoke-nonstrict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/S25.4.5.3_A1.1_T2.js` | `fail`: `p.then.length` was 0, expected 2 | `fail`: `p.then` was not a Function | builtin descriptor/standalone method handoff |
| `test/built-ins/Promise/prototype/then/deferred-is-resolved-value.js` | `fail`: returned Promise did not equal object | `fail`: returned object did not equal object identity | custom constructor/return identity handoff (deferred) |
| `test/built-ins/Promise/prototype/then/capability-executor-called-twice.js` | `compile_error`: `extern.convert_any` anyref/externref mismatch | same compile error | ABI/compiler handoff |
| `test/built-ins/Promise/prototype/then/ctor-custom.js` | `fail`: constructor count 0, expected 1 | `fail`: constructor count 0, expected 1 | fixed in host (`1/1`); standalone native-`$Promise` handoff |
| `test/built-ins/Promise/prototype/then/rxn-handler-fulfilled-invoke-strict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/rxn-handler-rejected-invoke-strict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |
| `test/built-ins/Promise/prototype/then/ctor-poisoned.js` | `fail`: expected Test262Error, no throw | `fail`: expected Test262Error, no throw | fixed in host (`1/1`); standalone native-`$Promise` handoff |
| `test/built-ins/Promise/prototype/then/resolve-settled-fulfilled-poisoned-then.js` | `fail`: promise fulfilled | `pass` | fixed: host reaction return thenable mirror |
| `test/built-ins/Promise/prototype/then/rxn-handler-fulfilled-invoke-nonstrict.js` | `process_crash`: runtime.ts:10143 null/undefined property in constructor bridge | `pass` | host callback/constructor bridge handoff |

Two semantic families are now covered. The four poisoned-thenable rows (4/4
host and 4/4 standalone) are the reaction-value bridge from the preceding
checkpoint: a host `Promise.prototype.then` callback returned an opaque WasmGC
object, so native V8 could not perform `Get(result, "then")`. The four
corresponding non-thenable rows remain settlement/identity controls (4/4 in
each lane).

This checkpoint adds the four constructor/species rows (4/4 host, 0/4
standalone). The host `Promise.prototype.then`/`.catch` calls now bypass the
generic async-return wrapper, so synchronous `Get(p, "constructor")`, species,
and constructor errors remain abrupt completions instead of becoming rejected
promises. `Promise_new` mints in the source sandbox realm, making a source
`Promise[@@species]` override visible to the native `.then()` operation. When
compiled code writes `constructor[Symbol.species]` through a closure carrier,
the runtime mirrors the property to cached host callable bridges; the host
synthetic subclass constructor also materializes `arguments` for constructors
that inspect the native call arity. A deferred executor shim was probed and
reverted: it made the deferred row pass but broke native `NewPromiseCapability`
resolve/reject callability in 12 existing Promise subclass/combinator tests.

The exact post-change 16-row sweep was recorded with structural controls in
both lanes. Host produced `8 pass / 4 fail / 4 process_crash`; the four
callback-bridge crashes were rerun one-per-process because they terminate the
host runner before JSONL emission (with one duplicate-path repeat).
Standalone produced `8 pass / 8 fail`. Artifacts are
`.tmp/issue-4760-post-host-safe.jsonl`, the five isolated
`.tmp/issue-4760-post-host-callback-*.jsonl` attempts, and
`.tmp/issue-4760-post-standalone.jsonl`; the four-row constructor confirmation
is `.tmp/issue-4760-ctor-host-final.jsonl` (`4/4`) and
`.tmp/issue-4760-ctor-standalone-final.jsonl` (`0/4`). Every arm reported
`control-must-pass -> pass` and `control-must-fail -> fail`.

The remaining non-passing host rows are eight source entries handled as
explicit handoffs rather than hidden behind this runtime boundary change: the
deferred custom-return identity row, the four distinct host callback-bridge
crashes, the
host/standalone builtin descriptor row, and the two `extern.convert_any`
ABI/compiler rows. In the standalone lane, the corresponding eight are the
four native-`$Promise` constructor/species rows, deferred identity,
descriptor, and the two ABI/compiler rows. Integration is intended for the
successor draft PR #5010.

## Acceptance

- All 16 baseline rows have isolated, reproducible dispositions in both lanes;
  the post-change denominators above are recorded, including process crashes
  and compile failures.
- The implemented poisoned-reaction cluster passes in host and standalone,
  and the constructor/species cluster passes in host, with exact regressions
  and structural controls.
- No timeout increase, filter exemption, skip, or oracle-only workaround.
