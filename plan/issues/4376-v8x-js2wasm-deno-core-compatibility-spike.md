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
  # 2026-09-30: explicit merge of loopdive/js2 main imports 116328 net src
  # lines since this branch's September 8 base. This is already-landed main
  # history, not new Deno implementation growth.
  - total
  # Destructured module exports use existing snapshot/live-binding routes.
  - src/codegen/module-namespace-value.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/checker/usage-inference.ts
  - src/codegen/map-runtime.ts
  - src/codegen/apply-closure-variadic-builtin.ts
  - src/codegen/ordinary-new-target.ts
  - src/codegen/rest-only-apply.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/native-construct.ts
  - src/codegen/function-body.ts
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
  # Native Map's carrier must not be mistaken for a user class layout merely
  # because an earlier value read already registered it.
  - src/codegen/class-bodies.ts::collectClassDeclaration
  # Freeze/prototype guards are factored into small builders. These grants
  # cover only the wiring into the existing physical-store and prototype
  # provider owners, not a new inline semantic implementation.
  - src/codegen/closed-struct-extern-set.ts::fillClosedStructExternSetArms
  - src/codegen/closed-struct-extern-set.ts::buildReceiverArms
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  # Construction activation state and lexical arrow capture delegate to the
  # shared helper; allocate rest expressions with the existing rest marker so
  # shared wrapper metadata cannot conflate ordinary array-formal declarations.
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/closures/arrow-phases.ts::mintClosureStructTypes
  # Hash the logical native-string view instead of the backing allocation.
  - src/codegen/map-runtime.ts::ensureMapHelpers
  # Runtime operand validation reuses the shared Reflect object classifier.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
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

### 2026-09-30: source module namespace publication

- Exact runtime graph rebuild continuation: factored the strict v8x builder's
  source-graph construction into `createDenoSourceGraph`, retaining all clean
  detached/pinned checks in the production entrypoint. Added a separate local
  native-test builder that hashes all six pinned Deno fixture sources and
  uses that same runtime/AOT graph generator. Its outputs are explicitly
  labeled test-only, not certified production packages. It refuses non-host
  imports and requires the namespace handle export.
- Rebuilding that exact staged runtime graph found a compiler ordering defect:
  when Map's native carrier is registered before `class SafeMap extends Map`,
  class collection treated it as an ordinary user-class parent, whose field
  table is absent, producing an empty subtype of the five-field Map carrier.
  Class collection now recognizes this exact native carrier and uses the
  existing builtin-subclass construction route; a shadowed user Map class is
  not matched. The hierarchy validator remains intact. Diagnostic logging was
  removed after observing the parent/child layouts.
- The rebuilt graph advances past that hierarchy error but remains **not
  emitted**: `script2` (the unchanged 02_timers wrapper) contains a local.get
  with undefined index at position 147, 209 declared locals. Next locate that
  instruction's producer; do not bypass binary validation or change Deno's
  source. Native exact-core namespace assertions have still NOT executed.
  Artifact build sessions 3139, 10594 and 67156 are terminal failures, not
  running jobs. The prewarmed Map regression compiles but is **0/1** at runtime:
  rendered exception is `TypeError: Cannot read properties of undefined
  (reading 'set')`. Its explicit constructor follows Deno's null-input branch
  `super(); return;`, so next verify the constructor's implicit-this return
  behavior rather than weakening the fixture to a default constructor.
  Builtin-subclass compatibility tests pass **11/11**; combined **11/12**.
  TS7 typecheck and function budget pass. Sessions 50533, 37986 and 57981 are
  terminal; no tests remain live. These changes are not ready to publish.

- Prelinked namespace implementation checkpoint (native exact-core execution
  still pending): runtime artifact generation now places the three live core
  bindings in a private initializer module and re-exports only `core`,
  `internals`, `primordials` through a compiler-native namespace facade. The
  unchanged `mod.js` body still captures bootstrap fields at the explicit
  module stage. Private initializer functions are not public namespace keys.
  Both runtime and POC artifacts expose a phase-guarded numeric namespace
  handle; runtime provenance includes both generated namespace sources.
- Rust prelinked Module::Evaluate now binds its original stable namespace
  wrapper to that artifact value and retains the runtime owner. Object::Set
  refuses writes to module namespace handles before ordinary realm dispatch,
  also covering synthetic namespaces with no graph-local setter. The native
  synthetic regression passes **1/1**, 50 filtered out. Staged compiler
  verification passes exact three-key enumeration, null prototype, live object
  reads, namespace write refusal, host-registration gap and failed/reordered
  stage refusal. The numeric-handle ABI continuation also passes: namespace
  kind is object, its prototype handle is null, and exported core.answer is
  observed live as 43. No process from these checks remains live.
- Targeted `cargo check --test js2wasm_spike` with the Deno POC/runtime compile
  features passes. The broader `cargo check --tests` fails in vendored V8
  tests on missing `third_party/icu/common/icudtl.dat` and an unrelated
  `Vec::new()` inference ambiguity; it is not a passing broad gate. Added
  exact-core native assertions for export identity/refusal, but these have NOT
  executed with a rebuilt exact runtime artifact. The strict artifact builder
  requires clean detached pinned checkouts; do not bypass its provenance rules
  or report the lightweight staged fixture as exact Deno native verification.

- Mixed-union continuation supersedes the red control below. The original
  receiver retains the actual string/array identity. The defect is later:
  an indexed read returns raw externref, then the typed union local uses the
  legacy externref boxing default and tags a boxed numeric element as string.
  Native string union reads now use the existing honest classifier only when
  the contextual sink is `$AnyValue`; generic boxing policy is unchanged.
  Missing classifier support refuses compilation instead of mis-tagging.
  Both mixed alternatives now pass (97 for string, 4 for numeric array).
- Candidate optional-string controls pass **4/4**; infrastructure **2/2** and
  unchanged Deno bootstrap **1/1**, **7/7** combined. Detached baseline
  `31237a90fb8`, same standalone/deno lane and explicit exnref Vitest harness,
  fails the identical minimal mixed-union control **0/1**, returning NaN for
  the string alternative before reaching its numeric assertion. TS7 typecheck,
  function/LOC budget, formatting and diff whitespace checks pass. Broader
  carrier/class replay is terminal **70/70** across seven files: dynamic
  element-read identity 15/15, class prototypes 17/17, dynamic native strings
  12/12, source namespace publication 2/2, numeric-any equality 9/9, mixed
  array tags 9/9, primitive-string indexing 6/6. No process remains live.
  This still does not establish native prelinked Deno namespace publication
  or complete graph-to-core/op/promise integration. Next work those actual
  integration paths; avoid replacing the original three-export core namespace
  with an ordinary snapshot object or a namespace containing adapter helpers.

- Latest infrastructure continuation fixes the baseline `getNewKey` trap.
  Deno's narrowed symbol `.description` receiver must use the symbol-branded
  i32 boundary, not numeric unboxing. Its `string | undefined` result also
  needs native-string runtime dispatch; the previous gate only admitted
  any/unknown and excluded unions containing strings. Updated the shared
  predicate used by indexed reads and guarded method calls. Indexed reads now
  check undefined singleton identifiers too, producing TypeError rather than
  falling through to an unsafe native-string cast.
- The exact infrastructure fixture now passes **2/2**. Combined replay of
  infrastructure, unchanged bootstrap, source namespaces and the new optional
  string controls is **8/9**. The new file passes symbol renaming, undefined
  refusal, and canonical bounds controls (**3/4**); its `string | number[]`
  control remains red at `mixed(1)` with `__str_flatten` null-pointer trap.
  That control is retained, not skipped or weakened. Baseline attribution for
  this newly added mixed-union case has NOT been measured yet. Next inspect
  its conditional/local carrier and narrowed element read rather than claiming
  all unions are supported. LOC/function budget gates, TS7 typecheck,
  formatting and whitespace checks pass after the fixes. Existing string
  compatibility tests pass **18/18 executed**, with **9 skipped** in the
  indexed-read file; skipped tests are not verification. All runs are terminal.

- Latest checkpoint supersedes the red prototype controls recorded below.
  Closed and open donor objects now pass **2/2** namespace regressions, and
  class prototype controls pass **17/17** (19/19 combined). The compiler
  stores identity-preserving prototype edges rather than snapshots, retains
  live inherited reads, supports null terminals, and refuses cycles and
  frozen-carrier mutation. Class intrinsic slots are synchronized so typed
  reads agree with dynamic reads. The old class-cycle test expected a silent
  no-op; it now checks the required TypeError and unchanged prototype, with
  native Node returning the same score 11.
- Property-walk wiring now validates its cursor shape and explicit-receiver
  local, and refuses compilation when the insertion point is missing rather
  than silently omitting inherited reads. TS7 typecheck, LOC budget and
  function budget gates pass after these changes.
- Native namespace run 65166 passed **1/1**, 49 filtered out, 148.01 s using
  an explicit fresh compiler identity. Earlier stale native output was traced
  to cache identity hashing the graph driver but not compiler sources. The
  runtime now hashes the compiler source tree, follows symlink aliases with
  cycle detection, and refuses broken inputs. Its integration test passes
  **1/1**, 50 filtered out. Native rerun 71073 is terminal **1/1 passed**,
  50 filtered out, 149.57 s, with the default cache identity and no override.
  It covers actual Rust namespace handles, calls, live prototype mutation,
  cycle refusal, frozen writes, original thrown-object identity, and no
  interpreter-provider instantiation.
- Broader compiler rerun is **19/20**: unchanged Deno bootstrap **1/1**,
  primordial substrate **17/17**, infrastructure destructuring **1/2**.
  The failing infrastructure fixture traps with `illegal cast` in
  `getNewKey`, called by `copyPropsRenamed`, during module initialization.
  Detached baseline `31237a90fb8`, same standalone/deno lane and explicit
  exnref Vitest harness, reproduces **1/2** with the same stack. This remains
  a real integration defect, not a regression attributed to this edge change.
  Latest diff whitespace and Prettier checks also pass. No test process from
  these runs remains live.
- Main was merged again at `669adddc31c` in signed merge `9e04306b9f6`.
  New source namespace/compiler edge work remains uncommitted in the compiler
  and `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo` runtime checkout.
  Unrelated local edits were preserved. Remaining full-integration gaps include
  prelinked Deno namespace binding, internal graph-to-core calls, descriptor
  operations, arbitrary cross-graph provenance/lifetimes, and broader async
  and module semantics. Strong-root edge/handle registries also still need a
  production lifetime and footprint audit. This is not full Deno completion.

- Prototype continuation: added graph-local get/set-prototype ABI, boxed
  boolean completion, native exception-preserving routing, and explicit
  module namespace null-prototype semantics. Rust Cargo check passes; this
  prototype slice is NOT verified working yet.
- Native prototype control run 62544 is terminal **0/1**, 49 filtered out,
  147.82 s (binary predates the new Rust prototype routes). Initial graph
  prototype identity and inherited value 7 pass, but setting otherProto
  reports true while subsequent prototype identity fails.
- Direct standalone compiler matrix run 74407 is terminal **0/2**: closed
  otherProto fails identity check -54; an open Object.create(null) control
  gets past prototype replacement, inherited-value update, and cycle refusal,
  then fails frozen-marker prototype refusal -56. Keep BOTH controls: do not
  change the failing closed case into an open object and declare completion.
- Relevant substrate: `$Object.$proto` stores `(ref null $Object)`.
  `object-runtime-prototype.ts` canonicalizes callable/builtin proto views but
  converts an unadmitted closed literal prototype into null. Dynamic-proto
  prescan promotes known identifier donors, not arbitrary runtime prototype
  values. Its status helper also returns permissive 1 for non-$Object
  receivers, bypassing a frozen closed carrier's bag flags. Next implement
  identity-preserving, live closed-object prototype support and correct
  integrity refusal in the compiler, not a source-fixture promotion workaround.
  The function/builtin proto-view registry is a possible substrate, but a
  snapshot copy of physical fields would lose live reads and is not acceptable.
- No native test remains running. The stronger prototype assertions currently
  leave the namespace regression red; prior read/write native passes apply
  only to their stated controls, not to the expanded prototype acceptance.

- Added graph-local `Reflect.set` routing with separate success/refusal/
  exception results in the Rust Object::Set API. Module namespace writes are
  explicitly refused without altering live bindings. A write completion must
  use the boxed-value ABI (`: any`), not an inferred raw i32 boolean.
- The frozen exported-object control exposed a real compiler defect:
  `Object.isFrozen` says true, but Reflect.set through a closed struct's raw
  physical-field arm reports success. Freeze records flags in the carrier
  bag; the physical store was bypassing it. Added lookup-only frozen-bag
  refusal before physical writes in `closed-struct-extern-set.ts`; no bag is
  allocated by this check. The namespace regression now passes 1/1 including
  ordinary mutation, frozen-write refusal, and namespace-write refusal.
- Wider standalone verification: 32/33 pass (26 non-extensible accessor,
  3 inherited setter gate, 2 computed-write, 1 unchanged Deno bootstrap).
  Remaining computedWriteCtorField returns 1 instead of 11, reproduced
  identically on baseline `31237a90fb8` in the same exnref Vitest lane (2/3).
  Reflect subset suite passes 3/4, and its stale assertion that Reflect.apply
  must refuse compilation fails identically on that baseline (targeted 0/1).
  These remain recorded failures, not green coverage. TS7, LOC gate, and
  diff whitespace checks pass.
- Native write run 42853 is terminal 0/1 (133.66 s), failing the ordinary
  write completion before the helper's boxed ABI correction. Strengthened
  native run 72318 is terminal **1/1**, 49 filtered out, 146.75 s: successful
  ordinary writes, frozen-object refusal, namespace-write refusal, original
  setter exception identity, and prior namespace/call controls all pass.
  Interpreter-provider instantiations remain unchanged. No native runs remain
  live. Source and adapter changes are still local and uncommitted.

- Merged `loopdive/js2` main `c72cb7bee00` into the active branch with signed
  merge `e3ea1b7e2e7`; no conflicts or overlapping dirty files. All unrelated
  local edits remain untouched. Merge is local, not pushed.
- Native AOT call routing run 13643 is terminal 0/1: `bump()` updates the live
  binding to 42, but reading graph-local `default.answer` returns undefined.
  Added identity-admitted graph-local property reads rather than interpreting
  foreign object layouts in the core realm. Nested object/function results of
  reads and calls are retained for subsequent graph dispatch.
- Native run 5003 is terminal **1/1**, 49 filtered out, 137.15 s: stable native
  namespace and callable identity, live binding update, legitimate undefined
  call completion, default object property read, original thrown object
  identity through Rust TryCatch, and zero additional interpreter-provider
  instantiations all pass. Uses namespace-context-v2.wasm, Wasmtime 47.0.3,
  same-store raw unwrap/keep ABI, and the local graph compiler.
- After the merge, standalone compiler namespace regression and unchanged
  exact Deno core bootstrap pass **2/2** using
  `.tmp/deno-resume-vitest.config.ts` (required exnref flag). Namespace controls
  also reject unrelated same-shaped objects/functions, exercise receiver and
  argument forwarding, and call an escaped closure returned from a graph
  method. TS7, Cargo check, and main `git diff --check` pass. An initial run
  without the exnref configuration failed on unsupported opcode, not runtime
  semantics; corrected harness is the evidence above.
- This does not complete module interoperability: graph-local setters,
  descriptor/prototype operations, internal graph-to-core calls, prelinked
  Deno namespace publication, and arbitrary cross-graph provenance/lifetimes
  still need implementation and verification. Observed-value tracking retains
  strong references and is not yet a production lifetime strategy. The known
  synthetic JSON/text/bytes test remains an unresolved baseline failure.

- Continuing the verified native foreign-call failure: add a graph-local
  matcher comparing callable identity with actual live exports, plus a
  graph-local AOT apply entry. Add private same-store unwrap/keep bridge
  exports; Rust roots the transient GC values, routes a matching call to its
  compiled graph, and transports normal/exception completions separately.
  A `void` result must not be used as evidence that dispatch missed. Nested
  host reentry uses the same Store-owned graph list through CallerRealm.
  This first tier covers graph exports, not yet every escaped factory closure.
- Audited v8x `Module__Evaluate` and `Module__GetModuleNamespace`: source
  modules allocate a stable branded Rust object but evaluation never publishes
  their compiled exports. Existing source namespace coverage checks branding
  and identity only, not export values or live updates.
- Plan: publish compiler-native namespaces for the statically reachable graph
  into the shared realm, then bind each stable Rust namespace wrapper to its
  corresponding realm value. Do not parse exports with regex or copy scalar
  values: callable/object identity and mutable live bindings must survive.
- Preserve lazy/disconnected manifest modules: namespace publication must not
  turn every known module into an eagerly executed dependency.
- Compiler implementation keeps the original entry and its export ABI, adds
  native namespace imports/publication, and supplies only reachable lowered
  source files. Verified live scalar updates, callable/default identity, and
  disconnected-module non-execution, 1/1. TS7 passes; exact Deno bootstrap
  passes 1/1. Broader graph suite passes 7/8; synthetic JSON/text/bytes global
  calls fail with `TypeError: called value is not a function` on both current
  candidate and original `31237a90fb8` baseline (same standalone Vitest lane).
- v8x source namespace binding and graph-owner retention implemented; Cargo
  check passes. Non-eval linked graphs with an existing context now skip
  interpreter-provider instantiation, with a native counter assertion added.
  Native namespace verification is not yet passing: first run hit sandboxed
  default cache path; second proved the generic callback fixture lacked
  `__v8x_context_global_this`. Added a dedicated context fixture with the
  required shared-realm exports. Third run (42240) is terminal 0/1: initial
  scalar 41, namespace identity, function identity, and callable brand pass,
  but calling `bump()` through the core realm silently leaves the live binding
  at 41 instead of 42. Its owning graph executes the same function correctly
  in the compiler test. Next implement a source-proven AOT foreign-call route
  rather than accepting undefined dispatcher fallthrough as a completed call.
- The first compiler probe's missing function brand was an instrument defect:
  its JavaScript graph lacked `allowJs: true`. With that corrected, the actual
  compiler failure was disconnected-module execution, fixed by pruning the
  compile inputs. Do not attribute the initial brand miss to codegen.
- Uncommitted checkpoint: graph publication helper and one regression test in
  js2; namespace binding, graph ownership, optional interpreter-provider
  selection, native test, and namespace context fixture generator in v8x.
  No native namespace changes have been pushed to PR #2. Cargo formatting
  reports both new and pre-existing differences; do not claim it passes.

### 2026-09-30: dynamic callback construction state

- Ordinary lifted functions lower `new.target` to `undefined` in
  `expressions.ts`; native ordinary construction invokes the same receiver
  dispatcher as a call and supplies no construction state. The bridge's host
  rejection guard therefore reaches the host import instead of throwing first.
- Add regressions for exact guard rejection, constructor identity, lexical
  arrows, ordinary nested calls, and cleanup after throwing. Plan a one-shot
  construction operand consumed into the callee activation's local before
  parameter initialization. Arrows capture that local; ordinary calls consume
  the cleared operand. Protect the native driver operand against exception
  exits and preserve the existing class constructor path.
- Initial four regressions were 0/4 on `31237a90fb8` and 4/4 with activation
  state. Native callback test now passes 1/1, including constructor rejection
  and caught host exceptions (previously 0/1).
- Additional default-parameter probe exposed a missing zero-arity dispatcher;
  when absent, ordinary construction now uses the existing widening vector
  bridge. A nine-argument rest probe exposed the fixed dispatcher cap; add a
  full-vector zero-fixed-formal rest arm, guarded by zero declared arity and
  the actual vec funcref signature. Preserve receiver and exception cleanup,
  and test every argument plus a non-rest array-formal control.
- The coexistence control exposed declaration-order-dependent overwrite of
  shared wrapper metadata. A registration-only fix passed the forward order
  but failed the reverse order (1/3 result). Rest function expressions now
  allocate the existing rest-marker subtype, matching declaration singletons;
  the ordinary array formal retains its distinct calling convention. Added
  both source orders and full-vector receiver/thrown-identity controls.
- Checkpoint on main base `ccc5de16cbd`: 25/25 focused compiler tests
  (nine new construction tests, exact Deno bootstrap, callback receivers,
  namespace destructuring, wide construction, runtime argv, and collections),
  20/20 callback/array controls, and 16/16 existing rest-carrier/dispatch tests.
  TS7, source/function budgets, and formatting pass. A fresh full bridge
  artifact passes all eight JS assertion groups and the native Rust/Wasmtime
  nested-callback test, 1/1 (48 other tests filtered out, 125.54 seconds).
- Handoff: this closes the host callback construction guard failure, not the
  full Deno integration acceptance list. Next verify typed ordinary constructor
  drivers and broader constructor paths, then implement source-text namespace
  publication/live bindings in v8x and general Rust-op/promise ordering. The
  existing class new.target path is preserved rather than redefined here.

### 2026-09-30: callback receiver isolation

- Merged latest `loopdive/js2` main (`fd0cf19cb95`) at `347f83b5078`, preserving
  unrelated dirty files without stashing.
- The exact bridge probe failed before Rust: `host.call(object, ...)` sent the
  global object's handle as `this`, not the object's handle. The variadic
  builtin apply shortcut admitted an ordinary rest callback sharing its
  Wasm signature and bypassed receiver installation. Restrict that shortcut
  to the three builtin metadata identities, including their discriminator
  fields, instead of signature shape alone.
- The self-contained regression with the original signature-only guard passes
  1/2 (`call` fails, `apply` is the control). The fixed full bridge passes
  receiver identity and nested reentry. Compiler regression and controls pass
  25/25, including the exact Deno bootstrap and destructured namespace cases;
  TS7 typecheck passes.
- Native callback verification now passes the receiver assertion and nested
  callback mutation, then fails later at `exerciseThrow` (returns -2, expected
  1). Host callback construction rejection is a separate remaining defect,
  also reproduced by the JavaScript-only bridge probe. The native test is
  terminal (0/1 overall); do not report it as passing.

### 2026-09-30: string-handle lookup verification

- The bridge decodes an empty string with the correct string brand and length,
  but receives a new handle instead of reusing the literal's Map entry.
- A minimal decode/delete control passes. Testing sliced strings to check
  whether collection hashing wrongly uses the whole backing array rather than
  the native string's logical length and offset. NativeString layout is
  `{len, off, data}`; the current Map hash scans `data.length` from index zero.
- Confirmed by a substring Map-key regression: 2/3 controls pass on the parent,
  the nonzero-offset substring lookup fails. Hashing logical length and offset
  makes 3/3 pass and the full context bridge fixture passes all assertions,
  including 512 transient-packet retirement checks. Native adapter verification
  is now running against the freshly compiled artifact, not a stale binary.
- Expanded Map/Set logical-view coverage including a surrogate-pair substring:
  4/4 regressions pass. Collection controls pass 24/24, and the exact Deno
  bootstrap remains passing (1/1). The native debug suite is live in session
  `12218`, process `22093`; it was using 572% CPU after 2m32s, not stalled.
  One selected function-name test failed immediately because its separate
  `V8X_JS2WASM_FUNCTION_NAMES_WASM` variable was missing. Its source fixture is
  included in the same context artifact; rerun with that variable after the
  current run completes. Do not restart the running suite on a wait timeout.
- Native run is now terminal (exit 101/SIGABRT), not still compiling. Numeric
  coercion/exception identity passed in Rust. Reentrant callback test aborts at
  `realm_host_mutate`: `args.this()` is not strictly equal to argument zero.
  This is an unresolved receiver-identity boundary defect; the aborted suite
  does not establish results for the other still-running tests.

### 2026-09-30: coercion exception ordering

- The context bridge fails specifically on `throwingCoercion` during ToNumber.
  Direct `valueOf()` and direct throw controls pass; unary `+value` fails.
- Emitted WAT shows the `any` local promoted to `f64`, calling ToNumber in
  the initializer before entering its `try_table`. This moves the observable
  `valueOf()` call and exception outside the source catch.
- Restrict the usage-only numeric-local route to writes with inert primitive
  conversion. Grounded-number definition proofs remain eligible. Pending
  regression and full bridge verification; full Deno integration remains open.
- Verified 97/97 focused numeric-local, coercion, usage-inference and prototype
  tests. Three envelope controls now pass; the original unary-plus case failed
  on the parent while direct calls and direct throws passed. An additional
  regression proves conversion is not invoked on an untaken read after an
  object assignment. Two old representation assertions required eager
  conversion of unknown writes and were corrected to require boxed carriers;
  their semantic checks remain unchanged.
- Full context fixture now passes numeric coercion and exception identity. Its
  next stop is empty-string canonical handle reuse after buffer decoding (not
  signed zero: extra checks prove signed-zero stability throughout handle
  growth). The fixture still stops before artifact publication.
- Exact two-store Deno bootstrap and destructured namespaces remain passing
  (4/4 tests). Typecheck also passes. Native namespace export publication is
  still the next integration step once the full context bridge is verified.

### 2026-09-30: resume native adapter after compiler namespace fix

- Restored the published v8x branch at `83f5554c398f94a77ac32e110104c45460969695`
  in `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`.
- First native adapter build stopped in vendor setup while downloading Chromium
  ICU test data. The adapter test does not embed that file; js2wasm setup now
  skips it, while manual `rusty_v8` setup retains upstream test support.
- Next verification is the native adapter suite and compiled module namespace
  publication. This checkpoint does not establish complete Deno integration.
- Native adapter baseline: 23/23 executed tests passed, 2 artifact-dependent
  tests ignored. Fresh compiled context fixture stopped on an invalid dynamic
  `Reflect.setPrototypeOf` prototype that should throw. A compiler regression
  reproducer rejected 0/9 invalid operands before adding runtime validation.
- Runtime validation now rejects 9/9 invalid operands. Focused namespace,
  prototype refusal, proxy, and Symbol tests: 44/44 passed; TS7 typecheck passed.
  The context fixture advances past prototype/identity/buffer checks but still
  fails later in numeric coercion with a Wasm exception, before writing a usable
  artifact. Do not claim the native compiled bridge suite passed.
- Runtime-compile native suite: 26 passed, 2 failed because their required raw
  Deno/runtime-eval artifacts are absent, 21 ignored. Compiler-free suite:
  23 passed, 2 ignored. Manual `setup_vendor.sh js2wasm` also succeeds.

2026-09-30 namespace validation complete: 22/23 focused tests pass with explicit exnref worker support. The sole failure in `issue-3188-module-namespace-tostringtag.test.ts`'s standalone TypeScript runtime-namespace callable projection reports `dynamic array length fill requires a pre-reserved Hole global`; pristine detached control `10ec2abc3a4` reproduces the identical failure (7/8 in that file). Three new destructured-export regressions were 0/3 on baseline and 3/3 on candidate. Exact two-store Deno bootstrap passes with namespace score 3 and no recorded blocker. TS7 and diff whitespace checks pass. New source only extends declaration admission; it reuses the existing snapshot and mutable getter machinery. Restored v8x checkout is clean at published `83f5554` with rusty_v8 pinned `dd1b4e9c743b7a11dbeb99d4d0dc55979218b905`; native rebuild and broader op/module/promise integration remain ahead. Original uncommitted ABI comment and Acorn artifact are preserved outside this fix.

2026-09-30 destructured namespace repair: baseline `10ec2abc3a4` fails all three new standalone regressions with raw Wasm exceptions. Candidate recognizes top-level BindingElement declarations, including nested object/array patterns, and routes const bindings to existing snapshots and let/var to existing live getters. The three regressions pass; the actual two-store Deno bootstrap checkpoint now returns namespace identity score 3 with no blocker, replacing the previous expected exception, and exact hello-world/host effects still pass. First broader run 8/9 passes; the only failure is the test worker's missing `--experimental-wasm-exnref` flag for a generator fixture. Rerun with explicit worker flag pending. TS7 typecheck passes. Full native v8x replay is not re-established yet; restored runtime checkout lacks initialized rusty_v8 submodule. This is compiler namespace progress, not completion of native namespace handles or full Deno integration.

2026-09-30 full bootstrap envelope rerun passes 1/1, including all source hashes, exact imports/exports, two isolated stores, wrapper/module/usage stages, host output and no provider calls. The remaining namespace failure is traced to `mod.js`'s `const {core, internals, primordials} = bootstrap; export {...}`: `module-namespace-value.ts` only accepts Identifier VariableDeclaration exports; the checker represents these bindings as BindingElement declarations, so it declines the whole namespace. Adding a regression for object aliases, array bindings, and nested mutable bindings before extending the existing snapshot/live-getter routes. Namespace success must then replace the bootstrap test's expected-exception checkpoint.

2026-09-30 resumed integration after main merge `10ec2abc3a4`: primordial substrate tests pass 17/17. Full unchanged-core child probe exits successfully and emits 2,697,863 bytes; the enclosing test stops at its stale 6.2–6.75 MB envelope before checking later assertions. Envelope updated to 2.5–2.9 MB, with source hashes, exact imports/exports, two-store stages, host calls and output assertions retained; rerun pending. Published v8x PR 2 remains open at `83f5554`, compiler PR 5784 remains open at `5aa3d8f85743bb`; original temporary checkouts now contain only leftover build directories. Restoring runtime source from its published branch in `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`. Module namespace test currently expects a recorded raw Wasm exception, so general namespace support remains an explicit integration gap.

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

The branch is synchronized with `loopdive/js2` main at `16498efb481cb022ee5c4dcc9bb137b6d4c91a50`. That sync exposed a reserved nested-parameter ABI regression in the Deno primordial graph: body compilation was re-registering a carrier already reserved by the hoist lane, changing an `externref` parameter to `ref_null`. The Deno-scoped guard in `src/codegen/statements/nested-declarations.ts` preserves the hoisted carrier order while leaving the general reservation fix enabled for other targets.

The focused reservation and Deno bootstrap suite passes after the guard, and `pnpm run typecheck` passes.

### PR 5784 Temporal acquisition race repair (2026-09-09, pending validation)

Actual merge-group run `34303910910`, host shard 9 job `102316820369`, contains all 26 Temporal regressions. One worker logged `Temporal provider NOT linked` after the JSBI source-link assertion failed at 02:39:20Z; three others loaded the same prewarmed provider successfully two seconds later. The acquisition helper formerly extracted directly into a shared root and treated entry-file existence as completion. This permits a reader to observe a file while another process is still extracting it. The source assertion remains correct and must not be relaxed.

The separately owned acquisition repair stages both pinned packages privately, validates their ESM link and UMD entry, and atomically publishes one completed generation keyed by both pins and extraction/link schema. Tarball integrity is rechecked on every call. A publication loser validates the completed winner and removes only its own staging path. Legacy extraction data remains untouched and is not trusted. Compatibility change: `force` produces a fresh generation and returned paths rather than deleting the shared root; existing readers retain valid paths.

Focused deterministic tests cover the partial-file visibility window, the unchanged old-reader link assertion, concurrent publication winner/loser behavior, failed extraction, corrupt tarballs despite an existing generation, and force preserving prior returned paths. These tests are written but not yet executed; no race reproduction or repair pass is claimed at this checkpoint. Compiler, runtime, workflows, baselines, pin contents and link assertions are unchanged. The join/presence and TypedArray blockers remain separate, and PR 5784 stays held.

The five acquisition tests subsequently passed (session 23374, exit 0, 1.86 seconds, Node 22.23.2 Darwin). The deterministic barrier exposes incomplete JSBI bytes and proves the unchanged old-reader link assertion rejects them; it does not execute the full old setup implementation. Concurrent new callers instead return the same completed generation and source hash, with no leftover staging directory. Negative controls retain tarball integrity and incomplete-generation refusal, and a failure extracting the second package publishes neither package. Cleanup releases the owned barrier and awaits acquisition-process close before deleting private fixtures, including assertion-failure paths. This is bounded acquisition evidence only: the 26 actual Temporal rows have not been rerun, and other held PRs are not cleared by this test result. Final review and normal publication gates remain pending.

## 2026-09-30 upstream-main sync

Merged `loopdive/js2` main at `eb57f327340aaecb4ffd664417ff15fe4ba13905` into `codex/4376-deno-followup-20260908`. The sole conflict was this handover: retained both the branch's Deno parameter-reservation guard record and main's Temporal acquisition race repair record. Compiler source merged automatically. Existing uncommitted documentation beside `IrLoweredSignature` is preserved at its new declaration location in `src/ir/backend/lower-contracts.ts`; the uncommitted Acorn Wasm artifact and unrelated untracked files remain outside the merge commit. This synchronization does not establish completion of Deno integration.
