---
id: 4759
title: "ES2015 module namespace Test262 residuals"
status: in_progress
created: 2026-08-26
updated: 2026-09-20
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

## FYI original-harness parity continuation (2026-09-20)

### Current evidence and boundary

The frozen authoritative standalone FYI census at project revision
`f3520ca177960f49c006edc3fd7acce8bebf58d9` (Test262
`b363f29d3c43c626dc852744ad64a0b48a003693`, test262.fyi
`beeff8b3d70e65dcdd00270fdb31ab12f041b049`) records 23 rows in
`language/module-code/namespace/`: 20 failures and three apparent passes. Its
result document is `/private/tmp/js2-4444-full-es2015-manifest.i16PO6/full-f352.json`
(SHA-256 `851a8f4e09d048aba2ce76d4c693d16c04efd5477ee36077079934bb00c73d6f`).

Exactly 16 namespace rows stop at `ReferenceError: ns is not defined`, including
the literal self-import row `language/module-code/namespace/Symbol.iterator.js`.
The seventeenth corpus-wide occurrence is deliberately outside this namespace
tree: `built-ins/Proxy/preventExtensions/trap-is-undefined-target-is-proxy.js`.
The three namespace passes are not positive controls: each is an expected
`ReferenceError` shape and can pass vacuously while `ns` is unresolved, as the
earlier post-link rerun already demonstrated.

The implementation worktree starts from project revision
`2f6c0f4f57db129c772a476345c28d85010cd175`. The `f3520ca` census is
historical before-route evidence only; any validation receipt must name its
candidate revision, Test262/test262.fyi revisions, source-assembly hash, and
whether the row used the single-source or `compileMulti` graph route. Its
totals must not be presented as corrected-runner results.

This is a runner assembly gap rather than a new compiler module-linking claim:

- `hasSelfModuleImport` already proves a pinned static self edge in
  `scripts/test262-fixture-graph.mjs`.
- The project runner already sends only namespace-tree self imports through
  `compileMulti` under the entry's pinned virtual key.
- The FYI reader currently attaches graph transport only when a static or
  dynamic `_FIXTURE` map is nonempty; its self-import records therefore reach
  the worker without an entry graph. The worker in turn requires a nonempty
  `fixtureFiles` map before selecting `compileMulti`.

### Narrow implementation plan

1. In `scripts/test262-fyi-reader.mjs`, compute the existing
   `hasSelfModuleImport` predicate only for
   `language/module-code/namespace/` entries and carry an explicit
   `selfModuleGraph` fact with the pinned entry key. Do not infer the fact from
   an arbitrary `entryFile`, and do not rewrite the assembled FYI source.
2. Transport that fact unchanged through `scripts/run-test262-fyi.mjs` to the
   existing project worker. It must survive an otherwise empty static fixture
   map.
3. In `scripts/test262-worker.mjs`, revalidate the transported fact against
   the canonical namespace entry key, a non-array fixture-file record, and the
   literal static self edge before
   selecting the existing `compileMulti` path. Select that path when either a
   real static fixture graph exists or this namespace-and-self-edge check is
   true. Keep the current graph options, literal entry, error handling, and
   deferred initialization behavior; do not promote dynamic fixture metadata
   into a static graph.
4. Add focused FYI-runner coverage for the transport/selection boundary,
   including a forged `selfModuleGraph: true` non-namespace request that must
   remain single-source, and keep the existing compiler-level self-namespace
   control in `tests/issue-4759-module-namespace.test.ts`. The production code
   must not touch module-namespace exotic-object lowering in this slice.

### Acceptance and regressions

- The exact `Symbol.iterator.js` FYI original-harness row must no longer use
  the unresolved `ns` single-source path. It may expose a separate
  namespace-exotic residual; this routing correction makes no broader
  namespace-family claim.
- `language/module-code/instn-star-props-circular.js`, the existing genuine
  linked `_FIXTURE` circular-module control from #3491, remains a passing
  static graph control.
- The non-namespace Proxy self-import control remains on its existing
  single-source route and retains its measured behavior.
- The existing FYI runner dynamic-import preservation control remains
  single-source; an empty fixture map or dynamic metadata alone must never
  activate `compileMulti`.
- A non-namespace request with a forged self-graph transport flag remains
  single-source even when it names a relative self import; the worker's
  namespace/pinned-edge revalidation is the authority, not caller metadata.
- Literal test262.fyi assembly, worker verdict normalization, negative-test
  matching, and pass/fail classification remain byte-for-byte unchanged.

### Initial candidate receipt

On candidate `2f6c0f4f57db129c772a476345c28d85010cd175`, the maintained FYI
runner executed the exact one-path manifest (SHA-256
`7302a3fa02d4b1d5d5e9b951cd006154f8f06a2cf648e08370173a875f311b61`) under
Node `v25.9.0` / Unicode `17.0`, target `gc`, with the checked Test262 revision
`b363f29d3c43c626dc852744ad64a0b48a003693` and test262.fyi revision
`beeff8b3d70e65dcdd00270fdb31ab12f041b049`. The literal assembled source was
10,592 bytes, SHA-256
`7594c3ac0d9115482f7333b65d22ef0b6d4d7eed6d8a8027d146c1ca08cc4536`, and the
reader marked it as the canonical empty `compileMulti` graph
`./language/module-code/namespace/Symbol.iterator.js`.

The `gc` result document
`/private/tmp/js2-4759-namespace-symbol-iterator-gc-20260920.json` (SHA-256
`0ba6ed2dbf36eb73e260e67e81e45648bd01bd45b4c0007bf1273b4f276c77ea`) records
`1/1` pass with `phase: runtime` and `reachedTest: true`; its terminal log is
`/private/tmp/js2-4759-namespace-symbol-iterator-gc-20260920.log` (SHA-256
`95c84dca60fc6f87bdad8ba657465468ce468f68e599922da35fe445a6234bfd`). The
matched Node 25 `standalone` result is also `1/1` pass at runtime:
`/private/tmp/js2-4759-namespace-symbol-iterator-standalone-20260920.json`
(SHA-256 `c77e2ae4589a8519cd75cbd0bcde8a6bc4a1a369997800665788eafd47949c5c`),
with log
`/private/tmp/js2-4759-namespace-symbol-iterator-standalone-20260920.log`
(SHA-256 `0df1b28115eb9d5f75ec7adef24ddc1dd9bb68dda4be2c30caabe94782ca36e4`).

The focused regression also carries a same-source kill-switch: the exact
assembled record retains its canonical key and empty fixture record but sends
`selfModuleGraph: false`, which must reproduce the original runtime
`ns is not defined` failure. This is route-causality evidence, not a clean
baseline or a substitute for a full namespace remeasurement. The next bounded
validation must execute that control alongside the enabled record.

These are newly measured route results, not a replacement for the frozen
`f3520ca` census and not claims about the remaining namespace-exotic rows.

### Next bounded namespace sweep

The next authoritative validation will run all 23 namespace paths selected
from the frozen `f3520ca` result document, in Node 25 `standalone` mode using
the maintained original-harness runner. Its frozen manifest is
`/private/tmp/js2-4759-namespace-f352-23-paths-20260920.txt` (23 paths,
SHA-256 `00e4af40f0fbd02715bd756ab04bbb6644f5b1cb80c617dbd23229cd31c92c7e`).
It must report every row separately, including the three historical
expected-`ReferenceError` passes, and must distinguish new linked
namespace-exotic residuals from runner setup failures. The sweep is
blast-radius evidence for this assembly change, not an all-green requirement
and not permission to alter verdict policy or namespace-exotic lowering.

### 23-path standalone receipt (2026-09-20)

That sweep is terminal at candidate
`2f6c0f4f57db129c772a476345c28d85010cd175`: 6 pass / 17 fail, under the same
Node 25 / Unicode 17 contract and pinned Test262/test262.fyi revisions as the
one-path receipt. Its result document is
`/private/tmp/js2-4759-namespace-f352-23-standalone-20260920.json` (SHA-256
`4c45d7dac947fc9d5b278b3bb36c61b7622799fd0bb88e03e65c256f822f9923`); its
terminal log is
`/private/tmp/js2-4759-namespace-f352-23-standalone-20260920.log` (SHA-256
`9eae15a06eb7cbf727ad3e278417aefc4462390a4f0cc6d2c4ab0aebf7818395`).

Against the historical `f3520ca` artifact, six rows move fail-to-pass:

- `internals/get-sym-not-found.js`
- `internals/has-property-str-not-found.js`
- `internals/has-property-sym-not-found.js`
- `internals/prevent-extensions.js`
- `internals/super-set-to-tdz-binding-with-accessor.js`
- `Symbol.iterator.js`

Three historical passes move pass-to-fail because their expected
`ReferenceError` no longer occurs after the namespace binding is linked:

- `internals/get-own-property-str-found-uninit.js`
- `internals/get-str-found-uninit.js`
- `internals/super-access-to-tdz-binding.js`

Those three were explicit vacuous controls in the frozen result, not evidence
of a supported namespace-exotic behavior. They remain failures here because
the resulting namespace-exotic semantics are still incomplete; no verdict
rule, allowance, or oracle version is changed to conceal them. The remaining
14 rows stay non-passing, making 17 current residual paths in total:

- `internals/define-own-property.js`, `internals/delete-exported-init.js`, and
  `internals/delete-exported-uninit.js` expose non-object Reflect operations.
- `internals/delete-non-exported.js`, `internals/set.js`, and
  `internals/super-access-to-tdz-binding.js` miss the required abrupt/TDZ
  behavior.
- `internals/get-own-property-str-found-uninit.js`,
  `internals/get-own-property-sym.js`, `internals/get-str-found-uninit.js`,
  `internals/get-str-initialize.js`, `internals/get-sym-found.js`,
  `internals/has-property-str-found-init.js`,
  `internals/has-property-str-found-uninit.js`, and
  `internals/has-property-sym-found.js` expose property visibility/value/TDZ
  residuals.
- `internals/own-property-keys-binding-types.js` and
  `internals/own-property-keys-sort.js` retain key-list behavior residuals.
- `Symbol.toStringTag.js` retains the namespace tag residual.

The `f3520ca` result is historical and this candidate is not its source-base
replacement; no adjusted full-corpus rate is inferred from this 23-row
comparison.

### Maintained baseline and oracle scope

This change affects the FYI original-harness transport only when that runner
explicitly sends `selfModuleGraph: true`. The maintained sharded CI runner
shares `scripts/test262-worker.mjs`, but it does not send that field; its
existing nonempty static-fixture path remains the same. Consequently the
change invalidates the worker cache key but does not change the maintained
baseline's input assembly or require a baseline artifact refresh. The FYI
receipt can legitimately differ from its old FYI census because the latter
used the wrong single-source assembly for this narrow shape.

No scoring, negative matching, vacuity classification, or error normalization
line changes in the worker. The `ORACLE_VERSION` stays unchanged; neither a
guard relaxation nor an oracle bump is appropriate merely because the three
historical expected-ReferenceError passes become visible residual failures.

### Oracle-version disposition

No `ORACLE_VERSION` bump is planned. This changes which compiler graph is
assembled for a narrowly proven source shape; it does not change verdict
classification, negative matching, vacuity policy, or result normalization.
The prior #4759 project-runner graph route likewise did not bump the oracle.
Verdict code is deliberately left unchanged because it is unnecessary for this
execution/assembly route; if implementation requires a verdict-policy change,
the repository's oracle-version requirements apply. Any resulting row changes
remain ordinary compiler-output deltas to measure against the same oracle.
