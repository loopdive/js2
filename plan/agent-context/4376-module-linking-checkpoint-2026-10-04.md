# Deno module linking checkpoint, 2026-10-04

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
