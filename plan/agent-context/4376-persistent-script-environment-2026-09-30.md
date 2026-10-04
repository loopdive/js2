# Persistent AOT Script environment

## Host-owned compiled import-meta checkpoint, 2026-10-04

Compiled module access now reaches Deno's installed metadata callback. The sidecar
rewrites the full import.meta object, including bracket access and resolve calls,
to private host capabilities instead of folding url/main/resolve. Each graph's
linker captures its native Module and Context handles; later calls into older
graphs retain the original identity. Ambiguous duplicate graph specifiers fail
explicitly. Callback access uses CallerRealm and a local TryCatch; native
plain-object CreateDataProperty now supports initial insertion and configurable
redefinition, refusing fixed properties. Compiled/exotic CreateDataProperty still
fails explicitly and needs a result-aware define-property bridge.

Fresh unchanged Deno main_and_side_module passes 1/1, 430 filtered /431.
Without graph packages it fails 0/1 with the missing-artifact diagnostic, so this
is not the earlier false pass. Native AOT metadata control passes 1/1, 47 filtered
/48, verifying custom loader properties, resolve callback execution, null
prototype, distinct same-URL Module metadata, repeated evaluation and calls into
the older graph after a newer one executes. Runtime compiler/interpreter counts
are zero. Ordinary native controls pass 34, fail zero, ignore 14 /48; scoped
native units pass 15/15 with 16 filtered /31. Graph packaging controls pass 3/3.
Unchanged lazy loading/missing-script pass 2/2 (429 filtered /431), WebIDL 17/17
(414 filtered /431). These remain subsets, not full conformance.

Compiler focused host-capability test passes 1/1 (7 skipped /8). Combined graph
and namespace controls report 10 pass /1 fail /11. The synthetic JSON/text/bytes
failure also reproduces with the exact pre-change sidecar from compiler
015ab63ba3 and the same compiler/harness: "TypeError: called value is not a
function". No all-green claim. TypeScript 7, scoped lint, formatting and diff
checks pass. Deno/vendor sources are unchanged.

New source-bound optimized graph packages live in
/private/tmp/deno-host-import-meta.hxupm6, built with Binaryen 125 and Wasmtime
47.0.3. Main digest a574aa4047147f18d7e25c7c334dc08c9993afbe6c114e655ad18879fd53f868,
native SHA b8eef5fc7a4efd1f50080d9f6fd4fe27e1a72940cd1ac1e330729b3b1d4270a7.
Side digest 1967c47478be41864d75c1937a2e809ea7f94030c98db318fcf8418f8c9be777,
native SHA a7b34a2bd51b6ab6b9851cdda8468209a6fce70efb7866d4246b65f37b0ca7e2.
Identity probe digest 07a972d75a9f5429683a123ee9a813f10d3c25c3be1aeb58593135f8767bcd4d,
native SHA 07c00c9ba935061cbe83dce6900355db0707023cb5cc88dbe70c8e6c57669ca4.
Full/small Context artifacts are unchanged. Graph inventories retain exact source
and optimized/native hashes. The packaging binary is build-side only; Deno and
native execution binaries do not enable runtime_compile.

Next: native Promise transport with identity/settlement/reactions, rooted original
AOT exception payloads, full unchanged source graphs/population and snapshots.
The missing-artifact Deno failure still gets obscured by unsupported Promise
conversion. Retain typed lexical, host service, shared-library and matched
benchmark requirements; integration and both draft PRs remain incomplete.

## Wrap-up and resume entry point, 2026-10-04

Work is published in existing draft PRs: compiler
https://github.com/loopdive/js2/pull/6468 and adapter
https://github.com/loopdive/v8x/pull/2. They remain incomplete, not merge-ready.
Compiler checkpoint before this note: 88f7e82c5ed10c9f046bc2c00aa412e5e5b4089e;
adapter checkpoint: 3fa461fce229f92094c4bd16d7bc0669f972b217.
Server main is 39fd7b7d44c9bc6f9be47ddd1f7fd75196a7d5f1 and is already an
ancestor through merge 2617ddf4d2. No additional merge is required.

The next implementation has not started. Wire the currently no-op
`v8__Isolate__SetHostInitializeImportMetaObjectCallback` in
`src/js2wasm/mod.rs` to Deno's installed callback, keeping metadata identity
per native Module and Context. Replace the compiler sidecar's entry-based
`import.meta.main` constant with host-owned metadata. Deno's callback is in
`libs/core/runtime/bindings.rs`; do not edit Deno or its tests. Publish cached
metadata before invoking callbacks and avoid mutable borrows across reentry.
Repackage exact graphs and rerun unchanged `main_and_side_module`, including
positive execution and missing-artifact negative controls.

Then implement native Promise transport in `realm_objects.rs` with real
identity and settlement, and preserve rooted Wasm exception payloads in
`run_deferred_module_init` rather than reducing them to diagnostic strings.
The evidence below predates this wrap-up; no new execution or benchmark was
performed during it. Preserve unrelated tracked edits and untracked artifacts
in the compiler workspace, and the adapter's existing `.tmp/` directory.

## Module evaluation and rejection checkpoint, 2026-10-04

Adapter source 9a4e13a1cdfcd0b22f52caa24a2ba421b50970e1 now returns a cached
rejected evaluation Promise on execution/package failures. Repeated Evaluate
retains Promise identity. Synthetic callback exceptions preserve native payload
identity without leaking a synchronous exception. Uninstantiated API misuse
still throws synchronously; its Rust unit passes 1/1 (27 filtered /28).
Promise reactions now capture throws with a local TryCatch; otherwise Deno's
outer catcher intercepted the throw and the derived Promise falsely fulfilled.

Compiler-free ordinary controls pass 34, fail zero, ignore 13 /47.
The added AOT execution control passes 1/1 with 46 filtered: before evaluation the
global marker is undefined, after evaluation it is 42, namespace answer is 42,
and repeated evaluation has the same fulfilled Promise. Runtime compilation and
interpreter counts are zero. Three graph packager tests pass 3/3; retained build
controls pass 15/15. Unchanged Deno lazy loading passes 1/1 in 1.62s; WebIDL
17/17 in 24.98s, denominators 431 with 430/414 filtered, not full coverage.

New trusted graph packager invokes the existing compile-graph sidecar build-side,
Binaryen 125 no-inline O3, and Wasmtime 47.0.3 precompilation. It binds exact
entry, ordered source graph and native SHA before loading. Artifacts live at
/private/tmp/deno-module-evaluation.Ma8rec. Positive execution graph digest
e5ea1b29832d0bf7e3ebcc71a36e469d2cd56f3d3ada3811b0fabb843ebda00f,
native SHA 366ffaca93aa539830bebbf09389742f986d22f33fa520a78f1eb32c7d2f4d29,
optimized SHA 87cb6a674fa2d7fdc5cb5be3e203bc334abcbfb509f5ce9778843f417aff20fb.
Compiler implementation remains a675081032, workspace docs head 4e6b00f6c8;
existing full/small Context artifacts are unchanged.

Actual main_and_side_module now fails 0/1 instead of falsely passing with no
trusted graph. With two source-exact optimized packages the main body succeeds
but the side body throws: compile-graph.ts lowers import.meta.main to true for
every graph entry, independent of Deno's loader role. The native
SetHostInitializeImportMetaObjectCallback is a no-op. Its actual thrown error is
then obscured by unsupported native Promise transport into the compiled realm.
These failures are evidence of incomplete semantics, not lost valid coverage.
Deno and vendor tests remain unchanged.

Resume with host-owned import-meta initialization/loader roles, native Promise
transport, and native AOT module exception rooting. run_deferred_module_init still
consumes and renders Wasm payloads as diagnostics; synthetic exception identity
does not prove compiled thrown-object identity. Add positive and negative
controls that observe execution and original rejection reasons. Full graphs,
snapshots, typed persistent references, host services and matched benchmarks
remain required. No new throughput/footprint claim.

## Explicit foreign getter receivers, 2026-10-04

Compiler implementation a675081032 and adapter implementation
1214214dcc0627d9d0cb61c4042a7413173c1558 add the optional
`__v8x_script_get_export_receiver` three-reference export. The old two-reference
getter remains unchanged. New packages forward target, key and receiver to the
existing native Reflect helper; old packages still explicitly refuse alternate
receivers rather than silently substituting the target.

Compiler getter suite passes 56/56, including direct explicit receiver identity,
thrown receiver identity and subsequent ordinary reads. TypeScript 7 and scoped
Biome lint pass. The compiler-free native foreign-read control passes 1/1
(42 filtered /43) with both new receiver and thrown-receiver cases, plus the old
package refusal control; it asserts zero runtime compilations and interpreter
instances. Ordinary adapter run remains 31 passed, zero failed, 12 ignored /43.
Unchanged actual Deno lazy loading still passes 1/1, 430 filtered /431, in 1.72s.

Build-side `build-foreign-get-test-packages.mjs --calls-only` rebuilt optimized
Binaryen/Wasmtime packages in /private/tmp/deno-reentrant-script.MZdH2Q.
The new factories have marker 91/92 to distinguish them from the preserved old
receiver-less factory. Existing Context artifacts are unchanged. Compiler tests
require the fork itself to receive --experimental-wasm-exnref; the repository
Vitest config overrides parent execArgv, so a temporary derived config supplied it.
Unflagged runs failed validation, not JavaScript semantics. The default TS5
typecheck is not the configured gate; `pnpm run typecheck` (TS7) passes.

A candidate `const receiver={marker:91}` top-level Script still fails the existing
persistent lexical guard requiring dynamic externref storage. This is a real
remaining typed-reference planning gap, not resolved by getter routing. Native
receiver tests use an existing Context-owned marker, not an inferred private slot.
Full graphs/population, snapshots, Context-internal foreign reflection, non-Script
owner routing, host services and matched benchmarks remain incomplete. This
checkpoint changes neither Deno source nor tests and makes no speedup claim.

## AOT CompileFunction and real lazy loading, 2026-10-04

Adapter implementation commit 5cae5514f0598aeffe2ce36869669a01d0c7ff87
and Script-only routing guard 0bd28340669fc2936c6de70e81e5aad343b8b8ab
supersedes the previous missing-CompileFunction checkpoint. Compiler runtime pin
remains 9bfee5a9c6893bc17313c226363648ebe1ccb6b3; no compiler implementation
changed in this continuation. Both existing PRs remain incomplete drafts.

Same-store instantiation now accepts Store or Caller access, retains new graphs
before initialization, roots exceptions and restores outer completion for nested
Scripts and function factories. CompileFunction looks up an AOT factory binding
the exact body, individual parameter names and resource. Build-side validation
parses the original Function body without invoking it and rejects parameter source
fragments. Native bound functions do not publish placeholder V8 cache blobs.

The first actual lazy replay progressed from ABI abort to `expected foo`. The
original lazy function independently returned foo, bar and a callable blah through
the native API. This isolated the next issue to cross-Script reads. Linked ownership
now recognizes other retained Script owners but excludes caller-owned values; get
and call imports route to the allocation owner. An intermediate inner RootScope
unrooted returned references too early; host returns now use Caller-rooted values.
Getter exceptions pass through unchanged, and own undefined does not trigger fallback.

Latest unchanged Deno replay, compiler-free Cargo patch at original Deno
1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44:

- Actual lazy loading 1/1, 430 filtered /431, 1.72s. Covers cached export identity,
  a lazy dependency and nested foo reads. Missing lazy script 1/1, 1.71s.
- WebIDL 17/17, 414 filtered /431, 24.89s; derived conversions 2/2,
  429 filtered /431, 3.06s. These subsets are not a population summary.
- Compiler-free adapter ordinary run: 31 pass, zero fail, 12 ignored /43.
  Four additional artifact-backed native controls pass 3/3 then 1/1 /43: callback
  loading, deferred Function bodies, original lazy exports and foreign reads/calls.
  They assert zero runtime compilations and zero interpreter instances.
- Runtime-profile ordinary controls: 35 pass, zero fail, 31 ignored, four filtered
  /70. Two formerly failing provider-retention controls also fail on clean adapter
  f236d22698; their fixtures now actually import a provider for retention checks
  and require zero provider instances for Context-only graphs.
- Build-side controls 18/18; Rust factory-binding unit 1/1; compiler-free cargo
  check and Rust formatting pass. Site rebuild fails because Typst is absent.

Artifacts: /private/tmp/deno-reentrant-script.MZdH2Q. Small optimized Context
native fixture is 19,669,600 bytes, SHA
bfb2c7162c54121d704c0d4ed59b0c307044aa1492c44168bff259909e9e2eba.
It was precompiled 1/1 in 108.83s after adding shared Symbol exports. This is a
fixture, not the full Deno Context or a footprint benchmark. The full Context is
the unchanged /private/tmp/deno-call-order-native.dBQZ3T/deno-core.cwasm below.
deno-scripts/ contains copied original Script packages plus two native lazy
function factories; deno-lazy-function-inputs.json records original file hashes
and bodies generated by Deno's actual public wrap_lazy_ext_script helper.

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-call-order-native.dBQZ3T/deno-core.cwasm V8X_JS2WASM_AOT_SCRIPT_DIR=/private/tmp/deno-reentrant-script.MZdH2Q/deno-scripts /private/tmp/deno-upstream-conformance.H6HA4g/deno/target/debug/deps/deno_core-87206ac56a2fccad --exact modules::tests::test_lazy_loaded_script --nocapture --test-threads=1
```

Next: extended native getter ABI for explicit alternate Reflect receivers, then
full unchanged module graphs and population, snapshots, context extensions/cache
semantics, macro inputs, host operations, BigInt/unpaired UTF-16, shared libraries
and matched V8/QuickJS/Porffor measurements. The current alternate-receiver path
explicitly refuses rather than silently substituting the target; a native negative
control verifies this limitation. Context-internal foreign reflection and non-Script
graph ownership still require coverage. No new speedup is claimed. Preserve all
unrelated user changes and pre-existing adapter .tmp/ files.

## Stop checkpoint and implementation entry point, 2026-10-04

Wrapped up at user request. Published implementation/test heads before this
documentation checkpoint: compiler b87dfe8cc95a8c9ceaab63b02f19bc109cdcf027,
adapter 4978e6bd83b411a7019a042d2380beaad0a597b6. Existing open drafts are
https://github.com/loopdive/js2/pull/6468 and
https://github.com/loopdive/v8x/pull/2. Do not create duplicates or mark them
merge-ready. No CompileFunction implementation was started and no new benchmark
was run during wrap-up. The measured artifact pins below remain authoritative.

Resume by factoring Script instantiation into a same-store helper usable through
both DenoRuntime and CallerRealm, exposed by RealmAccess. Retain newly instantiated
graphs in StoreData.aot_call_graphs even when initialization throws, and preserve
exception rooting and the outer Script completion during nested function-factory
execution. Ordinary root instantiation must retain its existing graph bookkeeping.

Implement the actual ScriptCompiler::CompileFunction signature from vendored
rusty_v8. Package exact body, parameter names and origin using a generic function
factory, then materialize the owning native callable through realm_objects.
Validate callable classification for Script-owned closures. Unsupported context
extensions or missing trusted packages must fail loudly, not be ignored.
realm_callback_access::with_owner provides active callback access; do not route
reentrant loading through with_runtime_owner's overlapping RefCell borrow.

Entry files in the adapter are src/js2wasm/mod.rs (Script Run and Source ABI),
src/js2wasm_spike.rs (instantiation and retention),
src/js2wasm_realm_values.rs (RealmAccess and CallerRealm),
src/js2wasm/realm_callback_access.rs, src/js2wasm/realm_objects.rs,
src/js2wasm_script_packages.rs and tools/js2wasm/script-packages.mjs.
Add native controls for parameter binding, deferred body execution, receiver,
exception identity, trusted-package refusal and callback reentry before replaying
unchanged modules::tests::test_lazy_loaded_script. Re-run WebIDL 17 tests,
derived conversions two tests and lazy-script-not-found as regression controls.
Do not substitute those subsets for the complete 431-test population.

Preserve unrelated lower-contracts documentation, acorn binary and untracked
user files. Adapter .tmp/ is also pre-existing. This checkpoint adds docs only;
no new test result, performance claim or completion credit is implied.

## Fresh native method-dispatch replay, 2026-10-04

The unchanged `modules::tests::test_lazy_loaded_script_not_found` now passes
1/1, 430 filtered /431, in 1.68s. It reaches the Rust host lazy-loader and
returns the expected cannot-be-lazy-loaded error. Fresh unchanged WebIDL passes
17/17, 414 filtered /431, in 23.95s; derived conversions pass 2/2, 429 filtered
/431, in 2.96s. builtin_core_module also passes 1/1, but emits the ordinary
module artifact-selection diagnostic; do not extrapolate module-graph coverage.

The unchanged actual `test_lazy_loaded_script` now reaches the next missing
adapter operation and aborts with exit 134 at
`v8__ScriptCompiler__CompileFunction`. This is not a passing lazy-loader. Deno's
modules/map.rs compiles a strict function body returning the original IIFE with
one `__bootstrap` parameter and no context extensions, then calls that function.
Next implement generic trusted-AOT Function-body packaging/lookup, parameter
bindings and execution through the existing owning graph call terminal. Preserve
closure/object/exception identity and caching. No runtime compiler or interpreter
is needed when bodies are packaged, and Deno tests/source must remain unchanged.
CompileFunction occurs during a Rust host callback entered from Wasm: reentrant
instantiation must use active CallerRealm access, not reborrow DenoRuntime's
RefCell (with_runtime_owner currently rejects overlapping mutable borrows).

Clean build compiler 9bfee5a9c6893bc17313c226363648ebe1ccb6b3; builder adapter
f236d22698bfe60bd82e4bbea9415c2e70176dd4; unchanged Deno
1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44. Native Rust replay reuses the existing
deno_core-87206ac56a2fccad binary; no adapter Rust code changed in this checkpoint.
Artifacts: /private/tmp/deno-call-order-native.dBQZ3T. Raw Context 2,724,683 bytes,
SHA 5e1e00422b3979354bc8f64772423f8323a48870b3fd23143b5685914f2bb3a6;
Binaryen 125 optimized 2,019,396 bytes,
SHA 02cf9fc795a8e946ffee2c11783456508b2bdcb44606541400407a5056d8006c.
Wasmtime 47.0.3 precompile passes 1/1 in 211.59s. Native image 44,121,952 bytes,
SHA cbb13265e36297f5bedca29b7e31d4439568dc08bc3a239082faab8054037aad.

All 16 module-test literal Scripts and all five WebIDL Scripts are optimized and
packaged. Conversion inventory: 4 packaged /2 unresolved macro inputs /6 sites,
exit 1 as required; not a green population. Unique core-inputs.*.json reports
record exact unchanged Rust hashes and clean compiler pins. Script manifests bind
exact source/specifier bytes and optimized hashes. Native replay command:

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-call-order-native.dBQZ3T/deno-core.cwasm V8X_JS2WASM_AOT_SCRIPT_DIR=/private/tmp/deno-call-order-native.dBQZ3T/scripts /private/tmp/deno-upstream-conformance.H6HA4g/deno/target/debug/deps/deno_core-87206ac56a2fccad --exact modules::tests::test_lazy_loaded_script_not_found --nocapture --test-threads=1
```

Three default-off standalone byte controls (arithmetic, array read, dynamic object
method) match clean pre-fix merge 2617ddf4d2 exactly against 9bfee5a9c6. Full
431-test population, snapshots, full module graphs, macro-generated inputs,
transport gaps, remaining call-route coverage and comparative benchmarks stay open.

Computed-call controls were strengthened after this native replay: the key now
comes from a linked runtime function instead of a string literal, and its exact
single evaluation is checked. The 13 selected call controls pass 13/13 again;
compiler implementation and native artifact pin remain unchanged.

## Continuation: main sync and call-reference ordering, 2026-10-04

Merged origin/main 39fd7b7d44c9bc6f9be47ddd1f7fd75196a7d5f1 in 2617ddf4d2.
The sole conflict retains ordinary callback new.target locals before main's
standalone fallback. After merge: focused Script controls 41/41 and callback /
expression controls 30/30 pass; TypeScript 7 passes. Unrelated local changes remain.

New ordering controls initially measured 1 pass /2 failures: a caller-owned
callback on a foreign receiver worked, but arguments ran before a foreign getter
(213 instead of 123), including arguments whose getter should throw first.
Call sites now capture a foreign method before arguments in call-frame locals;
the owning Context invokes the captured callee afterwards. Dot and computed
call controls pass 13/13, covering callable and getter throws, non-callable
TypeErrors after argument side effects, argument mutation without callee reread,
and caller-owned callbacks. The closed dispatch path was the actual tested
route, not the IR dynamic helper; no untested IR change is included. Broader
tests now pass 140/140 (54 focused +86 persistent Script, including two existing
expected failures in the latter). TypeScript 7 passes; scoped lint has no errors
and five pre-existing warnings. Fresh native replay remains unmeasured. Dynamic
spread and independently selected IR method routes still need ordering controls.

## Handoff: Context-owned method dispatch, 2026-10-04

The formerly expected-failing `Deno.core.loadExtScript("x")` compiler control
now executes successfully. Opted-in Script method dispatch resolves a foreign
receiver's method once through its Context, then delegates Context-owned callees
to the existing Context call terminal. Caller-owned callees retain local dispatch.
No interpreter or Deno source rewrite was added.

The eight selected controls pass 8/8: three nested reads, a method call with
receiver identity, and four getter modes covering normal return, thrown payload
identity, object non-callable and undefined non-callable TypeErrors. This is
same-store compiler evidence, not a fresh native Deno lazy-loader replay.
The complete focused suite passes 41/41 with no expected-failure marker on the
foreign method call. TypeScript 7 and scoped Biome lint pass. Broader persistent
Script and source-preservation populations were not rerun for this checkpoint.

Next steps: verify caller-owned callbacks stored on foreign receivers and getter
versus argument evaluation order; rebuild clean pinned optimized native artifacts
and replay the unchanged lazy-loader test. The last native evidence remains
WebIDL 17/17 and derived conversions 2/2; lazy-loader 0/1. Full 431-test replay
aborted at missing SnapshotCreator support, without a complete summary. Module
graphs, macro-generated inputs, native host operations, snapshots and matched
V8/QuickJS/Porffor benchmarks remain outstanding. Neither draft is merge-ready.

Compiler draft: https://github.com/loopdive/js2/pull/6468 (stacked base).
Adapter draft: https://github.com/loopdive/v8x/pull/2. Preserve unrelated
lower-contracts.ts documentation, acorn.wasm and untracked user files. Earlier
sections are chronological evidence at their stated revisions, not current claims.

## Ambient host-global failure isolated, 2026-10-04

A Context-owned Deno object is read as null by independently compiled Script
identifier Deno. The checker injects an ambient Deno namespace, so the existing
symbol-less linked lookup is bypassed and the unimplemented-global fallback
manufactures null. A narrow default-off fallback now resolves ambient names
through the Context lexical/object environment after native intrinsics decline.
Three controls now read Deno, Deno.core and Deno.core.loadExtScript correctly.
Calling that foreign method still throws "called value is not a function";
this fourth control is explicitly expected-failure, NOT a completed capability.
The adapter packaging options now provide the already-existing Context call
terminal, but this alone does not fix foreign callable classification.
Fresh unchanged native lazy-loader replay for this new fix is not yet measured.
Full focused suite passes 37/37 under Vitest, comprising 36 positive controls
and one expected failure. TypeScript 7 passes; scoped lint has two pre-existing
noExplicitAny warnings and no errors. The preceding 86-test persistent suite
has not been rerun after this ambient-read change.

## Broader Script packaging continuation, 2026-10-04

Compiler now creates a canonical initializer for function-only/empty completion
Scripts and exports the completion sink to retain its ABI through downstream DCE
even when every execution path is abrupt. Default-off behavior is unchanged by
these guards. Focused reflection/completion controls pass 33/33; persistent Script
controls pass 86/86; TypeScript 7 and scoped lint pass. Default-off byte parity and
the existing 91-test preservation population have not been rerun.

Adapter build-side tooling inventories unresolved Rust calls rather than silently
omitting them; strict literal-only callers still reject unsupported inputs.
First unchanged population: 22 call sites, 14 packaged /6 packaging failures /2
unresolved macro call sites. With the compiler changes, all 16 module-test literal
Scripts package after Binaryen optimization. This candidate run uses uncommitted
compiler edits, not a fresh clean-pin replay. Four conversion literals are also
packaged; unchanged derive_from_struct and derive_from_tuple_struct pass 2/2.
The unchanged lazy-script-not-found test executes but fails 0/1 with TypeError
instead of the required lazy-loading error. Do not infer module conformance from
packaging. Full module graph inputs, macro-generated source/resource bindings,
native lazy-loader operations and snapshot support remain incomplete.

## Fresh unchanged WebIDL result, 2026-10-04

Native compiler-free WebIDL replay now passes **17/17**, 0 ignored and 414
filtered of 431, in 21.79 seconds. Dictionary record conversion is verified fixed.
Compiler c98082082b163165ed6c5ba7f726c24d01ee1ba7; adapter 5c56521;
unchanged Deno 1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44.
Artifacts /private/tmp/deno-reflection-native.Zfl1zI contain a fresh optimized
Context and all five original optimized Script packages. Six Symbol globals were
verified in the actual Context. Full 431-test run terminated with exit 134 at
dynamic_imports_snapshot, unresolved v8__SnapshotCreator__CONSTRUCT. Earlier
tests lack non-WebIDL packages; no full-population summary exists. Adapter handoff records
hashes and the necessary optimized import-subset validation fix. This does not
complete full Deno integration or comparative benchmarking.

## Reflection and shared Symbol checkpoint, 2026-10-04

Compiler: native owning-Script symbol enumeration and descriptors accompany the
existing string-name export. Closed computed well-known Symbol fields participate
in enumeration and hasOwn. Shared Symbol state is now implemented as six native
mutable globals, reserved before defined globals; the adapter previously requested
this option but the compiler silently ignored it. Controls cover fresh symbols,
Symbol.for and Symbol.iterator identity across linked Scripts, descriptors and
getter non-invocation. Focused suite: 31/31 passed; TypeScript 7 passed.

Adapter: native property enumeration routes to the allocation's owning Script,
retains native keys, consults descriptors for filters, and handles canonical array
indices. Matching owners with missing reflection exports fail loudly. Context
bridge exports the same reflection operations. Script packaging now invokes
Binaryen before Wasmtime and records raw/optimized hashes and optimizer version.
Compiler-free adapter cargo check passed. These changes have NOT been replayed
against fresh native Deno artifacts, and packaging optimization is not yet verified
end to end. The old native result remains 16 pass /1 fail /414 filtered of 431.

Resume in this order: rebuild clean pinned Context and five original Scripts;
verify all six Symbol globals really exist; validate optimized import checks;
rebuild unchanged Deno tests and replay WebIDL before claiming the dictionary
record failure fixed. Then run broader conformance and matched benchmarks.
Native property-filter tests, Context exception identity, unpaired UTF-16 keys,
closed-symbol deletion/redefinition and default-off binary parity need additional
coverage. Full integration remains unfinished. The earlier 38/91 preservation
result (53 failures) has not been rerun for this checkpoint. Preserve unrelated
lower-contracts.ts and acorn.wasm edits, and all unrelated untracked files.

Existing compiler and adapter draft PRs are reused, not duplicated. Neither is
merge-ready. Historical measurements below apply only to their stated commits.

## Owning-Script string-name enumeration continuation, 2026-10-04

The remaining native WebIDL record failure has a concrete adapter omission:
`v8__Object__GetOwnPropertyNames` enumerates the Rust wrapper's property vector
without consulting its retained Wasm binding. That vector is empty for Script
allocations, even though native owning-Script property reads work.

The compiler now exposes opt-in `standaloneScriptOwnNamesExport`, ABI
`(externref) -> externref` returning a native array of own string names.
It reuses the finalized `__getOwnPropertyNames` implementation and requires
the native Script getter/ownership/completion mode. No Script wrapper, source
rewrite, JSON transport or interpreter is introduced. The export itself arms
array reflection demand when the source has no reflective call.

The new controls exposed IR alphabetical physical slots leaking into key order.
`IrObjectShape.ownNames` now retains source order independently of slots. Only
the opted-in object registry includes that order in its logical shape key and
records it in the existing `structInsertionOrder` map. Existing shape stamps
distinguish same-field objects with opposite insertion orders. Canonical array
indices are sorted numerically before ordinary strings. Other IR consumers keep
their existing physical layout/hash path when this option is absent.

Verification: getter/enumeration suite 27/27; four execution suites 115/115
including two existing expected failures; TypeScript 7 typecheck and scoped
Biome lint pass. Three default-off samples produce byte-identical binaries
against clean compiler dbe49bf307d6. Source-preservation remains 38 pass /53 fail
out of 91 with identical per-test statuses to the earlier receiver checkpoint;
it is NOT green. The attempted Biome `check` also checked import organization
and its conflicting formatter, and failed; use project Prettier plus Biome lint.

Next: validate and route the owning-Script export in the native adapter, keeping
allocation ownership and same-store native roots. String names alone cannot
implement V8's symbol-aware property API: add symbol and descriptor/filter
handling rather than silently dropping symbols or returning an empty wrapper
list. Broader literal/spread insertion-order fidelity still needs coverage.
The adapter pin and native packages have NOT advanced to this continuation;
unchanged WebIDL remains the last measured 16/17, not a newly fixed result.
Full integration acceptance and comparative benchmarking remain open.

## Final checkpoint and resume handoff, 2026-10-04

Published implementation: compiler `dbe49bf307d635bd5c838ac6b36051597c5aa253`;
adapter `33af9d76e8154954b50944f55408a30685c8cfe9`.
Existing drafts: https://github.com/loopdive/js2/pull/6468 and
https://github.com/loopdive/v8x/pull/2. The compiler PR is stacked on
`codex/4376-deno-callback-construction-20260930`, not main.
Neither draft represents complete Deno integration or is merge-ready.

Explicit Reflect receivers now reach linked Array own/index/custom-prototype
accessors and native iterator prototype accessors. The old two-argument vec
reader ABI remains unchanged; the three-argument reader is default-off.
Focused getter controls pass 21/21. Four execution suites pass 111/111,
including two existing expected failures. Source-preservation controls are NOT
green: 38 pass and 53 fail out of 91 on both baseline `73c8c2369` and candidate,
with identical per-test statuses. Do not rebaseline those failures silently.
Build-side adapter controls pass 15/15; compiler typecheck and commit gates pass.

A fresh clean pinned full Context uses the implementation commits above and
Deno `1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`.
Raw Wasm: 2,710,850 bytes, SHA-256
`e0cd4196f7e5f49e0edc01503d738c08ada13da337bd897f670a3a6a28862e1f`.
Binaryen 125 optimized Context: 2,009,537 bytes, SHA-256
`b1ccafb7b2cc226f1b7134bf7cd7845e10cf3e25acc62bf1b43f104ef245f969`.
Wasmtime 47.0.3 precompilation passes 1/1 in 207.48 seconds; native SHA-256
`ee1de8727239277aa14d0aa45858c35610333a43166951364af3a11aef68e418`.
These are artifact/build measurements, not runtime RSS or throughput.
The five original WebIDL Script packages are precompiled but not Binaryen
optimized; do not describe all artifacts as wasm-opt optimized.

Fresh unchanged native WebIDL replay: **16 pass, 1 fail, 0 ignored, 414 filtered
out of 431**, 21.13 seconds. Dictionary array conversion now returns the correct
`b: [65535]`. The remaining failure is object-record conversion:
`f: {}` instead of `f: {"foo": 1}`. Trace native property enumeration/ownership
and record conversion next; this is a failure location, not a proven root cause.
Do not change Deno tests or substitute a source-specific workaround.

Local artifacts and provenance:
`/private/tmp/deno-array-native-build.lcT9ej`.
Compiler-free unchanged Deno test checkout:
`/private/tmp/deno-upstream-conformance.H6HA4g/deno`.
Replay from that checkout:

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-array-native-build.lcT9ej/deno-core.cwasm V8X_JS2WASM_AOT_SCRIPT_DIR=/private/tmp/deno-array-native-build.lcT9ej/webidl-scripts target/debug/deps/deno_core-87206ac56a2fccad webidl::tests:: --nocapture --test-threads=1
```

Next: repair record conversion; run the full unchanged 431-test population;
complete native host capabilities, BigInt/UTF-16 transport, public Program
completion and AOT routing; factor shared code; then measure matched footprint
and performance against V8, QuickJS and Porffor. Full-population timeouts have
not been approved; never kill a test without approval. Preserve unrelated
workspace dirt. Typst rendering and fresh comparative benchmarks are unverified.

Required for complete Deno integration, not an alternative acceptance bar.
Sources known at packaging time must execute AOT without an interpreter.

## Continuation: typed primitive constants and global callables, 2026-10-04

Top-level inferred number/boolean `const` bindings now retain typed scalar
slots and box/unbox only at the Context lexical operation. Provider reads still
check TDZ first. Mutable typed bindings remain refused. Reference-typed consts
also remain refused: a broad experiment passed array identity but returned the
wrong answer after a later Script changed an element from number to string.
Const protects the binding, not element/field type proofs. Do not re-admit these
without sound shared representation and mutation handling.

Shared Script function writes through globalThis or top-level this now select
the existing native AOT callable carrier. This fixes a foreign function-property
call that previously returned without running its body. Selection is based on
direct callable producer syntax/name in shared mode, not just an inferred
signature; existing carrier aliases pass through. No broad runtime-eval flag,
interpreter or source rewrite is introduced.

Focused result: 86/86 reported, comprising 84 ordinary successes and the two
existing expected failures. Seven new ordinary controls cover numeric and
boolean constants, TDZ, unsafe array refusal, retained/foreign callable reads,
top-level-this installation, aliases and thrown identity. The five-file total
is 163: 158 ordinary successes, two expected failures and the same three
recorded ordinary TDZ failures (55 versus 63 and two call-count mismatches).
TypeScript 7, lint, formatting, coercion and oracle checks pass; budgets passed
before the small global-callable selection addition and will run at commit.

The native fixture now consists of one Context and eight independent Scripts.
Final raw controls and all nine packaging invocations pass. Compiler-free replay
passes 1/1 (36 filtered, 0.07 seconds), including inferred numeric const rejection
and a boolean-constant reader called through a foreign global alias. Runtime
compilation and runtime-eval provider instantiation counts remain zero. Local
fixtures: `/private/tmp/deno-script-scalars.6Tj5CN`. These are local trusted test
artifacts, not a rebuilt full Deno Context or unchanged Deno conformance proof.

Next: mutable and reference-typed binding planning, public Script completion
and artifact lookup, then a full Context rebuild and unchanged Deno tests.
Full integration, shared-library factoring and fresh comparative performance
measurements remain open. Both PRs stay draft; preserve user dirt.

## Wrap-up: native Context wiring, 2026-10-04

Compiler implementation remains at `cafc1769ccb45074064c5ca88f0262aae1388aa4`.
Draft compiler PR: https://github.com/loopdive/js2/pull/6468, targeting the
existing callback-construction branch, not main. Adapter changes are published
on `codex/4376-deno-realm-bootstrap` in draft PR
https://github.com/loopdive/v8x/pull/2. Do not open duplicate PRs.

The native linker now accepts `__v8x_context_lexical`. Runtime and namespace
Context builders export the existing compiler lexical provider, and the
production source graph records that provider in provenance. The runtime
compiler pin advances to `cafc1769ccb4`; the historical POC pin is unchanged.

One Context and six independent Script artifacts pass raw Node controls and
all seven Wasmtime packaging invocations. A separately built compiler-free
native test passes 1/1 (36 other tests filtered out, 0.07 seconds). It verifies
persistent lexical reads/writes, cross-Script object conversion, exact wide
BigInt postfix values, declaration preflight before effects, const-write
rejection, and isolation between two Contexts. The native test asserts zero
runtime compilations and zero runtime-eval provider instantiations. The fixture
contains `any` annotations and does not prove unchanged Deno Script semantics.
Adapter tool tests pass 9/9; both packaging and deployment Cargo profiles build.
Documentation rendering is unverified: Typst is absent at the configured path.

Adapter handoff and reproduction commands:
`tools/js2wasm/SCRIPT-ENVIRONMENT-HANDOFF.md`. Local native fixtures:
`/private/tmp/deno-script-native.X4IpnK`, with sources/hashes in `test-inputs.json`.
Adapter checkout: `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`.
The packaging test is not ignored; `--ignored` accidentally selects zero tests.
Only the fixture-dependent deployment test needs `--ignored`.

Resume with independent artifacts on the public Script path and actual
completion values, then typed lexical bindings and foreign accessors/callable
transport. Rebuild the full Deno Context on the new compiler pin and rerun
unchanged Deno tests. No new full-core artifact, conformance gain, shared-library
factoring, or fresh performance measurement is credited by this checkpoint.
Integration remains incomplete and both PRs remain draft. Preserve all user dirt.

## Latest continuation: native foreign conversion, 2026-10-04

Follow-up to published handoff `25f8fb58922` on the same branch and draft PR
https://github.com/loopdive/js2/pull/6468. The prior ordinary object/valueOf
failure is now fixed; the wrap-up section below describes its historical state.

Three independent causes were measured and repaired:

1. Open-object callable properties in shared Script mode were not wrapped in
   the existing canonical native AOT carrier. Wrapping is now enabled narrowly
   at object construction, without enabling the broad runtime-eval flag.
2. A closure-free consuming Script emitted `__call_accessor_get` as a constant
   undefined fallback because no local closure arity dispatcher existed. Its
   getter/conversion path now dispatches the foreign carrier directly, with the
   original receiver. Setter drivers remain on their existing void-result path;
   general foreign setter transport still needs separate verification.
3. A BigInt closure return was narrowed to i64, and the call-result envelope
   also decoded it through an i64 payload. Shared-Script closure signature/body
   planning now preserves the native reference carrier; wide values use the
   envelope's reference slot. Narrow values retain the scalar envelope path.

Intermediate native controls separated the failures: foreign property lookup
reported a callable and an explicit method call incremented score once, while
conversion did not. Adding the carrier dispatch made score equal one but the
exact-value assertion still failed. After the return/envelope fixes, the exact
original probe reports `scoreControl: 41, objectControl: 1, score: 1, exact: 1`.
Clean `fbe1958bd79`, with the same native owner/independent-Script harness and
source, reports `41, 1, 0, 0`. No JS semantic mock or object copy is involved.

The five-file regression reports 156 tests: 151 ordinary successes, two existing
expected failures and the same three ordinary TDZ baseline failures. The focused
file reports 79/79, including the two expected failures. New ordinary controls
exercise numeric function/method/arrow conversion, wide positive/negative and
narrow BigInt returns, receiver identity, and thrown-value identity with zero
lexical writes. TypeScript 7 and main-relative LOC/function budgets pass.
Final focused rerun after restricting the value-returning guard to getter
drivers again reports 79/79. Oracle and coercion checks pass. Dead-export exits
zero but its graph remains OPEN and runtime retirement/deletion is NOT CERTIFIED
because the two previously recorded nonliteral dynamic imports remain unknown.

Next: native Context provider packaging and adapter imports, then a clean
artifact rebuild and unchanged Deno conformance. General Script semantics,
foreign accessors/callable aliases and arbitrary arithmetic still require work.
The shared callable helper is reused within a module, not yet factored into an
external shared library. No new native deno_core artifact or full integration
completion is credited by this compiler-only change. Preserve all user dirt.

## Earlier wrap-up handoff: 2026-10-04

Published implementation: `921471e79e3e8d898650cf9aceacbb356bf5325a` on
`codex/4376-deno-lexical-checkpoint-20261004`. Existing checkpoint PR:
https://github.com/loopdive/js2/pull/6468, targeting
`codex/4376-deno-callback-construction-20260930`, not main. It remains draft
because the ordinary conversion control fails and native packaging is unwired.
Do not open a duplicate PR or claim full Deno integration is complete.

Last measured five-file regression: 147 tests, 141 ordinary successes, two
expected failures and four ordinary failures. The focused persistent Script
file has 70 tests: 67 ordinary successes, two expected failures and one ordinary
failure. These are recorded results from the implementation checkpoint, not a
fresh wrap-up rerun. TypeScript 7 and the recorded formatting, budget, coercion
and oracle checks passed. No newer native deno_core artifact was built.

Resume with the foreign object conversion failure: a prior independently
compiled Script stores an object whose `valueOf` increments `globalThis.score`
and returns `18446744073709551616n`; the next Script performs `retained++`.
The method is not called. A native owner/Script probe gives
`scoreControl: 41, objectControl: 1, score: 0, exact: 0` both on clean
`fbe1958bd79` and implementation `921471e79e3`, so this predates the exact
BigInt update helper. Keep the ordinary failing test visible.

Inspect `objectLiteralHasCallableProperty` in `src/codegen/literals.ts` and
the canonical AOT callable bridge in `src/codegen/runtime-eval-callable.ts`.
Callable-bearing object promotion currently depends on
`runtimeEvalCallableBoundaryEnabled`; foreign nominal object types are not
known to the consumer's local conversion dispatch. This is a working causal
hypothesis, not a proven fix. Audit all readers before changing that shared
flag. Separate method visibility from wide function-return representation with
numeric and wide-return probes, while retaining the original failing control.
Preserve object/callable identity and receiver behavior; do not copy the
object into a new carrier or substitute an interpreter for known AOT source.

After conversion is fixed, wire the lexical provider into the native Context
artifact builder and adapter imports, rebuild clean artifacts, and rerun
unchanged Deno tests. General Script semantics and conformance remain open as
detailed below. Preserve unrelated tracked edits and untracked files. This
wrap-up adds documentation only, with no new compiler or adapter changes.

## Measured boundary

At compiler `83442252a6d`, a provider exports its realm, allocation-owner
predicate, Reflect.get and exception tag. Independently compiled untouched
Scripts use `scriptGoal: true` and import that provider. Explicit
`globalThis.published=42` is observed as 42 by the provider. A fresh provider
after `var published=41; published=42` instead observes no value 42. This
rules out missing realm linkage as the var failure's explanation. The live
var value is still held in a private Wasm global. Lexical declarations also
do not persist into later independently compiled Scripts.

At that initial checkpoint, the persistent-environment regression file had
one positive property-write control and two explicitly expected failures.
It now has 12 ordinary controls and those two expected failures. Remove
`.fails` only when each real requirement is implemented.

## Resume checkpoint: 2026-10-01

Compiler branch: `codex/4376-deno-callback-construction-20260930`.
Open, non-draft PR: https://github.com/loopdive/js2/pull/6341.
Implementation tip: `96c4d6f833a2473317a7b7b6fb8b86fccb98aec6`.
The signed merge `ec1375e79d8` includes main
`e303c5c7946e92d66d89b0a18e2632905b1a0dde`.

The current turn inspected lexical implementation sites but made no lexical
implementation changes. No provider ABI has been selected or wired. The next
work must implement canonical cells and declaration preflight, not widen the
existing runtime-eval map into a substitute for persistent Script semantics.

Relevant inspected seams:

- `declarations.ts`: declaration preflight must precede private var seeds,
  function seeds and `emitScriptGlobalVarBindings`, before user code runs.
- `statements/variables.ts` and `statements/tdz.ts`: initialization must be
  distinct from assignment. Rewriting every global.set as initialization, or
  inferring initialization from a private flag, permits illegal TDZ writes.
- `expressions/identifiers.ts`: local and captured shadows precede global
  lookup. A later Script's unresolved name must consult the declarative record
  without exposing let/const as object properties.
- `expressions/unresolvable-assign.ts`: resolve the target before evaluating
  the RHS; writes must retain that Reference. Include increments, compound
  assignment, destructuring and IR stores, not only simple assignment.
- `global-environment.ts`: its runtime-eval lexical map lacks the required
  shared declaration/TDZ/const protocol and must not be credited as that record.

Preflight must validate the entire declaration manifest before creating any
new cells. Checking and creating one declaration at a time leaves partial
bindings behind if a later declaration conflicts. Preserve module separation,
typed computation specialization, shared thrown-value identity and AOT-only
deployment for known sources.

Latest compiler verification: TypeScript 7 passed; eight regression files
reported 73 tests, comprising 71 ordinary passes and two expected failures.
The 20 direct iterator controls all pass. Pre-push checks also passed 18/18
numeric-local tests, lint, formatting and issue integrity. Size checks were
additionally run against the merged main SHA, with allowances for existing
branch changes documented in the issue. Dead-export command exits zero but
still explicitly refuses complete runtime-retirement certification because
two dynamic-import targets remain open; do not report that certification.

Last verified native Deno artifact is older than the current compiler:
`/private/tmp/deno-reflective-iterator-build.zaaiw7`, compiler
`b37d12382a9a2632130c8b9b2088a1f14470a0fa`, adapter
`2a1ca8426b59596df4d3ad8111aa08b5273c8260`. Compiler-free adapter replay was
31/31 runnable tests, six ignored. Unchanged WebIDL was 13/17, with four
unknown classic Scripts refused before assertions. Do not credit these
artifacts with the latest var or keys/entries changes; rebuild clean artifacts
and rerun unchanged Deno tests after the persistent Script path is wired.

Adapter checkout: `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`, branch
`codex/4376-deno-realm-bootstrap`, PR https://github.com/loopdive/v8x/pull/2.
That PR remains draft because general integration is incomplete.
The previously hung conformance run is not completed evidence. Revalidate its
process before acting; do not kill or restart it without user approval.

Preserved unrelated user changes: `src/ir/backend/lower-contracts.ts`,
`website/public/acorn/acorn.wasm` and all existing untracked files/worktrees.
No cleanup, pruning or Deno source/test edits were performed.

Focused test invocation:

```sh
VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
node node_modules/vitest/vitest.mjs run \
  tests/issue-4376-persistent-script-environment.test.ts \
  tests/issue-4376-live-array-iterator.test.ts \
  --poolOptions.forks.execArgv=--experimental-wasm-exnref \
  --poolOptions.forks.execArgv=--max-old-space-size=4096
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

## 2026-10-01 implementation checkpoint

`standaloneScriptVarBindings` adds experimental single-source Script var
transport for dynamic externref bindings. Native getter/setter helpers use
the shared Context object record. The finalizer rewrites all emitted loads
and stores of those exact GlobalDef objects, including callback/IR bodies.
It resolves object identity after late string-global shifts and before DCE.
This uses the existing ownership-aware property reader and canonical realm,
not a Rust interpreter or end-of-script value copy.

Both private undefined-seeding paths must decline for these bindings, so a
later initializer-free var declaration preserves the prior value. Private
dead-top-level-binding elision is disabled for this explicit mode: another
Script can observe declarations that this source never reads. Default-mode
binary output remains unchanged in the control.

Private typed slots and flattened module graphs are explicitly refused.
Their existing type proofs and once-only graph initialization do not establish
Script semantics. This is not a full Script backend, is not enabled by the
Deno artifact builder, and does not close the normal inferred-number var or
lexical expected failures. Typed-boundary planning, persistent declarative
bindings, global declaration validation and completion values remain required.

The 2026-10-01 follow-up closes the separate reflective keys/entries snapshot
gap: all three Array.prototype factories now retain their live receiver.
Iterator next, rest draining and prototype dispatch recognize the two new
iteration kinds. Direct controls pass 20/20; eight regression files report
71 ordinary successes and two expected Script failures. No new native Deno
artifact was built for that change. It does not alter the lexical plan below.

## 2026-10-04 lexical checkpoint and resume instructions

Publish this slice on `codex/4376-deno-lexical-checkpoint-20261004`, based on
local `9c9586301f5`. The previous remote branch advanced to `60f99e83450`
with a main merge (270 commits ahead), so do not force-push over it. The follow-up
PR targets that existing integration branch and must absorb its newer main
before landing. Baseline comparisons below deliberately use the local base.

This checkpoint adds an experimental `standaloneScriptLexicalImport` option,
requiring shared Script var mode. A Context-owned, AOT-native provider is in
`examples/v8x-js2wasm-spike/script-lexical-provider.ts`. Its private cells retain
value, initialization state and const mutability without exposing properties.
The operation ABI is `(externref, f64, externref) -> externref`, with operation
numbers documented in `src/codegen/shared-script-lexical-access.ts`.

Script entry checks the complete declaration manifest before creating cells
or executing initializers. Exact own lexical global loads/stores use native
read/write/initialize helpers. Declaration initialization is explicit metadata
through AST-to-IR lowering and Wasm emission, not guessed from TDZ flags.
Symbol-less reads in a later independently compiled Script consult the Context
record before falling back to global lookup. The option remains off by default.

Verification on the uncommitted checkpoint: TypeScript 7 exited successfully;
the persistent Script environment file reports 20/20 tests, comprising 18
ordinary successes and two existing expected failures for the default API.
These focused controls cover cross-Script reads, Context isolation, declaration
conflicts before effects, abrupt initialization and const retention. The const
catch assertion and abrupt-initializer attribution still need stronger native
error/side-effect controls; do not infer complete exception conformance.

The five-file regression run reports 99/102 successes, including those two
expected failures, with three failures in the existing module lexical assignment
TDZ file. A clean archive of committed baseline `9c9586301f5`, using the same
Vitest fork/exnref harness, reproduces exactly those three failures (43/46).
They are not newly introduced by this checkpoint. TypeScript 7, formatting,
source/function budgets against merged main `e303c5c7946`, coercion and oracle
ratchets pass. The dead-export command exits zero but explicitly reports an open
graph and incomplete dynamic-import evidence: retirement is NOT certified.

This is NOT full persistent Script semantics or completed Deno integration.
Later-Script lexical writes, ambient builtin shadowing, module consumers,
function descriptor/identity rules, classes, lexical destructuring, typed-slot
planning, re-execution and completion values remain unfinished. Unsupported
classes/destructuring/typed lexical storage are refused explicitly. The native
provider has not been wired into the Deno artifact builder or adapter, and no
fresh deno_core binary/population was built for this checkpoint.

Resume with later-Script assignment/reference semantics and stronger controls,
then wire the native Context provider into artifact packaging. Re-run unchanged
WebIDL and the full deno_core population only after general Script execution is
available. Keep the full integration goal open and preserve unrelated worktree
changes; do not stage `lower-contracts.ts`, Acorn binaries or user scratch files.

## Representation and ownership

### 2026-10-04 continuation: exact native BigInt updates

The former wide/overflow TypeError refusals are replaced with native +/-1
arithmetic over canonical BigInt carriers. The builder lives in
`src/runtime/wasmgc/values/bigint-carrier-update.ts`; the codegen registrar
reuses one `__bigint_carrier_update(externref, i32) -> externref` per module.
Only the internal deltas +1 and -1 are admitted by the caller. Narrow overflow
promotes; wide carry/borrow uses copied limbs, trims the result and demotes
back to the narrow carrier when it fits. Postfix returns the primitive old
carrier, never a mutated magnitude or the original pre-conversion object.
No interpreter, compiler-at-runtime or Deno source modification is added.

Same-Script top-level lexical updates now use the Context cell too, selected
by exact source declaration identity instead of its name. Block and function
shadows keep their private storage. The own-Script control failed before that
routing change; it and the shadow control now pass. TDZ still throws before
writing; const PutValue retains the old value after exact computation.

The two replacement ordinary tests both threw before implementation and now
verify actual wide/postfix and signed-boundary/prefix results. A 24-case
runtime matrix passes for zero/sign changes, both signed-i64 boundaries and
positive/negative 192-bit carry/borrow. Later independently compiled Scripts
inspect both String results and native strict equality, including retained old
values and canonical wide-to-narrow transitions. The intermediate focused run
was 66/66 (64 ordinary successes plus two retained expected failures).

Final five-file regression run: 143/147 reported successes, comprising 141
ordinary successes and two existing expected failures. The persistent Script
file is 69/70 (67 ordinary, two expected). Its one ordinary failure is the new
cross-Script object/valueOf conversion control: the method isn't called.
The other three failures are the previously documented module-assignment TDZ
baseline failures. Selected files: persistent-script-environment, script-result,
module-lexical-assignment-tdz, realm-structural-carrier and live-array-iterator.
Do not claim a green final suite or mark the new conversion control expected.

Native owner/independent-Script A/B, same tsx/exnref harness and exact source:
clean `fbe1958bd79` archive and candidate both report `scoreControl: 41,
objectControl: 1, score: 0, exact: 0`. The positive controls prove the shared
property and object are present; the failing valueOf conversion predates this
update implementation. Runtime ToPrimitive's foreign method visibility and
callable carrier need investigation, as does wide return-value storage. Do not
copy a nominal object into another object as a substitute for preserving identity,
or enable the broad runtime-eval boundary flag without auditing its consumers.

TypeScript 7, formatting, main-relative LOC/function budgets (base
`60f99e83450`), coercion and oracle ratchets pass. The dead-export command exits
zero but still reports open dynamic-import evidence, not certified retirement.
No new native Deno artifact or full unchanged deno_core run is credited.
Remaining goal includes foreign conversion/callable transport, other exact
wide arithmetic, destructuring/with/eval/class/function/Script completion
semantics, native lexical-provider packaging and full Deno verification.

### 2026-10-04 continuation: exact first wide initializer

After checkpoint `32708a6a99c`, the wide initializer defect is fixed at
`bigint-wide.ts::tryFoldBigIntConstant`. The linked Script's first BigInt
constant reached this routine before the native union carrier types existed.
`ensureLateImport(__box_bigint)` alone is insufficient: that helper is outside
the late-import union name set and may already have a pending import. Use the
existing idempotent `addUnionImports` and flush index shifts before emitting the
exact reference carrier. No IR demotion, interpreter or Deno source edit is added.

Same native owner/Script probe: baseline `b17fdc53504` gives `exact: 0, zero: 1`;
candidate gives `exact: 1, zero: 0`. Focused tests now report 41/41, comprising
39 ordinary successes and the two existing expected failures. Five added
ordinary controls cover signed-i64 boundaries, positive/negative 2^64 and a
folded expression, with values inspected by a later independent Script.
The original wide refusal test now reaches and verifies its guard, but that
guard still rejects valid updates rather than implementing exact arithmetic.

The three-file BigInt regression run before the five extra controls reported
61/62, including two expected failures. The one failure is
`issue-6656-bigint-wide-carrier.test.ts::narrowedString`. A separate native
host-free compileMulti probe using that file's exact source reports
`controls: 1, narrowedString: 0, dynamicString: 1` on both clean baseline
`b17fdc53504` and candidate. This is a distinct existing narrow String route
defect, not a new failure or a passing suite. No fresh five-file/Deno artifact
run is credited. Exact wide arithmetic and native packaging still remain.

### 2026-10-04 handoff: captured read-modify-write references

Checkpoint adds cross-Script compound and logical assignments and prefix/postfix
updates through one captured Context Reference. GetValue precedes RHS effects;
the RHS runs once; logical assignments retain short-circuit behavior; const
writes throw after required RHS effects. Numeric strings are converted for
updates, while small BigInts retain their brand and prefix/postfix results.
`persistent-script-rmw.ts` contains the new routes. Synthetic compound RHS
identifiers retain the original node so the existing emitter sees BigInt types;
strict comparison narrowly recognizes potentially BigInt Script updates.

TypeScript 7 passes. Focused tests report 35/36: 33 ordinary successes, two
retained expected failures, and one ordinary wide-BigInt initialization failure.
The five-file run reports 114/118 successes (112 ordinary, two expected), with
that failure plus the same three previously documented baseline failures.
Do not relabel the new wide control as expected or claim these files are green.

A native standalone probe compiled the same lexical owner and independent
Script on clean archive `b17fdc53504` and the current candidate, using the same
tsx/exnref harness. Both report `exact: 0, zero: 1` for initialization with
18446744073709551616n before any update. This establishes an existing literal
representation defect, not correct wide update behavior. Update emission
explicitly refuses wide carriers and narrow overflow with TypeError until
exact native arithmetic exists. The wide test fails before reaching its guard.

Main-relative LOC/function budgets (base `60f99e83450`), coercion and oracle
ratchets pass. Dead-export exits zero but reports open dynamic-import evidence;
runtime retirement is not certified. No native Deno artifact was rebuilt.

Resume by fixing wide initializer representation at its IR/boxing seam, then
implement exact wide update/arithmetic and test consumers of BigInt update
results beyond strict equality. Also still required: destructuring writes,
with/eval activation precedence, classes and typed lexical planning, function
declaration/re-execution/completion semantics, provider wiring into native
Deno packaging and unchanged full deno_core verification. PR #6468 remains a
draft checkpoint targeting the existing integration branch, not main. Preserve
unrelated lower-contracts and Acorn binary edits and other user dirt.

### 2026-10-04 continuation: merged main and cross-Script assignment

Merge `ae009e6597a` incorporates the target integration branch at `60f99e83450`
without conflicts or changes to unrelated user dirt. TypeScript 7 passes after
the merge. Later-Script simple assignment now captures the lexical hit before
the RHS and writes the existing native cell after evaluating the RHS once.
The global miss captures its object-record Reference before the RHS and keeps
strict ReferenceError versus sloppy property-write behavior.

Two other seams had to change together: opt-in unresolved reads must not take
the earlier sloppy-implicit-global shortcut, and top-level strict identifier
assignments must be collected even without private module storage. Before
these changes the new controls either retained 41 or wrote 42 and then threw
on a wrongly object-routed read. Both now produce 42 without leaking a property.
The focused file reports 24/24, comprising 22 ordinary successes and the two
existing expected failures. Additional controls verify const TypeError after
RHS effects and strict/sloppy global misses, using native error-name inspection.

The five-file follow-up reports 103/106 successes, including the two expected
failures, with the same three baseline failures documented above. Main-relative
LOC/function budgets (base `60f99e83450`), coercion and oracle checks pass; the
dead-export command still does not certify retirement. No native Deno artifact
is credited by this compiler-only run.

The new helper is `src/codegen/expressions/persistent-script-lexical-assign.ts`.
Compound/increment/destructuring writes and eval activation precedence still
need explicit controls and implementation. Do not infer them from simple `=`.
Next packaging seam: the adapter's sidecar source and classic-Script dispatch
remain the source allowlist described above; the graph compiler is a Module
driver and must not be substituted for independent Script evaluation.

Each Context needs one GlobalEnvironmentRecord with an object record and a
persistent declarative record. Keep Module environment records separate and
do not expose lexical declarations as globalThis properties.

Use canonical mutable lexical cells with binding kind, initialization/TDZ
state and mutability. Object-record var/function bindings must use the actual
property value and attributes. Private Wasm globals cannot remain a second
source of truth. End-of-script mirroring is insufficient: callbacks and
getters can observe writes before the next statement or abrupt completion.

Each compiled Script needs a declaration manifest and execution entrypoint.
Validate all declarations against the Context before any initializer or user
statement. Re-executing source means Script evaluation again, not Module's
once-only initialization. Reject lexical conflicts before effects. A var
redeclaration preserves the existing value until its initializer executes.
Validate restricted global properties and extensibility from actual state.

## Readers and writers that must change together

- `codegen/index.ts` recordSourceGlobalEnvironment currently records names
  for one source/graph. Plan exact declaration identity and distinguish
  persistent Script bindings from module, local and captured bindings.
- `global-var-bindings.ts` seeds undefined while deliberately keeping the
  live value in a private Wasm global. Seeding alone cannot fix persistence.
- `global-function-bindings.ts` can seed a different closure from identifier
  reads. Initialize the same canonical function value for both routes.
- `expressions/identifiers.ts` module/capture routes precede global lookup.
  Select canonical Context cells/properties using exact declaration identity.
- `statements/variables.ts`, `expressions/assignment.ts`, increment,
  destructuring and IR global loads/stores must all use the same binding.
  Extending the narrow toString/valueOf writeback misses other writes.
- `global-environment.ts`, `property-access.ts` and assignment's realm-object
  interception must agree with reflection on values and descriptor semantics.

Publish the shared binding route in source/Program ABI planning before sealing
IR/body ABI. Adding new closures/types in a post-seal seed is not safe. Retain
TypeScript information for computation specialization while shared bindings
preserve arbitrary JS values, callable identity and foreign realm values.

## Completion and exceptions

### Incomplete completion checkpoint (2026-10-04)

Latest follow-up: **36/36 ordinary completion controls pass**. The apparent
implicit-return defect was a sink bug, not a function signature bug: direct
lowering erased void call values, leaving the preceding completion in place.
Completion-observable expression statements now request externref results,
so a void call supplies canonical undefined. They also retain the actual typeof
expression instead of using the side-effect-only operand shortcut. Added controls
cover both implicit and explicit void returns and exact typeof text.
TypeScript 7 passes; persistent Script plus existing Script result regressions
report 89/89, including two existing expected failures.

The adapter continuation adds a retained Context completion sink, reset and
rooted-handle getter, plus a private native Script instantiation method.
One Context and eleven independently compiled Scripts pass the Node/Wasm
fixture before native packaging. Completion uses the actual production value
bridge, not a substitute JSON representation. Foreign Script undefined
singletons are normalized to root handle zero. Native replay and public
source-bound Script dispatch must still be verified; no full Deno rebuild is
credited yet. See the adapter handoff for the final native replay evidence.

The previous 33/34 result and implicit-return hypothesis below are historical;
the focused failure is now fixed without changing callable signatures.

Follow-up after `7e0bf9e4965`: completion-observable Scripts now retain pure
top-level expression statements. A compiler-owned native undefined provider
uses the existing `emitUndefined` representation and is registered before IR
preparation. Scalar completion values use semantic number/boolean boxing, not
`extern.convert_any` on numeric operands. Direct break/continue in finally
stops lowering before the normal-completion restore.

The original 20 controls now pass. The expanded matrix has 34 tests; the
unannotated `function nested(){99;} nested();` control remains an ordinary
failure because it yields a Number rather than JavaScript undefined. Investigate
the actual source callable signature/implicit return, not a source matcher or
a special-case replacement in the completion sink. The last completed 31-test
run was 30 passes/1 failure; the final expanded result is recorded in the issue.
The separate persistent Script suite remains 86/86, including its two existing
expected failures. TypeScript 7 passes. Native adapter wiring and unchanged
full Deno conformance are still not credited by this compiler-only follow-up.

The historical failure counts and resume list below describe the first
checkpoint; steps 1 and 2 are now implemented and original controls pass.
General implicit-return semantics, remaining abrupt shapes, pure Program
configuration and native Context/public Script wiring still need work.

The branch now contains an opt-in `standaloneScriptCompletionImport` with
ABI `(externref) -> void`. The initializer remains `() -> void`; its normal
completion is published to a Context-owned sink. Source stays unwrapped,
reference identity stays native, and no interpreter or JSON transport is added.
Direct lowering reuses the existing completion register. Prepared IR tracks
an externref slot, resets statement completion and restores normal finally
completion. Chunked initialization is disabled for this option until completion
can be threaded between helpers. This is unfinished code, not a working public
Script result API. The option is off by default.

Fresh checkpoint verification: `tests/issue-4376-native-script-completion.test.ts`
has **5 ordinary passes and 15 ordinary failures out of 20**. Do not skip or
convert these failures to expected failures. Six bare-literal cases lose their
result because top-level pure expression collection still discards them. Nine
cases fail compilation because compatibility IR integration cannot materialize
the `js.closure.undefined` callable used to initialize/reset completion.
TypeScript 7 passed during implementation. No new native adapter or full Deno
artifact is credited by this checkpoint. Earlier native fixture results refer
to compiler `ce9b93df356` and adapter `0d8546557c9`, not this completion code.

Resume in this order:

1. Retain pure top-level ExpressionStatements only when Script completion is
   observable. Preserve existing default behavior and Module semantics.
2. Provide canonical native undefined to the compatibility IR completion path.
   Reuse an existing correct provider/representation if available; do not
   substitute null or a numeric sentinel for an externref undefined value.
3. Rerun the 20 ordinary controls with Wasm exception support, then cover
   repeated execution, nested functions, break/continue and abrupt finally.
4. Wire or explicitly reject completion in the pure source Program producer
   (`src/ir/program-source.ts`), which is not yet configured for this option.
5. Add the Context completion sink to native v8x imports and root returned
   values using its existing realm-value bridge. Public Script dispatch still
   needs exact-source-bound independent AOT artifacts; do not add example
   matching, source wrappers or JSON copying.
6. Repackage and run compiler-free controls, then rebuild the full Context and
   rerun unchanged WebIDL and deno_core tests before claiming integration.

Reproduce the checkpoint test:

```sh
pnpm exec vitest run tests/issue-4376-native-script-completion.test.ts \
  --poolOptions.forks.execArgv=--experimental-wasm-exnref \
  --poolOptions.forks.execArgv=--max-old-space-size=4096
```

Existing draft PR: https://github.com/loopdive/js2/pull/6468, targeting
`codex/4376-deno-callback-construction-20260930`, not main. Companion adapter
draft: https://github.com/loopdive/v8x/pull/2. Both remain unready to merge.

Keep source unwrapped. Function wrappers change declarations, top-level this,
return grammar and scope. Indirect eval's lexical lifetime is not persistent
Script scope. Neither scriptGoal nor entryScriptGoal provides this feature.

Reuse statement completion rules with an explicit normal result and a separate
exception path carrying the original realm value. Preserve UpdateEmpty,
loop/if/try resets and normal-finally restoration. Do not derive the result
from source text. Pure expression collection and IR discarded expressions must
retain values when completion is observable. Chunked init must thread the
completion across helpers rather than lose it in helper-local registers.

## Verification and packaging

Test independent Scripts in one Context, two Contexts and source executed
twice. Cover var/function/let/const, closures reading/writing between Scripts,
globalThis reflection, initializer-free var redeclaration, lexical conflicts
before effects, TDZ after abrupt initialization, const writes, restricted and
non-extensible properties, descriptors/deletion, strict/sloppy unresolved
references, thrown identity and statement completion/finally. Module controls
must retain private bindings and once-only initialization.

Package known sources AOT with declaration metadata, source hashes, Script
goal and ABI/config identity. Deploy without compiler/interpreter features.
Then rerun unchanged WebIDL (13/17 currently; four scripts rejected before
assertions) and the full unchanged deno_core population. These boundary tests
alone do not prove full integration.

## Wrap-up: native completion and package lookup (2026-10-04)

Compiler checkpoint `3d4c1dfdaf61f101cb07c7139b5a3ed65052d520` passes
36/36 ordinary completion controls. Persistent Script and older result controls
pass 89/89 including two existing expected failures. Earlier failing completion
counts above are historical, not current. Pure source Program completion remains
unconfigured, and these controls do not establish full Deno integration.

The adapter continuation factors its verified native artifact loader, adds an
exact-source/specifier Script digest and a proposed AOT package-directory lookup,
and separates native JS-thrown handles from Wasmtime infrastructure traps.
`run_aot_script` is not yet called by public `v8__Script__Run`; its dead-code
warnings are expected at this unfinished checkpoint. There is no Script package
writer or complete Script-goal/ABI validation, and thrown-value preservation
has not yet been independently tested. Do not infer public integration from the
private fixture.

Fresh compiler-free adapter replay passes 1/1 (36 filtered, 0.11 seconds) using
the twelve existing trusted artifacts at
`/private/tmp/deno-script-completion.8HrA0L`. Its ordinary suite passes 30/37
with seven explicitly ignored and zero failures; runtime options pass 10/10.
The adapter feature profile builds after using Wasmtime's
`scope.as_context_mut().take_pending_exception()` API. No full Context rebuild,
unchanged Deno conformance gain or new performance measurement is credited.

Resume from `tools/js2wasm/SCRIPT-ENVIRONMENT-HANDOFF.md` in adapter checkout
`/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`. Complete trusted packaging
and mismatch controls, public exact-source dispatch and realm-value adoption,
then compiler pure Program completion and a full unchanged Deno test run.
Existing draft PRs remain https://github.com/loopdive/js2/pull/6468 and
https://github.com/loopdive/v8x/pull/2. The compiler PR targets
`codex/4376-deno-callback-construction-20260930`, not main. Preserve unrelated
compiler worktree edits and adapter `.tmp/` content.

Latest adapter continuation: the previously unwired public path now executes
source/resource-bound AOT Script packages through public `Script::Run` and
adopts results/thrown values through the Context's existing realm bridge.
The public API fixture passes 1/1 (37 filtered) with repeated execution,
object identity, thrown object/number/undefined, two-Context isolation and
pre-effect mismatch rejection. Eight native packages were built separately;
runtime compilations and interpreter-provider instances remain zero. Native
digest/ABI checks pass 2/2 and build-side checks 13/13. Ordinary adapter checks
have 30 passes, eight ignored and zero failures out of 38. These supersede the
earlier public-wiring status, not the unchanged Deno conformance result.
The adapter handoff contains packaging and public-test reproduction commands.
Additional host capabilities, BigInt/UTF-16 adoption, runtime AOT compilation,
pure Program completion and a full Context/conformance rebuild remain open.

## Wrap-up handoff (2026-10-04)

Fresh Context rebuild is now measured, not outstanding: clean compiler
`3d4c1df`, adapter `064423a`, pinned Deno `1d4e6c1`. Raw Context is 2,709,108
bytes, Binaryen 125 optimized Context 2,008,044 bytes, Wasmtime native artifact
43,907,288 bytes. Native packaging passes 1/1 in 208.38 seconds. These numbers
are artifact sizes and build cost, not RSS or runtime performance.

Adapter fixes bootstrap ordering: the audited prelinked core transaction must
create the owner before generic Script lookup. Same-artifact unchanged WebIDL
`any` moves from 0/1 to 1/1. Five original WebIDL Script inputs are now packaged
offline without changing Deno. Fresh unchanged WebIDL remains 13/17 passing
with or without packages; four unknown-source failures become real iterable
conversion/assertion failures, not new passes. Public AOT fixture remains 1/1;
combined packaging/runtime-option/literal controls pass 15/15.

Detailed pins, artifact hashes, binaries, reproduction and remaining work are
in adapter `tools/js2wasm/SCRIPT-ENVIRONMENT-HANDOFF.md`. First lead is missing
owning-Script property/call dispatch exports: Context getters currently handle
foreign Script objects. This is not yet an attributed cause. Well-known Symbol
IDs are stable; preserve Script semantics rather than injecting Module exports.
Full unchanged deno_core, native capabilities, BigInt/UTF-16, runtime AOT source
compilation, pure Program completion and fresh benchmarks remain open.
Both existing PRs remain draft; compiler PR 6468 is stacked, not based on main.
## Owning-Script dispatch checkpoint (2026-10-04)

Scripts now optionally export native Get and Call helpers, dispatched only after
their allocation owner admits the value. Computed well-known Symbol methods are
materialized in closed object fields using declaration-proven keys and semantic
method names, rather than TypeScript's escaped physical field names. The adapter
validates helper signatures before execution and implements Uint32Value/Int32Value
with JavaScript truncation/wrapping and exception propagation.

Measured unchanged WebIDL result: **15 passed, 2 failed, 0 ignored, 414 filtered
out of 431**, up from 13/17 in the same subset. Newly passing tests are
`sequence_check_next_method_once` and `sequence_next_method_must_be_callable`.
Remaining failures are `dictionary` (array-valued field b) and
`sequence_propagates_next_getter_exception` (expected TypeError("boom")).
No Deno/vendor test sources or passing baselines were changed.

The Context artifact remains the earlier clean compiler `3d4c1df` / adapter
`064423a` build documented above. Five Script packages use this checkpoint's
compiler changes, and the runtime binary uses its adapter changes. This is not
a newly matched full Context rebuild. Current packages:
`/private/tmp/deno-current-aot-build.q7MC1w/webidl-owned-method-scripts`.
Replay from `/private/tmp/deno-upstream-conformance.H6HA4g/deno`:

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-current-aot-build.q7MC1w/deno-core.cwasm V8X_JS2WASM_AOT_SCRIPT_DIR=/private/tmp/deno-current-aot-build.q7MC1w/webidl-owned-method-scripts target/debug/deps/deno_core-87206ac56a2fccad webidl::tests:: --nocapture --test-threads=1
```

Checks: compiler completion/getter/persistent/result controls **128/128**,
including two existing expected failures; compiler typecheck and scoped lint pass.
Adapter compiler-free ordinary controls **31 passed, 8 ignored, 0 failed /39**,
native Script ABI controls **2/2**, and build-side controls **15/15**.
A separate runtime-compilation profile run reported 33 passes, four failures and
27 ignored /64: two Context/provider contract failures and two missing configured
precompiler inputs. That run is not a passing compiler-free result.

Node Wasm exception-reference support must be supplied as a fork execArgv array.
A misconfigured Vitest launch supplied the flag as characters and left a worker
waiting (session 78409, parent PID 65733, child 65736). Approval to stop it was
requested but not received; it was not killed. Corrected focused checks finished
separately using compiler `.tmp/deno-4376-vitest-exnref.config.ts`.

Resume with native Script-created array iterator support and exact thrown-error
branding/message transport. Do not mask an owning getter's undefined result by
falling back to another module, because that may overwrite intentional shadowing.
Then rebuild a matched Context and run the full unchanged deno_core population.
BigInt/UTF-16, native capabilities, pure Program completion, runtime AOT routing,
shared-library factoring and fresh performance measurements remain open.
The existing compiler PR is stacked, not main-based; both PRs remain drafts.

## Wrap-up: shared Array prototype checkpoint (2026-10-04)

Native Error adoption is published in adapter `60dfe37`; unchanged WebIDL now
reports **16 passed, 1 failed, 0 ignored, 414 filtered /431**. The remaining
failure is dictionary conversion of a Script-created array. This result uses
the earlier Context artifact and is not a fresh matched build or full population
result. Public Error controls pass 1/1 (38 filtered), including native branding,
message, identity and ordinary-object rejection with zero runtime compilation.

This compiler checkpoint adds an optional `standaloneGlobalThisImport.arrayPrototype`
provider, reserved native Symbol handling for Script Get, native Array iterator
prototype initialization and reflective iterator-property lookup. A same-store
Node control reads the shared iterator, calls its next method and obtains 70000
from an independently compiled Script array. The getter suite passes **4/4**.
The previous 128/128 compiler result predates these Array changes.

**Not merge-ready:** custom/null array prototypes and alternate Reflect receivers
are not proven safe in the new shared-prototype path. Own-undefined/accessor
shadowing and non-array negative controls must be added. Shared descriptor and
overlay metadata still require investigation. Do not infer full Array semantics
from the four focused controls, or credit a dictionary fix before a native replay.

Resume in this order:

1. Guard or correctly handle explicit custom/null prototypes and alternate
   receivers; add negative controls and broad iterator regressions.
2. Wire a native Context Array.prototype provider in adapter packaging and ABI
   validation. Existing Context artifacts do not export the new provider.
3. Rebuild a clean, pinned, matched Context plus exact original Script packages,
   then replay unchanged WebIDL and the full deno_core population. Repository
   harness requires cargo-nextest, which is absent; direct built libtest replay
   remains possible and must be labeled separately.
4. Continue full Deno host capabilities, BigInt/UTF-16, pure Program completion,
   runtime AOT routing, shared-library factoring and fresh benchmarks.

Focused command (Node exception-reference flag is an array in the config):

```sh
node node_modules/vitest/vitest.mjs run tests/issue-4376-native-script-getter.test.ts --config .tmp/deno-4376-vitest-exnref.config.ts --no-file-parallelism
```

Compiler PR https://github.com/loopdive/js2/pull/6468 is stacked on
`codex/4376-deno-callback-construction-20260930`. Adapter PR
https://github.com/loopdive/v8x/pull/2 targets main. Both are open drafts;
integration is incomplete. Preserve unrelated lower-contracts documentation,
acorn binary and untracked user files. The old misconfigured Vitest session
78409 was not killed because approval was not received.

## Continuation: linked Array mutation controls (2026-10-04)

The initial negative matrix measured 7/9 passing: own undefined, own accessor
and non-array rejection passed, but null/custom prototypes failed. Native
prototype edges now admit linked Array owners and Array-valued prototypes;
integrity checks consult the Array's vec bag, and mutated Array getPrototypeOf
reads no longer use a compile-time intrinsic shortcut. No new interpreter or
source-specific dictionary implementation was added.

The expanded getter suite passes **14/14**, including prototype/null identity,
own shadowing after mutation, non-extensible refusal and cycle refusal.
The four-file regression run passes **104/104** (getter 14, persistent Script
86 including two existing expected failures, Array-subclass identity 1 and
bootstrap null-chain 3). TypeScript 7 passes. These are Node same-store compiler
controls, not native Deno or population coverage.

Adapter source now exports `__v8x_context_array_prototype` from the runtime
Context builder and both small Context builders. Script options import that
provider; the runtime Context import allowlist admits it and the builder's owner
ABI check requires the export. Build-side controls pass **15/15**. Existing
Context artifacts lack the export and must be rebuilt before replay. Do not
reuse an old native hash or package manifest to claim the new ABI is verified.

Next: explicit Reflect receiver controls and any necessary propagation fix,
fresh clean pinned native Context/Script packaging, unchanged WebIDL replay,
then the full unchanged deno_core population. Canonical prototype identity and
cross-module descriptor/overlay metadata still require broader verification.
The last native unchanged WebIDL evidence remains **16/17**, not 17/17.

## Explicit Reflect receivers (2026-10-04)

The three-case initial receiver matrix passed only custom-prototype access;
own and nested-own accessors used the Array target as `this`. The vec property
reader now has a separate, default-off three-argument helper used by linked
getter bindings. Its existing two-argument ABI is unchanged. Overlay accessor
prologues consume the one-shot Reflect receiver before calling a getter, and
the receiver-aware helper receives the same overlay prologue with correctly
offset locals. The native Array iterator early Get arm consumes that state too.

Focused getter controls pass **21/21**, including numeric/string indexed
accessors, nested ordinary reads, Context Array prototype and native iterator
prototype receiver identity. The five-file run reports **149 passed, 53 failed
/202**, with two existing expected failures included among passes. The four
execution suites alone pass **111/111**. The source-preservation suite reports
38 passed /53 failed /91 both before and after this change: clean compiler
`73c8c2369784363154cdf3db118edf0dea9392cf` and the dirty candidate have exactly
the same per-test statuses. Baseline JSON is
`/private/tmp/deno-array-native-build.lcT9ej/preservation-baseline.json`;
candidate JSON is compiler `.tmp/4376-receiver-preservation-candidate.json`.
Do not describe the combined run as all green or repair its receipts silently.

TypeScript 7, scoped Biome lint, LOC and function budgets pass. A broad shared
local clone failed on a missing historical promisor object; a single-branch
depth-one local clone succeeded. The build staging directory is
`/private/tmp/deno-array-native-build.lcT9ej` with a clean baseline compiler at
`js2-clean`. Advance its clean detached pin only after committing the receiver
fix. Binaryen 125 is `node_modules/binaryen/bin/wasm-opt` (Node executable),
not a command currently available on PATH. Native replay remains outstanding.

## Wrap-up: native Promise transport checkpoint (2026-10-04)

Compiler 74ed7007fb and adapter 37923f2 already publish host-owned import-meta.
Unchanged Deno main/side passes 1/1, lazy/missing-script 2/2 and WebIDL 17/17,
all subsets of 431 tests. This does not establish full Deno integration.

The next adapter checkpoint adds a real compiled Promise mirror for native
Rust-created Promises, preserving native identity and synchronized settlement.
Compiler-free check and formatting pass, options controls pass 11/11,
staged-core helper controls pass, and the ordinary adapter suite passes 34/34
executed tests (14 ignored /48). Native mirror integration is not yet tested.
Old Context artifacts lack the new helper ABI and must be rebuilt. Failure
rollback, rejection event identity/order and native replay are first next steps.
No compiler implementation changed during wrap-up and no benchmark was run.

Detailed continuation is adapter `tools/js2wasm/NATIVE-PROMISE-HANDOFF.md`.
Existing draft PRs are https://github.com/loopdive/js2/pull/6468 and
https://github.com/loopdive/v8x/pull/2; update these rather than opening duplicates.
Neither is merge-ready. Preserve unrelated user changes in both worktrees.

## Full Context and original module exception continuation (2026-10-04)

Fresh full Context is `/private/tmp/deno-promise-full.X2WdwN/deno-core.cwasm`,
44,646,992 bytes, SHA256
`78aa8a50726f61577cdc54267d912af63acc7b85d24a931fa53e71a63ab2b237`.
Clean compiler b5f6cbae636d22d5c9e7901f779b4f1727003adc, builder
7b31b4ef839bbd4646b85441725e65c7f6a95dc6, unchanged Deno
1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44. Binaryen 125 optimized,
Wasmtime 47.0.3 precompile 1/1 in 224.14s. No interpreter provider emitted.

Main/side passes 1/1 (430 filtered /431). Missing-package negative fails 0/1
with the original loading error instead of the old Promise conversion failure.
Lazy loading passes 1/1, WebIDL 17/17, all unchanged Deno subsets. Rust adapter
build uses no runtime_compile feature. Do not credit the entire 431 population.

Original AOT graph thrown payloads are rooted before unwinding to native APIs.
The native test verified identity but initially failed marker read (NaN/42):
the graph readiness matcher refused objects escaped before namespace publication.
The sidecar adds __v8x_graph_get_owned_export; Rust dispatch proves allocation
ownership before using it. Native positive/throwing module tests now pass 2/2,
48 filtered /50, including exact Promise result/Module exception/global identity
and marker 42. Compiler namespace controls pass 4/4, including foreign-instance
allocation refusal. TS7 passes; scoped lint has one existing explicit-any warning.

New graph packages are `/private/tmp/deno-promise-full.X2WdwN/graphs-owned-get`.
They were built from this compiler candidate; the full Context uses the clean pin
above. Detailed adapter receipts are in tools/js2wasm/NATIVE-PROMISE-HANDOFF.md.
Next inspect the full unchanged test population and package its exact source
graphs, then continue snapshot and host/value work. Startup-module exceptions,
arbitrary thrown callables, transport failures after adoption and full snapshot
semantics still need coverage. No new throughput/footprint comparison.
