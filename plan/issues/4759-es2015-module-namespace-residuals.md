---
id: 4759
title: "ES2015 module namespace Test262 residuals"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: modules, runtime, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - scripts/test262-fixture-graph.mjs
  - scripts/test262-fyi-reader.mjs
  - tests
  - plan/issues/4759-es2015-module-namespace-residuals.md
---

# #4759 — ES2015 module namespace Test262 residuals

## Problem

The complete host run `20260826-180615` at checkpoint head `39f279650`
contains 20 non-passing `test/language/module-code/namespace/` rows: 19 runtime
failures and one compile error. Sixteen currently normalize to `ns is not
defined`; the remaining rows cover namespace own-key ordering, TDZ/accessor
behavior, and escaped-keyword parsing. Broad full-run attribution is not
sufficient, so each row needs isolated confirmation. The integration target is
the successor combined draft PR #5010.

## Implementation plan

1. Extract and rerun all 20 exact paths individually in host and standalone
   modes. Preserve raw diagnostics and separate parser, module-linking, and
   namespace-exotic-object failures.
2. Trace the dominant `ns is not defined` family through Test262 module
   dependency loading and namespace import binding creation. Reduce it to a
   minimal module graph with a positive namespace control.
3. Implement the narrow shared namespace binding/linking fix and add exact
   regression coverage. Do not emulate expected values in the harness.
4. Resolve only adjacent rows with the same proven cause; hand back parser or
   namespace-exotic-object rows as explicit follow-up clusters rather than
   mixing unrelated fixes.
5. Run exact pins and controls in both lanes plus TypeScript 5/7, formatting,
   lint, budgets, and issue gates. Commit a clean branch tip for integration
   into the single draft PR #5010 and record exact results here.

## Acceptance

- Every one of the 20 baseline rows has an isolated disposition.
- The confirmed shared namespace-binding control passes host and standalone;
  Test262 rows that require namespace-exotic behavior remain explicit follow-up
  dispositions.
- No test filtering, fixture rewrite, host-oracle shortcut, or skip is added.

## Measurement and disposition (2026-08-26)

The authoritative source is
`/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl`.
It contains 23 namespace records: 20 non-passing rows in scope and three
passing controls (`get-own-property-str-found-uninit.js`,
`get-str-found-uninit.js`, and `super-access-to-tdz-binding.js`). The 20-row
denominator is therefore 20/23 of the namespace slice, not a whole-corpus
ratio.

The host path-filtered rerun wrote all 20 selected rows to
`benchmarks/results/ns-host-all-results-20260826-194200.jsonl`; an isolated
single-path rerun of `Symbol.iterator.js` after the graph-route change is in
`benchmarks/results/ns-host-fixed-results-20260826-202000.jsonl`. The host
baseline signatures were reproduced as follows:

| disposition | count | paths/signature |
| --- | ---: | --- |
| self-import binding residual | 16 | `Symbol.iterator.js`, `Symbol.toStringTag.js`, `internals/define-own-property.js`, `delete-non-exported.js`, `get-own-property-sym.js`, `get-str-initialize.js`, `get-sym-found.js`, `get-sym-not-found.js`, `has-property-str-found-init.js`, `has-property-str-found-uninit.js`, `has-property-str-not-found.js`, `has-property-sym-found.js`, `has-property-sym-not-found.js`, `prevent-extensions.js`, `set.js`, `super-set-to-tdz-binding-with-accessor.js` — `ns is not defined` |
| delete/exotic residual | 2 | `delete-exported-init.js`, `delete-exported-uninit.js` — first `delete` expected TypeError but observed ReferenceError |
| namespace key-order/exotic residual | 1 | `own-property-keys-binding-types.js` — `TypeError: Cannot convert null to object` |
| parser residual | 1 | `own-property-keys-sort.js` — escaped keyword diagnostic at source line 22 |

The standalone path-filtered rerun has 19 recorded rows: 12 in
`benchmarks/results/ns-sa-all-results-20260826-195500.jsonl` and seven solo
files `ns-sa-solo-results-20260826-195700.jsonl` through
`ns-sa-solo-results-20260826-201100.jsonl`. Its 16 binding rows report
`ReferenceError: ns is not defined`; the two delete rows report the same
expected-TypeError mismatch with an undefined actual value; and the parser row
matches the host diagnostic. The solo
`own-property-keys-binding-types.js` process exhausted the default 512 MiB
worker heap before recording a verdict, so that one row remains an explicit
rerun obligation rather than being counted as pass or fail.

The single-source WAT for `Symbol.iterator.js` imports the string constant
`"ns is not defined"` and has one use of that import on the generated
ReferenceError path. This identifies unresolved single-source binding setup,
not a namespace export named `ns`. Compiling the same source under the pinned
self key `./language/module-code/namespace/Symbol.iterator.js` with
`compileMulti` removes that unresolved path. A minimal two-function self-import
control now returns `42` in both `gc` and `standalone` (`tests/issue-4759-module-namespace.test.ts`).

The exact `Symbol.iterator.js` Test262 row then reaches the next, honest
failure, `Cannot convert undefined or null to object`: the existing
`tryEmitCompiledModuleNamespaceObject` intentionally materializes only
immutable function-export namespaces. Empty, mutable, TDZ, symbol-key, and
descriptor/ordering namespace exotics are outside this binding fix and are
handed back as follow-up clusters. The three old passing controls are likewise
not treated as semantic evidence: they exercised unresolved `ns`/vacuous
ReferenceError paths and need remeasurement once namespace-exotic support lands.

The post-route isolated remeasurement covers all 20 rows in each lane. Host
results are in `benchmarks/results/ns-host-postsolo-results-20260826-210000.jsonl`:
two rows pass (`get-sym-not-found.js` and
`super-set-to-tdz-binding-with-accessor.js`), and the remaining 18 are 14
`type_error`, two assertion, and two generic Wasm-exception dispositions. None
retain the `ns is not defined` signature. Standalone results are in
`benchmarks/results/ns-sa-postsolo-results-20260826-220000.jsonl`: five rows
pass (`Symbol.iterator.js`, `get-sym-not-found.js`,
`has-property-str-not-found.js`, `has-property-sym-not-found.js`, and
`super-set-to-tdz-binding-with-accessor.js`), while the other 15 are recorded
as `[object WebAssembly.Exception]`; none retain `ReferenceError: ns is not
defined`. The former 512 MiB standalone OOM row was rerun with a 4 GiB Vitest
fork and 3 GiB compiler worker in `ns-sa-solo-fixed-results-20260826-205000.jsonl`
before the full post-route sweep.

The three baseline pass controls were also rerun after linking. Host records in
`benchmarks/results/ns-controls-host-results-20260826-230000.jsonl` now report
assertion failures (the expected ReferenceError became a TypeError or no
exception), and standalone records in
`benchmarks/results/ns-controls-sa-results-20260826-230500.jsonl` report the
generic Wasm exception. This confirms that their former pass status was
vacuous under unresolved `ns`; they are controls for the follow-up exotic
implementation, not regressions of the self-import linker route.

## Implemented checkpoint

`hasSelfModuleImport` in `scripts/test262-fixture-graph.mjs` recognizes only
static relative import/export-from edges resolving to the current pinned entry.
The shared Test262 runner scopes that predicate to the namespace test tree,
adds the entry source under the same virtual key, and uses `compileMulti` for
this shape alongside the existing `_FIXTURE` graph branch. A non-namespace
self-import control (`built-ins/Proxy/preventExtensions/trap-is-undefined-target-is-proxy.js`)
still reports its baseline `ns is not defined` in
`benchmarks/results/ns-unrelated-control-results-20260826-233000.jsonl`.
No Test262 fixture or harness source is rewritten, and ordinary single-source
tests are unchanged. `tests/issue-4759-module-namespace.test.ts` covers
static-edge filtering plus a self-namespace function-export control in both
execution lanes.

The clean handoff is to integrate this branch into combined draft PR #5010.
The remaining module-namespace exotic and escaped-keyword rows above are
intentionally not folded into this checkpoint.
