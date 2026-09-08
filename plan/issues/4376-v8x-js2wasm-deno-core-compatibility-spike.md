---
id: 4376
title: "Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime"
status: in-progress
created: 2026-08-12
updated: 2026-09-08
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+architecture
area: host-interop, runtime, deno
language_feature: modules, typescript
goal: deno-runtime
sprint: current
assignee: ttraenkler/codex-v8x-js2wasm
horizon: xl
related: [1584, 1662, 1772, 2525, 2658, 2928, 2997, 3571, 3731, 4377, 4378, 4380]
origin: "Project-lead request to determine whether js2wasm can run behind v8x and preserve Deno APIs without V8, JSC, or QuickJS"
loc-budget-allow:
  # 2026-09-08: delegate ordinary new.target reads to the per-frame value.
  - src/codegen/binary-ops.ts
  - src/codegen/typeof-delete.ts
  # 2026-08-28: PR #5148 checkpoint (Deno runtime integration — linked
  # shared-realm/callable boundaries, runtime-eval + exception transport,
  # Promise/reflection/buffer-view/finalizer behavior). Broad, measured
  # growth across codegen accepted for the checkpoint; consolidation is
  # follow-up work under this issue.
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/statements/variables.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/declarations.ts
  - src/codegen/dataview-native.ts
  - src/codegen/async-scheduler.ts
  - src/interp/emitter.ts
  - src/interp/loop.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/index.ts
  - src/codegen/array-methods.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/closure-exports.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/async-frame.ts
  - src/codegen/context/types.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/dyn-read.ts
  - src/codegen/promise-combinators.ts
  - src/compiler.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/proto-index-store.ts
  - src/codegen/object-ops.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions.ts
  - src/codegen/property-access.ts
  # 2026-08-30: unchanged deno_core publication through the captured
  # Object.assign primordial, plus native-string sentinel registration for
  # linked standalone/provider graphs.
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/registry/imports.ts
  # 2026-08-29: deno-core bootstrap local-index remapping (createTimer /
  # __eventLoopTick / runImmediates class): lift-time transitive-capture
  # promotion incl. no-captures branch, recorded-slot fallbacks, stale
  # name-keyed box guard, plus env-gated standalone debug facilities
  # (JS2WASM_DUMP_TYPES / JS2WASM_TRACE_LAST_STMT).
  - src/codegen/closures.ts
  - src/emit/binary.ts
  - src/codegen/statements.ts
  - src/link/linker.ts
  # 2026-08-29 (post-merge): terminal-flat-body relaxation of the #1058
  # shared-body refusal + instr-level double-shift guard commentary.
  - src/codegen/stack-balance.ts
  - src/codegen/expressions/late-imports.ts
  - src/codegen/async-scheduler.ts
func-budget-allow:
  # 2026-09-08: frame initialization/read hooks and native driver save/restore;
  # implementation lives in ordinary-new-target.ts, class handling unchanged.
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  # 2026-09-08: sparse reference-vector growth shares the existing hole
  # observers; inherited presence and own-key enumeration require distinct
  # predicates. Verified in both standalone configurations and public v8x APIs.
  - src/codegen/object-runtime.ts::fillConcatNativeHoleArms
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  # 2026-08-28: PR #5148 checkpoint (same rationale as the loc grants above).
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::generateModule
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/vec-props.ts::fillVecPropHelpers
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  # 2026-08-29: deno-core bootstrap remapping (see loc grants above).
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/link/linker.ts::emitLinked
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/object-runtime.ts::fillExternSetVecArms
  - src/codegen/property-access-dispatch.ts::tryBufferViewAttributeReads
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/interp/loop.ts::run
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildStateBody
  - src/codegen/property-access.ts::compileElementAccess
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
  - src/codegen/class-bodies.ts::compileSuperCall
  # 2026-08-30: closed-struct Object.assign publication and dynamic reads in
  # unchanged deno_core bootstrap code.
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
oracle-ratchet-allow:
  # 2026-08-28: PR #5148 checkpoint — new raw-checker queries in DataView
  # lowering and source-scan predicates; migrate to ctx.oracle in follow-up.
  - src/codegen/dataview-native.ts
  - src/codegen/index.ts
  - src/codegen/source-scan-predicates.ts
coercion-sites-allow:
  # Multi-source finalization checks whether the shared ToBoolean helper is
  # already registered before asking the existing union engine to add it.
  - src/codegen/index.ts
files:
  - .prettierignore
  - examples/v8x-js2wasm-spike/README.md
  - examples/v8x-js2wasm-spike/compile-graph.ts
  - examples/v8x-js2wasm-spike/deno.ts
  - examples/v8x-js2wasm-spike/v8x-js2wasm.patch
  - tests/v8x-js2wasm-spike.test.ts
  - tests/fixtures/deno-core-0.407.0/00_primordials.js
  - tests/fixtures/deno-core-0.407.0/00_infra.js
  - tests/fixtures/deno-core-0.407.0/02_timers.js
  - tests/fixtures/deno-core-0.407.0/01_core.js
  - tests/fixtures/deno-core-0.407.0/README.md
  - tests/fixtures/deno-core-0.407.0/mod.js
  - tests/fixtures/deno-core-0.407.0/hello_world_usage.js
  - src/codegen/analysis/realm-global-structural-carrier.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls-optional.ts
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
  - tests/helpers/deno-core-bootstrap-probe.ts
  - tests/issue-4376-deno-core-bootstrap.test.ts
  - tests/issue-4376-realm-structural-carrier.test.ts
  - tests/issue-4376-deno-primordials-runtime.test.ts
  - plan/issues/3731-generatemultimodule-missing-fill-drivers.md
  - plan/agent-context/v8x-js2wasm-deno-handover-2026-08-12.md
---
# #4376 — v8x + js2wasm as an engine-free Deno substrate

## Objective

Determine whether js2wasm can sit behind v8x's `rusty_v8`-compatible Rust API
so that:

1. Deno-facing code continues to call the API it already knows;
2. raw TypeScript module graphs retain their type information and compile
   directly to WasmGC rather than being transpiled to JavaScript;
3. Wasmtime executes the result without V8, JavaScriptCore, or QuickJS; and
4. a deployed artifact can run without shipping the js2wasm compiler.

The spike deliberately asks the compatibility question before trying to expose
Deno APIs as a new WASI world. Deno's Rust/JavaScript boundary is an object,
module, promise, and callback protocol, not a filesystem-style syscall API.

## Architecture verdict

The approach is viable as a staged architecture, but the spike is not yet a
portable Deno runtime.

```text
build time
  application .ts + Deno wrappers + op manifest
                   |
                   v
          js2wasm --platform deno
                   |
                   v
             linked WasmGC

run time
  deno_core / Rust host calls rusty_v8 API
                   |
                   v
          v8x compatibility layer
                   |
                   v
 shared Engine + Module + Linker + InstancePre
                   |
                   v
       private store + instance per module
                   |
                   v
       compiled wrappers call typed host ops
```

The first internal ABI should use ordinary typed Wasm imports. WIT/component
interfaces can describe the stable outer runtime boundary later, and WASI can
provide standard capabilities such as files, clocks, and sockets. Neither
WASI nor the Component Model replaces the JavaScript object graph that
`deno_core` and its wrappers share.

## What the spike implements

The patch in `examples/v8x-js2wasm-spike/v8x-js2wasm.patch` targets v8x
`v149.4.0-rc.4` at commit
`22cf7342405794d6e1cd851aa43a9b3447654742` and adds an opt-in
`engine_js2wasm` backend.

The implemented vertical slice provides Rust-owned:

- platform and isolate startup;
- contexts, Unicode strings, handles, and persistent handles;
- function/object templates and basic object/property storage;
- module compilation, resolver callbacks, graph instantiation, and evaluation
  promises; and
- exception values plus the complete simdutf compatibility surface.

The module path gathers untouched `.ts` sources through v8x's existing module
resolver, passes the linked graph to js2wasm with `platform: "deno"`, and
precompiles the WasmGC result for embedded Wasmtime 47.0.3. Production v8x
shares one compiler-free Engine and direct-Rust host Linker, caches one
Module/InstancePre per trusted artifact, and gives every evaluated module a
private store/instance that remains alive with its v8x module handle.

The integration fixture enters through the public `rusty_v8` API, evaluates a
typed three-module graph, and calls a Rust-owned `Deno.cwd()` implementation
through two primitive `v8x:deno` imports. It verifies the returned UTF-16
length and checksum against the host working directory and rejects a vacuous
result if no host op was called.

The test binary links neither JSC nor QuickJS. On macOS, `otool -L` reports
only `/usr/lib/libSystem.B.dylib`.

## Unchanged `deno_core` probe

The consumer probe uses Deno commit
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44` (Deno 2.9.2,
`deno_core` 0.407.0) and replaces only its workspace `v8` dependency:

```toml
v8 = { package = "v8x", path = "/path/to/v8x", default-features = false, features = ["simdutf", "engine_js2wasm", "js2wasm_runtime_compile", "js2wasm_diagnostic_abi"] }
```

No `deno_core`, `serde_v8`, or Deno JavaScript/TypeScript wrapper source is
patched. All Rust source compiles successfully against the new backend with
the Wasmtime dependency graph resolved in the probe lockfile.

A strict normal link now succeeds through an opt-in diagnostic ABI feature.
That feature supplies weak, fail-loud definitions for the exact 237 symbols
referenced by the pinned executable; every unimplemented call prints its exact
symbol and aborts. Strong backend implementations override those definitions.
This is an execution instrument, not a supported deployment configuration and
not evidence that the remaining functions have semantics.

The strict unchanged executable now initializes the platform and isolate,
installs Deno's callbacks and initial `Deno.core` object graph, evaluates the
exact pinned wrapper/module/application sequence, and exits successfully. The
module trace enumerates exactly nine `v8x:deno` scalar bridge imports and seven
deferred Promise/eval imports. The nine Deno imports bind to real Rust host ops;
the seven deferred imports are prelinked but are not executed by this path.

Running the unchanged pinned `deno_core` `hello_world` example against the
precompiled artifact exits 0 and prints exactly:

```text
The sum of
1,2,3
is
6
Exception:
TypeError: serde_v8 error: invalid type; expected: array, got: Number
```

This retires the diagnostic bootstrap stop for the exact program. It is a
value-level vertical slice, not evidence that unexecuted Deno APIs or the
remaining diagnostic ABI have semantics.

### Primordials boundary

`00_primordials.js` captures trusted copies of JavaScript built-ins such as
`Object`, `Array`, `Promise`, and `Reflect` before application code can
monkey-patch them. Deno's later wrappers use those private copies for stable
internal behavior. Primordials are therefore JavaScript object identities and
functions, not Rust ops and not WASI calls.

The compiler adapter had previously
omitted side-effect JavaScript imports because it did not set `allowJs`; fixing
that exposed and then fixed two honest compiler boundaries:

1. #4378 lowers the exact pristine
   `Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]())` capture through
   the native empty-array iterator and returns the genuine shared iterator
   prototype.
2. #4380 makes empty-object widening inspect arrow/function-expression IIFE
   bodies, preventing `primordials` from becoming a null carrier during the
   first property write.

The exact pinned `00_primordials.js`, `00_infra.js`, `02_timers.js`,
`01_core.js`, `mod.js`, and `hello_world_usage.js` sources now compile as one
state-sharing standalone/`deno` program. The raw artifact is 3,975,227 bytes
on the measured Darwin arm64 producer, with SHA-256
`452d485bd70d7cb8d5d7958e0aebfddf71463a8cb9710de56dffc9ff23f50e85`.
Raw Wasm layout is producer-platform-specific: the Linux x64 CI producer emits
the same byte count and passes the same value checks with SHA-256
`0738f4ca2b8852ee7262bd306efb70754dc4c7d5532288af2b16f46caca0eeda`.
The regression test therefore pins the six source hashes, graph shape, imports,
size, and behavior rather than one platform's raw-artifact digest.
Target-gated standardized `try_table` lowering lets Wasmtime 47.0.3 precompile
it to a distinct 62,035,464-byte target-specific artifact with SHA-256
`05b75d7f1e46f92565c42e5a8a3e336983e7e2b0eecfe4889dadab9075988a5a`.
The ignored precompile/bootstrap test passes 1/1 in 500.49 seconds.

The Node-side import emulator boots the raw module in two isolated stores.
Both stores advance through wrapper/module/usage values `42`/`43`/`44`, commit
exactly two sum transactions and six UTF-16 print transactions, reproduce the
exact serde `TypeError` and six output strings, and call none of the seven
deferred Promise/eval imports. The strict v8x follow-up recognizes the same six
pinned source hashes and order through the public `rusty_v8` lifecycle, loads
the precompiled artifact, binds the nine scalar imports to Rust, and completes
the unchanged `deno_core` example. General Rust/Wasm object identity, module
live bindings, and asynchronous op semantics remain separate work.

## What “306 ABI symbols” meant

The initial unchanged-`deno_core` link reported 306 distinct unresolved
symbols in the v8/inspector/shared-handle ABI. This number was a linker
inventory, not 306 missing Deno APIs and not 306 equally important runtime
features. It included:

- symbols needed immediately during startup;
- symbols referenced by compiled Rust code but not executed by this probe;
- overloads and lifecycle helpers representing one semantic operation; and
- inspector/debugger paths unrelated to a minimal production runtime.

The spike implements 106 distinct `v8__*` functions, 10 shared-pointer
compatibility functions, and all 43 simdutf functions. The current diagnostic
layer provides 237 exact weak, fail-loud definitions for functions referenced
by the pinned executable but not yet implemented strongly. None is executed by
the successful exact `hello_world` path. The useful progress measure is
observable behavior through the real host bridge, not trying to drive an
inventory to zero with empty stubs.

## Compiler-free deployment answer

Yes: after build-time compilation and Wasmtime precompilation, the deployed
runtime needs only the target-specific trusted `.cwasm` artifact, the Rust/v8x
host layer, and compiler-free embedded Wasmtime. It does not need js2wasm,
Node, Cranelift, or a JavaScript engine.

The spike now proves this explicitly: one test saves the linked Wasm artifact,
and a second invocation evaluates it while the configured compiler path is
`/compiler-is-not-installed`. The production `deno` target must still package
the application, real Deno wrappers, and generated op manifest as that one
ahead-of-time linked program.

## Compile-time cost

The compatibility analyses increase the deterministic #3437 harness traversal
count from 111,568 to 131,133 (+17.5%). This exceeds the prior 15% ceiling, so
the dedicated harness budget is intentionally rebanked with the repository's
provided update command. A follow-up should consolidate the added per-file
scans; this PR accepts the measured compile-time cost for the prototype rather
than hiding it behind a looser percentage margin.

## Spike acceptance

- [x] Preserve raw TypeScript source and use its types during js2wasm
      compilation; do not transpile it to JavaScript first.
- [x] Enter through v8x's public `rusty_v8` module lifecycle.
- [x] Compile and evaluate a linked multi-file graph in Wasmtime without JSC
      or QuickJS.
- [x] Resolve canonical `file:` imports to compileMulti's virtual filesystem
      identity, including incremental compilation (#4377).
- [x] Compile unchanged `deno_core` Rust source against `engine_js2wasm`.
- [x] Advance the diagnostic startup path through `Deno.core`, the exact pinned
      wrapper/module/application sequence, and the six-line `hello_world`
      result from unchanged Rust `deno_core`.
- [x] Keep unimplemented ABI paths fail-loud instead of adding success-shaped
      no-op stubs.
- [x] State the compiler-free deployment shape and the current sidecar
      limitation separately.

## Follow-up acceptance

- [x] Embed Wasmtime, share the Engine/Linker/precompiled Module/InstancePre,
      and keep one isolated store/instance alive per v8x module runtime.
- [x] Compile all six exact pinned wrapper/module/application sources as one
      state-sharing program and prove stages `42`/`43`/`44` in two isolated
      instances.
- [x] Add `02_timers.js`, `mod.js`, and the exact `hello_world_usage.js`
      application to that state-sharing program.
- [x] Bind a first Rust op (`Deno.cwd()`) through explicit typed imports.
- [x] Bind the exact `op_sum`/`op_print` scalar bridge, including the serde
      `TypeError` and UTF-16 output semantics.
- [ ] Generate the broader Rust op table and preserve general exception,
      promise, and microtask ordering across the bridge.
- [ ] Return module namespaces and live bindings through the v8x handles.
- [ ] Add dynamic imports, top-level await, synthetic modules, and non-`file:`
      specifier handling as demanded by executed Deno paths.
- [x] Save and run a proof artifact without the compiler sidecar or Node.
- [x] Include JavaScript side-effect modules in the virtual graph and compile
      the pinned unchanged `00_primordials.js` through its first two compiler
      boundaries (#4378, #4380).
- [x] Emit standardized `try_table` EH so the exact wrapper artifact loads in
      v8x's embedded Wasmtime (#2997).
- [x] Route the pinned wrapper/module/application sequence through v8x's public
      `rusty_v8` lifecycle and real Rust host imports.
- [x] Prove the same path from the unchanged pinned Rust `deno_core`
      `hello_world` executable with exact output and exit status.
- [ ] Replace the narrow scalar/callback bridge with general shared
      object/function identity.
- [ ] Package the real Deno wrapper/application artifact for distribution.

## Verification

Repository checks:

```sh
DENO_CORE_BOOTSTRAP_WASM_OUTPUT=/private/tmp/deno-core-host-ops.wasm \
node --max-old-space-size=2048 --experimental-wasm-exnref --import tsx \
  tests/helpers/deno-core-bootstrap-probe.ts

pnpm exec vitest run \
  tests/issue-4376-deno-primordials-runtime.test.ts \
  tests/issue-4376-deno-core-bootstrap.test.ts \
  tests/issue-4376-realm-structural-carrier.test.ts \
  tests/issue-4378-array-prototype-iterator-bootstrap.test.ts \
  tests/issue-4380-empty-object-widening-iife-body.test.ts \
  tests/issue-4377-multifile-exported-object-shorthand-callable.test.ts \
  tests/v8x-js2wasm-spike.test.ts \
  tests/multi-file.test.ts
pnpm run typecheck
pnpm exec prettier --check \
  src/codegen/analysis/realm-global-structural-carrier.ts \
  src/codegen/expressions/calls-closures.ts \
  src/codegen/index.ts \
  src/codegen/statements/variables.ts \
  tests/helpers/deno-core-bootstrap-probe.ts \
  tests/issue-4376-deno-core-bootstrap.test.ts \
  tests/issue-4376-realm-structural-carrier.test.ts
```

Patched-v8x checks:

```sh
cargo check --no-default-features --features engine_js2wasm,simdutf --lib
cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test rv8_test_simdutf

V8X_JS2WASM_COMPILER_SCRIPT=/absolute/path/to/compile-graph.ts \
V8X_JS2WASM_WORKDIR=/absolute/path/to/js2wasm \
V8X_JS2WASM_ARTIFACT_OUTPUT=/tmp/deno-app.cwasm \
cargo test --no-default-features \
  --features js2wasm_spike,simdutf \
  --test js2wasm_spike

V8X_JS2WASM_AOT_MODULE=/tmp/deno-app.cwasm \
V8X_JS2WASM_COMPILER=/compiler-is-not-installed \
cargo test --no-default-features \
  --features engine_js2wasm,simdutf \
  --test js2wasm_spike

V8X_JS2WASM_DENO_CORE_WASM=/private/tmp/deno-core-host-ops.wasm \
V8X_JS2WASM_DENO_CORE_AOT_OUTPUT=/private/tmp/deno-core-452d485b.cwasm \
cargo test --no-default-features \
  --features engine_js2wasm,simdutf,js2wasm_runtime_compile \
  --test js2wasm_spike \
  boots_exact_deno_core_artifact_in_two_wasmtime_stores -- --ignored --exact
```

With the pinned Deno workspace dependency redirected to v8x, the strict runtime
proof is:

```sh
V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-core-452d485b.cwasm \
cargo run -p deno_core --example hello_world
```

The current Darwin arm64 six-source raw bootstrap artifact is 3,975,227 bytes with SHA-256
`452d485bd70d7cb8d5d7958e0aebfddf71463a8cb9710de56dffc9ff23f50e85`.
Linux x64 CI emits the same byte count and semantic result with SHA-256
`0738f4ca2b8852ee7262bd306efb70754dc4c7d5532288af2b16f46caca0eeda`;
the raw binary digest is not treated as cross-platform canonical.
The compiler-side proof boots it in two stores, reaches `42`/`43`/`44` twice,
records two sums and six prints per store, and executes none of the seven
deferred imports. Wasmtime precompilation passes 1/1 in 500.49 seconds and
produces a separate 62,035,464-byte `.cwasm` with SHA-256
`05b75d7f1e46f92565c42e5a8a3e336983e7e2b0eecfe4889dadab9075988a5a`.
The pinned unchanged Deno commit `1d4e6c1` then exits 0 with the exact six lines
above through real Rust ops. Prior controls remain: the broader focused audit
passed 109/109 relevant tests; five `issue-1472.test.ts` failures reproduced on
pristine `origin/main`; simdutf passed 14/14; and the first `Deno.cwd()`
source-compile and compiler-free AOT integrations passed 1/1 each. The smaller
1,434,192-byte precompiled fixture belongs to that earlier `cwd` proof, not the
current Deno-core artifact.

## PR #5148 checkpoint continuation (2026-08-29, branch claude/deno-integration-map52s)

The draft checkpoint PR #5148 (codex/deno-runtime-integration-checkpoint) was
merged onto `claude/deno-integration-map52s`, reconciled with current main,
and its declared test gaps driven down. Fixed on that branch:

- Promise expandos on the native `$Promise` (`$bag` slot was added but
  `$Promise` never joined `BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES`) — 3 tests.
- Reflected Symbol/Promise constructor statics + runtime-eval slot peel: the
  nullish-callee arm's non-nullish half now dispatches through
  `__apply_closure` instead of answering `undefined` — 3 tests.
- Linked-realm bare identifier reads (symbol-less names no longer classified
  as #3505 cross-module leaks) — fixed shared-globalThis bareRead/bareCall
  and both v8x graph-compiler failures — 3 tests.
- Detached-buffer `.byteLength` (dyn-view arm gated to dynamic receivers;
  bare-vec fallback clamps the -1 marker) — 1 test.
- Realm `Int8Array` identity (seed the #4490 identity carrier, not
  `$__ta_ctor`) and hoisted-capture types for literals the declaration
  promotes to the open `$Object` representation (`{ __proto__: null }`) —
  2 tests.

Remaining known gaps (all reproduce at the checkpoint merge point or on
origin/main — none introduced by the continuation):

- `uncurryThis`: a bare `Function.prototype` VALUE read
  (`const fp = Function.prototype`) throws a raw wasm exception during
  module init (pre-existing; direct `Function.prototype.bind` reads work).
- deno-core bootstrap `createTimer`: lifted-body local-index remapping
  (`references local 2413, but only 35 params + 350 locals`) — the
  PR-documented remapping gap.
- compile-multi finalizer parity's Array-proto-iterator case: sits on the
  host-lane CPR override machinery, which fails 6/7 of
  `tests/issue-1719-cpr.test.ts` on origin/main in this container.
- `#2623` box-depth (3) and `#1312` async recursion (1): pre-existing at the
  merge point.
- `tests/issue-2928-runtime-link.test.ts` "returns and invokes an interpreted
  closure across the Wasm module boundary": hangs in an uninterruptible wasm
  loop until the 20-minute vitest timeout — present since the checkpoint
  merge (reproduced at the merge point with none of the continuation fixes
  applied).

## Current artifact refresh (2026-08-31)

The current exact artifact measures 10,004,942 bytes with SHA-256
`88e2d7dfef7e5fba490bdf79802b7242a11d0cb1eedc2d0ca393ed24416af024`.
It imports exactly nine `v8x:deno` bridges and two deferred `runtime-eval`
imports, with no `env::Promise_new` import. Two isolated stores still complete
the `42`/`43`/`44` stages and all bridge checks. Against the clean checkpoint
without the composed patch (10,007,948 bytes), the patch reduces the artifact
by 3,006 bytes; the larger artifact size predates it.

## Handover

The exact pins, stop point, reproduction steps, rejected shortcuts, and safest
next slice are recorded in
[`plan/agent-context/v8x-js2wasm-deno-handover-2026-08-12.md`](../agent-context/v8x-js2wasm-deno-handover-2026-08-12.md).

The initial spike merged in
[#4396](https://github.com/loopdive/js2wasm/pull/4396). The compiler/runtime
follow-ups and primordials bootstrap merged in
[#4404](https://github.com/loopdive/js2wasm/pull/4404). The v8x-side changes are
tracked in
[`loopdive/v8x#1`](https://github.com/loopdive/v8x/pull/1) from
[`codex/js2wasm-module-backend`](https://github.com/loopdive/v8x/tree/codex/js2wasm-module-backend)
through commit `3095ded9b69055ecc936109cf71d270d4acf6c79`, which adds the strict
unchanged-`deno_core` proof on top of the earlier public `Script::Run` bridge.


## 2026-09-08 upstream-main sync

The branch is synchronized with `loopdive/js2` main at `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`. Follow-up instrumentation identified the bootstrap regression in `copyAccessor({ enumerable, get, set })`: eager registration converted its inferred binding-pattern type from `externref` into a closed struct. The earlier platform-specific explanation was incorrect.

Both nested signature registration paths now avoid creating structs for unannotated object-binding parameters. Explicit parameter types still register on every platform. The former Deno-only exclusion failed an optional local-interface parameter on Deno; that case now runs in the reservation tests. The new descriptor regression fails on both platforms with the guard removed, and passes with the guard present.

The focused reservation and Deno bootstrap suite passes after the guard, and `pnpm run typecheck` passes.

The Wasmtime CLI graph test now supplies a compiled `v8x:context` provider and invokes the deferred `__module_init` export. Its deliberately incorrect expected answer must throw during initialization, so successful instantiation alone cannot pass this test. The recursive externref test also explicitly invokes initialization. These are compiler/Wasmtime tests; they do not certify that the Rust v8x backend binds the context ABI. The latest checked backend revision is `43aef11c114a0673230335140e3fb517dd283c15`, and completing that host binding remains a separate integration requirement.

### Rust context integration: verified remaining failure

The public Rust graph test was extended in `/private/tmp/v8x-deno-followup-20260908/tests/js2wasm_spike.rs` so compiled code must read the `greeting` value installed by Rust on its Context global. With `V8X_JS2WASM_COMPILER_SCRIPT=/private/tmp/js2-poc-fixed2/examples/v8x-js2wasm-spike/compile-graph.ts` and `V8X_JS2WASM_WORKDIR=/private/tmp/js2-poc-fixed2`, `cargo test --no-default-features --features engine_js2wasm,js2wasm_runtime_compile,simdutf --test js2wasm_spike evaluates_raw_typescript_graph_through_wasmtime -- --ignored --exact` fails (0/1) at `unimplemented js2wasm host import v8x:context::__v8x_context_global_this`.

The existing module test only read the host-set global back through Rust. Its arithmetic and cwd probes did not exercise a Wasm read of the context global. The new assertion makes this missing behavior observable.

Implementation boundary: `ContextState` owns the core runtime through `Rc<RefCell<DenoRuntime>>`, but `ModuleState` owns a separate `DenoRuntime`, and `compile_and_instantiate` unconditionally creates a new store. Shared Wasm GC references require a common store within one context, with per-module instances retaining that context owner. Separate contexts must still be isolated. The host global must be synchronized with the compiled realm, including object and callable identity; binding a fresh empty global for each module would not satisfy the regression.

Required follow-up verification: host-to-Wasm reads, Wasm-to-host writes, two modules sharing one context, two contexts remaining isolated, and callable/object identity across those boundaries. The raw core bootstrap alone does not prove these requirements.

### Context-store ownership checkpoint

The local v8x checkout at `/private/tmp/v8x-deno-followup-20260908` now keeps a shared `Rc<RefCell<DenoRuntime>>` in ContextState and module handles. Subsequent graphs instantiate into that store and reuse its runtime-eval provider. A bootstrapped context supplies its core runtime as the owner. The primary core instance is restored after graph initialization, including initialization errors; graph instances are retained. Reentrant execution is rejected via try_borrow_mut. Bootstrap after ordinary module evaluation is explicitly rejected for now, rather than silently creating a second store.

Validation: runtime-compiler and compiler-free cargo checks pass. The backend integration suite reports 14 passed, 2 failed because required artifact environment variables were not supplied, and 2 ignored. Two new ownership unit tests compile but do not run: the library test executable fails linking existing missing ABI symbols (execution scopes, Rust allocator, sandbox query, inspector string buffer). This is not a passing ownership test result.

Still incomplete: `v8x:context` imports and bidirectional global/callable identity. The first failed graph and provider-instantiation failure lifetime paths need further review before exposing realm references. The new unit tests must run, and context-level integration tests are still required. These local edits are uncommitted and not published.

### Executed ownership regressions and provider failure fix

The two ownership diagnostics now run through the existing hidden runtime-profile integration-test entry point pattern, avoiding the unrelated incomplete library-test ABI. Command: `cargo test --no-default-features --features engine_js2wasm,js2wasm_runtime_compile,simdutf --test js2wasm_spike context_store`. Result: 2/2 passed, 18 other tests filtered out. These tests cover store-local instance access, separate runtime state, primary-instance restoration after deferred initialization throws, and provider reuse after the application's Wasm start function traps. They do not prove Context global integration.

Provider ownership is now saved immediately after successful provider instantiation, before linking/instantiating the application. Previously an application start trap could leave the provider in the Wasmtime store but forget its handle, causing a subsequent graph to create a second realm. The failure regression mutates the retained provider global and observes the same value on retry, with exactly one provider instantiation. Negative control removing the retention assignment fails 0/1 at `provider retained`; the assignment was restored and verified. The compiler-free cargo check also passes. Full context imports remain unimplemented; the first failed graph's context ownership still needs review.

### Core-owned context linking checkpoint

The Rust backend now recognizes only the two audited `v8x:context` imports and links them to the retained core instance for subsequent graphs. Missing function exports produce an explicit error before deferred-import trap binding; unknown context imports remain rejected. The artifact builder appends `__v8x_context_global_this` and generic `__v8x_context_call` exports to the core entry and requires them in its output export manifest.

Important ownership correction: the interpreter provider does not own Deno's global. Its eval functions receive the application's global as an argument. Creating an independent provider global would split the realm. The new linker prefers the primary core instance; a context with no core still requires a suitable realm provider and is not complete.

Validation: 2/2 Rust ownership integration tests pass, including core-context linking when the interpreter lacks context exports, missing-export rejection, unknown-import rejection and repeated graph linking. This uses a null-returning Wasm fixture ONLY to check linker behavior, not global semantics. The compiler's shared-global test is now parametrized for explicit call dispatch and generic apply: 3/3 passed. Builder syntax and compiler-free cargo check pass. The full pinned artifact has NOT been rebuilt or run with these new exports. Host-to-Wasm global synchronization, callable/object identity, the first-failed-graph lifetime and full context-level integration remain open.

### First deferred initializer preserves context ownership

Module evaluation now publishes its runtime to ContextState and ModuleState before running deferred top-level initialization. Construction and primary initialization are separate internally; bootstrap's existing constructor still performs both. Publishing holds no context heap borrow while Wasm executes. Evaluation-error reporting was inspected and preserves the runtime field.

The new regression writes 9 into a mutable Wasm global and traps in the first `__module_init`. Its published owner remains available, retains 9, and accepts a second graph without replacing that state. The ownership integration suite passes 2/2. Moving publication after initialization fails 0/1 at `owner published before initialization`; the correct order was restored. Compiler-free cargo check passes.

Scope: this proves deferred initialization ownership, not a first-module Wasm start-section trap before an Instance exists, nor host-global synchronization. The compiler's graph path requests deferred initialization. The full artifact rebuild and Rust/Wasm value bridge remain outstanding. Changes are still local and uncommitted.

### Compiled realm value-handle bridge

Added `tools/js2wasm/context-value-bridge.mjs` in the local v8x checkout and included its source in the generated core entry before source-graph hashing. The builder requires all 13 bridge exports. The bridge keeps values inside their owning compiled realm and returns numeric handles for global/object/array access, property get/set, callable invocation, numbers and UTF-16 strings. Identity interning distinguishes signed zero and interns NaN. Invalid handles and wrong scalar kinds throw rather than silently coercing.

Saved executable check: `node --experimental-wasm-exnref --import /private/tmp/js2-poc-fixed2/node_modules/tsx/dist/loader.mjs tools/js2wasm/test-context-value-bridge.mjs /private/tmp/js2-poc-fixed2`, run from the v8x checkout. It compiles the actual bridge source to zero-import standalone Wasm and passes assertions for property identity, callable returning the same object handle, UTF-16 surrogate units, NaN, signed zero, and invalid handle/type failures. Node v24.4.1 requires the exception flag. Builder syntax and diff checks pass.

Not yet complete: Rust Context Object APIs do not call this bridge, Rust host callbacks are not represented by these handles, boolean/null/bigint/symbol construction and full value conversion remain, handles are strong roots until context disposal, and repeated string append retains intermediate strings. The full pinned core artifact has not been rebuilt. This is the compiled half of the value transport, not a claim of Rust/Wasm context synchronization.

### Rust-to-Wasmtime value transport verified

Added `src/js2wasm_realm_values.rs`: Rust transport for realm handles, global/property access, numeric values, UTF-16 strings and callable invocation. Each DenoRuntime receives a checked, process-unique realm identifier; handles from another runtime are rejected before calling Wasm. Returned handles, string lengths and UTF-16 units are validated, and allocation failures are reported. Unpaired UTF-16 surrogates are preserved rather than converted through a Rust UTF-8 String.

The saved Node bridge check can optionally write the exact verified Wasm to its third argument. Generated `.tmp/context-values.wasm` is 327,224 bytes. With `V8X_JS2WASM_CONTEXT_VALUES_WASM=/private/tmp/v8x-deno-followup-20260908/.tmp/context-values.wasm`, command `cargo test --no-default-features --features engine_js2wasm,js2wasm_runtime_compile,simdutf --test js2wasm_spike transfers_context_values_through_embedded_wasmtime -- --ignored --exact` passed 1/1 in 40.70 seconds. It tests actual Rust/embedded-Wasmtime property writes/readback, stable object and callable-result handles, UTF-16 including a lone surrogate, NaN, signed zero, and cross-realm rejection. Compiler-free cargo check passes with expected unused-transport warnings because production Object APIs do not call it yet.

Remaining boundary: wire public Context/Object/Function APIs to these methods with stable Rust wrapper identity, host callback representation, lifetime/release policy, and reentrancy handling. The transport always needs the realm-owning primary instance; audit the temporary graph-instance swap before invoking transport during graph execution. Full Deno artifact rebuild remains outstanding. Changes are uncommitted.

### Realm owner remains fixed during graph execution

DenoRuntime now records a separate immutable `realm_instance`. Value transport and graph context imports use that instance rather than the temporarily selected executing `instance`. This prevents identical numeric handles from accidentally indexing another graph's table during module execution.

The embedded-Wasmtime regression selects a second independently instantiated bridge module as the executing instance while retaining the original realm handles. Property reads and callable results retain identity: 1/1 passed in 21.74 seconds. Negative control changing transport back to `instance` fails 0/1 with a thrown Wasm exception in `__v8x_value_get`; the correct binding was restored and inspected. Public `v8__Object__Get` and `v8__Object__Set` still use Rust property storage exclusively. Their dispatch and stable wrapper identity remain the next production integration boundary.

### Public Object Get/Set reaches the compiled realm

Added `src/js2wasm/realm_objects.rs` and isolate-owned wrapper bindings. Bound objects dispatch public `v8__Object__Get` and `v8__Object__Set` through the Rust realm transport. Returned ordinary objects are cached by owning runtime and realm handle, so repeated reads and aliases reuse the same Rust Object allocation. Unbound objects retain the existing backend behavior. Number/string/undefined conversions and passing an already-bound same-realm object are supported; other conversions raise an explicit error. Arrays now have distinct bridge kind 9, avoiding misrepresenting an array as an ordinary object.

The hidden test attachment requires an empty Rust global and does not stand in for automatic Deno bootstrap integration. `public_objects_use_compiled_realm_and_preserve_identity` ran through public Context/Object APIs against the freshly compiled fixture and passed 1/1 in 36.98 seconds. It verifies repeated wrapper identity, numeric property read/write, object alias identity and UTF-16 text. The ordinary backend suite passed 16/16 executed tests (4 ignored, 2 packaging-artifact tests explicitly filtered out). Compiler-free cargo check passes, with unused global/call transport methods still reported.

Remaining: automatic context attachment and seeding existing host properties, Function APIs and host callbacks, arrays/exotic values, booleans/null/bigint/symbol conversion, unpaired-surrogate Rust string backing, property enumeration/descriptors/prototypes for bound wrappers, and handle release. The cached Rust wrapper currently represents identity and Get/Set, not complete object reflection. Production Deno boot is not yet connected to this attachment. Changes remain local and uncommitted.

### Public realm-backed Function calls

Bound function values now receive cached Rust Function wrappers (with their compiled name), and the shared native invocation entry point dispatches them through the owning Wasmtime runtime. Argument arrays and receivers use the existing realm transport. Function identity and returned object identity are preserved. Construction remains explicitly unsupported; `Function::NewInstance` now propagates a null failure instead of returning a fabricated receiver after invocation failed. No fallback callback silently executes a detached realm function.

The rebuilt fixture adds receiver-sensitive and throwing functions. `public_objects_use_compiled_realm_and_preserve_identity` now covers functions as well: 1/1 passed in 59.83 seconds through public Rust APIs. Checks include IsFunction, repeated callable identity, identity-function result, receiver-sensitive result 100, failure observable by TryCatch, and unsupported construction returning None with a caught error. It does not prove exact thrown JS object/type identity; errors still travel through the current Rust error-reporting path. Existing backend suite: 16 passed, 4 ignored, 2 packaging tests filtered out. Compiler-free check passes.

Remaining Function work: Rust-hosted callbacks callable from Wasm, constructors, full metadata/reflection, complete argument/result conversion, reentrancy and exact exception identity. Automatic Deno attachment/seeding and the full artifact rebuild remain open. Changes are local and uncommitted.

### Array/scalar integration exposes a compiler sparse-growth defect

Added explicit boolean/null creation and decoding to the compiled bridge and Rust transport. Realm array wrappers now preserve array branding and dispatch public Length/GetIndex/SetIndex to Wasm. Added the previously missing `v8__Value__IsFalse` ABI symbol, with a regression proving that zero/null/undefined are not the boolean false.

Ordinary backend tests: 17 passed, 4 ignored, 2 packaging tests filtered out. Compiler-free check passes. The full public realm regression is currently FAILING (0/1): after writing index 4 of `[1, true, null]`, index 3 reads as null instead of undefined. Direct Node execution of the identical compiled artifact reports kind 1 for both index 2 and the gap at index 3, so Rust conversion is not the cause.

New minimal failing compiler regression: `tests/issue-4376-realm-array-sparse-write.test.ts` in the js2 worktree. `pnpm exec vitest run tests/issue-4376-realm-array-sparse-write.test.ts` fails 0/1 (probe returns 0, expected 1). Its controls verify the existing null and newly written numeric value before testing the hole. The binary has no imports. This is intentionally not skipped or normalized by the bridge.

Next investigation: `scanForArrayHoles` in `src/codegen/array-holes.ts` sets hole demand from source patterns; generic any-typed indexed writes can create holes without a literal elision. Inspect the relevant growth/store and read-boundary paths before changing demand gates. This is a hypothesis, not a verified root-cause patch. Array support is not complete while this regression fails. Changes remain local and uncommitted.

### 2026-09-08 main sync and sparse-array bridge fix

Fetched `https://github.com/loopdive/js2.git main`: `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`. Both the main working branch and `codex/4376-deno-descriptor-carrier` already include it (one local commit ahead, zero behind). No merge or stash was needed; unrelated main-worktree edits were preserved.

Indexed assignments now activate hole handling before function compilation. Ordinary reference-vector growth uses the hole sentinel without incorrectly switching its struct carrier to the base type. Dynamic reads hide the sentinel and consult inherited indices. The shared presence observer now handles these holes; `in` consults prototypes while `Object.keys` uses an own-property predicate. The expanded regression first failed at inherited presence, then at inherited-key exclusion, and now passes both configurations.

Measured: sparse mixed-array regression 2/2; sparse-tail suite 17/17; ordinary indexed-set descriptor suite 2/2. The descriptor suite requires `--experimental-wasm-exnref` in Vitest's fork `execArgv`, not merely the parent Node invocation. The bridge fixture rebuilt successfully and `public_objects_use_compiled_realm_and_preserve_identity` passed 1/1 in embedded Wasmtime (30.67 seconds), including array holes, boolean/null values, functions, receiver calls, identity and failure propagation. `pnpm run typecheck` passed; plain `tsc --noEmit` used the wrong project configuration and failed.

Full conformance and the previously observed reduce-test discrepancy have not been revalidated. This is a local uncommitted compiler/runtime checkpoint, not a completed Deno integration. Automatic realm attachment/seeding, Rust-host callbacks, complete reflection/value support, full pinned core artifact rebuild, signing and publication remain outstanding.

Final candidate uses `ctx.oracle.typeFactOf` for pre-scan demand, conservatively enabling holes for unresolved and union receivers. Repeated focused suite: 21/21 passed with exception support enabled in the workers. Configured typecheck, LOC/function budgets, coercion-site and oracle ratchets passed; diff whitespace check passed.

`check:dead-exports` exited zero but reported only preservation evidence (6/6 source and cut witnesses). Its strict production-rooted closure remained open at nonliteral dynamic imports in `src/optimize.ts` and `src/runtime/platform-capability-adapter.ts`. Do not describe that output as full retirement/deletion certification. No source deletion is proposed here.

### Host object graphs can enter the compiled realm

Added local v8x `src/js2wasm/realm_host_values.rs`. Public Set and Function argument conversion can now adopt ordinary host object graphs and dense arrays. An iterative preflight snapshots the reachable graph, validates same-realm references, and rejects unsupported values before any bindings are published. All object handles are allocated before properties are defined, preserving cycles and aliases. Bindings are published only after initialization, so original Rust object identity is retained and subsequent Get/Set reaches the compiled realm.

The compiled bridge now exports `__v8x_value_define_data`; Rust transport validates realm ownership before invoking it. Transfer uses own data-property definition rather than assignment, preserving attributes and treating `__proto__` as an own key. The builder export list now contains 17 names. No pinned full-core artifact was rebuilt.

Measured through public Rust APIs and embedded Wasmtime: `transfers_host_graph_without_losing_identity_or_descriptors` passed 1/1 (46.83 seconds), covering cycles, aliases, array member identity, read-only/non-enumerable/non-configurable data properties, an own `__proto__` value, and a Wasm mutation observed via the original Rust child wrapper. `rejected_host_graph_can_be_repaired_and_retried` passed 1/1 (39.54 seconds), proving a nested unsupported host function leaves the target global unchanged and the original graph repairable before a successful retry. Ordinary backend suite: 17 passed, 6 ignored, 2 packaging-artifact tests filtered. Compiler-free cargo check passed with the existing unused realm_global warning. Diff whitespace check passed.

Limits remain explicit: host functions, symbols, exotic values, explicit prototypes and internal fields are rejected; full reflection is not forwarded. Host ArrayState currently stores new/grown slots as undefined rather than distinguishing holes, so this does not prove sparse host-array parity. Failed Wasm initialization can leave unreachable handles rooted until realm disposal, consistent with the existing unreleased handle table. Automatic production context attachment/seeding remains pending host callbacks; the diagnostic attachment still requires an empty global. Changes are local and uncommitted.

### Generic Rust host callbacks and synchronous re-entry

Added the `RealmAccess` interface, implemented by both DenoRuntime and a Wasmtime Caller-backed adapter. The store records the immutable realm instance/id after instantiation. Callback access is scoped to the synchronous stack using a thread-local stack, an RAII pop guard, and a RefCell lease; it does not reborrow the outer DenoRuntime while Wasm is executing. Nested Wasm-to-Rust calls receive their own Caller adapter. The native callback invocation entry is separate from public Function dispatch to avoid routing the callback back into itself.

The bridge now imports `v8x:deno::__v8x_host_call` and exports `__v8x_value_host_function` and `__v8x_value_error` (19 bridge exports total). Host functions in object graphs are supported, retaining their original Rust callback/data and stable wrapper identity. Registry ids are validated as integers and checked against the invoking realm; pointers are not passed to Wasm. Receiver/arguments/results stay in the owning realm. Rust exceptions use a negative result-handle encoding that the compiled wrapper throws; TypeError/RangeError/Error creation is supported, but full custom exception identity/type fidelity is not complete.

Measured initial callback regression: `calls_rust_from_wasm_with_nested_reentry_and_caught_exceptions` passed 1/1 in 76.92 seconds. It exercises Wasm -> Rust array reads / object mutation -> Wasm -> a second Rust callback, original object identity, receiver identity and a Rust-thrown TypeError caught by Wasm. Graph-transfer tests subsequently passed 2/2 in 65.43 seconds; the rejected-value test now uses a Symbol because host functions are supported. Ordinary suite: 17 passed, 7 ignored, 2 packaging tests filtered. Compiler-free cargo check passed. Builder/source syntax and whitespace checks passed. The exact bridge fixture has one audited host import instead of zero.

The extended callback regression is NOW FAILING 0/1: a construction rejection check was added because constructor callbacks remain unsupported. The wrapper has a new.target guard, but dynamic `new host()` does not reliably execute its body. A new compiler regression `tests/issue-4376-dynamic-host-constructor.test.ts` isolates this without any imports: ordinary invocation of a factory-returned captured closure produces -7 as expected; construction leaves the marker at 0 instead of producing 7, in both standalone/default and standalone/deno (0/2). An earlier simpler direct Node probe independently produced 0 without throwing. This is not yet proof of only a new.target defect: the constructor body itself is skipped.

Next compiler investigation: `tryCompileNativeConstructFromValue` in `src/codegen/expressions/new-super.ts` has static eligibility predicates that can decline a factory-returned any value. Later dynamic-TA fallback arms can yield null for a non-TA closure and return. Determine the exact emitted path, then repair actual closure dispatch and new.target semantics with positive/negative controls and adjacent constructor tests. Do not delete the failing construction test or treat ordinary callback success as complete constructor support. Automatic Deno global attachment/seeding, complete value/reflection behavior, full pinned artifacts, signing and publication remain open. Changes are local and uncommitted.

### Dynamic constructor dispatch and ordinary-function new.target checkpoint

The prior failure had two mechanisms. A const any local initialized by a factory could miss native constructor dispatch; an admitted ordinary function-expression constructor executed but its new.target read was statically lowered to undefined. Added factory-constructor-value.ts with a narrow source proof: const call result, unchanged single-return ordinary factory, ordinary non-async/non-generator returned function, and no dynamic-code demand. The proof declines uncertain/mutable alternatives, including destructuring and loop writes.

Added ordinary-new-target.ts. The native constructor driver installs the actual callee as a pending externref NewTarget. Lifted ordinary function expressions capture and consume that slot at entry, giving each frame a stable local and preventing nested ordinary calls from inheriting it. The driver restores the pending slot on normal and tagged-exception exits. Generic value, typeof and class-comparison lowering honor that local; existing class-id handling is retained for class constructors. The pending slot must use canonicalUndefinedExternInstrs, not ref.null.extern: the latter was a verified null/undefined mismatch, exposed by the nested-call regression before correction.

Measured final candidate: issue-4376-dynamic-host-constructor.test.ts 4/4 passed across standalone/default and standalone/deno, including actual callee identity, ordinary versus constructed invocation, nested ordinary calls, a throwing constructor and subsequent calls. issue-4376-factory-constructor-proof.test.ts 9/9 passed. Existing class new.target suite 7/7 passed. Adjacent issue-3981 suite was 13/14 on the candidate; the same prototype-link test failed with the same object-versus-11 output on a fresh source archive of baseline 18180e82ce0da8aa991af5f9e41dc16c6f94a23d at /private/tmp/js2-constructor-baseline.kr48NX, using the same standalone harness and dependencies. It is not attributed to this candidate.

Rebuilt the exact bridge fixture with the final compiler and ran calls_rust_from_wasm_with_nested_reentry_and_caught_exceptions through embedded Wasmtime: 1/1 passed in 77.71 seconds, including the newly added construction rejection. The earlier failing extended callback regression is now green. Configured typecheck passed. LOC/function budgets (with dated issue grants), coercion and oracle ratchets, and whitespace checks passed.

Scope limits: this does not complete lexical new.target capture in arrows, all named/fnctor/typed-constructor entry paths, Reflect.construct with a separate NewTarget, arbitrary unknown factory results, or cross-module constructor dispatch. The adjacent prototype defect remains on baseline. Full Deno integration still needs production context attachment/seeding, broader value/reflection coverage, rebuilt pinned full-core artifacts, and signing/publication. Changes remain local and uncommitted.

### Main synchronization and populated-context attachment (2026-09-08)

Fetched loopdive/js2 main at 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0 (six new commits). Merged into codex/4376-deno-followup-20260908 with signed merge d45d7a9177bbcf77e9a5ce2c75cb2815ca52f103. Unrelated src/ir/lower.ts and website/public/acorn/acorn.wasm edits were preserved.

Active compiler continuation is now /private/tmp/js2-deno-main-sync-20260908 on codex/4376-deno-realm-main-sync, based on that merge. The tracked HEAD diff and five new compiler/test files from /private/tmp/js2-poc-fixed2 were applied as patches with no conflicts, not copied over newer source files. The original dirty worktree remains untouched as a recovery checkpoint. Main ancestry and diff whitespace checks passed.

Configured typecheck passed. Five focused suites passed 25/25: factory constructor proof, ordinary constructor/new.target, sparse array writes, inferred descriptor parameters, and incoming main's conditional-alias property-write regression. Rebuilt the context bridge using this updated compiler; Node identity, callable, UTF-16, NaN, signed-zero and invalid-handle checks passed.

Continued v8x in /private/tmp/v8x-deno-followup-20260908: graph transfer accepts an existing root handle, and the diagnostic attachment seeds a populated global instead of rejecting it. Graph cycles back to the host global map to the actual compiled global. Repeat attachment is rejected. This remains diagnostic attachment, not production bootstrap: seeding after core initialization could replace captured Deno/core objects, so production sequencing still requires a separate implementation. Compiler-free cargo check passed (existing unused realm_global warning). Populated-global Rust regression passed 1/1 in 38.40 seconds, including cycles through the existing global, aliases, descriptors, dense arrays and mutation observed through the original Rust wrapper. The callback/nested-reentry/caught-exception regression also passed 1/1 in 38.40 seconds using the newly rebuilt artifact. A final ls-remote still reported main at 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0. The merge is committed locally; compiler/runtime continuation changes remain uncommitted and nothing was pushed.

### Production bootstrap publication and initialization hook

The previous turn made verified progress. Production deno_core_bootstrap_runtime_from_env now uses instantiate_published and publishes directly into ContextState before deferred module initialization. The bridge setup precedes initialization. A phase-zero retry with an existing bootstrap owner is rejected; a failed initializer retains its original owner rather than replacing values/callbacks with a fresh realm.

Added the __v8x_attach_context host import. It validates a nonzero owner identity against the current context's retained Rc, then uses CallerRealm to seed the host global during Wasm initialization without reborrowing DenoRuntime. The store holds an equality token, never dereferences that address and does not hold a non-Send Rc/Weak. An initial Weak design failed ResourceLimiter's Send bound and was replaced.

For the runtime builder profile, bridge handles now initialize in runtime-seed before the attachment hook and core imports. Entry re-exports the bridge from that module. Provenance hashes the actual generated seed. POC profile retains its existing append behavior. named_property/set_named_property now route bound objects through the realm; attached core callback installation validates genuine functions instead of replacing them with legacy stubs on the frozen core object.

New fixture mode (fourth argument bootstrap) compiles deferred initialization that imports the hook, reads hostNumber=42 during initialization, writes initializedFromHost=43, and optionally throws afterward. Node compilation/execution checks passed. The Rust regression attaches_host_context_during_bootstrap_and_retains_failed_owner covers successful and failed initialization plus rejected owner replacement. It is currently running. Compiler-free cargo check passed, with instantiate now unused in that profile. Full pinned Deno boot remains unverified, and further host-value/exotic compatibility gaps are expected to surface when it is rebuilt. Changes remain local and uncommitted.

The initial single-source Rust bootstrap regression passed 1/1 in 183.88 seconds (two contexts and two rejected replacement attempts). Ordinary backend suite passed 17/17 executed tests; eight artifact-dependent tests were ignored and two packaging tests filtered.

A follow-up fixture matching the builder's multi-module layout exposed missing Wasm exports through export-star: __v8x_value_global was not a function at the initialization hook. The builder and fixture now use explicit typed entrypoint forwarders generated from all 19 bridge signatures, with completeness and parameter-shape validation. This is ABI glue, not a fix or claim of general compiler re-export support. The actual value table remains in the seed module before core initialization. The multi-module fixture passed direct Node compilation/execution checks. Its Rust run is currently in progress. Diagnostic duplicate-bootstrap rejection now happens before recompiling the fixture, matching the production phase-zero preflight.

Multi-module primitive-seeding Rust regression passed 1/1 in 78.02 seconds. The fixture was then strengthened: core initialization calls a Rust-hosted hostCallback(42), expecting 43, before the optional throw. This rebuilt multi-module callback fixture passed Node checks and is running through Wasmtime. This extra case directly covers host-op calls during initialization, rather than inferring them from a post-boot callback test. Syntax checks, compiler-free cargo check and diff whitespace checks passed.

Final multi-module host-callback bootstrap regression passed 1/1 in 87.04 seconds in embedded Wasmtime. Both successful and throwing initialization invoke the Rust callback during the core-module body and expose initializedFromHost=43 through the retained context global. Repeated bootstrap attempts are rejected and the result remains accessible. This validates the hook/publication/Caller route, not a complete Deno core boot. Full pinned artifacts must now be rebuilt from committed clean inputs; signing worked for the last main merge, so the earlier locked-key observation must not be treated as a current blocker without rechecking. Remaining work includes real core host-op/exotic-value gaps, removal of runtime POC shims, full Deno application execution, and publication. Nothing was pushed in this turn.

### Signed checkpoints and full pinned runtime build

Compiler inventory validation initially failed because factory-constructor-value.ts and ordinary-new-target.ts were unclassified. Added both as unmigrated/mixed-needs-split, not as completed architecture. Inventory mode now reports inventory-valid-architecture-incomplete with zero errors. Oracle/coercion ratchets and typecheck passed; commit hooks passed formatting, lint and LOC/function budgets.

Signed compiler commit: d8841e9e7f7ef502d51a6165788cd55c2e75a24a on codex/4376-deno-realm-main-sync. Signed v8x commit: 2c963a67c4d2c8319a3b12b716884642a96681b8 on codex/4376-deno-realm-bootstrap. The first signing attempt failed because this shell lacked SSH_AUTH_SOCK. launchctl getenv SSH_AUTH_SOCK returned /var/run/com.apple.launchd.PiCv9LrvUs/Listeners; ssh-add -l on that socket confirmed the exact configured key fingerprint. Retrying with that agent connection succeeded without changing signing settings. Neither branch has been pushed.

Clean detached inputs: /private/tmp/js2-deno-pinned-20260908 (d8841e9), /private/tmp/v8x-deno-pinned-20260908 (2c963a6), /private/tmp/deno-4376-clean (1d4e6c1). The unmodified strict runtime-profile builder completed using these inputs:
- /private/tmp/deno-realm-artifacts.QKbqDv/core.wasm: 11,132,226 bytes, SHA-256 86319d1d9b40bf74a8c6cd6906e27dae7f91a22308c9f01e41bd1536b5fd9cb3.
- provider.wasm: 25,312,089 bytes, SHA-256 efebe30fdbee030c22f5fe746924707a50bf5d41102900c95fd4fb7d233f29ad.
- provenance.json is in the same output directory.
The builder passed raw bootstrap validation with stub imports and interpreter provider canaries. This is not real Rust-host Deno boot. Intentional v8x:deno imports still trigger the compiler's standalone host-import warnings.

A separate Deno run worktree, /private/tmp/deno-realm-run-20260908, has only Cargo.toml/Cargo.lock changed. Core sources and hello_world.rs remain unchanged. Cargo.toml aliases the local v8x package with simdutf, engine_js2wasm and js2wasm_diagnostic_abi. Applied the existing zero-context Cargo.lock patch with --unidiff-zero. Cargo adjusted that lock for the compiler-free feature selection; one missing cached crate was fetched. cargo build --locked -p deno_core --example hello_world passed using CARGO_TARGET_DIR=/private/tmp/v8x-deno-followup-20260908/target. The resolved deno_core feature tree has engine_js2wasm/diagnostic ABI and no Cranelift, JSC, QuickJS or runtime compilation.

Live precompilation: exec session 4443 runs both precompiles_exact_ tests serially in /private/tmp/v8x-deno-followup-20260908, with core/provider raw paths above and AOT outputs core.cwasm/provider.cwasm in the same directory. At the last authoritative process inspection the test process (PID 30072) was alive at about 100% CPU after 2m37s, RSS about 827 MiB, still on core precompilation. Resume that session, do not restart solely because it is slow.

Next: once precompilation succeeds, run /private/tmp/v8x-deno-followup-20260908/target/debug/examples/hello_world with V8X_JS2WASM_DENO_CORE_AOT_MODULE and V8X_JS2WASM_RUNTIME_EVAL_AOT_MODULE pointing to those new cwasm files. Diagnose the actual host bootstrap failure or output without changing Deno's example. Full Deno integration is still incomplete.

The documentation now states the verified callback/init coverage and its limits. make -C site all could not render it because Typst is not installed; this remains a publication check, not a Wasm build blocker.

### Continuation-data bridge while full AOT compilation runs

Previous turn was verified build progress. The original precompile session 4443 remains alive; do not restart it as a missing process. Sampling PID 30072 showed Cranelift Wasm translation spending its time in SSABuilder::use_var / CompoundBitSet::clear in the debug compiler build. At 14m30s it was still CPU-active (about 99%, about 2 GiB RSS). The sample is /private/tmp/deno-realm-artifacts.QKbqDv/precompile.sample.txt.

Started an explicit release-build comparison in exec session 38308, with two Cargo build jobs and serial tests, leaving the original job running. It writes core-release.cwasm/provider-release.cwasm in the same artifact directory, so it cannot overwrite the debug job's outputs. This comparison follows the profiler evidence, not a presumed dead process or observation timeout. It is still building the release precompiler at the last check.

Found a real runtime-probe mismatch by source inspection: the generated runtime probe expects __capturedBootstrap on globalThis, but the actual pinned Deno op_set_captured_bootstrap stores a Global<Value> privately in ModuleMap data. The POC seed writes the global; the real host op does not. This probe must be revised against actual runtime publication semantics, not made unconditionally successful. No probe change has been made yet; preserve the first actual host-boot failure as evidence.

Also found missing continuation-data APIs in the js2wasm backend. Added src/js2wasm/continuation.rs and isolate state shared by native Context get/set APIs and the extras object's getContinuationPreservedEmbedderData/setContinuationPreservedEmbedderData callbacks. Native queued functions capture at enqueue; pending/settled native promise reactions capture at registration, carry that value into execution, and restore the caller's value afterward with an RAII guard. The value arena keeps these handles alive. This does not yet cover the separate compiled-JS promise scheduler.

Measured: two new focused tests passed. The expanded ordinary backend suite passed 19/19 executed tests, with eight artifact-dependent tests ignored and two packaging tests filtered. Coverage includes object identity in both directions between extras callbacks/native APIs, fresh-isolate default state, missing setter argument resetting to undefined, pending-vs-settled promise registration timing, and restoration after a throwing microtask. Compiler-free cargo check and diff whitespace check passed. The unchanged Deno hello_world executable was rebuilt successfully with these local host changes (cargo build --locked, 8.06 seconds). These continuation changes remain uncommitted on codex/4376-deno-realm-bootstrap.

Next: resume both live precompilation handles (4443 debug, 38308 release). Use the first complete pair to run the unchanged Deno example with compiler-free AOT-module environment variables; no interpreter/compiler source is required by the executable. Keep the exact source/artifact variant in the result. Full Deno boot and integration remain unverified.

### Real native-host bootstrap checkpoint after main sync

The release precompiler comparison completed: 2/2 exact-artifact tests passed in 184.71 seconds. Outputs are core-release.cwasm and provider-release.cwasm under /private/tmp/deno-realm-artifacts.QKbqDv. The original debug precompile session 4443 remains running on the provider; it has not been killed or restarted.

The unchanged pinned deno_core hello_world example now runs with the compiler-free v8x backend and this release AOT pair, but does NOT boot successfully. Its first real-host failure rejected Deno's global object because it has two native internal fields. Host graph adoption now retains those fields in the original Rust wrapper, without exposing pointers to Wasm. The strengthened bootstrap regression failed before this change and passed afterward, including a Wasm identity round trip and both field slots remaining accessible.

Added bounded decoding of pending bootstrap exceptions through the existing __exn_render_prepare / __exn_render_char exports. Rendering failure preserves the original Wasmtime error and clears any secondary pending exception. The fixture now checks the actual text "Error: requested bootstrap failure", not just a generic failure. Added optional V8X_JS2WASM_TRACE_HOST callback-name tracing.

Latest actual example result: exit 101, __module_init_chunk_4 throws TypeError: Cannot destructure 'null' or 'undefined'. With host tracing enabled, no host callback was entered before this failure. Do not attribute this to op_get_extras_binding_object without further evidence.

Separate confirmed ordering defect: pinned Deno runtime/jsruntime.rs initializes Deno.core namespace, executes 00_primordials and 00_infra, registers native ops, and only later executes the remaining core scripts. The current runtime artifact imports all four scripts eagerly and runs them during the first Script::Run request. Its numeric stage exports merely acknowledge stages after eager execution; they do not enforce native initialization order. This must become actual deferred script execution in one shared realm, with native op registration between infrastructure and core. Keep original Deno scripts unchanged; generate staging wrappers/exports in the artifact builder and invoke them at the corresponding host Script::Run boundary. Validate the order with a fixture whose later bootstrap phase requires a callback installed only after its first phase. Do not retain POC seed ops as a substitute for native registration.

Current measured checks: ordinary backend 19/19 executed tests passed (8 artifact-dependent tests ignored, 2 precompile tests filtered); bootstrap/internal-field/exception-message fixture passed 1/1. Compiler-free Deno build passed after the diagnostic change. cargo fmt applied and fmt check passed. Full Deno integration remains incomplete. Next investigate the precise nullish input in chunk 4, then implement the actual script-stage boundary and revise the runtime probe's POC-only __capturedBootstrap assumption. No new PR has been opened or pushed in this continuation.

### Deferred native bootstrap stages and promoted-capture compiler fix

Saved signed v8x checkpoint 9c50a91 on codex/4376-deno-realm-bootstrap. A new staged-core generator wraps the four original classic-script bodies and defers mod.js publication. Rust executes each stage at its actual Script::Run boundary; native op registration can now occur between infrastructure and timers/core. Runtime-profile POC ops, extras, timers and typed-array replacements were removed. Runtime validation checks initial phase zero rather than falsely claiming full bootstrap with stub imports; the real bootstrap probe runs after module publication and no longer requires POC-only __capturedBootstrap.

Node staging fixture passed. Fresh Rust-host fixture passed 1/1, including late native callback registration, rejected reordering, and refusal to retry a failed stage. Ordinary backend suite passed 19/19 executed (9 artifact-dependent ignored, 2 precompile tests filtered). The unchanged compiler-free Deno example rebuilt successfully. Full artifact build from clean v8x 9c50a91 and compiler d8841e9 failed before emission: script3 contained undefined local.get indices.

The reduced compiler cause is method/accessor capture promotion. Promotion keeps boxedCaptures metadata but deletes localMap so access uses capturedBoxGlobals. Function-value materialization tested boxedCaptures without checking whether its local still exists. It now chooses the existing shared global cell when the local is absent. Read-only captures of promoted boxed globals now load the inner value when their expected representation matches it, instead of placing a raw cell in an externref closure field.

New four-test regression measured 2/4 passing before the fix (unpromoted controls) and 4/4 after (both JS-host and standalone). Related capture suites brought the measured total to 24/24. A compileMulti reduction containing all four unchanged Deno scripts and mod.js now emits and WebAssembly.compile validates 5,198,491 bytes; this is not the full runtime artifact or evidence of boot. Initial typecheck caught optional promotedBox.valType, corrected with an explicit proven-type guard.

While building the staging fixture, assigning an exported function declaration directly to globalThis produced ReferenceError: moduleAnswer is not defined. The fixture uses an ordinary function expression for its test-only global accessor. This separate compiler defect remains unaddressed; do not mistake that fixture change for a compiler fix. Exploratory function-valued class/object capture examples also produced incorrect numeric results and need separate reduction before any broad closure-conformance claim.

Next: commit/pin the compiler correction, rebuild the exact full runtime artifact from clean pinned inputs, precompile using release Wasmtime, then run the unchanged Deno hello_world. The old debug precompile session 4443 remains CPU work in progress and must not be killed or restarted solely for slowness.
