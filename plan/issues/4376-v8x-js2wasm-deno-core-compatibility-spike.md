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
  # 2026-09-08: preserve Symbol brand and validate erased Symbol.keyFor arguments.
  - src/codegen/expressions/call-namespace-static.ts
  # 2026-09-08: immutable native Error construction identity and generic prototype hook.
  - src/codegen/registry/types.ts
  - src/codegen/registry/error-types.ts
  - src/codegen/disposable-runtime.ts
  - src/codegen/object-runtime-prototype.ts
  # 2026-09-08: delegate linked publication literal construction to shared-carrier proof.
  - src/codegen/literals.ts
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
  # 2026-09-08: validated native Symbol carrier unboxing for keyFor.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  # 2026-09-08: initialize the appended immutable Error identity field.
  - src/codegen/registry/types.ts::getOrRegisterErrorStructType
  - src/codegen/registry/error-types.ts::emitErrorStructConstructor
  - src/codegen/registry/error-types.ts::ensureNativeSuppressedErrorCtor
  - src/codegen/promise-combinators.ts::buildAnyRejectBody
  # 2026-09-08: publication construction/signature hooks; proof lives in linked-realm-literal.ts.
  - src/codegen/literals.ts::compileObjectLiteral
  - src/codegen/index.ts::resolveWasmType
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

### Exact staged artifact built; real Deno reaches async-op registration

Compiler correction committed and signed as d5e89399007ace10620be180224c36d0bdcd511a. TypeScript 7 typecheck, LOC/function-budget hooks and lint-staged passed. Active compiler checkout remains /private/tmp/js2-deno-main-sync-20260908, branch codex/4376-deno-realm-main-sync. Clean pinned compiler inputs are /private/tmp/js2-deno-staged-pinned-20260908 at that SHA, with ignored node_modules symlink to /private/tmp/js2-poc-fixed2/node_modules.

Active v8x branch now has signed commits 357e231f2caf0d68594b27c94e691afcfcfd3160 (synchronized compiler pins) and 8896bef29e16f8d67601dc03df546cb9a0f4b52f (remove eager duplicate inputs). The first pin-only rebuild still ran the original scripts: compileMulti includes all supplied sources, so simply deleting imports was insufficient. Runtime graph now deletes the separate core/*.js entries after embedding their unchanged bodies into staged-core.ts. Clean builder checkout /private/tmp/v8x-deno-staged-pinned-20260908 is detached at 8896bef.

Strict full runtime builder SUCCEEDED from those clean v8x/js2 inputs and clean pinned Deno 1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44. Artifacts:
- /private/tmp/deno-staged-artifacts.dLlzUS/core.wasm: 7,004,455 bytes, SHA256 1f3b4aaef6afd72590b5a8097a863e1910c715290bb24509422e052a3635f125
- /private/tmp/deno-staged-artifacts.dLlzUS/provider.wasm: 25,312,089 bytes, SHA256 efebe30fdbee030c22f5fe746924707a50bf5d41102900c95fd4fb7d233f29ad
- provenance.json in that directory records the exact graph and pins.
- core-release.cwasm and provider-release.cwasm: new release precompilation session 81595 finished, 2/2 passed in 170.28 seconds.
- Old debug session 4443 finally finished, 2/2 passed in 4208.54 seconds. It is terminal; do not poll/restart it.

Raw Wasm check: __module_init leaves __v8x_deno_script_phase at 0; running script phase 0 returns 1. This is real compiled primordials execution, not full native-host boot.

The unchanged native Deno example now passes primordials AND infrastructure and reaches libs/core/runtime/bindings.rs:585, where native async-op registration calls compiled Deno.core.setUpAsyncStub. This call returns an empty handle after a compiled exception. Added uncommitted diagnostics in v8x src/js2wasm_realm_values.rs (render pending realm-call exceptions through existing render exports) and src/js2wasm/realm_objects.rs (log report() errors only with V8X_JS2WASM_TRACE_HOST). The actual decoded failure is:
TypeError: Function.prototype.apply is not yet implemented in --target standalone
Backtrace: __runtime_eval_unwrap_call_result -> __apply_closure -> __closure_method_call -> __extern_method_call -> __call_m_apply_2 -> __v8x_value_call.
Do NOT attribute the current failure to op argument length without stronger evidence.

Latest exact native command, cwd /private/tmp/deno-realm-run-20260908:
V8X_JS2WASM_TRACE_HOST=1 V8X_JS2WASM_DENO_CORE_AOT_MODULE=/private/tmp/deno-staged-artifacts.dLlzUS/core-release.cwasm V8X_JS2WASM_RUNTIME_EVAL_AOT_MODULE=/private/tmp/deno-staged-artifacts.dLlzUS/provider-release.cwasm /private/tmp/v8x-deno-followup-20260908/target/debug/examples/hello_world
It exits 101 with the decoded error above. Deno libs/core remains unchanged; only Cargo.toml/lock are patched. Both fresh AOT artifacts were used in this latest run. An earlier run reused the previous byte-identical provider AOT while fresh provider precompilation was still running; it reached the same native unwrap panic.

Next compiler task: implement the real first-class Function.prototype.apply native method body, not a syntax-only special case or a bypass of the realm call.
- src/codegen/array-object-proto.ts around2496 wires Function prototype toString and @@hasInstance but no apply native body.
- src/codegen/native-proto.ts around1118 generates the exact refusal above when glue.emitMemberBody returns null.
- Existing reserveApplyClosure(ctx) in object-runtime.ts around7357 provides (fn, receiver, argVector) -> externref with compiled/interpreter/proxy dispatch. This is the call target to reuse, not recursively invoking property .apply.
- call-namespace-static.ts around1865 contains Reflect.apply array-like-list materialization; reuse appropriate helpers/semantics, including IsCallable and CreateListFromArrayLike, null/undefined -> empty list for Function.prototype.apply, getter order, receiver preservation and thrown-value propagation.
- Native-prototype closure ABI: local0=self, local1=target function (method this), local2=thisArg, local3=argArray. Look at function-proto-has-instance.ts for wiring style.
- Existing context-value bridge uses callable.apply(receiver,args). It worked before primordials materialized Function.prototype's first-class methods. Do not hide the missing intrinsic by changing that bridge to a special-case call.

Separate confirmed future gap by source inspection: v8__FunctionTemplate__New and v8__Function__New currently ignore their _length argument; allocate_function supplies name but no length property. Deno's setUpAsyncStub selects originalOp.length - 1. Fix and regression-test native function arity, including preservation across realm transfer, once the current apply refusal is resolved. No arity fix was made yet.

No PR pushed/opened during this continuation. Full Deno integration is NOT complete. Do not mark goal complete; no external-authority blocker exists.

### First-class apply continuation after verified main sync

Fetched https://github.com/loopdive/js2.git main again: 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0 is already an ancestor of the continuation HEAD d5e89399007ace10620be180224c36d0bdcd511a. No additional merge or stash was necessary. Main workspace unrelated edits remain untouched.

Implemented Function.prototype.apply as a native first-class closure through reserveApplyClosure. It validates the callable first, admits null/undefined as empty argument lists, materializes array-like arguments before invocation, and propagates getter/target exceptions. Registered the helper in compiler-boundaries.json as unmigrated mixed-needs-split; this is not architecture closure. The existing apply arity was already 2.

Focused standalone suite: 12/12 passed using a Node child with --experimental-wasm-exnref. Tests cover receiver and arguments, null/undefined lists, getter order, five primitive list brands, non-callable target ordering, getter throws and target throws. Typecheck passed. LOC/function/coercion/oracle ratchets returned success. Dead-export command returned zero but explicitly reports preservation-only 6/6 and open production-rooted architecture; do not call that architecture complete.

Separate unresolved defect found while isolating the intrinsic: Reflect.apply(a, fn, [null, [42]]) returns NaN where the explicit array-typed form Reflect.apply(a, fn, [null, [42]] as any[]) returns 42, with a = Function.prototype.apply and fn = function(x:number){return x;}. The heterogeneous untyped argument literal is emitted as a tuple carrier that the existing generic call bridge does not read correctly. The focused suite uses an invoke(target:any, receiver:any, args:any[]) helper to isolate the intrinsic, not to claim tuple support. Preserve this defect as follow-up work; do not treat the 12/12 result as coverage of all array representations.

The first adjacent run was 25/37: eight absent test262 files and four exception-support failures. A self-contained rerun was 22/26 because vitest.config.ts overrides fork execArgv, stripping parent flags. Use startVitest with explicit poolOptions.forks.execArgv including --experimental-wasm-exnref for those existing suites. Do not alter global test configuration or fetch/run a Test262 sweep for this check.

Full Deno artifacts have NOT been rebuilt with this apply implementation. Last actual native bootstrap remains the apply refusal at async-op registration described above. Next: finish adjacent checks, commit/pin this compiler checkpoint, update v8x compiler pins, build clean exact artifacts and rerun unchanged Deno. Native function length and tuple-carrier handling remain separate follow-ups.

Worker-level exception-flag override completed: 26/26 tests passed across five self-contained suites (first-class apply, promoted function values, Function.prototype @@hasInstance, callable Function.prototype, Reflect/Proxy review regressions). This replaces the instrument-limited 22/26 result, not the missing external Test262 rows.

### Native bootstrap reaches 01_core.js after first-class apply and callback arity

Verified compiler HEAD 2cb538dec286690b2a79d41352ad7550c71b3237. Runtime pin checkpoint a3eaea9 synchronizes all six compiler-reference occurrences. New clean detached builder inputs: /private/tmp/js2-deno-apply-pinned-20260908 at 2cb538dec28669 and /private/tmp/v8x-deno-apply-pinned-20260908 at a3eaea9; Deno remains clean 1d4e6c1 in /private/tmp/deno-4376-clean. Strict runtime-profile build passed.

Artifacts in /private/tmp/deno-apply-artifacts.CBdJnT:
- core.wasm: 7,004,738 bytes, SHA256 86c58001c1a7c06da67231ad03fcea216ecaa08b6b2871461050691c31404e36.
- provider.wasm: 25,312,089 bytes, SHA256 efebe30fdbee030c22f5fe746924707a50bf5d41102900c95fd4fb7d233f29ad.
- provenance.json records the exact clean inputs.
- core-release.cwasm and provider-release.cwasm: release precompile session 6528 completed 2/2 in 170.70 seconds. No live precompile process remains.

First real Deno run with the new core but old native runtime still failed in async-op registration; payload renderer returned -1 instead of the previous apply refusal. That run used the byte-identical previous provider AOT while duplicate provider precompilation finished. Do not attribute the new error to apply without evidence.

Added native length regression for FunctionTemplate and Function builders with arities 0,1,3,8: failed before (length was undefined), passed after. Signed runtime checkpoint 2194c76 stores declared template length and publishes native Function length in the host property graph with read-only/non-enumerable/configurable attributes. Existing bootstrap callback fixture strengthened to check length 3 after actual realm adoption: passed 1/1 using .tmp/bootstrap-context-callback.wasm. Ordinary backend passed 20 executed tests, with 9 artifact-dependent tests ignored and 2 precompile tests filtered. The attempted GetPropertyAttributes assertion exposed a missing ABI symbol; this extra assertion was removed, not implemented, so do not claim that API is supported. Length value transfer is tested; descriptor flags are set by implementation but not independently asserted through that missing API. Cargo fmt passed; Typst docs updated but renderer remains unavailable.

Rebuilt unchanged Deno example with CARGO_TARGET_DIR=/private/tmp/v8x-deno-followup-20260908/target cargo build --locked -p deno_core --example hello_world in /private/tmp/deno-realm-run-20260908. Only Cargo.toml/lock differ, git diff --exit-code -- libs/core passed. Final actual run used both new AOT files with V8X_JS2WASM_TRACE_HOST=1. It took minutes at high CPU; sampling confirmed progress in execute_virtual_ops_module/create_exports_for_ops_virtual_module, not a deadlock. The process/session 19609 is now TERMINAL, exit101.

Latest actual boundary: native async-op registration succeeds far enough to execute 01_core.js (script phase3). Trace invokes op_get_extras_binding_object then op_get_ext_import_meta_proto. The latter callback return fails with: host object with an explicit prototype cannot yet enter the realm. Backtrace __closure_46 -> script3 -> __fn_tramp_script3_cached -> __call_fn_method_0 -> __apply_closure -> __runtime_eval_call_aot -> __apply_closure -> runScript. Deno reports Failed to execute ext:core/01_core.js at runtime/jsruntime.rs:743. Full boot is not done.

Next required implementation: preserve explicit prototypes during host graph adoption. src/js2wasm/realm_host_values.rs snapshot currently rejects any ObjectState.prototype.is_some(). Do not drop the prototype or substitute an ordinary object. Snapshot prototype edges (including null and shared/cyclic object graphs), allocate all nodes first, then set each explicit prototype through the compiled realm before publication. Existing context-value-bridge.mjs has no get/set-prototype export yet; add typed forwarders and Rust RealmAccess support consistently, and cover null and object prototypes plus identity through a fixture before another strict pinned artifact rebuild. Deno op_get_ext_import_meta_proto in ops_builtin_v8.rs:1330 returns the stored native object; 01_core.js:794 writes its log function. Keep those sources unchanged.

Runtime branch codex/4376-deno-realm-bootstrap is clean except untracked .tmp fixtures; HEAD2194c76 includes the previously uncommitted exception diagnostics. No PR pushed or opened in this continuation. Goal remains active with no external blocker.

### Explicit-prototype adoption and Reflect status correction

Implemented prototype edges in runtime realm_host_values graph snapshots: retain null and shared object prototypes, traverse prototype nodes before allocation, install prototype edges after all handles exist, and publish only after initialization. Added live Rust GetPrototype/SetPrototype realm routing and two typed bridge exports. Rust transfer fixture covers shared prototype identity, inherited values, null, legal property cycles, rejected prototype cycles and post-adoption updates. Initial Node/Rust cycle assertions failed because standalone Reflect.setPrototypeOf returned true even when its writer rejected the cycle.

Compiler correction in call-namespace-static.ts consults existing __object_setPrototypeOf_status before writing and returns false for ordinary cycle/non-extensibility refusals. Dynamic operands use the strict native Reflect object guard, permitting only null as a primitive prototype. Preserves Object.prototype immutable handling. Does not claim general proxy trap status or every exotic carrier. Nine focused tests pass. Node bridge assertions and three Rust context/graph transfer tests pass with .tmp/context-prototypes-fixed.wasm; ordinary runtime 20/20, ten artifact-dependent tests ignored, two precompile tests filtered.

Additional independent compiler limitation: direct Object.preventExtensions(a) on an Object.create carrier did not establish runtime non-extensibility in the first test; routing through function prevent(target:any) { Object.preventExtensions(target); } makes that condition real and the rejection test passes. Keep this separate from status-helper correctness and do not claim it fixed. Full Deno artifacts still use the earlier pins until these changes are committed and rebuilt.

Wider compiler run: 42/44 passed across new prototype-status (9), apply (12), and existing issue-5268 object/array (23). Exact clean baseline 2cb538dec28669 reproduced the same two proxy freeze/defineProperty failures (21/23); candidate has no new failures in that adjacent suite. Typecheck and source-ratchet gates passed; dead-export command still reports the previously documented open architecture despite exit0.

Prototype checkpoints committed: compiler a1d57eed58cb672c76e2afd3caf603f1eb7a42a4 and runtime 23e81f0d69f117ecc5ebe919de819da4756ec26c. Clean detached pins at /private/tmp/js2-deno-proto-pinned-20260908 and /private/tmp/v8x-deno-proto-pinned-20260908. Strict runtime builder passed; artifacts /private/tmp/deno-proto-artifacts.cIgQAh/core.wasm (7,077,019 bytes, SHA256 3f8baf77f57df7a5ed376a1c2009d2640bd05d92a02e22840a6405aa537ba7ed) and provider.wasm (25,312,089 bytes, unchanged efebe30fdbee030c22f5fe746924707a50bf5d41102900c95fd4fb7d233f29ad), with provenance.json. Native Deno build passed against runtime23e81f0.

Precompile session56751 has completed core-release.cwasm and is still running the provider as of the last verified poll. Native replay session82073 is also live, using the new core AOT and byte-identical provider AOT from /private/tmp/deno-apply-artifacts.CBdJnT. Do not restart either solely on timeout. Final result pending. Replay manifest finalizer currently pins Linux x86_64; these macOS diagnostics are not evidence that the Linux clean replay packaging gate passed.

Both jobs above are now TERMINAL. Precompile56751 passed2/2 in173.14seconds and produced both core-release.cwasm and provider-release.cwasm in deno-proto-artifacts.cIgQAh. Native replay82073 exited101. It progressed past explicit-prototype transfer and called op_get_extras_binding_object, op_get_ext_import_meta_proto, and op_set_captured_bootstrap. Latest failure remains phase3 (01_core.js): Error: queueMicrotask is already defined. Backtrace __runtime_eval_unwrap_call_result -> __apply_closure -> runScript. This is not proof of a preinstalled global collision.

The actual throw is 00_primordials.js:596-600: a captured let queueMicrotask = undefined is shared by its descriptor getter and setQueueMicrotask(value); setter throws when the captured value is already non-undefined. 01_core.js:1300 assigns its wrapper to globalThis and line1301 calls that setter. Next investigate whether the setter sees the same capture cell as the getter, whether a name-based alias resolves the global wrapper, or whether a previous initialization really assigned it. Do not delete/reinitialize the global to hide this.

Read-only raw-artifact probe on current core.wasm (Node Wasm exceptions, stub imports used ONLY for primordials): __module_init phase0; runScript(0) phase1; reading __bootstrap.primordials.queueMicrotask through the real getter returns kind0 (undefined). Thus primordials initialization itself exposes the expected getter value. This is a narrow capture probe, not a native-host boot. Need reduced getter/setter shared-cell tests and/or inspect the live native phase boundary before assigning blame. Full integration remains incomplete; no processes are left running from this turn and nothing was pushed.

### queueMicrotask first-assignment failure reduced to inline capture storage

Raw current-artifact probe now calls setQueueMicrotask immediately after runScript(0), before infra or any other Deno stage: getter reports kind0, but the first setter call throws the same already-defined Error. Therefore later Deno/global initialization is not the cause. Small untyped JavaScript getter/setter closures work, including a variable named queueMicrotask. A TypeScript initializer wrapped in an exported stage function reproduces the throw, including with an explicit any annotation.

Generated Wasm identified two defects. First, canBoxBindingInDominatingParent treated an inline IIFE source body as if its preceding declarations already appeared in the outer stage activation buffer. It allocated the shared cell before the detached inline block, copying the raw null default; the block then initialized only the raw local to undefined. Added source-owner equality to the hoisting proof so an inline IIFE uses ordinary lazy shared-cell construction at the proper point. Both typed and inferred reduced setter first calls then stop throwing.

Second, the inferred-undefined getter was emitted with a void Wasm result: its cell read was followed by drop; return. The earlier getter kind0 probe therefore masked the stale null cell rather than proving its correct initialization. Preserve an explicit value-returning closure ABI when TypeScript infers undefined; keep contextual void (distinct from undefined) callbacks void. Reduced numeric cases now preserve the shared updated value and reject a second assignment without changing it. Added callable identity/invocation cases matching Deno.

Typecheck and LOC/function/coercion/oracle ratchets passed. Wider check 72/74 across six suites; exact clean baseline a1d57eed58cb67 reproduces the same two failures in illegal-cast-closures-585 (stale prepared class descriptor) and issue-3214-void-host-callback (non-void preclaim diagnostic). Baseline subset35/37, candidate unchanged there. New four-case callable/numeric stage suite result follows. Full Deno has not been rebuilt with these capture fixes yet.

Final new stage-capture suite passed4/4: inferred and any-typed cells, each storing either a number or a callable, preserving identity, callable invocation and second-assignment refusal.

### Capture-fix pinned rebuild

Verified signed compiler b55a4b7a0fe6bee2a561994666af10158b6dcab4 and runtime pin cf127c5. Fresh fetch of loopdive/js2 main remains 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0 and is already an ancestor. Clean detached input worktrees: /private/tmp/js2-deno-capture-pinned-20260908 and /private/tmp/v8x-deno-capture-pinned-20260908. Strict runtime-profile builder passed (session2069 terminal exit0).

Artifacts in /private/tmp/deno-capture-artifacts.jzM6ey: core.wasm 7,076,996 bytes, SHA256 3cfe0fa97da732d232c7210b8c5a0133e878c278b90ae84b8fbb41aeb3700ed3; provider.wasm 25,312,089 bytes, unchanged SHA256 efebe30fdbee030c22f5fe746924707a50bf5d41102900c95fd4fb7d233f29ad; provenance.json records pinned inputs. Release core precompile passed1/1 in32.87seconds (session96512 terminal). Native replay session51986 started with new core-release.cwasm and byte-identical provider-release.cwasm from deno-proto-artifacts.cIgQAh. Deno libs/core diff remains empty. Final replay outcome pending; do not infer boot from artifact success.

Native replay51986 is now TERMINAL, exit134. It passed the previous queueMicrotask first-assignment failure and reached op_print, but stdout was [object String], not the expected example output. Trace: op_get_extras_binding_object, op_get_ext_import_meta_proto, op_set_captured_bootstrap; three host-value-conversion unsupported-type diagnostics; op_print(2 arguments); classic script threw TypeError: Array.prototype.toString is not yet callable as a value in --target standalone; then diagnostic ABI abort v8__Private__ForApi. No native processes remain from this rebuild. This is progress through core initialization, NOT a completed example or full Deno integration.

Next boundaries: compiler src/codegen/array-object-proto.ts native array member fallback near946 must implement first-class Array.prototype.toString faithfully (including callable join lookup and Object.prototype.toString fallback), not swallow it. Separate runtime src/js2wasm/realm_objects.rs:58 unsupported host conversion messages and [object String] output need diagnosis. Error-reporting Private API is currently only a diagnostic symbol in src/js2wasm/diagnostic_abi_symbols.txt; other backend implementations exist but must not be blindly copied or make private keys visible to JS. Preserve each failure separately and cover reduced positive/negative controls before another pinned rebuild. Nothing pushed.

### First-class array stringification follow-up

Latest native failure reduced to Array.prototype.toString used as a value: initial focused9tests passed2/9 (only nullish refusals). New native body reads join once, calls with the object receiver and an empty argument list, preserves arbitrary returned values and thrown values, and uses the intrinsic object classifier with the existing Symbol.toStringTag lookup when join is not callable. Primitive receivers are wrapped before any getter observes them using the existing internal primitive-slot construction tail. Symbol and BigInt wrappers retain their native prototype links; BigInt prototype now seeds its intrinsic Symbol.toStringTag.

Focused21/21 passed: arrays, holes/nullish elements, own join overrides, getter order, return identity, exceptions, five primitive wrapper brands and default tags. Wider76/76 across six self-contained suites passed (new suite, first-class apply, Reflect prototype status, any-array join, runtime object classifier, and higher-order array method value checks). The higher-order suite contains WAT assertions, so not all76 are execution checks. Official typecheck passed; direct pnpm exec tsc used the wrong configuration and produced missing Node types, not a measured source regression. Full Deno has not yet been rebuilt with this patch. No claim of complete Proxy/exotic classifier coverage; those existing unsupported cases remain loud.

Array-stringification checkpoint: signed compiler1223c7fc7775374264dca8f0f4c247d19e397b08; runtime pin5a1af1b. Clean inputs /private/tmp/js2-deno-string-pinned-20260908 and /private/tmp/v8x-deno-string-pinned-20260908. Strict builder51674 terminal exit0. Artifacts /private/tmp/deno-string-artifacts.M24Uzy/core.wasm7,078,838bytes SHA256a0ca3fc687f6b9ea4170c00f210006ad659b3f51fbae17e39a5af654d5747b68; provider.wasm25,328,181bytes SHA256b8b45d3ab4d09a1106c6b1d310236f9eba8b56f85ba50080dc9f643621c41c42. Provider changed and was NOT reused. Release precompile7944 terminal2/2pass172.06seconds. Native replay8582 currently live with both new AOT files; result pending.

Read-only next-boundary probes: simplified console map/join paths all return the expected string (3/3), so do not blame consoleStringify. Actual unchanged hello_world Rust script uses function print(value) { Deno.core.print(value.toString()+"\\n"); }. On compiler1223c7fc standalone, function stringify(value:any) called with The sum of: value.toString() throws called value is not a function; Reflect.apply(value.toString,value,[] as any[]) returns a nonmatching string; Reflect.apply(String.prototype.toString,value,[] as any[]) throws String.prototype.toString is not yet implemented in --target standalone. The corresponding body EXISTS in wrapper-proto-to-string.ts. Temporary canEmitWrapperThisValueBody logging on a minimal exported-parameter probe showed String, standalone=true, typeof predicate73, so missing dependency at that guard is not proven and is contradicted for that probe. Instrumentation removed and source diff verified empty. Need trace actual dispatched callee/source-order variant, not duplicate the existing intrinsic.

Native replay8582 is TERMINAL exit134. New output is [object String], then1,2,3, then[object String]. This proves the first-class array fix changes the actual unchanged Deno execution. It then calls real host op_sum with3arguments according to the host callback trace, although the script passes a single arr argument. The subsequent classic-script error is TypeError with an empty rendered message; error-reporting abort remains v8__Private__ForApi. The three unsupported host-value conversion diagnostics also remain. No native jobs from this checkpoint remain live. Full example/integration still fails. Next independently trace dynamic String toString dispatch, single-array argument preservation at op_sum, and native Symbol/private error-state APIs. Do not rewrite the Deno example or treat the observed3arguments as the expected call shape.

Final gates for compiler1223c7fc: official typecheck and focused21/21 rerun passed after wrapper-tail deduplication; source function/LOC/coercion/oracle gates passed. Dead-export command returned0 but reports production-rooted evidence incomplete, preservation-only6/6, strict modeled closureFAIL and retirement/deletionNOTCERTIFIED, unchanged architecture limitation. No new PR or push in this continuation.

### Host callable cross-module argument preservation, September 8 continuation

Fresh fetch of loopdive/js2 main remains 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0; merging it into codex/4376-deno-realm-main-sync reports already up to date. User workspace changes remain untouched.

Raw full-core/provider probe on deno-string-artifacts.M24Uzy has a successful dynamic literal42 control. Direct bridge invocation of a host function with one array reaches the callback with count1 and first kind9. Dynamic fn([1,2,3]) instead reaches count3 and first kind3; fn(42) reaches count0. The foreign raw closure receives the first argument in its module-local rest-vector slot. Add explicit compiler intrinsic __runtime_eval_wrap_aot_callable and use the existing canonical caller-owned adapter when v8x creates host functions. Initial two-module regression changes from [0,0,0,0] to [103,100,300,0], proving nested-array, scalar, three-argument and zero-argument handling.

Additional function length test initially fails: caller define/read1, provider direct read0, provider computed-key read1. This REFUTES the tentative adapter-bag divergence explanation: the owning getter already reads the bag correctly. emitStandaloneAnyLength only tests the local closure root, so a foreign canonical adapter falls through to generic length. Include the registered canonical adapter in that narrow callable guard. Initial full regression then passes1/1; expanded arity matrix and neighboring tests pending. No full pinned rebuild with this patch yet; unchanged native example still fails at the previously recorded boundary. Preserve the unrelated string printing, unsupported host types, and Private API failures separately.

Expanded validation passed23/23 across four suites: explicit two-module adapter matrix (arities0,1,3,8), builtin metadata length, TypedArray constructor metadata, and first-class apply. Official typecheck passed. LOC/function/coercion/oracle ratchets passed; dead-export exits0 with the same explicitly incomplete production-rooted evidence and strict modeled closureFAIL, not architecture certification.

Signed compiler e551d8afb3933a78374d80695ae3891db57247e1 and v8x8e626bd saved. Clean pinned inputs /private/tmp/js2-deno-callable-pinned-20260908 and /private/tmp/v8x-deno-callable-pinned-20260908. Strict builder94468 terminal exit0: /private/tmp/deno-callable-artifacts.BoCIPe/core.wasm7,079,764bytes SHA256e20c4da4a25f7d3408da34eb90861966a4ba7949af019fcdcec34e7e6b726f86; provider.wasm25,329,846bytes SHA2569416cc0f18d799e528886c9deac1061cca6100e922e24be0f080a777a896ea7d. Fresh raw core/provider probe25727 terminal exit0: literal42 success; fn(42) count1 kind3; fn([1,2,3]) count1 kind9; fn(1,2,3) count3 kind3; direct bridge array call count1 kind9. Same fixed results also measured using old provider with new core (78858), attributing argument repair to host exposure.

Native Deno hello_world rebuild77057 exit0 with unchanged libs/core. Native function-length test passed1/1 using release engine_js2wasm+js2wasm_runtime_compile+simdutf. An initial test attempt omitted runtime_compile and failed at compilation (21 missing gated-helper/type errors); that is not a runtime pass. Release precompile24724 still processing provider after core pass; native replay pending.

Release precompile24724 TERMINAL2/2pass166.58seconds. Native replay27247 TERMINAL exit134 with new core-release.cwasm/provider-release.cwasm. Trace reaches op_get_extras_binding_object(0), op_get_ext_import_meta_proto(0), op_set_captured_bootstrap(1), then the same three unsupported host-value diagnostics. Stdout: [object String], 1,2,3, [object String]. Real op_sum now receives ONE argument, then op_print emits [object Number], then the deliberately invalid op_sum also receives ONE argument. Classic script throws TypeError with an empty rendered message and aborts on unresolved v8__Private__ForApi. This verifies the argument fix in unchanged native Deno, not full example completion; the numeric printed value is NOT verified as6 by [object Number]. No native/build/precompile processes from this checkpoint remain running.

Next: diagnose dynamic primitive toString selection for strings/numbers and the expected invalid-op exception conversion/catch path. Keep the three unsupported host conversions and missing Private API tracked independently. Do not change libs/core or hide the expected serde_v8 error. No PR/push for this checkpoint yet; implementation commits e551d8af (compiler) and8e626bd (v8x) are local.

### Primitive prototype retention follow-up

Full raw core/provider probe on BoCIPe reproduces abc.toString as [object String] and 6.toString as [object Number]; literal42 control passes. String.prototype.toString and Number.prototype.toString compare equal to Object.prototype.toString. Explicit prototype .call probes throw ReferenceError describe is not defined, a separate unresolved symptom. Reduced standalone TypeScript probe: without retained prototypes, direct any-value toString throws, computed-key Reflect.apply returns wrong string, explicit String.prototype.toString Reflect.apply throws. Retaining String/Number/Boolean prototypes through a WeakMap makes all three probes return expectedabc (3/3). Add primitive-prototype retention to installRuntimeEvalRealm beside existing Array/Promise retention. Full rebuilt provider validation pending; this does not yet prove the separate generic compiler demand issue fixed.

Primitive-retention focused checks passed29/29 across three suites (new erased receiver checks, issue4619 wrapper methods, runtime-eval array companion probes). Official typecheck and LOC/function/coercion/oracle gates passed. Dead-export remains exit0 with production-rooted evidence incomplete and strict modeled closureFAIL. Full provider/native replay remains required.

Existing BoCIPe raw provider controls: throw7/catch returns7; throw new TypeError(x)/catch returns messagex; reading e.toString() throws Object.prototype.toString not yet implemented. Reduced computed-key Reflect.apply on TypeError returns wrong value without retention and expectedTypeError: x with Error.prototype alone retained. Retain Error.prototype beside the primitive companions; this fixes lookup demand, not yet proven native exception transport.

Error companion expanded checks passed32/32 across the same three suites; official typecheck and source ratchets passed with unchanged incomplete dead-export evidence.

New full provider from compiler032c437c and runtime8ca13c5 built successfully in CmFuHd: core byte-identical to BoCIPe; provider25,457,118bytes SHA256d8fb55d5342d4bee80371c14a6779c667ac931488c2a69a508d2a8e98f7261c8. Raw probe40312 passes literal42, abc.toString=>abc, 6.toString=>6, true.toString=>true, caught TypeError.toString=>TypeError: x. Release provider precompile83841 passed1/1 in139.28seconds. Native replay39896 started with byte-identical BoCIPe core AOT and new provider AOT, still pending.

Host callback exception probe83615 with negative error handle: try fn/catch e.message escapes as TypeError host failure, unlike interpreted throw/catch. Reduced independently compiled caller/provider confirms inactive callback catches17, but active eval callback leaks foreign Wasm exception. Replacing active raw rethrow with the existing result envelope makes the provider catch17. Initial outer harness still threw because its synthetic eval import returned an invalid outer result; instrumentation separated provider-returned17 from that unrelated decoder failure. Baseline kill-switch48098 instead reports providerescapedWasmException. New regression explicitly throws a JS sentinel AFTER measured provider return, avoiding the invalid outer decoder path and proving both ordinary return and caught-error callbacks. Candidate exception change is not yet committed or fully validated.

Native prototype-retention replay39896 TERMINAL exit134: prints exact first four lines The sum of / 1,2,3 / is / 6. Both op_sum calls receive one argument. The intentionally invalid second call still escapes as TypeError(empty message), then diagnostic ABI abort v8__Private__ForApi. Same three unsupported host-value diagnostics remain. This proves primitive printing fixed in unchanged native Deno, not complete exception handling or integration. No native jobs from this rebuild remain.

Exception candidate passed8/8 across active reentry, existing envelope, and explicit callable suites; official typecheck and source ratchets passed (dead-export evidence still incomplete). Active payload cases cover number17, stringpayload, and object identity, each with a normal-return control and fresh caller instance. Restoring HEAD runtime-eval-callable.ts for a kill-switch run makes all3 new cases fail with foreign WebAssembly.Exception instead of the explicit post-callback sentinel (27046 exit1); candidate restored in finally. This confirms active reentry exception-envelope fix, not outer eval result decoding.

Exception fix signed compiler e58e67115dbacdbba1a0d172daab494e713c72b4, runtime pin a5293fa. Clean detached inputs /private/tmp/js2-deno-exception-pinned-20260908 and /private/tmp/v8x-deno-exception-pinned-20260908. Strict builder62103 terminal exit0. Artifacts /private/tmp/deno-exception-artifacts.CV3pIp/core.wasm7,080,891bytes SHA2567c32e85ec04adfda5353cd8cab23749450eadf2ce4d7b2c25d43ebfe08d9f72e; provider.wasm unchanged SHA256d8fb55d5342d4bee80371c14a6779c667ac931488c2a69a508d2a8e98f7261c8. Raw full-module negative-host-error probe46892 now catches host failure and renders TypeError: host failure (literal42 positive control). Core release precompile8641 passed1/1 in33.20seconds. Native replay92852 is live with new core AOT and exact byte-identical provider AOT from CmFuHd; stdout/stderr separately captured in CV3pIp/stdout.txt and stderr.txt, tracing off. No compiler/Node dependency in native binary feature list; libs/core diff empty. Await terminal status before claiming success.

Native exception replay92852 TERMINAL exit134. Captured stdout is The sum of / 1,2,3 / is / 6 / Exception: / null, not the required serde_v8 error text. stderr: call __v8x_script_result_utf16_length traps on null reference, then unresolved v8__Private__ForApi. This verifies the native catch now executes, not successful error rendering or completion. The raw host callback probe is weaker than native error construction: it creates a core bridge TypeError directly, while the native serde path may use a realm-backed error factory. Investigate that difference without modifying the Deno example. Separately final undefined script-result rendering was already suspect in the original raw probe (returning undefined instead of99 trapped the result formatter); now it is observable in the real example.

Read-only Deno source points to the three unsupported bootstrap conversions: libs/core/runtime/jsruntime.rs around1780-1874 passes Uint8Array tick_info, Uint32Array immediate_info and Int32Array timer_info to __setTickInfo/__setImmediateInfo/__setTimerInfo. This is a source-supported hypothesis, not yet a traced type identification. These arrays must preserve shared Rust/JS backing-store updates, not become detached copies. into_realm currently supports no TypedArray/ArrayBuffer arm, and report only prints when TRACE_HOST is set while still recording an exception. Trace-off stderr cannot prove those errors absent. Full integration remains active; all jobs from this turn are terminal, no PR or push.

### Main sync and error-builder reduction, 2026-09-08

Fresh fetch of loopdive/js2 main returned 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0, already an ancestor of compiler checkpoint34f115c8ef0290. Merge reports already up to date. Primary-checkout dirt preserved.

Four reduced staged error-builder variants executed. With the unannotated errorMap matching Deno, dynamic new errorClass(msg) produces an ordinary object missing name/message. Literal new TypeError(msg) preserves both fields. Optional-call removal changes neither result. Earlier errorMap:any instead returned null through an erased computed-call defect, so that probe does not establish the real factory's cause. Scratch: .tmp/probe-error-builder.mjs.

The exact full core still mishandles undefined result encoding. Two small compileMulti extractions of the exact recursive encoder correctly handle undefined/null/42 through exported dynamic inputs with matching Deno options. Do not conflate null and undefined to hide the full-program defect.

Next scoped compiler change: recognize exact built-in Error constructor values in native zero/one-argument construction, retaining normal function dispatch and excluding AggregateError's different argument contract. Reuse native Error storage and canonical coercion. Options/cause and alternate new.target require separate coverage before extending this arm.

Candidate13/13 focused tests pass. Wider43/44 executed pass, plus6 explicitly skipped. Clean checkpoint34f115c8ef0290 reproduces the sole neighboring failure (issue-3981 constructor prototype test returns an opaque object instead of11); its same run fails all13 new cases, passes30, skips6. Candidate restored in finally. Undefined-message own-property absence is covered; inherited default message read remains a known pre-existing defect: both literal and dynamic TypeError() read null rather than empty string in the reduced probe. Do not claim that read fixed.

Final focused check after routing reservation through the canonical coercion engine:37/37 executed pass across three suites, six existing skips; configured TypeScript7 typecheck and LOC/function/coercion/oracle ratchets pass. Dead-export command exits0 but explicitly reports production-rooted evidence incomplete, strict modeled closure FAIL, retirement NOT CERTIFIED. This is not an architecture-closure claim. Native Deno rebuild with the constructor-value fix remains pending.

### Intrinsic Error value checkpoint and native replay

Signed compiler0285ee23673648d734ede90ae08e3456948b8b0b, runtime17e1f31. Clean detached inputs /private/tmp/js2-deno-error-value-pinned-20260908 and /private/tmp/v8x-deno-error-value-pinned-20260908. Strict builder23085 passed. Artifacts /private/tmp/deno-error-value-artifacts.YZwCQG: core.wasm7,082,667bytes SHA2564240b7baaee2238e17238491137b5062462172ca39ca08cf55d0c0b2d25ccaf6; provider.wasm25,457,264bytes SHA256f00d8e2f3b56f0bdff275fbfeef01638a0251987396812b0c663d2308bbee03d; provenance.json records inputs. Both modules changed. Release precompile7467 passed2/2 in163.54seconds, producing both core-release.cwasm and provider-release.cwasm.

Native replay55450 TERMINAL exit134. Unmodified Deno libs/core now produces exact expected stdout: The sum of / 1,2,3 / is / 6 / Exception: / TypeError: serde_v8 error: invalid type; expected: array, got: Number. Files stdout.txt/stderr.txt are separately captured in YZwCQG, tracing off. Remaining stderr: __v8x_script_result_utf16_length null-reference trap, followed by diagnostic unresolved v8__Private__ForApi. This verifies error construction in actual Deno, not a completed successful replay. Shared typed-array bootstrap conversions remain separately unverified; trace-off silence is not proof of absence.

Undefined encoder now reduced with the real provider in .tmp/probe-eval-result-encoder.mjs: eval('undefined') is correctly recognized as undefined before encoding, but encoder returns status1 and length traps;42 and null controls return status1, lengths2/4. Further reduction .tmp/probe-eval-optional-string.mjs shows function enc(v:any):string|undefined emits ref.null6 on its undefined return, and the boundary consumer observes null (test2). Changing only the annotation to any emits the canonical singleton and returns test1. This is diagnostic, not a proposed Deno source workaround. Inspect mixed-return-widening.ts (explicitly leaves reference results unchanged) and declarations.ts boundary result ABI. Direct-undefined input with eval-enabled source separately returns test3 even with any return, so do not assume all undefined argument handling is the same defect. All probes and native/precompile/build processes from this checkpoint are terminal; nothing pushed, integration goal remains active.

### Follow-up: optional reference results crossing eval

Resume from clean compiler35dbf01ae74fb5. Previous turn is verified progress: native exact stdout and13 new constructor tests fixed, but exit134 persists. Investigate the return ABI for string|undefined at the eval callable boundary. Preserve specialized reference returns away from that boundary and keep null distinct; do not change the Deno encoder annotation.

Optional-reference candidate:22/22 tests across3 suites passed. Clean baseline35dbf01ae74fb5 fails1/6 new cases (top-level optional string returns null); other5 are passing array/object/nested controls, not fixes. Six no-eval byte controls (optional string, optional number, numeric square, each standalone and gc) are byte-identical to baseline. Candidate restored after baseline test. Nested signature changes were unnecessary for the measured failure and removed; only published source-level eval callable results opt into reference widening. Full extracted encoder with actual provider now yields undefined status0/length0 and unchanged42/null status1 lengths2/4.

Final narrowed candidate30/30 focused tests pass across optional-reference, active exception, intrinsic Error, inline-stage capture and explicit callable suites. Configured TypeScript7 typecheck and source ratchets pass; dead-export command retains its documented incomplete-evidence report despite exit0. No full Deno replay yet with this return-ABI checkpoint.

### Optional-reference checkpoint: native examples exit successfully

Signed compiler0d4c1916348a550f931af8541218cfd333c98d46; runtime pin a6ce3f0. Clean detached inputs /private/tmp/js2-deno-return-pinned-20260908 and /private/tmp/v8x-deno-return-pinned-20260908. Strict builder39507 passed. Artifacts /private/tmp/deno-return-artifacts.EEsz0l/core.wasm7,081,839bytes SHA25631daf776968eb52ce059e3f55ef5c8b4225b16fd585a993f77d6d29042736217; provider.wasm25,457,264bytes SHA256f00d8e2f3b56f0bdff275fbfeef01638a0251987396812b0c663d2308bbee03d. Provider is byte-identical to YZwCQG (cmp exit0), so its trusted provider-release.cwasm was reused. Release core precompile16365 passed1/1 in32.97seconds. Full raw artifact probe34971 returns undefined/void0 status0, null status1 textnull,42 status1 text42, with no formatter trap.

Native unchanged hello_world replay26090 TERMINAL exit0. Exact stdout independently compared to all six expected lines including the caught serde_v8 TypeError: true. stderr size0. This is the first verified successful general runtime-profile hello_world replay in this continuation, rather than just expected stdout followed by abort. libs/core diff remains empty; only native runner Cargo.toml/Cargo.lock differ for the v8x dependency.

Unchanged eval_js_value build70569 passed. Traced native replay49016 TERMINAL exit0, stdout Output: Number(10), satisfying the example's own serde_json equality assertion. stderr contains the three normal initial host callback traces and three unsupported host-value conversion diagnostics, with no formatter trap or Private ABI abort. Thus successful examples do NOT prove clean bootstrap: the three recorded exceptions still require a real fix. Deno source passes Uint8Array tick_info, Uint32Array immediate_info and Int32Array timer_info through the three init setters; realm_objects::into_realm has no TypedArray arm. This remains source-supported attribution until a type-specific trace/reduced transfer test verifies each call. Preserve actual shared backing semantics, not detached array copies or source-name-specific substitutions.

Additional inspected limitation relevant to full integration: Script__Run uses materialize_deno_script_result for ordinary runtime results, and allocate_script_json_value still contains constructor-source-spelling reconstruction for six typed-array forms. Do not count this JSON/source-pattern path as general realm identity or proper shared typed-array support. Follow-up acceptance for object/function identity, module namespaces/live bindings, module loading, event-loop ordering and distribution remains open.

Feature inspection cargo tree -p v8x downloaded missing workspace dependency cache entries before finishing; no source/lock changes were made by that check. It showed Wasmtime runtime enabled; do not treat this filtered output alone as a full compiler-free deployment audit. Native runner dependency still explicitly disables default features and selects simdutf, engine_js2wasm, js2wasm_diagnostic_abi. All build/probe/native sessions above are terminal, no work left running and nothing pushed. Goal remains active.

### Shared host buffer follow-up

Current runtime a6ce3f0, compiler76f40d240146d4 documentation checkpoint. Both unchanged native examples exit0, but traced eval_js_value has three unsupported host conversions. Need type-specific diagnostics before attributing each failure. Deno ContextState stores Box<[u8;2]>, Box<[u32;3]>, Box<[i32;1]>, exposed through ordinary ArrayBuffers with no-op deleters; these are not concurrent SharedArrayBuffers.

Candidate design under investigation: maintain one canonical Wasm buffer per retained Rust backing store and typed views over it. Synchronize bytes at every Rust-to-Wasm entry/exit and Wasm-to-Rust callback entry/exit, including nested re-entry and exceptional exits. This is observable shared backing for ordinary single-threaded ArrayBuffers, not detached snapshots; overlapping views and host pointer writes must agree. WasmGC's packed byte arrays cannot directly alias arbitrary Rust pointers. Do not claim concurrent SharedArrayBuffer or zero-copy support from this design. First inventory all entrypoints and ownership/deleter lifetimes; if any boundary cannot be covered, fail rather than silently diverge. General JS-created typed-array result branding and the older source-pattern JSON result path remain separate incomplete work.

### Fresh main verification and buffer transition controls

Fresh fetch of https://github.com/loopdive/js2.git main on 2026-09-08 returned 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0. Merge in codex/4376-deno-realm-main-sync reported already up to date; ancestry verified. Existing issue edits and all primary-workspace changes preserved.

Type-specific native eval_js_value replay exited0 with Output: Number(10), identifying the three rejected bootstrap values as Uint8Array offset0 length2, Uint32Array offset0 length3, and Int32Array offset0 length1. These are verified diagnostics, not merely source attribution.

Candidate bridge exports create fixed ArrayBuffers, overlapping native typed views, and a private raw GC storage accessor. Ordinary and deferred-bootstrap Node fixtures both pass shared-view, bounds, kind rejection and existing identity/callback controls. Wasmtime call-hook feature enabled in the runtime candidate. Opt-in Rust proof tests direct rooted packed-GC-byte synchronization across Rust/Wasm transitions: nested re-entry sees Rust writes, host-originated errors preserve host writes, and Wasm-originated exceptions flush Wasm writes without losing the pending exception. Latest release run: 1/1 executed passes in4.52seconds. Fixture path .tmp/context-buffers.wasm, test tests/js2wasm_buffer_hook.rs; bootstrap fixture .tmp/context-buffers-bootstrap.wasm.

Production transfer is NOT wired. Next: retain each native backing store for the lifetime of its store-local GC binding, canonicalize buffers and views, install the validated hook in DenoHostState, and expose registration through both DenoRuntime and CallerRealm. Rebuild from clean pinned artifacts and rerun traced unchanged Deno examples before claiming the three bootstrap exceptions fixed. The hook currently exists only in the opt-in proof test; no claim of zero-copy, SharedArrayBuffer concurrency, or completed Deno integration. No PR/push in this continuation.

### Production buffer ownership and Map subclass order

Runtime signed checkpoint cf19ddb43c96fd9b1ccf2ba7fde856d3ef7a5819 wires retained fixed host buffers through both DenoRuntime and CallerRealm. Store hooks synchronize rooted packed GC bytes without Wasm calls, and temporary roots are scoped. Send-bound heap limiting is separated from thread-affine backing-store ownership; configure_heap_limit updates the limiter too. Custom typed-array properties still fail explicitly; concurrent SharedArrayBuffer and JS-created exotic-result identity remain open.

Production Rust buffer test passes1/1, including original handle identity, overlapping Uint8/Uint32 views, direct native pointer writes, Wasm writes on exceptional return, and exactly-once deleter after isolate destruction. Runtime context suite27/28 executed passes; unchanged clean runtime a6ce3f0 reproduces the sole callback failure with the same artifact: Function.prototype.call is not yet implemented in --target standalone. Broader default invocation20pass/2missing-precompile-env failures/11ignored is not an all-green run. Compiler-free diagnostic cargo check passed. Native unchanged eval_js_value rebuilt successfully with cf19ddb but has not run with an updated artifact.

Strict full builder using clean cf19ddb and compiler0d4c191 failed before runtime execution: SafeMap subtype no longer has an exact mutable-field prefix of native Map. Artifact directory /private/tmp/deno-buffer-artifacts.qwFLpF contains no verified successful new full artifact. Reduced .tmp/probe-map-subclass-order.mjs proves source-order dependence: without earlier collection, SafeMap constructs and returns42; an earlier Set or Map registers the private native Map carrier, and class heritage mistakes it for a user-class layout.

Compiler candidate classParentStructType excludes that exact native carrier from nominal class inheritance while preserving user-defined Map classes. Nine new regressions/control tests pass; baseline HEAD with the candidate file temporarily replaced fails7/9, passes the no-collection and user-Map controls2/9. Candidate restored in finally. Wider five-suite55/55 passes. TypeScript7 typecheck and LOC/function/coercion/oracle gates pass after extracting the helper rather than enlarging collectClassDeclaration. Dead-export command exits0 but continues to report production-rooted evidence incomplete and modeled closure FAIL; no architecture completion claim. Next: checkpoint compiler, advance runtime compiler pins, build clean full artifacts, and rerun traced unmodified Deno examples. Full integration remains active.

### Clean buffer artifacts and next executed module boundary

Runtime pin checkpoint91e9b36, compilerf5b174ed4310c044f2fb67d3f56bd9e8cc810a10. Clean detached worktrees /private/tmp/v8x-deno-map-order-pinned-20260908 and /private/tmp/js2-deno-map-order-pinned-20260908. Strict runtime builder35410 completed successfully: /private/tmp/deno-map-order-artifacts.ITbCKR/core.wasm7,639,220bytes SHA2565ee74f626ab37657be3ccdf207713868cf82b55c8ab653bc4ef607dceaccaf22; provider.wasm25,457,264bytes SHA256f00d8e2f3b56f0bdff275fbfeef01638a0251987396812b0c663d2308bbee03d. Provider cmp matches YZwCQG, whose trusted provider-release.cwasm is reused. Wasmtime release core precompile17701 passed1/1 in33.11seconds.

Traced native eval_js_value68171 exited0: stdout exactly Output: Number(10), only3 normal callback trace lines. Traced unchanged hello_world29410 exited0: stdout exact six expected lines including the caught serde_v8 TypeError, only11 callback trace lines. Independent assertions verified both stdout files and every stderr line; zero conversion errors. Thus all three previously rejected native bootstrap arrays now enter the compiled realm. libs/core remains unchanged. This does not prove full Deno compatibility.

Unchanged op2 built successfully but replay52208 aborted134 after the three normal core bootstrap callbacks. Primary diagnostic: compiler-free engine_js2wasm requires a trusted V8X_JS2WASM_AOT_MODULE for the extension module graph. Error reporting then reaches unimplemented v8__Private__ForApi. Need package and run the real ext:op2_sample/op2.js plus application graph against the core-owned realm; neither provide a dummy artifact nor claim modules done because scalar scripts work.

Candidate first-class Function.prototype.call uses the receiver-aware variadic native closure ABI, retaining all arguments and delegating to the ordinary apply bridge. Updated context fixture .tmp/context-call-candidate.wasm fixes the formerly failing Rust nested-callback test1/1. Full selected context suite9972 passes28/28 (five artifact/graph-specific tests explicitly filtered, not claimed). Focused compiler tests initially6/7: an extracted Reflect.apply case lost arguments. Reduced direct Reflect.apply also returnedNaN independently of Function.prototype.call, proving the remaining issue is not only the new method. Native Reflect.apply's local-argument emitter skipped the force-vector rule already used in the host-facing argument emitter, allowing contextual tuple layouts for array literals. Candidate shared compileReflectArgumentValue preserves literal list length at both paths, with try/finally restoring the flag; all four reduced expressions now return42 and initial focused7/7passes. Changes remain uncommitted pending wider gates and baseline controls.

Final call/Reflect verification: focused9/9 passes; unchanged compilerf5b174ed4310c0 baseline fails5/9, passes4controls, and both candidate files restored in finally. Wider run initially48passes/8missing-file failures; existing primary-checkout Test262 test and harness directories were linked into the previously empty local test262 directory (no fetch or corpus sweep), then the same five-suite selection passed56/56 including all eight exact referenced upstream rows. TypeScript7 typecheck and LOC/function/coercion/oracle gates pass. Dead-export command's incomplete-evidence/strict-closure FAIL remains explicitly open. Updated context fixture passes28/28 Rust tests, not a full Deno test suite. Native examples above still use the clean f5b174ed compiler artifact; the new call changes require a subsequent pin/artifact refresh before claiming them in native Deno. All native runs are terminal; op2 graph packaging plus Private::ForApi error handling are the next executed boundaries.


### Main synchronization and extension graph packaging continuation

Fresh fetch of https://github.com/loopdive/js2.git main returned 04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0; merge on codex/4376-deno-realm-main-sync reports already up to date. Compiler HEAD remains bbb5f3987f836036774660e204870a4ee94d37ea. Primary workspace changes preserved.

Runtime candidate adds isolate-private key storage and content-addressed multi-graph package directories. Private keys are separate from public properties and are tested for interning, hidden enumeration, explicit undefined presence, deletion, non-inheritance and compiled-realm handle identity. Graph package binding tests reject entry/source/byte mismatches. Final selected runtime suite47702 passes31/31, with5 explicitly filtered artifact-specific cases; no full Deno suite claim. Changes remain uncommitted in /private/tmp/v8x-deno-followup-20260908.

Build-time op2 packaging11575 exited1, but produced two native packages and graph binding sidecars in /private/tmp/deno-op2-packages.p7w5OR. After core bootstrap and extension initialization, application __module_init throws TypeError: called value is not a function in __extern_method_call. This replaces the earlier missing-artifact failure. Private-only replay previously reached Deno error.rs:1294 constructor-to-object unwrap; that error-formatting defect remains open.

Build-time runner temporarily enabled js2wasm_runtime_compile and upgraded its local workspace semver pin from1.0.25 to1.0.28 for Wasmtime47 compiler dependencies. Compiler feature has now been removed again; offline compiler-free op2 rebuild52836 passed, with only owned Cargo.toml/Cargo.lock changes and no libs/core edits. Compiler-free replay99003 uses V8X_JS2WASM_AOT_GRAPH_DIR and the same working directory as packaging; running at this checkpoint, not claimed successful.

Reduced three-module Node probe .tmp/probe-op2-shared.mjs reproduced the same TypeError without Deno: independent context provider, extension publishing an object with a closure, and application calling that method. First two probe attempts were invalid harnesses (inferred provider ABI, then TypeScript annotations in .js); corrected .ts provider plus .js consumers initialized the extension and failed in the application. This narrows investigation to the shared compiled-module boundary, but does not yet distinguish object member representation from callable dispatch. Full integration remains open.


Compiler-free replay99003 reached the same __extern_method_call TypeError after the three normal bootstrap callbacks, using only the two directory packages plus the precompiled core/provider, with no runtime compiler feature or compiler environment variables. This verifies package selection/load through actual module execution, not successful op2 completion. libs/core diff remains empty. Existing standalone shared-global import control suite9125 passes3/3; the failing three-module producer/application shape is not covered by those two-module provider/reader controls. An explicitly open dictionary variant of the reduced producer also fails, so merely replacing the object literal with an any-typed dictionary is not a fix. No source workaround applied to Deno.


### Linked literal publication: field visibility and inferred return ABI

Three-module reduction now proves object identity survives while producer-only closed-struct field metadata does not. Both context and consumer read undefined for use_state and NaN for marker7; the producer reads both successfully, even when all readers use the producer's own string key. Replacing construction with Object.create(null) makes all three read correctly. This excludes key-string provenance as the cause. Scratch .tmp/probe-op2-properties.mjs and .tmp/probe-op2-shared.mjs retained.

Candidate linked-realm-literal.ts recognizes fresh literals published directly into the unshadowed linked global, including nested property literals and transparent wrappers. literals.ts constructs an open object at creation, avoiding identity-breaking copies. resolveWasmType must recognize the same literal's inferred type: construction-only fixed application calls but regressed the producer's inferred object return to null. Signature routing now preserves the raw shared carrier too. Aliased publications, arbitrary escaped class/struct instances and complete structural compatibility remain open, not claimed by this scoped proof.

Baseline29698 with both source hooks replaced by unchanged bbb5f398 (restored in finally) fails all three publication tests. Flat cases fail marker7 as NaN; nested case cannot preserve the expected nested reference. Candidate publication tests pass3/3 and shared-global controls pass3/3. A fourth test exposed an independent pre-existing shadowed-globalThis read: unchanged baseline also invokes the linked getter from a function-local shadow. Recorded explicitly as it.fails, not counted as working behavior. Final five-suite1634 reports33 passing test cases:32 ordinary passing cases and1 expected-failure case; tests cover inferred producer return identity, dot/bracket/nested literals, actual invocation, missing-method TypeError, ordinary typed local control, existing realm carriers, call bridge and graph preparation. Initial shadow control failed first on missing imports, then on an unexpected linked getter with fail-fast imports; no claim of fixed shadow behavior.

Native candidate packaging5228 TERMINAL exit1. Both packages in /private/tmp/deno-op2-publication.GVGy5Z were written19:46:21 and19:46:32, BEFORE baseline source substitution/test at19:46:46. This timing check matters: candidate packaging and later baseline testing shared the compiler directory. No future overlap should be scheduled; pin clean immutable inputs for release verification. Native trace gets past publication and through __call_m_op_use_state_1 into the host-function closure, then fails converting a value with __v8x_value_utf16_length: TypeError expected string handle. There is no op_use_state callback trace yet, so Rust op execution is NOT proved. New boundary likely involves callback argument conversion; inspect actual values before attributing the cause.

Compiler-free op2 rebuilt after removing js2wasm_runtime_compile again (offline build exit0). Replay3328 is LIVE using only the new package directory and precompiled core/provider; no success claim until terminal. Native libs/core remains untouched. TypeScript7 check passes after explicit Expression typing in the helper. LOC/function/coercion/oracle gates pass with dated hook-growth grants; dead-export command exits0 but reports the existing production-evidence incomplete / strict modeled closure FAIL. Nothing pushed; full goal remains active.


Publication checkpoint fa1bd5c4226eae committed with signing and normal fast hooks. Compiler-free replay3328 TERMINAL exit1, reproducing the later expected-string-handle conversion failure from the packaged application. No runtime compiler enabled. Source inspection identifies from_realm's kind6 Function wrapper construction as a mandatory read of the JS name property followed by realm_as_utf16; a non-string or inaccessible cross-module name would cause this trace before the Rust callback is logged. This is an attribution pending a value-kind diagnostic/reduced callback conversion test, not a proved missing-name diagnosis. No live build/test/native sessions remain at this checkpoint. Runtime Private/package edits remain uncommitted as previously recorded; no push/PR made in this continuation.


### Native callback name conversion and External branding

Native diagnostic replay86507 TERMINAL exit1 proves the op2 callback's name has realm kind0 (undefined), immediately before the UTF-16 conversion error. Prior bootstrap callback names are kind4 strings. Candidate from_realm now decodes only actual strings; other JS name values stay on the original bound function while the Rust wrapper caches an empty display name. This does not coerce or overwrite the JavaScript property. Accessor-name effects and exact internal function-name metadata remain separate work.

Updated fixture tools/js2wasm/test-context-value-bridge.mjs exercises undefined name, numeric name17 and ordinary namedCallback. Initial fixture used local bindings with the same names as global publication keys; those published keys read undefined, producing a BadType before the targeted conversion. Distinct local identifiers corrected that harness confound. Node independently verifies value kinds6/6/6 and name kinds0/3/4. Corrected baseline82297 fails on name kind0 with the same expected-string-handle error; candidate58869 passes1/1, preserving callback identity, returns42/43/44, public undefined/17 name values and ordinary named get_name. Full selected runtime13592 passes32/32 with five artifact-specific cases filtered. Compiler-free target check11429 passes.

Compiler-free native replay19486 TERMINAL exit134 now logs op_use_state (1 argument), then the diagnostic ABI aborts at v8__Value__IsExternal. Added brand check over the existing HeapValue::External variant, not pointer non-nullness. Targeted compiler-free test71278 passes1/1 for null and non-null pointer Externals and six negative controls. Native op2 rebuild52353 passed; compiler-free replay90425 currently LIVE with external-fixed stdout/stderr under /private/tmp/deno-op2-publication.GVGy5Z. Latest selected33-case suite2524 currently running. Do not claim op2 exit0 yet.

README and site documents now explain multi-graph package directories and non-string callback names. make -C site all exits2 because /opt/homebrew/bin/typst is absent; rendered site validation is not done. Runtime remains uncommitted pending the current checks; libs/core sources untouched. No broad Deno test baseline has been updated or claimed from these focused integration tests.


### Unchanged compiler-free op2 exits successfully

Runtime signed checkpoint c09cd8fe37afabb65492315bee707b0290d7b250 contains Private keys, multi-graph directory packaging, tolerant callback display-name caching, and Value::IsExternal. Full selected runtime2524 passes33/33, with5 explicitly filtered artifact-specific cases. Standalone compiler-free External test passes1/1. Source fixture .tmp/context-function-names.wasm was compiled with compilerfa1bd5c4226eaef102ef07b83ed3d743850fbaeb and independently checked for callback/name kinds.

Native compiler-free op2 replay90425 TERMINAL EXIT0. Inputs: /private/tmp/deno-map-order-artifacts.ITbCKR/core-release.cwasm, /private/tmp/deno-error-value-artifacts.YZwCQG/provider-release.cwasm, and both content-bound graph packages in /private/tmp/deno-op2-publication.GVGy5Z. Root native dependency explicitly excludes js2wasm_runtime_compile. Runtime was built from the subsequently committed c09cd8f source; no source change occurred between final build and commit beyond formatting tests/docs. Working directory remains /private/tmp/v8x-deno-followup-20260908 to match the packaged main module URL.

Independent Node assertions verified external-fixed-stdout.txt is exactly empty, and external-fixed-stderr.txt contains exactly four normal callbacks: op_get_extras_binding_object, op_get_ext_import_meta_proto, op_set_captured_bootstrap, op_use_state (1 argument). There are no conversion diagnostics or unresolved ABI symbols. This is expected: the unchanged op2 example stores the callback in Rust OpState but never invokes it, so Hello World must NOT be expected or claimed. libs/core diff is empty. This proves the real extension graph plus application graph, callback conversion, Rust op dispatch and example event-loop completion without a runtime compiler. It does not prove later invocation of that stored foreign callback, arbitrary module namespaces/live bindings, dynamic imports/TLA, full Deno CLI or the entire deno_core test suite.

All build/test/native sessions in this continuation are terminal. Runtime tracked worktree is clean, with retained .tmp/ scratch only. Compiler source checkpoint remains fa1bd5c; this issue handover has uncommitted updates. No PR/push was made. Site rendering remains unverified because Typst is unavailable. Next validation: rerun prior native examples against the runtime checkpoint, exercise another unchanged example and stored callback invocation, then build clean pinned full artifacts before release claims. Full integration goal remains active.


### Main sync and native Error continuation

Compiler-free hello_world replay10810 exits0 with the expected sum6 and caught serde_v8 TypeError. Retained foreign callback test94832 passes1/1: after replacing its global with a function returning99, the original stored function retains captured state and returns42 then45. New test-only graph attachment uses the shared engine.

Unchanged disable_ops replay35683 exits101 in libs/core/error.rs:1294 while formatting the intentionally thrown op-is-disabled Error. Deno bindings and its existing disabled-op test confirm throwing is intended; the example comment about a no-op is stale. No Deno sources changed. Runtime native Error adoption candidate preserves constructor, message and original native identity, but test93639 still fails prototype.is_object. Baseline23815 failed constructor first. Generic compiled Object.getPrototypeOf currently lacks an Error carrier arm; implementation and broad validation remain open. Runtime candidate is uncommitted, not a completed fix.

User requested another main sync. Fetched loopdive/js2 main at01bd10472f143f2e6b5454f666d3470fef3903cb. Preserving this handover in a signed checkpoint before merging, without stashing. Primary user checkout and unrelated changes remain untouched.


Main sync completed in signed merge1bfe7c0959bc530928ac0af562264fe0538b4015; fetched01bd10472f143f2e6b5454f666d3470fef3903cb is an ancestor. No conflicts. Post-merge TypeScript7 typecheck passes. Five focused suites67194 report57/57:56 ordinary passing cases plus the existing explicitly expected shadowed-globalThis failure. Suites: linked-realm-publication, error-constructor-value, function-proto-call, realm-structural-carrier, and upstream standalone-temporal-provider. No broad test262 claim.

Post-merge compiler-only reduction61195 confirms the native Error prototype defect independently of Rust: direct Object.getPrototypeOf(new TypeError()) equals TypeError.prototype; an exported proto(value:any) called with the exported make() Error returns null instead. An ordinary object through the same erased helper equals Object.prototype (positive control). Renaming the public error.name does not repair it. The fix must dispatch on internal Error brand and retain canonical prototype identity, not mutable constructor/name properties. Error prototype parent links and user subclasses require explicit handling; no speculative compiler fix applied. Runtime adoption candidate remains uncommitted and its prototype test remains failing.


### Generic native Error prototype candidate

Baseline merged1bfe7c prototype suite39657 fails8/9 with the ordinary/null-object control passing. Candidate99560 passes9/9. Eight-suite43963 reports62/62:61 ordinary cases plus the existing expected shadow failure. Typecheck43199 passes. New immutable intrinsicTag field6 separates construction identity from mutable name and preserves Test262Error as -1 rather than confusing its shared Error instanceof tag. All four identified Error construction sites initialize the field, including Promise.any AggregateError and both SuppressedError constructors. Existing instance field indices remain stable, but Wasm structural ABI changes, so old artifacts must be rebuilt.

New fillErrorPrototypeArms dispatches native builtins through canonical prototypes and walks native Error prototype parents. User-subclass defaults, prototype overrides, AggregateError/SuppressedError reflection and full shared-realm subtype behavior are still open and must not be reported as complete. No Deno edits. New fixture generation31068 passes; Rust test54706 passes1/1 for native Error constructor/message/identity/stable prototype with context-error-prototypes.wasm. The configured older provider was not used to create or round-trip that Error, so this focused test is not cross-version artifact compatibility evidence. Full core/provider recompilation and native replay remain pending.


Compiler signed checkpoint a994605f4faaa34829d3cd92f6d84faa5669cf17 contains the Error reflection candidate. Additional renamed-harness separation control passes: prototype suite70403 now10/10; this control proves non-conflation, not complete user-subclass reflection. Runtime signed checkpoint d6481ce928f4a0769740303c30c8ac513e49727f adopts native Errors and adds retained-callback tests. Selected runtime5063 passes35/35,5 artifact-specific tests filtered. Compiler-free check36321 passes. Compiler gates6366 pass LOC/function/coercion/oracle; dead-export command exits0 but existing dynamic-import evidence remains OPEN/strict FAIL, no retirement certification. Nothing pushed.

Clean detached build inputs under /private/tmp/deno-error-prototype-build.4UZS08/{js2,v8x,deno} at those compiler/runtime hashes and Deno1d4e6c1. Raw builder7289 exits0 including five provider canaries and raw cross-module initialization. Core7640532bytes SHA25672008c6727f02a7d3c5c62e6b18aa30c2c3a8a37efca3b1723463854646770c4; provider25463095bytes SHA256bda61f11d0c95344d15c7541a4489c289bedfc6303fb8e7cf0983d872e4c11ba. Exact source records in provenance.json, build.log retained. Clean compiler node_modules symlinks the existing dependency installation; actual optimizer is bundled Binaryen125, not a newly installed toolchain.

Optimization session65276 currently LIVE: optimizeBinaryAsync(level3,preserveNamestrue) processes core/provider sequentially and requires optimized=true plus WebAssembly.validate before writing core-O3.wasm/provider-O3.wasm. Process67564 confirmed running bundled wasm-opt at98percent CPU. Native example rebuild28599 exits0 for disable_ops and hello_world with runtime compilation disabled, libs/core diff empty. These rebuilt binaries have not yet run against new artifacts. Next: wait same optimizer handle, validate provider canaries on optimized bytes, precompile both with release Wasmtime, and replay disable_ops/hello_world. Do not report native formatting fixed until those runs finish.


Optimization65276 TERMINAL exit0. Core-O3.wasm5403915bytes SHA2566aba79ddf87138e6191fda199330a627e4835a3b2c8513422556bcc4e291fa13; provider-O3.wasm15833595bytes SHA2569b3a1f22427c735c8c331cb1adfa83063a362566536214dd836ba4fbf5320b15. Bundled wasm-opt125 -O3, no-inline, all-features except custom descriptors, preserve names. Core release precompile40100 passes1/1 in27.58s, output core-O3.cwasm. Raw-provider control precompile39999 passes1/1 in140.89s, provider-raw.cwasm. Optimized-provider precompile21108 remains LIVE.

Optimized Node check3390 printed all five passing canaries and deferred core link initialization, then TERMINAL exit133 with V8 background WasmGC optimizer Zone OOM. NOT a clean pass. Repeated identical canaries/link checks with locally verified --liftoff-only flag exits0 (tool a4b4fe); this avoids Node TurboFan tier-up and is not an optimizer performance claim. Native Wasmtime remains independent validation. Runtime full constructor-chain test24289 passes1/1, checkpointc89c95d adds the regression without production changes. Initial patch attempt68329 made no edit because formatting changed; its pass was only the old test, superseded by24289.

Compiler-free native disable_ops control55878 currently LIVE using core-O3.cwasm plus new-layout unoptimized provider-raw.cwasm. Logs disable-control.stdout/stderr in build root. No old-layout artifacts used. Wait the same handle; empty logs during initial store boot are not a completed test. Next use provider-O3.cwasm after21108 completes and run both disable_ops and hello_world.


### Optimized compiler-free native replay confirms Error prototype repair

Optimized-provider precompile21108 TERMINAL exit0,1/1 in134.78s. Native optimized hello8691 TERMINAL EXIT0 with both core-O3.cwasm/provider-O3.cwasm. Independent Node assertions5f483d verify exact prior six-line sum/exception stdout and exactly11 callback-only stderr lines, with no conversion diagnostics. No runtime compiler enabled, libs/core unchanged.

Both disable_ops control55878 and fully optimized22663 TERMINAL exit101 at libs/core/examples/disable_ops.rs:28:6 (the example unwrap), NOT libs/core/error.rs:1294. Both render JsError name Error, message op is disabled, exception_message Uncaught Error: op is disabled, no aggregate. The operation is intentionally disabled; zero exit is not the correct expectation for this unchanged example. This verifies the repaired native Error prototype path in Deno itself. Logs retained as disable-control.*, disable-O3.*, hello-O3.* under build root.

Remaining extra diagnostic in BOTH disabled-op variants: host value conversion to the compiled realm is not implemented for this type. Deno error.rs1152 creates Symbol.for("errorAdditionalPropertyKeys") and reads it from the exception. into_realm has no Symbol arm. New uncommitted Rust regression native_errors_accept_registered_symbol_property_keys reproduces absence returningNone rather thanSome(undefined):52634 TERMINAL fails1/1 at tests/js2wasm_spike.rs2655. Later set/read assertions were not reached. No fake success or empty-value fallback implemented.

Next implement bidirectional native/realm Symbol transfer preserving identity and distinguishing registered Symbols, fresh Symbols with equal descriptions, absent vs empty descriptions and well-known Symbol.iterator. Native SymbolState currently stores only description; isolate symbol_registry and iterator_symbol retain membership identity, so a description string alone is NOT proof of registry or well-known status. Realm from_realm also lacks kind8 transfer. Add JS-side registry roundtrip controls before claiming Symbol.for compatibility. Full core/provider need regeneration after bridge export changes.

All optimizer/build/precompile/native processes in this continuation are terminal. Compiler source clean at a994605f apart from this handover. Runtime HEADc89c95d is test-only over productiond6481ce; only the new failing Symbol regression is dirty. No push/PR. Full integration goal remains active; unchanged op2 has not been rebuilt against the new Error structural ABI.


### Symbol bridge and compiler prerequisites

Native registered-key test98375 passes1/1 after adding native/realm Symbol transfer, but roundtrip23946 fails: registeredSymbol is a Number. Node inspection15e31c proves baseline Symbol.for publication kind3 and fresh description missing. Native registry lookup must not be inferred from equal descriptions. Added bridge exports create/kind/text, per-owner Symbol bindings, native registry/iterator pointer membership, and inverse kind8 transfer; simple/native-host graph leaves now admit Symbol values. Host object Symbol-key enumeration remains separately unsupported.

Compiler candidate preserves symbol:true on native Symbol.for return; generic Symbol.description reads the native table; narrowed Symbol.description uses branded i32 coercion; Symbol.keyFor validates and unboxes native Symbol carriers rather than numerical coercion. Initial brand-only/fill candidate still fails roundtrip14986 because narrowed reads/keyFor used number unboxing. Final fixture context-symbols-fixed2.wasm and Rust98298 pass1/1 across native/compiled values: global registry identity, distinct fresh symbols, absent/empty descriptions, iterator identity, native-fresh roundtrip, JavaScript reading the native Error registered key. This is ONE compiled realm, not multiple Contexts or independent graph registry unification.

Compiler two-entrypath tests initially hit Vitest opaque-Wasm-value rendering in not.toBe. Raw boolean identity assertion retains the same distinctness requirement and passes; there was no demonstrated symbol allocation reuse. Two suites16404 pass2/2 and typecheck0. Five suites74329 pass44/44:43 ordinary tests plus existing shadowed-globalThis expected failure, including invalid dynamic Symbol.keyFor arguments producing TypeError. Candidate source files and runtime source remain uncommitted. Current selected37-case runtime run is LIVE with newly generated Symbol bootstrap/linked fixtures. Full native artifacts still need rebuild for new bridge exports; prior native replay validated Error changes, not these Symbol changes.
