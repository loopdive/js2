# Deno module linking checkpoint, 2026-10-04

## Continuation: optional imported references

`expressions/linked-module-reference.ts` now resolves linked member references
in source order and puts the remaining chain inside each optional nullish
guard. This prevents optional calls from reaching a private copied dependency
and preserves computed-key/argument skipping, nested chains, named-call
undefined receivers and parenthesized member receivers. Export the existing
`emitBaseCoercibilityGuard` for non-optional property references, which must
throw on a nullish base before call arguments execute. The compiler control
initially measured 57 instead of 59 after four optional imported calls; that
owner discrepancy is fixed. An expanded native fixture is being rebuilt;
do not reuse the previous spread-only package hashes for it.

## Continuation: imported spread calls

An explicit compiler control reproduced a wrong-owner spread call: after
`ns.sum(...args)` the original owner stayed at count 5 instead of 10. The
linked-call path had declined all spreads, leaving a static private function
fallback. It now builds a local argument vector using the existing strict
native iterator materializer, then invokes the original callable through the
same owner-aware bridge as ordinary calls. Inline array literals use the
existing force-vector argument lowering, not opaque tuple carriers.

Expanded compiler controls pass **11/11** across three files and cover namespace and named calls, empty/mixed spreads, nested
imported argument calls, runtime array parameters, and rejecting null as a
non-iterable without executing the callee. Default-off byte parity remains
covered. The expanded native shared-module control also passes **1/1**, 51
filtered /52, using clean committed compiler
`c6dbe274881465e039490d94ec35bbc76ded7437`, freshly rebuilt fixtures and
Binaryen 125 O3 /Wasmtime 47.0.3. Its final compiler/interpreter counters are
zero; the same fixtures pass Node V8 **1/1**. Native ordinary controls remain
34 passed, 17 ignored, 1 filtered /52. No unchanged Deno test or benchmark was
rerun in this continuation.

New package directory `/private/tmp/deno-module-spread.JjnDxv`; the old
owner-only package directory below cannot satisfy the expanded fixture hashes.
From the adapter workspace:

```sh
V8X_JS2WASM_SCRIPT_ENVIRONMENT_DIR=/private/tmp/deno-native-promise.6898GB V8X_JS2WASM_AOT_GRAPH_DIR=/private/tmp/deno-module-spread.JjnDxv target/debug/deps/js2wasm_spike-8b524eb9ef0b52c1 --exact shared_modules::aot_shared_dependency_keeps_namespace_live_exports_and_single_execution --ignored --nocapture --test-threads=1
```

Optional imported calls still decline this path. Prepared IR initializer
guards, cycles/TDZ, cached errors and full Deno coverage remain unfinished.

## Wrap-up: authoritative resume state

Work stopped at the user's checkpoint request. No new implementation was made
after the owner-aware call fix. Both existing PRs are open drafts, not merged:

- Compiler [PR 6468](https://github.com/loopdive/js2/pull/6468), implementation
  `e840ca2ce08b8bc970c60c907ddd23dd0abae9bf`, branch
  `codex/4376-deno-lexical-checkpoint-20261004`. This PR is stacked on
  `codex/4376-deno-callback-construction-20260930`, not main.
- Adapter [PR 2](https://github.com/loopdive/v8x/pull/2), published head
  `8c2a87b7191c505e0028236da7975993d60126fc`, implementation
  `90323467c858f278db8294e8d068121f311146da`, branch
  `codex/4376-deno-realm-bootstrap`, base main.

Latest compiler controls passed **11/11** across three files; typechecking,
scoped formatting and source gates passed. The dead-export tool exits zero but
reports an uncertified runtime-retirement closure; do not claim retirement.
The adapter ordinary controls passed **34/34**, with 17 ignored and one filtered
environment-dependent test out of 52. The explicit shared-module control passed
**1/1**, 51 filtered /52, using a clean committed compiler at e840ca2ce0.
The five selected unchanged Deno tests passed **5/5**, each 430 filtered /431;
their graph/Script packages are still development artifacts. These are previous
execution receipts, not newly rerun tests at wrap-up. No new performance or
footprint measurements were made.

Clean shared-module replay, from the adapter workspace:

```sh
V8X_JS2WASM_SCRIPT_ENVIRONMENT_DIR=/private/tmp/deno-native-promise.6898GB V8X_JS2WASM_AOT_GRAPH_DIR=/private/tmp/deno-module-owners-clean.WynXRu target/debug/deps/js2wasm_spike-8b524eb9ef0b52c1 --exact shared_modules::aot_shared_dependency_keeps_namespace_live_exports_and_single_execution --ignored --nocapture --test-threads=1
```

Clean compiler checkout: `/private/tmp/deno-promise-full.X2WdwN/js2`, detached
at e840ca2ce0. Packages use Binaryen 125 O3 and Wasmtime 47.0.3; final runtime
compiler/interpreter counters are zero. Fixture changes require fresh packages
and rebuilding the Rust test binary, which embeds those fixtures.

Next work, in order:

1. Add explicit imported optional/spread-call, getter/argument-order and nested
   foreign-closure controls. The current linked-call helper declines optional
   chains and spread; their fallback paths have not been proven owner-safe.
2. Guard prepared IR per-source initializers, including
   `src/codegen/multi-prepared-module-init-batch.ts`, and prove the IR path
   actually participates. Reserve capability imports and flush late shifts
   before capturing function indices. Do not disable IR to pass the test.
3. Test cycles, temporal dead zones, cached evaluation failures and negative
   capability/Context ownership cases. Migrate raw checker queries to oracle
   facts. The typed static inter-file callable preflight remains a known gap.
4. Rebuild the selected unchanged Deno packages from the clean compiler pin
   using the explicit tsx loader, then expand beyond the five selected tests.
   Snapshot creation currently aborts at `v8__SnapshotCreator__CONSTRUCT`;
   the full 431-test population is not passing or fully verified.
5. Complete remaining module/host behavior before matched footprint and speed
   benchmarks. Do not treat these checkpoint PRs as finished Deno integration.

The continuation section below supersedes the historical failing-control and
old resume instructions farther down. Unrelated compiler dirt and adapter
`.tmp/` were preserved; no cleanup, stash, main push or merge was performed.

## Continuation: callable ownership fixed

The previously failing expanded shared dependency test now passes **1/1**,
51 filtered /52, including namespace and named mutations to 4/5, namespace
receiver identity, bare-call undefined, same-URL distinct Modules and zero
runtime compiler/interpreter counts. Node V8 control remains 1/1.

Fixes: namespace function-value specialization conditionally reads the original
capability; `expressions/linked-module-call.ts` captures receiver/callee before
arguments and uses the existing linked resolved-call bridge. Remove the duplicate
early dynamic call in call-identifier. An empty source map remains byte-identical.
Native `js2wasm_foreign_get.rs` previously excluded all Module graphs. It now
recognizes `__v8x_graph_owns`, routes get/call to the actual allocation owner and
retains explicit receiver semantics. New graph exports provide owning
three-reference getters and allocation-proven calls to nested closures.
Native direct export dispatch also rejects graphs merely re-exporting a foreign
function. Caller reachability is not callee ownership.

Five exact unchanged Deno module tests now pass **5/5**, each 430 filtered /431:
builtin_core_module, import_meta_resolve, import_meta_filename_dirname,
evaluate_already_evaluated_module and evaluate_already_evaluated_module_sync.
Missing builtin graph package fails **0/1** with loading refusal. An exploratory
import_meta_ prefix run executed two passing tests, then aborted at
`v8__SnapshotCreator__CONSTRUCT`; do not score it as full-suite completion.

Rebuild unchanged Deno runner from its checkout with
`RUSTFLAGS='--cfg tokio_unstable' cargo test --offline -p deno_core --lib --no-run`.
This fixes the linker configuration failure without editing Deno. Exact replay:

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-promise-full.X2WdwN/deno-core.cwasm V8X_JS2WASM_AOT_SCRIPT_DIR=/private/tmp/deno-module-linking.pmIWQ4/deno/scripts V8X_JS2WASM_AOT_GRAPH_DIR=/private/tmp/deno-module-linking.pmIWQ4/deno/graphs target/debug/deps/deno_core-87206ac56a2fccad --exact modules::tests::builtin_core_module --nocapture --test-threads=1
```

All five graph packages were built successfully. The combined builder then
failed loading compiler `.js` imports during Script packaging without tsx.
The four exact assertion Scripts were subsequently built with Node's explicit
`--import tsx` loader; keep that loader when rebuilding from compiler source.
No Deno source/test rewrite or interpreter was added. Existing full/small
Context artifacts are unchanged. New packages still use the dirty development
compiler candidate, not a clean published compiler pin.

Compiler controls verify owner receiver behavior and original function identity,
native capability import presence and unmapped byte parity. The first parity
probe used a typed exact static inter-file call, which fails the callable
preflight on both this candidate and clean 1c2f7c35fd. It is a pre-existing
`non-exact graph edge` failure, not evidence that typed integration is complete.
The checked-in parity probe tests namespace function values instead.

Resume with prepared IR initializer guards and explicit parity tests, cycles,
TDZ/cached failures, optional and spread imported calls, negative capability
controls and full unchanged population. Rebuild clean artifacts before claiming
published reproducibility. Both PRs remain drafts; no fresh benchmark.
The failed call checkpoint below is historical, not current behavior.

Incomplete implementation checkpoint. Continue in the existing draft PRs:
[compiler](https://github.com/loopdive/js2/pull/6468) and
[adapter](https://github.com/loopdive/v8x/pull/2). Neither is merge-ready.
The compiler PR is stacked on `codex/4376-deno-callback-construction-20260930`.
The tracked task is 4376, **Spike v8x as a rusty_v8-compatible js2wasm backend
for a compiler-free Deno runtime**. Do not mark the integration complete.

## Implementation

Compiler branch `codex/4376-deno-lexical-checkpoint-20261004`, workspace
`/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm`. Adapter branch
`codex/4376-deno-realm-bootstrap`, workspace
`/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`.

The optional `standaloneModuleNamespaceImports` map binds exact compiler
SourceFile names to `() -> externref` imports. The adapter captures the native
Module and Context per graph, not a URL-global cache. Null means not evaluated;
otherwise the import unwraps the original Context-owned namespace. Ownership,
ABI shape and missing/ambiguous native binding checks refuse mismatches.

Compiler `src/codegen/linked-module-namespace.ts` guards each legacy per-source
initializer and redirects named imported reads to the canonical namespace.
`module-namespace-value.ts` returns that namespace instead of a duplicate.
`expressions/calls.ts` and `call-identifier.ts` attempt dynamic imported-call
routing. `compiler.ts` explicitly forwards the option; without that forwarding
the graph compiled without capability imports and the initial probe was a no-op.
`examples/v8x-js2wasm-spike/compile-graph.ts` creates the source-to-capability map.
The default option is off. No deployed compiler or interpreter was added.

Adapter `src/js2wasm_module_namespaces.rs` binds imports. `js2wasm_spike.rs`
classifies these capabilities as deferred native bindings and installs them.
`js2wasm/realm_objects.rs` retrieves only evaluated, correctly owned namespaces.
`js2wasm_realm_values.rs` shares the existing checked-handle conversion.

## Measured boundary

The earlier, smaller native test passed 1/1: dependency execution once,
first/second namespace identity, count initially 2, and named/namespace reads
observe the original native dependency bump to 3. This used dirty compiler
development artifacts, not a clean published build receipt.

The expanded current native test **fails 0/1, 51 filtered /52**. Those preceding
identity/read assertions pass, then `mutateNamespace` returns **1 instead of 4**.
Named mutation, namespace/bare-call receiver binding, same-URL distinct Module
identity and the final zero-compiler/interpreter counters are not reached.
Do not describe them as passing. The exact JavaScript fixture passes **1/1**
under Node's V8 module evaluator, including call/receiver assertions.

Current ordinary adapter controls: **34 passed, 0 failed, 17 ignored,
1 environment-dependent core Script test filtered /52**. Formatting passes.
Current scoped compiler lint and namespace controls pass 6/6. TypeScript
typechecking passes. The earlier broader run was
25 passed /1 failed /26; its Hole-global failure reproduced on clean ba14fcaedb
(7/8). No new unchanged Deno result or benchmark is claimed in this checkpoint.

## Reproduce the current failure

Development graphs: `/private/tmp/deno-module-linking.pmIWQ4`. Built from this
dirty compiler candidate with Binaryen 125 O3 and Wasmtime 47.0.3. First binding
digest `16173d5026e480a4bd48ea39dc737035903323c69199ae9013700996314520f0`;
second `c10d47605cf2ed1389e52c98fc37b1fda72e7c86601eacc166b9a7ccb9dbbea5`.
Do not reuse pre-expansion fixture packages as evidence for the current test.

From the adapter workspace:

```sh
V8X_JS2WASM_SCRIPT_ENVIRONMENT_DIR=/private/tmp/deno-native-promise.6898GB V8X_JS2WASM_AOT_GRAPH_DIR=/private/tmp/deno-module-linking.pmIWQ4 target/debug/deps/js2wasm_spike-8b524eb9ef0b52c1 --exact shared_modules::aot_shared_dependency_keeps_namespace_live_exports_and_single_execution --ignored --nocapture --test-threads=1
node --experimental-vm-modules --test tools/js2wasm/test-shared-module-fixtures.mjs
```

Small Context SHA256 is
`52530264bf83966d5049409029fa4b7819dc1e881758c775fd8e3f7234e23123`,
19,883,016 bytes. Native binary features are `js2wasm_deno_poc`,
`js2wasm_gc_copying`, `js2wasm_diagnostic_abi`, without `runtime_compile`.
Temporary artifacts are local inputs, not checked-in distributable packages.

## Resume order

1. Fix calls into the original dependency owner. Inspect compiler static/dynamic
   routing and adapter `js2wasm_graph_calls.rs` ownership selection. A namespace
   function must execute its original closure, not the later graph's private
   function/global slots. Preserve getter/argument order and receiver semantics.
2. Replay the entire expanded control, including bare-call `this`, namespace-call
   `this` and same-URL distinct native Modules. Keep the failure visible.
3. Guard the prepared IR M2 initializer adapter in
   `src/codegen/multi-prepared-module-init-batch.ts`; only legacy initialization
   is guarded today. Add option/import-floor, default-off parity, malformed,
   missing/ambiguous binding, wrong-Context, cycles/TDZ and failed-evaluation tests.
   Migrate raw checker queries to oracle facts. Do not disable IR or add an
   interpreter to make the test green.
4. Build artifacts from a clean committed compiler pin before claiming published
   reproducibility. Clean staging compiler is
   `/private/tmp/deno-promise-full.X2WdwN/js2` at 1c2f7c35fd; it does not include
   this checkpoint yet. Fetch the full branch and detach FETCH_HEAD to advance.
5. Rebuild the native unchanged Deno test runner. The last build in
   `/private/tmp/deno-upstream-conformance.H6HA4g/deno` failed linking (exit 101),
   not a live build. Inspect its macOS linker config and recorded flags before
   retrying. Old `deno_core-87206ac56a2fccad` uses the earlier adapter and cannot
   validate these new imports. Do not edit Deno source or tests.
6. Replay exact `builtin_core_module` packages, then expand the unchanged
   population. Historical selected module result is 4 passed /1 failed /5,
   each 430 filtered /431. Full integration, snapshots, dynamic import/top-level
   await, remaining host transport and matched benchmarks remain unverified.

Preserve compiler dirt in `src/ir/backend/lower-contracts.ts`,
`website/public/acorn/acorn.wasm`, unrelated untracked files and adapter `.tmp/`.
Do not blanket stage, stash, clean or prune them. Typst and cargo-nextest are
unavailable; site rendering and nextest baselines are not verified.
