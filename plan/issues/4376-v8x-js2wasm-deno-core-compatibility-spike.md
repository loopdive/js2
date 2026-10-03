---
id: 4376
title: "Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime"
status: in-progress
created: 2026-08-12
updated: 2026-10-04
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
  # 2026-10-04: narrow opt-in routing to the captured-reference RMW leaf;
  # direct BigInt update equality must not fold from an inferred Number type.
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/unary-updates.ts
  - src/codegen/binary-ops.ts
  # 2026-10-04: later Script assignment resolves the Context lexical record
  # before RHS evaluation, preserving strict/sloppy global behavior on misses.
  - src/codegen/expressions/unresolvable-assign.ts
  # 2026-10-04: opt-in native lexical cells preserve declaration initialization
  # through IR rather than treating it as an ordinary binding assignment.
  - src/ir/core/nodes.ts
  - src/ir/builder.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/wasm/model/instructions.ts
  # 2026-10-01: experimental shared Script var transport adds one config field
  # and preserves Context bindings rather than resetting private-slot seeds.
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/module-var-undefined-seed.ts
  # 2026-09-30: live receiver-backed VEC stepping and rest draining reuse the
  # existing native indexed readers instead of normalized element snapshots.
  - src/codegen/iterator-native.ts
  # 2026-10-01: reflective keys/entries use live receiver-backed records too;
  # next/rest/prototype dispatch recognizes their distinct iteration kinds.
  - src/codegen/array-proto-iterator-value.ts
  # 2026-09-30: runtime import-alias declaration checks in both typeof forms;
  # type-only imports remain unresolvable at runtime.
  - src/codegen/typeof-delete.ts
  # 2026-09-30: one-line read guard prevents the native Promise handler slot
  # from participating in alternate physical-field property dispatch.
  - src/codegen/property-access-exact-shapes.ts
  # 2026-09-30: five instructions mark the native Promise in the existing
  # non-suspending IR await arm. No new driver branch or fallback is added.
  - src/ir/lower-generic.ts
  # 2026-10-01: against the newly merged main, the existing native Promise
  # rejection resolver adds one import and a three-line method. Restate this
  # branch's allowance here rather than relying on an unchanged issue's grant.
  - src/ir/integration.ts
  # Four public API documentation lines explain the opt-in shared realm tag.
  # No implementation logic is added to this barrel.
  - src/index.ts
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
  - src/codegen/closures/funcref-as-closure.ts
  - src/emit/binary.ts
  - src/codegen/statements.ts
  - src/link/linker.ts
  # 2026-08-29 (post-merge): terminal-flat-body relaxation of the #1058
  # shared-body refusal + instr-level double-shift guard commentary.
  - src/codegen/stack-balance.ts
  - src/codegen/expressions/late-imports.ts
  - src/codegen/async-scheduler.ts
func-budget-allow:
  # 2026-10-04: exact opt-in calls into the persistent-reference leaf and
  # dynamic equality for a persistent update whose checker assumes Number.
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/ir/integration.ts::makeResolver
  # 2026-10-01: restate the pre-existing receiver-backed live next/latch arm
  # against merged main. keys/entries value construction is a separate helper;
  # rest finalization only admits the two additional native record kinds.
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  # Existing one-line linked realm property-reader reservation differs from main.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  # 2026-09-30: same five-instruction handler-state write in the existing
  # IR await arm, charged to both nested function counters by the gate.
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  # Canonical Array identity fallback delegates to a separate constructor helper.
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  # Keep constructor lexical class identity explicit for nested SuperCall.
  - src/codegen/class-bodies.ts::compileClassBodiesInner
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

### 2026-09-30 pending reaction FIFO prerequisite

Final verification: native build-time session 43863 passes 1/1 (52 filtered, 254.71 seconds including precompilation), including the three Rust pending-op reactions in [1,2,3] order. The resulting `deno-native-fifo.cwasm` plus matching attestation passes the genuinely compiler-free focused target, 24/24 executed tests with 2 explicit ignores (session 85031, 1.28 seconds). Bootstrap/staged/timer/order regressions pass 20/20 (session 25945). All cited sessions are terminal; the earlier pending statement below is historical. The deployment fixture now needs these FIFO artifacts to exercise the new generated code. Public docs record local ordering and distinguish it from still-unproven global ordering; Typst rendering remains unavailable. Handler-state work is next, not completed by this fix.

Tracing handler-state registration exposed a local Promise ordering defect: pending reactions are prepended, then settlement traversed that list newest-first. Fresh fulfillment and rejection probes both failed with order 321 instead of 123 (session 77283, 0/2). Settlement now restores registration order before enqueueing: immutable multi-node callback lists are copied in reverse while preserving function/capture references; null and single-reaction lists allocate no copies. The Promise/callback ABI and the common single-reaction path are unchanged. A separate runtime-body helper emits fresh instruction objects at each use to avoid shared-instruction remap hazards. This does not establish global order across multiple graphs and Rust's queue, and handler-state reporting remains unimplemented.

Focused Promise/ring/Deno-hook controls pass 37/37 (session 52104). Stronger ownership/shared-tag/order controls pass 7/7 (session 3906), including reentrant reaction scheduling, thrown-handler reason identity and the expected 12345 ordering behind existing siblings. Native resource and resolution controls passed 99/99 in session 31605, but its settlement-preservation child failed 17/19 before execution: Node rejected standardized exception instructions because that isolated process omitted `--experimental-wasm-exnref`. Its explicit child argv and authenticated expected launch now include that flag. All 19 preservation/provenance tests subsequently pass (session 1828). No execution assertion or source receipt was weakened.

Rebuilt `deno-native-fifo.wasm` is 2,665,968 bytes, six exact sources, 16 native host-function imports. Node artifact controls pass 2/2. The native test registers three real Rust reactions on Deno's pending op and requires order [1,2,3] after the public checkpoint. Build-time native/precompile session 43863 is still running; compiler-free validation must load its new `deno-native-fifo.cwasm` with the matching attestation, not an older artifact whose generated settlement code retains LIFO behavior. TS7 and LOC/function budgets pass. All source edits remain local/uncommitted. Next finish this native ordering proof, then add actual persistent Promise handler state and unified scheduler ordering, retaining the full Deno integration acceptance.

### 2026-09-30 owning-graph Promise reaction routing

Final native rerun passes 1/1 (session 23978, 50 filtered, 146.26 seconds including raw context/graph compilation). For both pending and already-settled graph Promises it verifies result 43, chained result 44, thrown native-handler rejection, catch recovery to undefined, and asynchronous Pending states before checkpoints. The prior failures remain below as attribution evidence. The runtime tag whitelist and provider-presence check are required parts of the fix. Full compiler-free replay for this specific separately compiled graph is still unverified; general queue ordering and handler tracking remain open.

All sessions mentioned in this section are now terminal; earlier live/pending statements describe intermediate checkpoints. Final compiler-free focused target passes 24/24 executed tests with 2 explicit ignores (session 8232, 1.11 seconds). TS7, LOC/function budgets, Prettier, rustfmt and whitespace checks pass after the shared-tag repair. Public docs still cannot be rendered locally without Typst. No full vendor/Deno conformance population or throughput comparison was run, and all new compiler/runtime source changes remain local/uncommitted.

The stronger chained/rejecting native test exposed an additional cross-graph exception-tag defect (session 15635, 0/1, 50 filtered, 124.82 seconds). Fulfillment/chaining reached 44, but a thrown Rust handler escaped the application graph's rejection wrapper and left its derived Promise Pending. The context callback closure throws the context's module-local tag; the separately compiled graph catches a distinct tag. The mandatory rejection assertion is retained. A new opt-in `standaloneGlobalThisImport.exceptionTag` imports the realm provider's exported tag through the existing host-free linked-tag mechanism, and compile-graph selects `v8x:context.__exn_tag`. Omitting the option retains local tags. Compiler controls pass 4/4 across two files (session 71369), including a provider's original exception payload caught with the shared tag and a negative control proving it escapes without sharing. Native chained/rejection/catch rerun session 90400 is still running; do not count this repair as full native rejection acceptance until terminal success.

Prepared namespace graphs now publish `__v8x_graph_promise_then_export`. It rejects unowned receiver values, calls the compiled Promise intrinsic and remembers the returned derived Promise, so subsequent reactions can route back to the same graph. Runtime dispatch unwraps same-store handles, tests graph ownership and retains the actual completion; graph-thrown exceptions keep their payload identity. Both ordinary runtime and active-callback realm access use this route before the owning context's default reaction helper. No interpreter route was introduced.

Session 90400 ended 0/1 (147.89 seconds): the runtime import whitelist rejected `v8x:context::__exn_tag` before evaluation. The runtime now admits that exact Tag import and verifies `realm.get_tag` before linking; a missing tag remains an explicit error rather than a deferred trap. Native stronger rerun session 23978 is live. The four compiler controls and latest TS7 pass, but native thrown-handler acceptance is still pending this terminal result.

Compiler namespace controls pass 3/3 (session 75070), including pending/settled receivers, deferred callback execution, result 43 and an unowned-Promise refusal. The native source-namespace test passes 1/1 (session 77649, 50 filtered, 148.61 seconds including context/graph compilation), exercising pending and already-settled Promises created by a separate application graph and Rust callbacks adopted by the shared context realm. Existing live bindings, object/prototype identity, namespace write rejection, exception identity and no-interpreter-instantiation assertions remain intact. This test enables runtime compilation for its input artifacts; it is not evidence of compiler-free cross-graph replay. The focused compiler-free pinned Deno target separately still passes 24/24 executed tests with 2 explicit ignores (session 85837, 1.07 seconds). TS7, LOC/function budgets, formatting and diff checks pass.

Runtime/compiler changes remain local. Next validate chained and rejecting cross-graph reactions, then implement genuine handler-state reporting and marking, unified queue ordering, and the remaining full-Deno acceptance. The goal remains open.

### 2026-09-30 native compiled Promise reactions

Native `Then`/`Catch` now call an exported compiled-realm helper invoking the actual `Promise.prototype.then` intrinsic. The derived Promise remains Wasm-owned and is retained through the existing identity table, rather than creating a Rust placeholder or polling settlement. Missing handlers use undefined; native handlers enter through the existing callback bridge, with a per-reaction snapshot of continuation-preserved data and an RAII restore after invocation. Ordinary native callbacks still use the current continuation, not a registration-time snapshot. Handler tracking and reaction registration on foreign application graph Promise types remain incomplete; this change does not establish unified queue ordering.

Staged tooling controls pass pending and already-fulfilled receivers, no synchronous callback on registration or settlement, callback result 43, thrown reason 77, and catch recovery to 78. The native public Script::Run test passes 1/1 in the genuinely compiler-free build (session 36735, 25 filtered, 1.02 seconds), with pending/fulfilled native reactions, distinct derived Promise identity, a thrown Rust handler, catch recovery, original captured object continuation identity, and restoration of the checkpoint's prior continuation after a handler mutates it. Existing scalar/object/rejection, stack, namespace and unchanged hello-world assertions remain mandatory.

New artifact: `deno-native-reactions.wasm`, 2,665,760 bytes, six pinned sources and 16 native host-function imports. Node artifact controls pass 2/2. Trusted local precompile/attestation: `deno-native-reactions.cwasm` and `deno-native-reactions.attestation.json` in `/private/tmp/v8x-deno-resume-20260930.o0sxeO`. Precompilation took place in session 3280, whose raw two-store boot test subsequently failed because this native attachment artifact requires a live context; 0/1 raw-store boots is not counted as acceptance. The public native-context test loaded the resulting artifact and passed independently. Cargo checks, rustfmt and whitespace checks pass. Runtime changes remain local/uncommitted. Next: expose real compiled handler state/marking and route reactions to their owning graph, followed by ordered shared scheduler and the remaining general Deno acceptance.

Final focused compiler-free target rerun passes 24/24 executed tests, with 2 explicitly ignored artifact/provider tests (session 22964, 1.19 seconds). Rust formatting, whitespace and shell syntax checks also pass after the reaction changes. Full vendor/Deno conformance and application throughput remain unmeasured.

### 2026-09-30 verified compiler-free pending-op rejection

The Deno host now installs `Error.captureStackTrace` before primordial capture, through the existing native callback bridge. It captures actual Wasmtime frame indices and available function names, defines a non-enumerable `stack` on the original error, and preserves an already supplied embedder implementation. No Deno fixture was modified and no interpreter or new host import was added. The native pending-op test now verifies scalar fulfillment, original-object fulfillment, original TypeError rejection identity, and a stack beginning with the error name/message and containing real `wasm-function` frames. Source locations, identity-based `constructorOpt` frame trimming, and complete V8 formatting remain unimplemented.

A feature audit corrected the earlier compiler-free claim below: `js2wasm_deno_poc` previously depended on `js2wasm_runtime_compile`, so omitting the latter on the command line still linked Cranelift. The POC feature now depends only on `engine_js2wasm`; build-time commands explicitly enable `js2wasm_runtime_compile`. The resolved Wasmtime feature graph for `--no-default-features --features js2wasm_deno_poc,js2wasm_gc_copying,simdutf` contains runtime/GC features and no Cranelift. In that genuinely compiler-free build, the unchanged native Deno path passes 1/1 (session 83641, 25 filtered, 1.06 seconds). The complete focused `js2wasm_spike` target then passes 24/24 executed tests with 2 explicitly ignored raw-graph/provider-artifact tests (session 69489, 1.00 second). These durations are test-suite timings, not throughput benchmarks or full Deno acceptance.

The existing six-source `deno-native-microtasks.wasm` and trusted local precompile/attestation were reused. Node AOT controls pass 2/2: exactly 16 native function imports, no provider/memory imports, and unknown-script refusal without native op invocation. The staged tooling acceptance script also passes deferred stages, host-registration gap, live namespace publication, and rejected reorder/retry controls (session 43513). An explicit compiler-enabled library build still passes after the feature split (session 98170). Rust formatting, shell syntax and whitespace checks pass. Public documentation describes both verified behavior and remaining gaps, but rendering is unverified because Typst is not installed, including at `/opt/homebrew/bin/typst`. Runtime changes remain local/uncommitted in `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`.

Next is native Promise reaction registration and handler tracking. Current `Then`, `Catch`, `HasHandler`, and `MarkAsHandled` explicitly report unsupported operations on compiled Promise wrappers. The compiler's existing `__promise_boundary_observe` is conditional on notification imports and immediately notifies for already-settled promises; it cannot be treated as an unconditional, correctly ordered native `.then` ABI. Use the compiled Promise's real reaction machinery, preserve returned Promise identity and asynchronous callbacks, and test both pending and already-settled cases, thrown handlers, chaining, and continuation data. Unified native/cross-graph FIFO, general Rust op/module acceptance, and production packaging also remain open. No full-integration completion is claimed.

### 2026-09-30 native pending-op checkpoint progress

The native test now calls Deno's real `core.__eventLoopTick(promiseId, isOk, result)` to settle pending ops. The initial attempt to read `globalThis.__infra` was invalid: unchanged `01_core.js` intentionally deletes that private bootstrap object after capturing its resolver. No Deno source was changed to expose it. With the existing adapter, the scalar promise stayed Pending after the public microtask checkpoint, proving that the checkpoint drained only Rust's queue and not the compiled Promise-reaction queue.

The compiler now exports `__microtasks_pending(): i32` alongside `__drain_microtasks`. The count is the actual queue tail minus head, not a guessed success flag. Exact-source eager/staged pending regressions assert zero jobs before settlement, positive jobs after settlement, and zero after draining. All 34 tests across those regressions and the unchanged full bootstrap pass (session 43921). TS7 and LOC/function budgets pass.

The runtime checkpoint now drains attached compiled graph queues to an observed fixed point, then continues any Rust-side jobs they enqueue. It clones owners before entering Wasmtime, deduplicates runtimes, enters each owning Context and retains the existing reentrancy guard and heap-limit enforcement. Contexts are tracked separately from allocated values so checkpoints do not scan the whole heap. Graphs publishing a drain without the new count ABI fail explicitly; they must be rebuilt. Three Rust-native microtask FIFO/chaining/continuation controls pass. Library and selected integration-target cargo checks pass. A broad `cargo check --tests` cannot build unrelated rusty_v8 vendor tests because pinned ICU data is absent and an existing serializer Vec assertion is type-ambiguous; neither vendor source nor data was modified.

The scalar-only native checkpoint test passed 1/1 after precompilation (session 28512, 246.61 seconds). The expanded test verifies scalar and original-object identity through actual pending ops, but its mandatory rejection identity check currently FAILS for op ID 2. The compiled catch-derived promise correctly becomes Rejected, yet the reason is a replacement TypeError with name `TypeError` and message `called value is not a function`, instead of the original Rust TypeError. Cause: Deno's unchanged `__opRejectHandler` calls captured `ErrorCaptureStackTrace`, while the standalone realm intentionally lacks V8's non-standard `Error.captureStackTrace` (`standalone-unavailable-globals.ts`). The assertion is retained; rejection compatibility is not claimed. Latest failure: session 83062, 0/1, 52 filtered, 0.89 seconds, after successful scalar/object settlement assertions.

Current artifacts: `deno-native-microtasks.wasm` (2,663,500 bytes, six pinned sources, 16 host imports, no interpreter), `deno-native-microtasks.cwasm`, and `deno-native-microtasks.attestation.json` in `/private/tmp/v8x-deno-resume-20260930.o0sxeO`. Rebuilt optional context fixture is `namespace-context-microtasks.wasm` (1,147,138 bytes). Runtime source remains uncommitted in that directory's `repo` on `codex/4376-deno-realm-bootstrap`. Compiler queue-count publication and assertions are local on `codex/4376-deno-callback-construction-20260930`.

Next: implement the Deno host realm's real stack-capture API before primordial capture, preserving rejection reason identity and honest available stack information, rather than changing the pinned handler or silently adding a no-op. Also still open: native `Promise.then/catch` on compiled Promise wrappers, handler tracking, cross-graph/native unified FIFO and continuation/exception ordering, broader Rust op/module acceptance and production packaging. The current fixed-point drainer verifies quiescence; it does not prove one globally ordered queue across native and multiple compiled graphs. The full Deno integration goal remains open.

### 2026-09-30 native script completion repaired

Main was fetched from `loopdive/js2` and merged at `aa95a371ac66de545e06c10f428ef2da578be082`; signed merge commit `824a310d172` follows Deno checkpoint `f18f2ff083a`. Unrelated local ABI comments and the Acorn artifact remain untouched.

The remaining result-string trap was a compiler result-carrier defect, not a JSON parser or Deno-source issue. `__v8xEncodeEvalValue` returns `string | undefined`; its nullable native-string result preserved absence on typed calls but generic function-value dispatch converted the null reference into JavaScript null. The native router therefore reported status 1 and stored a null string for the AOT program's undefined completion. Minimal direct/imported controls passed while dynamic invocation failed. The full generated graph reproduced the same defect (`probeUndefined = 1`). Extending the existing function-declaration mixed-undefined result widening to native references preserves the actual undefined value at its producer. The general union/type-mapper rule is unchanged; non-nullish signatures and already-boxed results retain their carriers.

After this repair, 122/122 focused compiler tests pass across 17 test files, including exact-source pending-promise settlement, unchanged full bootstrap, nullable call results, constructor guards and primordial invokers. TS7 typecheck and diff checks pass. The newly repaired concrete-reference residual is now a positive regression; two other stale expected-failure rows were separately confirmed already passing with this repair removed and are not credited as gains. No full test262 population sweep or new throughput comparison has been run.

Native public `Script::Run` integration passes 1/1 (52 filtered), session 83205, 250.62 seconds including Wasmtime precompilation. Artifact `/private/tmp/v8x-deno-resume-20260930.o0sxeO/deno-native-result.wasm` is 2,663,441 bytes, contains six exact pinned Deno sources and 16 host-function imports, and ships no interpreter. Corresponding trusted local artifacts are `deno-native-result.cwasm` and `deno-native-result.attestation.json`. The unchanged hello-world source returns undefined and produces all six expected prints and two sum callbacks, including the original Rust TypeError. Earlier checks in the same test also verify native op stubs, scalar/object fulfilled Promise results, pending op ID 0 and Pending state, three source namespace bindings, and continuation data identity.

Historical correction: session 16915 passed 1/1 (52 filtered, 0.92 seconds) while loading the trusted precompiled artifact, but was not compiler-free. Although `js2wasm_runtime_compile` was omitted explicitly, the POC feature still enabled it transitively. The later feature correction and independently verified compiler-free run are recorded above. Rust formatting, LOC/function budgets and whitespace checks passed at this checkpoint; test duration is not an application throughput benchmark.

This closes the native hello-world completion blocker, not the full integration goal. Next: connect native microtask checkpoints to the compiled graph's queue and settle the real Deno pending-op Promise through the public API, preserving scalar/object identity and exception ordering. General Rust op registration, module loading/live bindings, dynamic imports/TLA, broader shared values, and production artifact packaging remain subject to the unchecked follow-up acceptance below. Runtime changes in `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo` remain uncommitted on `codex/4376-deno-realm-bootstrap`; compiler changes are local on `codex/4376-deno-callback-construction-20260930`. Existing PRs are compiler PR 6341 and runtime PR 2; neither has received this new repair yet.

### 2026-09-30: source module namespace publication

- Pending-op follow-up isolated and fixed stale uncurrying rewrites. Native
  callback tracing in session **78317** received numeric promise id **0**,
  correctly: the unchanged source advances nextPromiseId only for pending
  operations. The initial assertion expecting 2 after two immediate ops was
  a test assumption, corrected to the source's actual contract. Exact-source
  JavaScript controls then reproduced the null property failure without Rust
  for both eager and staged initialization. A temporary, explicitly modified
  diagnostic copy showed `new Array` length 4096 but ArrayPrototypeFill returned
  nullish. The smaller descriptor-copy matrix isolated captured
  `uncurry = bind.bind(call)`: inlining the copy or freshly constructing
  `Function.prototype.call.bind(value)` passed, while the stored helper failed.
  The compiler rewrote uncurry/applyBind calls to outer call/apply aliases,
  inventing free variables absent from nested capture plans. Both obsolete
  rewrites are removed; current native Function.prototype invokers execute
  the actual stored bound helper and preserve its identity. Deno sources are
  unchanged. All temporary diagnostic source edits/dumps were removed.
  Promise/ring/descriptor/exact-source matrix **31/31**, invoker regression
  **6/6**, prior uncurry regression **3/3**, unchanged bootstrap **1/1** pass,
  **41/41** total in session **77256**; TS7/LOC/function gates pass. Captured
  applyBind inline/nested controls pass **2/2** in session **48209**. Stronger
  exact-source tests confirm returned values are genuinely branded pending
  Promises (guarded state reader returns 0), **2/2** in session **65443**.
  New six-source AOT artifact `deno-native-uncurry.wasm` is **2,663,571 bytes**,
  16 host imports, no interpreter. Native run now includes initial ring
  hasPromise checks and the pending-op numeric id assertion; previous ring
  probe session **4810** failed in a runtime-eval result unwrap, before the
  pending call. Fresh artifact native/precompile session **51658** finished
  **0/1**, 52 filtered, **243.19s** including compilation. It passes real
  startup ops, scalar fulfillment 42, fulfilled original Rust object identity,
  both empty-ring probes, and the pending native op with correct numeric id 0
  and Promise Pending state. Module namespace publication/identity and
  async-context/native continuation checks also pass; unchanged hello-world
  executes its print and sum callbacks. Remaining failure is a null-reference
  trap in `__v8x_script_result_utf16_length`, before native script.run returns.
  The compiler-free local precompile is now
  `/private/tmp/v8x-deno-resume-20260930.o0sxeO/deno-native-uncurry.cwasm` with
  its matching `.attestation.json`; reuse it for cheap adapter iterations.
  Next inspect runHostScript status, encoder return, and scriptResult global
  stores rather than bypassing the result decoder. Full integration remains
  incomplete. Session **93226** passes **2/2** pending-to-fulfilled transition
  and explicit-drain checks against unchanged infrastructure, including value
  42 read through the native Promise ABI. All processes are terminal. Current
  changes are local/uncommitted on the existing compiler and v8x branches.

- Staged pending-op reproductions isolate a further defect: aliased Promise
  construction returned null without executing the executor. The canonical
  Promise slot may not exist when the lifted function compiles before its
  initializer. Dynamic native construction now reserves that identity slot,
  checks runtime carrier identity, and delegates to the existing synchronous
  executor machinery. Detached instruction buffers are registered for late
  import relocation. Direct Array construction shares the identity guard.
  New controls cover ring read, executor execution, catch, symbol publication,
  single evaluation, invalid/missing executors, and an unrelated constructor.
  Promise/ring **17/17**, direct Promise regression **9/9**, unchanged bootstrap
  **1/1** pass, total **27/27**. LOC/function and format/diff gates pass.
  Rebuilt native artifact `deno-native-promise.wasm` is **2,657,877 bytes**, six
  pinned sources, 16 host imports, no interpreter. Native session **65929** is
  finished **0/1**, 52 filtered, **242.31s** including precompilation. The
  unchanged full graph still fails in setPromise with a null property read;
  reduced controls are not evidence of full pending-op success. Trusted local
  precompile was produced at
  `/private/tmp/v8x-deno-resume-20260930.o0sxeO/deno-native-promise.cwasm`.
  Additional capture/Promise controls pass **38/38** in session **54696**;
  repository TS7 passes. Deferred resolver test also passes, giving Promise/
  ring **18/18**, including queued (not synchronous) reaction execution.
  Constructor-acquisition matrix now passes **22/22** including the direct
  builtin and dynamic globalThis paths; constructor acquisition alone does
  not explain the remaining full-graph failure. Next inspect actual promiseId
  numeric transport and the full graph's captured ring/sentinel values after
  the prior immediate wrappers run. All sessions are terminal. The latest
  compiler changes remain local/uncommitted. `npx tsgo` was the wrong command and attempted a
  network package lookup; use repository `npm run typecheck` instead.

- Follow-up ring initialization fixes add first-class Array.prototype.fill
  with optional bounds/coercion and canonical aliased Array construction.
  Focused compiler controls pass **27/27**; LOC gate passes. Native rebuilt
  six-source artifact is **2,656,122 bytes**, 16 host imports, no interpreter.
  Native session **45466** finished **0/1**, 52 filtered, **239.41s** including
  Wasmtime precompilation. Pending setPromise still throws on a null/undefined
  property read, so ring-only controls do not prove the full pending path.
  Next isolate Promise construction, catch, and symbol publication separately.

- Native Promise transport now reuses the compiler's existing guarded
  `__promise_boundary_state` / `__promise_boundary_value` exports. The v8x
  graph dispatcher unwraps the same-store GC value, checks loaded graph/realm
  readers (-1 is explicitly not a Promise), validates states 0–2, and retains
  the actual result in the realm's handle table. Realm conversion allocates
  only a stable Rust Promise wrapper; native State/Result re-read live Wasm
  state instead of reporting the wrapper's placeholder settlement. No compiler
  ABI addition, raw artifact rebuild, or interpreter was needed. Native
  Then/Catch and handler tracking fail explicitly while unimplemented rather
  than acting on an unrelated native placeholder promise.
  Targeted Cargo check and diff gates pass; existing native Promise/microtask
  and synthetic-module controls pass **2/2**, 51 filtered.
- Exact native run **23120** passed boot, fulfilled result 42, module namespace
  identity/write rejection, and async-context/native continuation identity.
  It reached the unchanged hello-world usage, then failed **0/1** in **0.54s**
  at `__v8x_script_result_utf16_length` with a null-reference trap. The print
  fixture was corrected to use V8 boolean conversion for Deno's omitted
  `isErr` argument (unchanged core forwards undefined); the earlier Boolean-only
  fixture assertion aborted session **80632** inside the C callback. This
  correction does not alter Deno source or compiler behavior. Next inspect
  the AOT `runHostScript` status and `scriptResult` stores before assuming the
  JSON/result decoder itself is the cause.
- Stronger async controls now invoke distinct compiled wrappers returning a
  scalar, the original Rust object, and a pending native op. Latest native
  session **18415** finished **0/1**, 52 filtered, **0.58s**: scalar fulfillment
  and fulfilled-object identity pass, then the pending op throws
  `TypeError: Cannot access property on null or undefined` in `setPromise`.
  Stack includes `setPromise → __call_fn_method_0 → __apply_closure →
  __proto_method_-1073741805_apply → … → __v8x_value_call`.
  The pending native callback itself executes. Inspect the unchanged
  infrastructure's `promiseRing`, `NO_PROMISE`, `promiseMap` captures and
  oldPromise lookup, plus its Promise constructor/catch path. Do not bypass
  the pending test to claim complete async integration. Object control is
  intentionally before the pending control so its independent evidence is
  observable; pending remains mandatory. Rejected state, live pending-to-settled
  transitions, owning-graph reactions, handler tracking, and microtask ordering
  still require implementation/verification. Namespace/usage assertions after
  this new pending control have not run in this latest test. No native test
  remains live; all progress is local/uncommitted in the existing compiler and
  v8x branches/PRs. Full integration remains in progress.
- Follow-up native execution exposed two compiler defects in the unchanged
  primordial getter/setter. An inlined IIFE's initialized local was eagerly
  boxed in the caller's root buffer, before the initializer in the detached
  IIFE block. Eager boxing now declines that owner and uses construction-site
  boxing with the existing conditional-cell repair. Separately, an inferred
  `undefined` getter return was compiled as void and discarded even after a
  sibling setter changed the binding. Value-bearing closures inferred as
  `undefined` now retain an externref result; contextual `void` contracts still
  retain their existing behavior. The two staged fixtures cover same-named and
  differently named core functions and invoke the retained function through
  the getter. Capture/TDZ/sibling/unchanged bootstrap controls pass **51/51**;
  primordial and ordinary callback controls pass **24/24**. TS7 typecheck and
  LOC/function gates pass. The wider ambient host-callback suite is **29/30**:
  its non-void IR-claim rejection fails identically with the return fix removed
  (session 7057), so it is not attributed to this change.
- The previous missing-op failure was resolved by registering three real Rust
  startup capabilities: extras/continuation state, import-meta prototype, and
  retained captured bootstrap. No pinned Deno source or artifact-only fallback
  was substituted. Native sessions **81840** and **5202** then failed with
  `queueMicrotask is already defined`; the latter reported all three startup
  callbacks in order and passed the pre-core undefined getter check. This led
  to the compiler fixes above. The latest six-source artifact build **62639**
  completed with **2,654,606 bytes**, **16 imports**. Native session **59276**
  finished **0/1**, 52 filtered, in **249.26s**. All four unchanged classic
  bootstrap scripts pass, all three startup op events match, and native print
  and sum function identity checks pass. The next assertion failed when
  calling `setUpAsyncStub` with an invalid length-zero native op: the exact
  source dispatches on `originalOp.length - 1` and requires at least the
  promise-id argument. Its old fixture also incorrectly expected the original
  op back rather than the new wrapper. The corrected fixture uses a real
  length-one Rust callback returning 42, checks distinct wrapper identity,
  invokes it, then requires a fulfilled Rust-visible Promise carrying 42.
  Session **45734** finishes **0/1**, 52 filtered, in **0.48s** at that Promise
  classification assertion: callback execution succeeds, but its returned
  compiled Promise is wrapped as a generic native object. No test remains
  live. Next implement owning-graph Promise classification/state/result and
  continuation/microtask transport, not an object-as-Promise heuristic.
  `realm_objects::from_realm` currently supports generic object/function/array
  kinds only, while `__v8x_value_kind` never distinguishes promises. Namespace,
  async-context, and hello-world assertions after this new check have not
  executed in the latest native run. Do not claim the full example passes.
  Saved precompile output/attestation are at the existing
  `deno-native-namespace.cwasm` and `.attestation.json` paths. Final compiler
  rebuild **16551** is byte-identical to the native-tested artifact, SHA-256
  `9f37cd6fb2a944d2b4d5849b66a8d7f8e31cecebadf15664727a3e81f7023840`.
  Completion remains unproven.
- Resolved the native graph's next validation error: immutable
  `scopeAsyncContext` captures `getAsyncContext` / `setAsyncContext` read
  promotion globals that hold mutable cells shared with other closures. The
  immutable function-value emitter treated those as plain value globals.
  Added a narrow promoted-value helper that extracts field zero only when
  the box and value registries identify the same global and the expected
  value type matches both registered metadata and physical cell layout.
  Missing globals or disagreeing physical metadata fail loudly; consumers
  expecting a cell and foreign same-named registrations remain on the old
  path. Seven new positive/negative helper controls pass. Capture ABI,
  sibling, shadow/TDZ controls pass **36/36**, and unchanged bootstrap,
  infrastructure, namespaces, Map constructors and optional strings pass
  **12/12**. TS7 typecheck and LOC/function budget gates pass.
- Exact six-source runtime/AOT artifact now validates, with **2,654,629
  bytes**, **16 imports**, all functions in `v8x:deno`, no interpreter imports,
  and the native namespace handle export. Builds 28571 and 54211 completed
  successfully. Production packaging now requires that handle export too;
  strict clean pinned production packaging has not yet been executed. The
  staged-core tool control passes deferred scripts, host registration gap,
  namespace publication and rejected reorder/retry (session 64864).
- Exact native public Script::Run test ran in exec session **63991**
  (`routes_exact_deno_core_scripts_through_public_script_run`, runtime clone
  `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`). It uses the validated
  raw artifact `/private/tmp/v8x-deno-resume-20260930.o0sxeO/deno-native-namespace.wasm`
  and `namespace-context-v2.wasm`, with cache dir `namespace-cache`, all under
  the same temporary root. Intentional wrong-order/modified-source controls
  printed expected rejections. It finished **0/1**, 52 filtered, in 245.73s,
  terminal exit 101: phases 0–2 advance, but phase 3 (`01_core.js`) throws
  `TypeError: called value is not a function`, stack
  `__runtime_eval_unwrap_call_result → __apply_closure → __dyn_call_55 → runScript`.
  This is execution evidence, not a Wasm validation failure. Before finishing,
  process 69307 was alive after 3m51s at 99.6% CPU, RSS 1,246,976 KiB; do not
  infer failure from such timing in future runs. No native test remains live.
  Next identify that phase-3 call and inspect host-op registration: the Rust
  fixture installs only `op_print` and `op_sum`, while the exact core startup
  also calls `op_get_extras_binding_object`, `op_get_ext_import_meta_proto`,
  `op_set_captured_bootstrap`; the standalone artifact scaffold supplies those
  three locally. Verify whether exposing the Rust-owned ops object replaces
  these capabilities before deciding whether the fixture or adapter is wrong.
  Do not insert no-op behavior or modify pinned Deno source to mask this.
  Goal remains incomplete until exact native core behavior and the wider
  integration requirements are actually verified.

- After merging main `88c33c80a89` as `afe06b5c6e1`, fixed the prewarmed
  collection regression's actual remaining cause: constructor contexts did
  not carry their lexical class name. Nested `super()` guessed it from the
  generated function name; anonymous names such as `__anonClass_0_new`
  cannot satisfy that naming heuristic, so the call never initialized `this`.
  Constructor contexts now carry `enclosingClassName`, like method contexts.
  The original explicit `super(); return;` fixture is retained and expanded
  to anonymous, named, and underscore-containing named class expressions.
  All three pass; builtin subclasses, optional strings, and source namespace
  controls pass **20/20** combined. Main's host-key overlap controls plus
  optional strings passed **51/51** with fork-level Wasm exception support.
  Exact six-source staged graph rebuild still fails on the timers wrapper's
  undefined local index (position 147, 209 locals). Diagnostic WAT captured
  at `/private/tmp/deno-timers-emit-types.txt.wat`; no validation bypass or
  upstream source edits. Sessions 41720 and 59174 are terminal. Exact native
  core execution remains unverified, and the integration is not complete.

- Located the undefined-local producer in mutable function-value capture
  reification. `boxedCaptures` retained `timerListId` / `getAsyncContext`
  metadata while `localMap` had no binding, and a non-null assertion emitted
  `local.get undefined`. The pending repair accepts a live box only when its
  actual local type agrees with its ref-cell type; otherwise existing global
  or recorded-slot sourcing runs. The exact graph now emits but fails native
  Wasm validation in `script3`: `struct.new[3] expected externref, found
  ref.as_non_null (ref 850)` at byte 575211. Type 850 is the externref ref-cell;
  next inspect value-versus-cell sourcing for this closure operand. No cast
  or validator weakening was introduced. Diagnostic WAT/types are at
  `/private/tmp/deno-core-capture-types.txt{,.wat}`. Capture ABI/sibling controls,
  infrastructure and unchanged bootstrap pass **16/16**; constructor return,
  Promise and super-property controls pass **61/61**. Artifact sessions 56458
  and 32411 failed terminally; test sessions 14660 and 17720 passed terminally.
  This capture repair is still pending exact native graph validation, not a
  claim that prelinked native core boots.

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

## 2026-09-30 persistent compiled Promise handler state

Current checkout: `codex/4376-deno-callback-construction-20260930`. Checkpoint
`8350144928` preserves cross-graph reactions/shared exception tags and pending
reaction FIFO. Merge `a64e50a23e` then incorporates main
`8245fc8ea121909a81d98cce003340c7c55e1296` without conflicts. Unrelated local
Acorn bytes, the lower-contracts documentation edit and untracked files remain
untouched. No publication is claimed for these local commits.

The native Promise carrier now appends an internal mutable i32 handler flag at
slot 4, preserving state/value/callback/property-bag slots 0–3. Both reservation
and codegen layouts agree, and all 25 mint sites initialize the new slot
(including the IR emitter). Then/catch/finally, boundary observation, await,
combinators and native adoption mark handling independently of the callback
list, which settlement clears. The internal finally restoration Promise starts
handled because its reaction is pre-attached. Own-then overrides do not mark
the receiver. Explicit host marking also marks any existing WASI rejection
tracking node, and marking before rejection suppresses an unhandled note.

Guarded `__promise_boundary_has_handler` and
`__promise_boundary_mark_handled` return -1 for non-carriers. v8x dispatches
these against compiled graphs and the realm in the shared store, with explicit
errors for outdated artifacts lacking this ABI. Native `HasHandler` and
`MarkAsHandled` no longer refuse bound compiled Promises. A direct-read test
caught physical-field leakage; exact/alternate field reads now exclude this
internal slot, with dot/bracket and empty-string user-expando controls. No
interpreter is added.

Verification on the final source: 185/185 compiler tests across nine files
(session 4372); TS7 typecheck passes. Exact-base resolution receipt tests retain
the authenticated donor and independently account for exactly one intentional
adoption handler write, rather than regenerating the donor. LOC/function
budgets against the fetched main, coercion gate, and checker gate against the
current commit pass. The whole branch still has the previously reported raw
checker increase in closures and unused-export/dynamic-import audit failures;
this scoped pass does not clear those publication gates.

Runtime clone remains `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`,
branch `codex/4376-deno-realm-bootstrap`; runtime edits are uncommitted. The
native pinned-core acceptance passes 1/1 (session 88246, 247.69s). Final source
rebuild `deno-native-handlers-final.wasm` is byte-identical to
`deno-native-handlers.wasm`: 2,666,341 bytes, SHA-256
`48d110221d3e5ecb6958238110a96549efe27fb29f7f2a7931d97470a6d2f8b7`.
Use matching `deno-native-handlers.cwasm` and
`deno-native-handlers.attestation.json` in the same owned artifact directory.
Compiler-free focused runtime target with only
`js2wasm_deno_poc,js2wasm_gc_copying,simdutf` passes 24/24, with 2 explicitly
ignored cases (session 33130, 1.69s); assertions cover handler state before and
after native reaction checkpoints and explicit marking. Rust formatting and
focused cargo check pass. Full vendor cargo check still fails on missing ICU
data and its existing ambiguous Vec assertion; vendor tests are unmodified.
Typst is unavailable, so the edited runtime docs are not render-verified.

An intermediate empty-name carrier experiment was rejected. Its separately
precompiled native check also terminated successfully (session 39955, 1/1),
but `deno-native-handlers-private.*` are historical experiment artifacts, not
the final-source replay inputs. No processes from these runs remain live.

Full integration remains open: general host rejection events, unified
cross-graph/native queue ordering, broader real Rust-op and Deno suites,
compiler-free cross-graph replay, complete module/import coverage and actual
distribution packaging. This closes the focused handler-state bridge gap,
not the overall Deno integration acceptance criteria.

## 2026-09-30 shared native/compiled microtask queue checkpoint

Merged fresh `loopdive/js2` main `2255e91c9831764120943201fbd52b03267033f5`
without conflicts in signed local merge `b92a8c66ca`. Existing work was
preserved; this merge has not been pushed.

The compiler exports `__drain_one_microtask` over the existing Wasm-owned
queue. It advances the head before invoking the callback and returns after
one job. Empty queues are no-ops and the batch-drain API is retained. An
opt-in `standaloneMicrotaskNotifyImport` adds a `() -> void` host notification
after each real enqueue. Its namespace must be explicitly linked. Registration
flushes late import shifts before emitting the imported call and refuses a
same-named local function or an incompatible imported signature.

The runtime clone at `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo`
now accepts `v8x:deno.__v8x_microtask_notify`. It records the actual calling
graph's single-job drain in the isolate's native FIFO, with realm ownership
and captured continuation data. The native queue uses a deque rather than
shifting a vector. Realm IDs are assigned before instantiation. Standalone
Stores without an isolate maintain their own notification FIFO. Older
non-notifying artifacts still use the previous batch fallback; mixed legacy
and notifying graphs do not establish unified ordering.

Compiler verification: TS7 passes; 143/143 focused tests across six files
(session 34787), including fulfillment, rejection, reentrant chains, an
8,193-job grown queue, invalid option refusals, and two separately compiled
graphs interleaved with a host job. The latter uses a Node host coordinator,
not the Rust adapter. The deliberate `ensureMicrotaskQueue` receipt change
is independently reversed before checking the unchanged donor hash; the
focused receipt passes 1/1, with 128 skipped (session 91814). The wider
settlement ownership receipt suite was not green: its initial run had 16/129
failures. Raw retained-function comparison found 13/66 mismatches already
in HEAD and 14/66 in the working tree, with the enqueue change accounting for
the extra mismatch. Canonical receipt failures and earlier retained-function
changes still require reconciliation, not replacement hashes.
Final rerun of that wider receipt suite terminates at 114/129 passing,
15 failing (session 68519), with the enqueue receipt now passing.
LOC/function budget commands pass using their default base resolution; the supplied
`--base` argument is not an implemented override, so no exact-main-base
claim is made. Earlier whole-branch publication gate failures remain open.

New native artifact `deno-native-ordered.wasm` has 2,666,543 bytes, six
authenticated source fixtures and 17 native function imports, with no
interpreter added. Build-time precompile and public pinned-core acceptance
pass 1/1 (session 72346, 250.92 seconds). The acceptance requires the order
compiled reaction 1, native callback 2, chained compiled reaction 3, with
no synchronous callback execution. Compiler-free replay using matching
`deno-native-ordered.cwasm` and `deno-native-ordered.attestation.json` passes
24/24 with two explicit ignores (session 98522, 1.01 seconds). All three
artifacts are in the owned parent directory of the runtime clone. Rust
formatting and focused cargo check pass. Typst remains unavailable.

Compiler and runtime scheduler edits are local and uncommitted at this
checkpoint. The development fixture builder enables notifications; the
historically locked production builder options are unchanged. Next enable
the notification consistently in application/context graph builds, rebuild
their artifacts and verify actual Rust multi-graph/native interleaving and
compiler-free replay. Do not substitute the Node multi-graph check for that
acceptance. Production packaging, general rejection events, broader real
Deno/Rust-op suites and complete module/import coverage remain open.

## 2026-09-30 compiler-free multi-graph ordering acceptance

Application `compile-graph.ts` and the development shared-context fixture
builder now enable the same explicitly linked enqueue notification as the
pinned-core development fixture. The native namespace test loads two
independently compiled application graphs into the shared Store, queues
their settled-Promise reactions, chains more reactions, inserts a Rust
microtask, and requires `[1,2,3,11,12]`. It checks no synchronous callbacks,
no duplicate jobs at a second checkpoint, and preserves its existing live
namespace, object/prototype and exception-identity assertions.

Build-time native acceptance passes 1/1 (session 15866, 171.68 seconds).
A second build-time run passes 1/1 (session 96340, 126.82 seconds) while
serializing the context and publishing both source-bound graph artifacts.
A hidden test attachment helper loads a trusted, immutable precompiled
context using the existing deployment deserialization path. The test now
also compiles into compiler-free builds; raw Wasm attachment is explicitly
refused there. Attachment configures the owning isolate before subsequent
compiled enqueues.

Compiler-free native replay passes 1/1, with 25 filtered (session 81100,
0.55 seconds), enabling only `engine_js2wasm,js2wasm_gc_copying,simdutf`.
It uses `namespace-context-ordered.cwasm` and `ordered-graphs/` in the owned
artifact directory `/private/tmp/v8x-deno-resume-20260930.o0sxeO`. That
directory contains two distinct `.cwasm` graph artifacts and their exact
graph/byte-binding sidecars; no graph compiler environment is configured
for replay. The context artifact has 23,455,064 bytes. This is an unoptimized
development fixture size, not a new footprint comparison or production
package estimate. Runtime-eval instantiations are unchanged by the test.
Dependency-tree controls contain 267 rows and no Wasmtime Cranelift package
for the compiler-free profile, versus 360 rows including
`wasmtime-internal-cranelift v47.0.3` for the build-time profile.

The negative control is real execution: the same current pinned-core
ordering test against the previous `deno-native-handlers.cwasm` fails 0/1
with actual `[2,1,3]` versus required `[1,2,3]` (session 8183). This isolates
the old batch scheduling defect rather than merely asserting an export
exists. Its failure is intentional and is not a failure of the new artifact.

Compiler namespace/queue/tag controls pass 16/16 across four files (session
5191). Additional notification-collision controls refuse local-function and
wrong-signature import reuse; the expanded queue suite passes 11/11 (session
33526). TS7, default-base LOC/function gates, rustfmt and whitespace checks
pass. The 15 wider source-receipt failures from the preceding checkpoint
remain unresolved; no donor hashes or gate thresholds were regenerated to
hide them. Typst remains unavailable.

All new edits remain local/uncommitted. This closes the focused native
multi-graph/compiler-free replay ordering gap, not full Deno integration.
Production artifact/profile commitments still need the notification ABI,
general rejection-event delivery and module/import coverage remain open,
and the full Deno/Rust-op test population has not been proven.

Final new-artifact compiler-free pinned-core target rerun passes 24/24
executed, with three explicit ignores (session 10572, 1.17 seconds).
The namespace case is one of those default ignores and was separately
executed successfully in session 81100 above. All processes cited in this
checkpoint are terminal. Compiler Prettier checks and both worktrees'
whitespace checks pass on the final files.

## 2026-09-30 runtime packaging scheduler contract

The runtime production builder and native development fixture now share
`runtimeCompileOptions(execution)`. AOT mode exports Symbol state and links
only `v8x:deno`, including the verified enqueue notification. Explicit dynamic
fallback preserves both that notification and shared provider Symbol state;
this option test does not establish ordering inside an interpreter provider.
The historically frozen POC compile options and their commitment are unchanged.

Runtime packaging now checks exactly one native notification function import
and all three scheduler function exports before publishing bytes. Empty
modules, uninspectable values, and a real module with only the notification
import are negative controls. The native artifact check invokes the existing
binary-level linear-memory detector, so its GC-only assertion also excludes
unexported defined memories rather than relying only on import descriptors.

Node option/contract tests pass 6/6. Real rebuilt native-artifact controls pass
2/2, including refusing unknown scripts without native op calls. Rebuilding
the authenticated six-source fixture with the shared production options yields
2,666,543 bytes and 17 native imports, byte-identical by `cmp` to the already
native/compiler-free verified `deno-native-ordered.wasm`. New copy:
`/private/tmp/v8x-deno-resume-20260930.o0sxeO/deno-native-production-options.wasm`,
SHA-256 `2376bb786df65caa199091ae6b32ff0ff992ae579324e0b0ed25006d747a327d`.
These are shared-option/development-artifact checks, not a clean-checkout
production packaging proof.

Production release remains incomplete. The builder currently pins compiler
`8fd489a918dee3be51bb1e75d191f9815a830eb0`; this must advance to a committed
revision containing the new ABI after reconciling the branch's publication
gates. A real detached clean-checkout build, revised runtime provenance and
deployment validation remain required. The runtime source edits and new
`tools/js2wasm/test-runtime-compile-options.mjs` remain local/uncommitted.
Docs explicitly preserve that distinction. Whitespace checks pass; Typst is
still unavailable. All commands in this checkpoint are terminal.

Next reconcile the 15 wider ownership/source-receipt failures against the
deliberate Promise-carrier/handler-state and queue changes without blindly
replacing donor hashes, then checkpoint the compiler ABI so runtime pins can
reference actual committed code. Full integration, broader Deno conformance,
general rejection events and complete import/module coverage remain open.

## 2026-09-30 settlement receipt reconciliation, 15 to 5 failures

The wider settlement ownership suite initially fails 15/129 (session 97367).
Its original constant, declaration and retained-function digests remain
unchanged. Reconciliation explicitly reverses the exactly-once deliberate
callback-list reversal, persistent handler field/initialization/writes,
pending-count export and single-job drain additions before authenticating
the old declarations. The instruction-model leaf import is still type-only;
the new reaction-order helper import is separately checked by its exact
name and path. Main's independently introduced intrinsic-then and observable
finally changes are also accounted for explicitly, with their D5/D7 runtime
behavior tests included in verification. No runtime compiler behavior or
donor fixture is changed in this checkpoint.

Five new negative controls refuse changed field mutability, a wrong handled
flag value, a corrupted pending-count operand, deletion of the ordered-list
call and deletion of the persistent handler read. They prove these approved
deltas cannot silently be altered or removed while retaining a green receipt.

Final combined verification (session 56683) executes 228 tests across six
files: 223 pass and five fail. The only remaining failures are the historical
receipts for `buildPromiseSettleClosureInstrs`, `ensurePromiseExecutorClosures`,
`ensurePromiseThenableSubstrate`, `buildPromiseResolveValueLocals` and
`buildPromiseResolveValueBody`. Their code was moved/delegated in the already
merged resolution-body refactor, not changed by this turn. The independent
52-test resolution preservation suite passes, as do notification/handler
and D5/D7 behavior suites. The old five donor function texts in
`issue-3518-promise-resolution-donors.json` match these exact historical
digests, but merely substituting those texts would not authenticate current
delegation and is not used as a shortcut.

Next connect those receipts to authenticated moved owners and verify their
current adapters/canonical bodies through the existing operand-sensitive
resolution controls. Preserve donor hashes and the distinction between
source identity and behavior preservation. TS7 passes. Edits remain local
and uncommitted; this is partial gate reconciliation, not a ready-to-land or
complete-integration claim. All cited processes are terminal.

### 2026-09-30 checkpoint before requested main merge

Extracted reusable authenticated resolution receipt helpers without changing
the donor fixture or its digests. The independent resolution suite remains
52/52. Current adapter checks reduce the outstanding settlement receipt
failures from five to one. TS7 passes; the combined focused run (session
78801) passes 232/233 tests across six files. The remaining failure exercises
capture field indices other than 5, which the canonical settle closure builder
explicitly refuses. Investigate the actual registered layout and historical
builder contract before changing either the guard or the receipt matrix.
This checkpoint is incomplete and not a ready-to-merge claim.

Fetched loopdive/js2 main at ee6828f1ef2f6dd7dc26c1eabe699ed8e8a12e50
for the user's requested merge. Its two new commits refresh npm compatibility
artifacts. Unrelated working-tree changes are excluded from the checkpoint.

### 2026-09-30 resolution receipts reconciled after main merge

Signed merge 1461355fb5 includes fetched loopdive/js2 main ee6828f1ef.
The remaining receipt failure was an invalid synthetic constructor layout,
not a runtime compiler defect: `createBuiltinFunctionMetadataType` emits
`func`, `$arity`, `$bag`, `bfnstate`, `bfnid`, then the Promise capture is
appended at slot 5. The authenticated donor constructor always emitted
these five metadata operands and ignored the supplied capture-field index.
The canonical moved constructor intentionally refuses other capture slots.

The verifier now checks the actual metadata field inventory, retains exact
donor output comparison for valid layouts, and explicitly accounts for
refusal of slots 1 and 17 rather than dropping those matrix cases. Live-owner
negative controls remove or alter the guard and must fail verification.
Neither donor fixture nor historical digest changed. Settlement receipts
pass 139/139 and resolution preservation passes 53/53. Combined post-merge
run (session 44471) passes 234/234 across six files; TS7, scoped Biome and
diff whitespace checks pass. No compiler behavior was changed in this step.

Full Deno integration remains incomplete. Next advance the runtime packaging
compiler pin to the committed scheduler ABI and verify a clean detached
artifact build, then continue the broader unchecked acceptance requirements.

### 2026-09-30 pinned clean runtime packaging attempt

Runtime checkpoint 59ec036 is signed and contains the accumulated native
realm/graph bridge and FIFO work. Runtime packaging now independently pins
compiler 54eaa2239acd5eb1f383a500bd4d4a3b9dbdb3b2; the historical POC
compiler pin and compile-options commitment are unchanged. Pin/options
contracts pass 7/7 and the compiler-free pinned core rerun (session 21842)
passes 24/24 with three explicit ignores. No broad Deno baseline changed.

Prepared clean detached inputs under /private/tmp/deno-release-build.cGYWlK:
runtime clone `v8x` at 59ec036, compiler worktree `compiler` at 54eaa2239a,
and sparse Deno checkout `deno` at 1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44.
Compiler dependencies are shared through an ignored node_modules symlink.
Local compiler clones failed because shallow/promisor history requested an
unavailable historical object; the detached worktree succeeded without
altering the active compiler checkout. The AOT production builder is running
as session 12622 against these inputs. Do not claim packaging success until
its output and provenance are inspected. An initial test-staged-core command
was invoked without its mandatory compiler argument and only reported usage;
that invocation is not a test result or evidence of a runtime regression.

The clean builder (session 12622) completed successfully. Inspected the actual
provenance and recomputed the output and compile-options digests: artifact
2,666,543 bytes, SHA-256 2376bb786df65caa199091ae6b32ff0ff992ae579324e0b0ed25006d747a327d,
17 native function imports, null runtime-eval provider, exact committed
runtime/compiler/Deno revisions. `cmp` confirms byte identity with the already
verified ordered native development artifact. All three input checkouts are
still clean. This proves the clean raw-artifact build, not production release
execution or broader Deno conformance. Fresh trusted Wasmtime precompilation
of this exact packaged raw file is running as session 62847; follow with
compiler-free replay against its output and paired attestation.

Fresh trusted precompilation passes 1/1 (session 62847, 244.43 seconds).
The generated native artifact is 47,328,568 bytes for aarch64-apple-darwin,
Wasmtime 47.0.3, SHA-256 1b877a293a239f03e78eb52707d3d8589ca4306d165736a6a9c301794b5f9e84.
Recomputed the native hash and verified its attestation binds the exact
raw artifact hash above. This is a development native artifact, not a
normalized distribution payload or a new comparative footprint benchmark.
Compiler-free replay of this freshly packaged artifact passes 24/24 with
three explicit ignores (session 37601, 1.02 seconds). No runtime compiler
feature or interpreter provider is configured for that replay.

Separately reran the compiler-free source-namespace/two-graph FIFO test
against the existing trusted ordered graph artifacts: 1/1 passes, 25 filtered,
0.59 seconds. Those graph artifacts were not rebuilt in the clean production
packaging step; do not confuse this distinct test with packaging them.
Raw artifact structural/unknown-script controls pass 2/2. A negative build
control rejects the active compiler branch before compilation. All cited
processes are terminal. The original broader integration checkboxes remain
open: general Rust op coverage, rejection events, full module/import semantics,
general shared-value behavior and production distribution remain unproven.

### 2026-09-30 native Promise rejection callback implementation

Inspection of the pinned Deno exception state confirms that it depends on
the rusty_v8 rejection callback to retain unhandled Promise/reason identity
and cancel the pending event when a first handler is added. The js2wasm
backend's `SetPromiseRejectCallback` was a no-op. Native callback registration
is now stored on the owning isolate (not thread-global); notification uses
the existing three-word rusty_v8 message ABI and real getter symbols.
Native settlement reports unhandled rejection and duplicate settle attempts,
and first late handler attachment reports the handler event with no value.
Explicit `MarkAsHandled` remains a silent flag update. Callbacks run without
retaining Promise/isolate state borrows, allowing reentrant handler attachment.

First three public-API native controls pass 3/3 (session 8438). Added reentrant
attachment and isolate-local lifecycle controls; the complete compiler-free
core fixture rerun is now session 81511. This step does not yet deliver Wasm-owned Promise rejection
events: compiled settle and then/adoption/await paths require an authenticated
host notification bridge. That work remains part of the original open scope;
do not mark the general rejection-event acceptance complete on native tests.

The initial full rerun passes 29/29 with three ignores (session 81511).
Notification-removal negative control (session 27352) produces four failures
out of five new native tests, with only early-handler suppression passing;
restoring notification returns 5/5 (session 91378). Added a sixth control for
fulfillment-only `.then` rejection propagation: the handled parent is not
reported, the derived Promise is reported at the checkpoint with the original
reason identity, and later catch attachment sends a no-value handler event.
Final compiler-free fixture run (session 91400) passes 30/30, three explicit
ignores, 1.11 seconds. All cited processes are terminal; the removal mutant
was restored before final validation. Rust formatting and diff whitespace
checks pass. No compiler or interpreter was enabled in these replay runs.

Next wire compiled events at actual settlement/handler transitions, including
direct rejected construction, adoption, await and combinators. Polling the
final Promise state only at checkpoint end is not equivalent: same-turn late
handlers must cancel the original tracked event and reaction jobs may create
new rejected derived Promises. Preserve exact owner/realm and reason identity
and avoid reentering a borrowed Wasmtime runtime during host notification.

### 2026-09-30 compiled rejection producer checkpoint

Enumerated persistent handler writes in then/finally, boundary observation,
await, adoption and combinator subscription. The existing unhandled list is
WASI-only and is an exit reporter, not a Deno rejection event stream. Its
final handled flags cannot reconstruct same-turn reject/handle transitions.

Added a byte-inert optional same-graph dispatcher instruction builder, wired
pending settlement and direct `Promise.reject` construction to it, with
unhandled suppression based on the persistent handler flag. Duplicate settle
branches carry attempted-value events without changing the original result.
The dispatcher name is `__v8x_deno_promise_reject_dispatch` with signature
`(number, any, any) -> void`. Ordinary graphs without this function emit no
event instructions. This is a compiler producer, not yet a native adapter
connection: no runtime artifact pin or packaging claim has advanced.

Added executable Wasm controls for direct/pending rejection, attempted
duplicate reject, early handlers, async/reaction throws and the absent
dispatcher. Typecheck and focused tests are running as session 43141.
Still required: first late-handler event across all listed consumers,
resolve-value duplicate paths, dispatcher signature authentication and native
event retention/flush without borrowing reentrancy. Existing source receipt
checks must account for deliberate opt-in deltas without regenerating donors.

First focused run (43141) passes 29/30. The raw exported async function
control initially exercised the unwrapped Wasm ABI rather than a compiled
JavaScript call. Correcting that test exposes a separate real producer gap:
`wrapAsyncCallInTryCatch` constructs a rejected Promise directly, bypassing
both the settle helper and `emitStandalonePromiseReject`. This arm is now
instrumented only when the dispatcher exists, including both tagged and
foreign catch arms, with fresh instructions and a temporary local released
after emission. No dispatcher allocates no new local. The test still verifies
the original reason and Promise identity, not merely absence of a trap.

Final TS7 and focused compiler run (4120) pass: 6/6 rejection controls plus
13 handler and 11 queue controls, 30/30 across three files. Scoped Biome and
whitespace checks pass. A/B against clean compiler 54eaa2239a confirms exact
byte identity for three ordinary dispatcher-free programs (session 55690):
direct reject 149,080 bytes, pending reject/early catch 164,426 bytes, reaction
chain 161,826 bytes. That comparison preceded the async-wrapper instrumentation;
repeat it with that final edit before claiming the final full default-output
contract. The wrapper likewise gates its new local/instructions on dispatcher
presence, but this reasoning alone is not measured byte identity.

Wider ownership verification (52050) has four remaining settlement receipt
failures: canonical opt-in source deltas, the new instruction-leaf import,
the direct reject emitter delta and the extra dispatcher lookup ordering.
Resolution preservation passes 53/53. The transient fifth failure in that
combined run was the async control subsequently fixed above. Do not regenerate
historical hashes or present the new focused behavior controls as a clean
publication gate. Compiler changes remain local and uncommitted; no runtime
pin, compiled native-event transport or general rejection claim has advanced.
All processes cited here are terminal. Next implement late-handler events,
authenticate the dispatcher signature and reconcile explicit source deltas.

### 2026-09-30 rejection dispatcher authentication

Replaced bare reserved-name lookups with a shared physical target validator.
It resolves through the allocator-aware function lookup, rejects imports and
uninspectable targets, requires `(f64, externref, externref) -> void`, and
rejects asynchronous dispatchers. Absence remains the deliberate opt-out;
presence with an unknown or incompatible signature is an explicit compiler
error rather than invalid Wasm or silently missing notifications.

Added six incompatible declaration controls (arity, event carrier, Promise
carrier, result carrier, async function and imported function) plus an
uninspectable-target control. Typecheck and the expanded event suite are
running as session 81343. Native event transport, first late-handler
notifications and explicit source-receipt reconciliation still remain open.

### 2026-09-30 late subscription events and receipt reconciliation

Fetched loopdive/js2 main again: ee6828f1ef2f6dd7dc26c1eabe699ed8e8a12e50
is already an ancestor of the current branch. Merge reports already up to date;
unrelated dirty changes are preserved, no stash or cleanup was performed.

Dispatcher authentication completed successfully (81343: 13/13). First-late
reaction notifications for then/catch/finally and boundary observation passed
with existing handler and queue controls (18611: 41/41). Extended the same
helper to native Promise adoption, frame-driver await classification, and both
combinator subscription adapters. It marks the persistent handler before event
dispatch, suppresses repeat handle events, and leaves explicit MarkAsHandled
silent. New executable controls cover both already-rejected and pending inputs
for adoption, await, all, race, allSettled and any. Derived Promise events are
kept distinct from source identity rather than discarded globally.

Reconciled authenticated source receipts using exact, single-occurrence delta
reversal, not replacement historical hashes. Adapter fixtures now bind the
real dispatcher validator. Added refusal controls for changed dispatcher,
boundary observer local and rejection reason field. Updated the result-mutation
control to the actual multiline guard, requiring one live mutation site; its
old replacement had become a no-op. The new instruction leaf is constrained
to one type-only model import.

Final run 50654 is terminal: 248/248 across settlement ownership (142),
resolution preservation (53), compiled rejection events (29), persistent
handler state (13) and one-job queue controls (11). TS7 passes. Scoped Biome
lint-only passes with five existing explicit-any warnings in the receipt
helper; full Biome formatting is not claimed because the repo uses Prettier.
Whitespace checks pass.

Dispatcher-free A/B (98674), standalone/deno/hostBridge-always, compares clean
pinned compiler 54eaa2239acd5eb1f383a500bd4d4a3b9dbdb3b2 against the current
working candidate after all producer and subscription changes: byte-identical
direct rejection (149,080), pending rejection/early catch (164,612), then chain
(161,826) and async throw through a compiled JS wrapper (149,209 bytes).

All changes remain local and uncommitted. The native runtime is unchanged at
2140dde; runtime compiler pin and trusted packaged artifacts have not advanced.
Next: retain and flush compiled events through the native adapter with exact
owner/realm identity and without reentering a borrowed Wasmtime store. Also
audit non-suspending IR await and resolve-value duplicate/thenable paths before
claiming complete reaction/rejection coverage. Broader Rust ops, module and
application conformance requirements remain open; this is not full integration.

### 2026-09-30 non-suspending IR await event coverage

Audited the additional native-carrier await path in `ir/lower-generic.ts`.
It previously marked field 4 directly without emitting a late reaction event.
Added an optional authenticated dispatcher resolver to the IR integration and
extended the pure reaction helper to accept an externref scratch local. Each
use builds fresh conversion instructions, preserving the no-shared-mutable-node
rule. Dispatcher absence preserves the original cast/mark sequence exactly.
The existing unrelated documentation edit in lower-contracts.ts is preserved.

Added a direct IR-builder executable Wasm control, not a compiled-source test
that might silently select the frame driver. It exercises the actual generic
lowerer, constructs a rejected carrier and checks exact reason identity,
first-only handle events, repeated awaits and plain-value passthrough, with
dispatcher enabled and disabled. Both controls pass (2003: 2/2).

Final 5338 is terminal: 250/250 across six suites (the earlier five plus the
two IR-await controls). TS7 89445 passes. Dispatcher-free A/B 67739 against
clean compiler 54eaa2239acd5eb1f383a500bd4d4a3b9dbdb3b2 confirms byte identity
for a fulfilled await program in standalone (159,457 bytes) and WASI (118,748).
An earlier compiled WASI probe (82020) was not behavioral evidence: instantiation
failed for missing WASI imports and it claimed zero IR functions. The direct
builder test avoids that routing ambiguity and does execute the IR body.

Native transport investigation: the runtime already has realm-rooted numeric
value handles, a same-graph `__v8x_value_keep`, and a central mutable runtime
borrow in `with_deno_core_runtime`. The dispatcher can retain Promise/reason
handles and enqueue events during Wasm execution, but native notification must
occur only after releasing the RefCell borrow. Compiled microtasks also use
separate borrow paths and need the same flush semantics. Events must bind the
owning realm and isolate, not depend on whichever context happens to be current.
No native transport implementation or artifact pin advancement is claimed.

Remaining producer audit includes IR `async.throw`'s directly minted rejected
carrier and resolve-value duplicate/thenable paths. Changes remain local and
uncommitted; the full integration objective is still active.

### 2026-09-30 IR direct rejection and native transport implementation

Instrumented generic IR `async.throw`'s directly minted rejected carrier with
event 0. Only a validated dispatcher allocates its scratch local; no dispatcher
leaves the original emission unchanged. Extended the direct IR Wasm test to
exercise both await and async.throw with/without a dispatcher. First run 40210
failed on a Vitest negative equality matcher inspecting an opaque Wasm object,
not on compilation or execution. A boolean identity comparison fixes that
instrument defect; 70366 passes 4/4. Final 67022 is terminal: 252/252 across
six compiler suites and TS7 passes.

Runtime worktree `/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo` now has
uncommitted native transport changes. New pure `js2wasm_rejection_events.rs`
retains ordered numeric root handles with owning realm/isolate metadata;
unknown events and non-integral/non-finite/out-of-range handles are refused.
The `v8x:deno/__v8x_promise_reject_notify` import only enqueues, never invokes
user callbacks while Wasmtime runs. Captured continuation data travels with
the event. A realm flusher converts exact Promise/reason wrappers under a
borrow, ends the borrow, restores continuation data, then notifies the native
callback. First-late-handler events retain a null native value. Non-Promise
carriers and wrong owner identities are explicit errors, not fabricated events.

The common Deno execution wrapper, compiled microtask paths and non-active
realm-value access use the post-borrow flush boundary. Callback-active access
continues to defer delivery to its outer execution boundary. Same-realm
recursive flushes are guarded so reentrant notifications append behind earlier
events. Cross-realm global ordering is not yet proven by this per-realm queue
and must be covered before a general ordering claim.

Runtime builder source now defines the same-graph dispatcher and roots values
with its context bridge before calling the numeric host import. **The compiler
pin remains 54eaa2239a and that older compiler does not produce these events.**
Do not publish/rebuild a claimed event-capable artifact from that pin. Advance
the pin only to a committed, verified compiler checkpoint and add an actual
compiled-event artifact control; import presence or an exported dispatcher is
not proof that compiler producer sites emitted calls.

Native cargo check passes (62436, 69749, 32089). Direct dependency-free Rust
queue tests pass 2/2; runtime option contracts pass 7/7 (69749). `cargo test
--lib` 51553 is terminal and failed to link existing missing DisallowJavascript-
ExecutionScope, sandbox and inspector symbols. No vendor code was changed.
The direct Rust leaf test was used as a bounded alternative, not a replacement
claim for a full library suite. Existing trusted core artifact regression run
40146 passes 30/30 with three explicit ignored tests; that artifact predates
compiled event producers and cannot prove the new transport end to end.
Final regression repeat after continuation capture (4316) is terminal and
passes 30/30, three ignored, in 1.12 seconds. All cited processes are terminal.

Next: committed compiler pin, fresh compiler-free event artifact, exact reason/
Promise identity and callback reentry tests for the transport, cross-realm
notification ordering, and resolve-value/thenable duplicate-path coverage.
No PR push, artifact pin advancement or full-integration completion occurred.

### 2026-09-30 compiled event transport end-to-end verification

Added two public rusty_v8 integration controls against a freshly compiled
context: exact Promise/reason identity with first-only late registration, and
callback reentry that attaches a handler to the Wasm-owned Promise. The fixture
does not synthesize native rejection events. It calls compiled Promise.reject
and catch, whose compiler-generated dispatcher reaches the queued host import.
The native tests assert exact wrapper addresses, absent value on the handle
event, persistent handler state and no duplicate events after checkpoint.

Runtime tooling now shares `contextPromiseRejectionDispatcherSource` between
the core artifact builder and the namespace fixture builder. It validates the
root-keeper identifier and roots both values. Namespace builder opt-in flags
`--rejection-events` and `--rejection-events-disabled` produce the positive
fixture and the same workload without the dispatcher. These are local test
artifacts from the working compiler, not a claim that the production compiler
pin has advanced.

Positive raw build 8966: `/private/tmp/v8x-events-context-20260930.wasm`,
1,153,382 bytes, SHA-256
`ad1c418de50e732660dabd3fa635c48ab27c166306d0b8e8df61f44e168dc36d`.
Raw replay 20570 passes 2/2 in 125.64 seconds including native compilation.
Precompile 94502 passes 1/1 in 126.71 seconds with Wasmtime 47.0.3, producing
`/private/tmp/v8x-events-context-20260930.cwasm`, 23,521,584 bytes, SHA-256
`68a1bd8a7e41dc29fc597a765919008321fc111011d26996554d00e88f81a743`.
These development artifact sizes are not a normalized deployment benchmark.

Compiler-free replay 77384 passes 2/2 in 0.04 seconds with features
engine_js2wasm/js2wasm_gc_copying/simdutf and no runtime-compile feature.
Dependency A/B confirms wasmtime-internal-cranelift is absent under those
features and present as version 47.0.3 when js2wasm_runtime_compile is added.
This proof concerns the selected Wasmtime compilation dependency, not a full
binary size or linker audit.

Negative raw build 37214: 1,152,720 bytes, then negative precompile 17077
passes 1/1 in 121.82 seconds. Running the same compiler-free delivery tests on
`/private/tmp/v8x-events-disabled-context-20260930.cwasm` fails 2/2 at the
expected missing callback count (0 instead of 1) and missing reentrant handler
(false instead of true). Positive artifact replay immediately afterward passes
2/2 again in 0.08 seconds. No source rollback or removal of expected assertions
was needed. Runtime option/source contracts now pass 8/8. All cited processes
are terminal. Updated site/callbacks.typ to describe only this measured opt-in
behavior; Typst is unavailable, so rendering is unverified.

Open scope is unchanged: compiler pin/checkpoint and complete-core artifact
rebuild, multi-graph producer verification, cross-realm global event ordering,
resolve-value/thenable duplicate paths and the broader Deno integration gates.
The per-realm transport now has actual compiler-free behavioral evidence;
that evidence is not full Deno conformance. All changes remain local.

### 2026-09-30 clean artifact and cross-realm ordering follow-up

Compiler checkpoint `23d2e6cda9e58e1ee4da95b62719d6cdc03cd14a`
contains the authenticated event producer and an executable multi-file
dispatcher test. The pre-merge focused compiler run passed 253/253 and TS7.
Adapter checkpoint `89c8b0761047fb86c8c3f365e7e2a509dbd74a5b`
advances the runtime compiler pin to that checkpoint. Both commits are signed.

Clean detached worktrees under
`/private/tmp/deno-event-release-build.X2rntG` produced the complete pinned
Deno core raw AOT module: 2,675,441 bytes, SHA-256
`4eaf0ee70ebe0e8e0b26f188c1680f3912d9411c6d394b3fdbf5a6cf5260dafb`.
Raw provenance matches the two checkpoints and Deno
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`, with 18 native imports and
no interpreter provider. The first native precompile attempt terminated
because the fresh adapter checkout lacked its submodule and DNS failed.
Initialized rusty_v8 from the verified local checkout at its exact gitlink
`dd1b4e9c743b7a11dbeb99d4d0dc55979218b905`; no vendor source was changed.
Replacement native precompile is session 76363, still running at this entry.
Compiler-free replay remains pending and must use this artifact's attestation.

Latest loopdive/js2 main `9df21d402cd7d9a4e7cafb5e78880338c41a2c6b`
is merged in signed commit `8ad96ad65f8526538dfb8d31a9805f91cbc3c554`.
Unrelated local source documentation and acorn binary edits were preserved.
Post-merge TS7 passes; focused regression run 38998 is pending.

Cross-realm delivery is now being tested rather than inferred from the
per-realm reentry guard. A new actual compiled fixture queues a rejection
and its late-handler notification in realm A. The native rejection callback
enters realm B and rejects a different Promise. The public API test requires
A's already queued handler event to precede B's new rejection, with exact
Promise and reason identities. Raw fixture build 63206 passed (1,154,062
bytes); native fixture precompile 29528 is running. No ordering fix or passing
ordering result is claimed yet. Full integration acceptance remains open.

Clean full-core precompile 76363 finished 1/1 in 243.95 seconds. Native
artifact: 47,460,024 bytes, SHA-256
`8373919144fb41c0f3b7ca476fb6ebbc962d5d72e4730994676da129f8a49237`.
Recomputed raw and native hashes match the paired attestation (Wasmtime
47.0.3, aarch64-apple-darwin). Compiler-free full-core integration target
86988 passes 30/30, with five explicitly ignored artifact-specific controls,
in 1.02 seconds. This includes exact core Script::Run bootstrap and host
effects, not the complete upstream deno_core test suite. No runtime compiler
feature or interpreter provider is enabled in this replay. Public callback
docs now reflect the advanced pin; Typst rendering remains unverified.
Post-merge compiler run 38998 passes 252/252 across six selected suites,
including ten upstream super-write controls. The single-microtask suite was
not part of that invocation; the earlier 253 count is a different selection.

The missing post-merge single-microtask selection passed 11/11 (12337).
Together the two post-merge invocations cover 263 tests, not one 263-test run.

Cross-realm fixture precompile 29528 passed 1/1 in 124.04 seconds. The
compiler-free public API ordering test against the pre-fix adapter failed
0/1 (97096): realm B's unhandled event preceded realm A's already queued
handler-added event. This directly attributes the defect to per-realm delivery,
not artifact import presence. The repair moves native-attached compiled
notifications into an isolate-local queue and reentry guard. Each event
retains its stable Rc owner identity, realm id, isolate, rooted value handles
and captured continuation data. Owner lookup compares identities without
borrowing an executing Store. An executing head owner defers the queue rather
than skipping it; an unavailable owner is a loud error. Delivery enters the
event's context and releases the Store borrow before invoking user code.
Standalone contexts without a native isolate retain their existing local queue.

The initial repair replay failed 0/3 (26745) because test-realm attachment
does not use production's publish-before-initialize path and had no stable
owner identity. The common runtime-entry boundary now authenticates and
initializes its Rc identity, refusing any subsequent change. The same trusted
artifact then passes 3/3 compiler-free controls (29249), including exact
cross-realm Promise/reason identity and unchanged same-realm handler reentry.
No compiler or interpreter was needed for that replay. Full-core replay on
the repaired adapter is session 7748, pending at this entry. Runtime option
contracts pass 8/8; cargo formatting and diff checks pass. Typst is absent.

Remaining scope includes resolve-value/thenable duplicate paths, nested
cross-realm execution while an outer Store is still running, native/compiled
notification interleaving, broader real Rust ops and upstream Deno conformance,
complete module/dynamic-import/TLA behavior and production packaging. The
ordering control closes one measured gap, not the full acceptance checklist.

Repaired-adapter compiler-free full-core replay 7748 passes 30/30 in 1.12
seconds, with six ignored explicit artifact controls (the additional one is
the new cross-realm control separately executed above). No baseline file was
changed from this bounded integration target. All processes cited in this
follow-up are terminal. The complete core artifact still records the clean
89c8 adapter build inputs; the repaired-adapter run is a subsequent host A/B
using the exact same trusted native module, not a newly attributed artifact.

Signed local adapter checkpoint:
`6bf28ba17ae66c4d35190ea1b08213265091c511` on
`codex/4376-deno-realm-bootstrap`. Tracked adapter files are clean; only its
untracked `.tmp/` remains. Existing compiler PR 6341 and adapter PR 2 have not
been updated by a push in this follow-up. Next work should test nested Store
reentry and native/compiled notification interleaving, then audit the compiler's
resolve-value once-only guard and adoption paths against actual emitted code.

### 2026-09-30 resolving-function once-only audit

Auditing executor and thenable resolving pairs against pending adoption, not
only settled Promise state. Current closure trampolines capture just the
Promise; the state guard lives in fulfillment/rejection helpers. Resolution
can enqueue adoption and leave that state pending, so a subsequent reject
or executor throw can still win incorrectly. A second resolve also reaches
Get(then) before the eventual settlement guard. Added three emitted-Wasm
controls for pending adoption followed by duplicate reject/resolve, ignored
second-resolution getter, and executor throw after pending adoption. Run
14378 is pending. The intended repair is a shared per-resolving-pair latch,
distinct from Promise state and fresh for each thenable-assimilation job;
adding a Promise-state check alone is not a complete fix. No pass is claimed.

Baseline emitted-Wasm controls 14378 fail 0/3: duplicate rejection overrides
pending adoption (state 2 instead of 0), a second resolve reads the poisoned
then getter (1 instead of 0 reads), and executor throw overrides pending
adoption. The implementation adds one mutable i32 resolving-pair cell shared
by both closure values. Each trampoline locks that cell before resolution can
read user properties or enqueue adoption. Duplicate attempts return without
settling and optionally report their original attempted value as event 2/3.
Executor and thenable throw catches invoke the same reject closure, not a
low-level Promise-state-only reject. Each thenable job allocates a fresh pair.
Both executor routes and the observable aggregate capability route are wired.

The explicit native resource planner declares the same cell and extra capture
field, increasing its exact inventory from 25 resources/26 operations to
26/27. Inventory tests retain exact row and role assertions rather than
weakening the denominator. Frozen donor hashes are unchanged. Source receipts
account for the exact new cell, field, shifted type index and guard prefix,
and the updated live mutation controls still fail on wrong settle targets.
Pure legacy-resource builder fixtures retain their original instruction shape;
actual native graphs intentionally change behavior and bytes for this fix,
including ordinary standalone programs without a Deno dispatcher.

After import/type repairs, 36658 passed all 33 event controls but exposed
outdated exact resource counts and a multi-occurrence receipt mutation site.
The guard has a separate instruction builder so canonical settle-body operand
mutants retain one authentic target. Reconciled run 61747 passes 280/280:
38 emitted event controls, 53 resolution receipts, 47 native resource controls
and 142 settlement ownership controls. New behavioral tests cover thenable
pending adoption followed by reject and throw, getter reentry, fresh nested
thenable jobs, any-valued executors and ordinary graphs without notifications.
Broader run 92594 passes 96/96 across nine executor/thenable/combinator,
closure reservation, handler, scheduler and IR suites. TS7 passes (91316 and
59704). These are two disjoint selections, not one 376-test invocation.

Semantics checked against CreateResolvingFunctions, which consumes the shared
pair before Get(then), and the definition of resolved-but-pending promises:
https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-createresolvingfunctions
The prior one-shot comment relying only on settled state is superseded.
Default merge-base LOC gates pass. An attempted check:function-budget command
does not exist; the real check:func-budget invocation is 75699/pending below
and must not be represented as passed until its actual output is available.
Compiler commit, runtime pin advancement and complete-core artifact rebuild
are still pending for this latch implementation.

Final unified selection 85008 passes 376/376 in 13 suites after reusing the
same reject closure for the thenable job's call arguments and throw catch.
TS7 passes in that invocation. Function-budget 75699 is now terminal and
passes against default merge-base(origin); it is not an exact-base gate claim.
All compiler test commands cited above are terminal. Next checkpoint should
pin only the resulting committed compiler SHA and rebuild from clean detached
worktrees before reporting packaged Deno behavior with the latch enabled.

Signed compiler checkpoint is
`f3e92a6179d54984bbe1f5e63ab2caaa329a66cc`. Its commit hooks passed
Prettier, Biome and default merge-base LOC/function gates; slow hooks were
explicitly skipped. Unrelated lower-contracts documentation and acorn binary
edits remain uncommitted and unchanged. Adapter checkpoint
`26a8fbaab839ba886e3bc478ac340e1817e2b001` pins that exact compiler,
retaining historical POC options; runtime option contracts pass 8/8.

Clean detached build root:
`/private/tmp/deno-resolving-pair-release-build.MTZesR`, with compiler and
v8x subdirectories at the two checkpoints. Compiler node_modules is an
ignored link to the existing main dependencies. Deno source is the unchanged
clean checkout `/private/tmp/deno-release-build.cGYWlK/deno` at
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44`. Initialized rusty_v8 locally
at the exact unchanged gitlink dd1b4e9c743b7a11dbeb99d4d0dc55979218b905.
Raw build 10711 passed: 2,675,207 bytes, SHA-256
`6fa9f40507353e0dd7538c19b3f8abe3153b4b59d089e455ec415475d230d2e6`.
Recomputed bytes/hash match deno-core.provenance.json, which retains 18 native
imports, the exact three source commits and no runtime-eval provider.

Native precompile **71472 is confirmed live** at this handoff. Do not restart
it based on an observation timeout. It uses the clean v8x directory,
`CARGO_TARGET_DIR=/private/tmp/v8x-deno-resume-20260930.o0sxeO/repo/target`,
V8X_JS2WASM_DENO_CORE_WASM pointing to this root's deno-core.wasm,
V8X_JS2WASM_DENO_CORE_AOT_OUTPUT to deno-core.cwasm and
V8X_JS2WASM_DENO_CORE_AOT_ATTESTATION to deno-core.attestation.json.
Command: cargo test --offline --no-default-features --features
js2wasm_deno_poc,js2wasm_gc_copying,simdutf,js2wasm_runtime_compile
--test js2wasm_spike precompiles_exact_deno_core_artifact -- --exact --nocapture.

After the same handle reports terminal success, recompute raw/native hashes
against the new attestation and run the whole js2wasm_spike integration target
without js2wasm_runtime_compile, using the new AOT module/attestation and main's
tests/fixtures/deno-core-0.407.0. That replay has not run yet. The prior 30/30
core result used the earlier compiler pin, so it does not prove packaged
behavior with this latch. General nested active-Store reentry, native/compiled
notification ordering, broader Rust ops, full upstream conformance, imports,
TLA and production packaging remain in scope. Commits remain local; no PR
push or external comment was made in this follow-up.

### Resolving-pair packaged replay and general-op audit

Native precompile 71472 is now terminal: 1/1 passed in 240.75 seconds.
The native artifact is 47,460,032 bytes, SHA-256
`a2a2f9e59deb8da144dfc836fddc2ba233d0088f057cba2fbc6588db1237582c`.
Both raw and native hashes were recomputed from disk and match the attestation.
Compiler-free replay 53463 passed 30/30 with six ignored in 1.08 seconds,
using the artifact root and commands above without js2wasm_runtime_compile.
This supersedes the prior live-handle handoff, not the broader remaining scope.

Merged newly fetched loopdive/js2 main ad10f2e8605692cd8baf0a884be0ab6cd305dab5
into the compiler branch as signed merge 310b266bd9. Incoming changes are
benchmark/baseline documentation, not the compiler artifact pin. Unrelated
local edits remain preserved.

The runtime profile does not use the hardcoded seed op table: graph construction
replaces it with __v8x_attach_context, which transfers the real Rust global
object and ops through realm_host_callbacks. Legacy print/sum binding code alone
is therefore not evidence that general Rust ops are unavailable. The application
packager is still restricted to the pinned hello-world source; expanding general
AOT application/module packaging remains required. Do not replace this restriction
with arbitrary classic scripts wrapped in a function, which would change scope,
completion values and repeat-execution semantics.

Added native integration controls for every argument-bearing generated upstream
async stub (one through nine user arguments), checking argument order, receiver
identity and returned object identity. Initial focused replay 41536 passed 1/1.
Added a callback-count floor and an unsupported ten-argument refusal control;
final full-target verification is pending below. Deno wrapper sources remain
unmodified and no interpreter/compiler feature is enabled for replay.

Full-target 92180 is terminal: 29/30 passed, six ignored. The new upstream
ten-user-argument rejection control fails: instead of the expected core Error,
the adapter exposes a diagnostic ending in `exception length outside diagnostic
limit: -1`. Diagnostic rerun 18466 reproduces 0/1. Wasm backtrace points to
__runtime_eval_unwrap_call_result through __apply_closure/__closure_method_call.
This is a new observed boundary failure, not evidence the arity cap can be removed.

Local adapter candidate in src/js2wasm_graph_calls.rs now retains the single
externref exception payload for bootstrap-realm calls, mirroring existing
application-graph dispatch, instead of rendering a new diagnostic Error.
Full-target 62392 remains 29/30, six ignored: the same refusal now exposes
`null`, still not the required Error. Thus exception transport alone does not
finish the repair. Next investigate whether the compiled call-result failure
envelope already carries null (including the explicit runtime-eval refusal
provider path), and prove the actual source error reaches native TryCatch.
Do not weaken the error assertion or modify upstream Deno wrappers. Nine
argument-bearing branches and their exact callback-count floor pass before
this failure; the broader integration test stops at the new negative control.
The adapter candidate and tests remain uncommitted pending that repair.

Compiler isolation reproduces the same null before any native adapter runs.
New issue-4376-core-error-constructor controls pass two direct/captured Error
controls but fail the actual unchanged 00_primordials.js + 00_infra.js refusal
with -1 (caught null). Constructor-value tracing did not recognize a const
object binding element, so the dynamic-new miss returned null. Added candidate
tracing for const { Error } and renamed const { TypeError: Alias } bindings.
This only prepares the existing identity-guarded constructor helper; it does
not infer intrinsic identity from a name or replace arbitrary bag functions.
No new shared context field or instruction array is introduced. Readers of
the trace are helper preparation, shadowed extern-name selection and alias
invoke selection; their runtime carrier identity guards remain intact.

Compiler run 94098 passes 34/34 across five suites, including all seven Error
families, renamed bindings, one-time source/message side effects, a negative
user-class-under-Error-key control, and the unchanged upstream scripts. The
upstream refusal control is now 42, not null. Native replay still needs a new
artifact built from the committed repair; old artifacts cannot prove this fix.

TS7 40587 passed. Signed compiler repair is
`11e0185184b8bc7b6baf538d3c1b539307885283`; fast commit hooks passed after a
lint-only test variable rename, while slow hooks were explicitly skipped.
Signed adapter checkpoint is `8e6b777b420c50868abacdbafa1193d49a8a825b`,
including exception retention, nine argument controls and the new compiler
pin. Runtime compile-options contracts pass 8/8. No PR push has been made.

New clean detached root is
`/private/tmp/deno-primordial-error-release-build.2XCUVn`, with compiler/v8x
subdirectories at those commits, ignored compiler dependency symlink and exact
unchanged rusty_v8 gitlink. Deno input remains the clean pinned checkout used
above. Raw build 72048 passed with 2,676,273 bytes, SHA-256
`461c03d4100948585735bef1f44a138a8cf90e50e93e7ed65d9c0cfb2dce9147`.
Provenance retains unchanged source hashes/options, 18 native imports and no
interpreter provider. Native precompile 5923 is live and uses this root's raw,
native and attestation paths with the same command/features as 71472 above.
Do not restart that handle after an observation timeout. Native refusal behavior
is not yet verified for this compiler pin.

Precompile 5923 is terminal 1/1 in 248.45 seconds. Native size is
47,476,520 bytes, SHA-256
`87024a93f0eaaabbded62c0e6d7977bebd5b6b3e269dfe08712fe50ce732fe58`.
Both raw/native hashes match attestation. Compiler suite 31055 passes 37/37
across six Deno bootstrap/primordial/coercion suites (overlaps 94098; do not
sum the selections). Native replay 97397 still reports 29/30, six ignored,
but the refusal is now `[object Object]`, not null. That isolates a third
gap: native Value::ToString ignores bound realm objects and prints its Rust
placeholder. The compiled Error and exception transport repairs are not a
complete native string-conversion repair.

A trial calling the realm's String carrier failed 90637 with no string result.
It was removed. New __v8x_value_to_string performs the compiler's spec-string
argument coercion and returns a success/value envelope. Rust reads it using
the owning realm, preserves thrown-value identity and records it in native
TryCatch. A trial template substitution accepted Symbol in 90821, exposing
an existing compiler template-coercion gap; no pass was claimed. The bridge
instead uses the native String.prototype.concat argument operation, whose
spec ToString walk handles the string hint and Symbol rejection. Node bridge
95917 passes Error text, string-hint coercion, thrown identity and direct
Symbol refusal, alongside its existing scalar/buffer/callback controls.
Added a Symbol-producing object coercion control; 62206 is pending. Native
replay needs another artifact containing this new export. No Deno source or
wrapper is modified.

String conversion bridge control 62206 is terminal and passes, including a
Symbol returned from object @@toPrimitive("string"). Signed adapter checkpoint
`e3f0223f8f246a1fdbd37508d71ccee647ffdb17` includes the native conversion,
compiled export, controls and accurately limited public documentation. Typst
is unavailable; no render result is claimed. The clean validation v8x checkout
was advanced to this checkpoint; the previous artifact files were retained.

Raw rebuild 82262 is terminal success, producing deno-core-string.wasm under
the same build root: 2,678,030 bytes, SHA-256
`74b35e573c2e107d19d267b874ca31d4eb2df9d45b81ea0f30e6f1de31e6f270`.
The source-graph digest changed to
`d854c4626d1e320f6e62b14d7dcc856f09aa976f4731379b02f6ac4aa10d83c5`
because the conversion bridge/export changed, not because upstream scripts
were edited. The runtime compiler remains 11e0185184, 18 native imports and
no interpreter provider. Native precompile 97481 is live. Its configured
output/attestation files are deno-core-string.cwasm and
deno-core-string.attestation.json, in this same root. Resume that handle;
after success verify both hashes and run the full compiler-free target with
the new string artifact. Do not use the earlier deno-core.cwasm to test this
new bridge export. Native conversion/brand conformance remains unproven beyond
the bounded tests; full Deno compatibility and general app routing remain open.

Native precompile 97481 is terminal success: 1/1 in 243.19 seconds.
deno-core-string.cwasm is 47,509,488 bytes, SHA-256
`74f9ae2e55393bea826697ccf40cd51b8b257844f086d25df2d2e608e35ebf7d`.
Both raw/native hashes recomputed from disk match its attestation. Compiler-free
full-target replay 10607 passes 30/30, six ignored, in 1.25 seconds with
js2wasm_deno_poc,js2wasm_gc_copying,simdutf only. The upstream oversized async
stub now reaches native TryCatch with the expected Error text, completing the
three-part construction/transport/string-conversion repair for this control.

Extended native full-target replay 44543 passes 30/30, six ignored, in 1.34
seconds using that same trusted artifact. A Rust-owned object's toString is
called from compiled spec coercion with the exact receiver identity and zero
arguments; changing that method to throw a Rust object makes Value::ToString
return None and native TryCatch observe that exact object. The callback event
floor is exactly [string, throw], excluding a vacuous native placeholder path.
These controls do not prove full cross-graph coercion, Error branding or Deno
conformance. All handles in this repair are terminal; no live precompile remains.

### Full upstream harness preparation after main merge

Merged loopdive/js2 main 721d12bf9f11512d7c00eb55b82f3863748b358b as signed
9dc3f4fe56, preserving unrelated local changes. The refreshed rejection context
precompile passes 1/1 in 128.18 seconds. Compiler-free rejection replay passes
3/3 in 0.11 seconds, covering late handlers, native callback reentry and
cross-realm enqueue order. This is separate from the 30-test bootstrap target.

Full upstream Deno checkout: /private/tmp/deno-upstream-conformance.H6HA4g/deno,
pinned at 1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44. Only Cargo.toml and
Cargo.lock are adapted, selecting the v8x path dependency with compiler-free
js2wasm, copying GC and fail-loud diagnostic ABI. Deno sources and tests remain
unchanged. The initial offline dependency resolution refused the older bumpalo
lock; the documented seven-package Cargo update succeeded offline and resolved
Wasmtime 47.0.3. Full deno_core unit-test compilation is now running in session
74438. No upstream conformance result or baseline change is claimed yet.

Session 74438 failed before adapter compilation: Deno's configured ld64.lld
cannot parse the installed macOS 27 SDK's arm64e.x1 TAPI architecture. Retrying
with RUSTFLAGS='--cfg tokio_unstable' selects the host linker without editing
upstream files. Session 3468 then built the unchanged deno_core unit-test binary
in 57.15 seconds. Enumeration reports 431 tests, not a test pass count.

Using the trusted deno-core-string AOT artifact and its attestation, upstream
runtime::tests::misc::test_heap_limit_cb_remove passes 1/1 (430 filtered) in
1.40 seconds. test_execute_script_return_value and test_pump_message_loop each
fail 0/1 after successful JsRuntime construction when their first arbitrary
script is refused by the closed-world artifact. General classic-script AOT
global lexical environments and completion values remain required; do not
relax the refusal by treating arbitrary scripts as function bodies.

The unchanged upstream hello_world example builds and runs compiler-free in
session 82439, returning exit 0 and printing sum 6. Its negative case prints
only TypeError, missing the expected serde_v8 diagnostic. This contradicts
the manual callback fixture's full error text and must be fixed rather than
called complete. A new direct upstream buildCustomError message assertion in
tests/issue-4376-core-error-constructor.test.ts is under test in session 96337
to separate compiler construction from native callback transport. No baseline
was changed, and no upstream source/test was modified.

The standalone diagnostic experiment is terminal: 96337 fails 10/11 with an
opaque Wasm exception from buildCustomError. It does not isolate construction
from ErrorCaptureStackTrace and was removed from the unrelated existing async
refusal test. The native upstream example remains the acceptance check for the
missing error message, not this discarded instrument.

Seven focused constructor-through-parameter controls fail before the repair:
43035 passes 10/18, with all seven Error families returning objects with the
wrong name. Adding a retry only to the dynamic-new null fallback does not help
(25433, same 10/18); the earlier function-constructor lane intercepts the site.
The repair guards canonical Error-family carrier identity before that lane,
uses spec message conversion, and preserves the original user-constructor
lowering for every other value. No new shared context field or aliased Instr
object is introduced. Untraced any/unknown new sites now include seven small
Error dispatch arms; RegExp's expensive compiler is not added for those sites.

Final focused validation 86725 passes 42/42 across five suites, including seven
parameter constructors with argument/conversion counts exactly one, a user
constructor with one argument evaluation and one constructor call, and the
existing capture, shadowing, identity and RegExp controls. TS7 session 81972
passes. This is a compiler checkpoint, not proof the real Deno message is
repaired: rebuild the pinned runtime core and its native artifact, then rerun
the unchanged upstream example and full-target controls. All sessions in this
checkpoint are terminal; no native build or compiler check is still running.

### Clean parameter-constructor artifact rebuild

Adapter checkpoint 9ee8ba94840978337db4dcdd778b0f18682f35a5 advances only the
runtime compiler pin to e6a8f950b10165106d37b80e7bcc247f802a2128; historical
POC remains unchanged. Runtime option contracts pass 8/8. Clean detached
packaging inputs are /private/tmp/deno-parameter-error-release-build.Vy1d5l/
compiler and v8x, with the original clean pinned Deno checkout. Builder 74173
is terminal success: deno-core.wasm is 2,687,026 bytes, SHA-256
`8a71883a3675fb798dc75f8b17db3c895c661218dacefad323ea1d4c68775844`.
Its provenance reports 18 native function imports and no interpreter provider.

New native controls call the actual compiled core.buildCustomError for six
upstream registered Error families. Old-artifact baseline 95822 fails 0/1:
Error ToString is "Error", expected "Error: native op failure". This reproduces
the upstream example's missing-message problem independently of the sum op.
The new native precompile is still live in session 7832; poll this same handle,
do not restart it. Replay must use the new artifact and paired attestation.
No claim is made that the native error message is repaired until that replay
and the unchanged upstream example pass with full diagnostic text.

Native precompile 7832 is terminal success, 1/1 in 248.54 seconds. The new
deno-core.cwasm is 47,689,992 bytes, SHA-256
`9a42a3f1c4ca44af05bc0267a64e0f6d3bc44d02f66fc863649c972ab9a83062`.
Raw/native disk hashes match the paired Wasmtime 47.0.3 attestation for
aarch64-apple-darwin. Compiler-free full target 63199 passes 30/30, six ignored,
in 1.47 seconds, including all six real upstream error-builder message checks.
This contrasts with the same new native control on the previous artifact,
which failed before any sum-op execution. The unchanged upstream hello_world
binary replay 69532 exits 0 and prints the complete expected diagnostic:
TypeError: serde_v8 error: invalid type; expected: array, got: Number.
No upstream Deno source or tests were edited and no interpreter was loaded.

Broader compiler bootstrap/coercion validation 91517 passes 26/26 across five
suites in 23.36 seconds. These are separate from the earlier 42/42 constructor
controls. All sessions in this rebuild are terminal. The next major acceptance
gap remains general AOT classic-script compilation with shared global lexical
environments and completion values; the shipped source allowlist remains
deliberately narrow. The full 431-test upstream suite has not been run to
completion and must not be represented as passing from these bounded results.

### Ordinary upstream module packaging and Script-route investigation

The compiler already records global object var and lexical binding names
(codegen/index.ts recordSourceGlobalEnvironment), and threads a real completion
register through statement lowering (statements/eval-completion-value.ts).
However, emitStandaloneGlobalScriptEvalRuntime in expressions/eval-inline.ts
unconditionally calls __runtime_script_eval in the provider. ScriptGoal only
selects grammar checks; entryScriptGoal selects script strictness/global behavior
for the entry, not independent persistent Script execution across calls.
The multi-file path currently accumulates one initializer for the whole graph.
Thus simply wrapping sources, or using indirect eval's isolated lexical scope,
would not implement the required persistent global Script environment.

Unchanged upstream test_get_module_namespace baseline 16560 fails 0/1 (430
filtered): bootstrap succeeds, but no trusted AOT graph is configured. This is
a packaging input failure, not evidence namespaces themselves fail. Packaging
run 56866 completed 1/1 with the development-only js2wasm_runtime_compile
feature and clean e6a8f compiler sidecar. Compiler-free replay 5768 also passed
the same unchanged upstream test 1/1 with runtime_compile and compiler
configuration removed. The packaged application graph is 5,066,608 bytes,
SHA-256 1defe8b589284a4acaa80cb162b5d7889ad99dc9218ff233f51e206697995d6a,
under the owned Vy1d5l release directory; its source-binding sidecar matched.

The development compile initially failed Cargo resolution because the upstream
workspace pins semver 1.0.25 while Wasmtime's Cranelift feature needs >=1.0.27.
Only root Cargo.toml/lock metadata is adapted to semver 1.0.28; no Deno source
or test is changed. Cargo resolves the packaging feature offline. This feature
is never evidence of a compiler-free deployment and must be removed for replay.

### Ownership-aware cross-graph property reads, 2026-09-30

Upstream modules::tests::builtin_core_module packaging run 79868 reported
libtest 1/1 but logged a thrown "core missing" during module initialization.
The test does not await its evaluation future. This is not a passing Deno
application evaluation. A separately compiled consumer using the exact pinned
ext:core/mod.js reproduced the failure: provider bootstrap starts with only
primordials, then Object.assign adds core and internals. Consumer run returned
-1 (missing core). A provider with all physical fields present at construction
was a positive control. The added properties live in the owner's module-local
property side tables, not in the consumer's matching physical struct.

The explicit standaloneGlobalThisImport ABI now optionally pairs an ownership
predicate with Get(object,key,receiver). __extern_get checks ownership before
every graph-local carrier, property bag, and cache arm. Reflect.get's receiver
is passed through and consumed before invoking the owner's getter. Inlined
graph-local getter cache arms are disabled only for this opted-in ABI; ordinary
standalone modules retain their current code paths. Both single-source and
multi-source finalizers install the owner guard. Incomplete ownership ABI
configuration fails validation.

The reproduction now returns 42. Controls verify independently added local
properties return 83, a foreign accessor receives its explicit receiver, and a
foreign argument can be read without any globalThis expression. Focused linked
getter exception control preserves the original thrown object's identity
through the shared tag; the final linked-getter suite passed 3/3.
Focused linked
realm/namespace/exception tests passed 13/13; the subsequent linked bootstrap,
real core bootstrap, primordials, and infra suites passed 23/23. TypeScript
checking passed. These are compiler-side checks, not a native upstream replay.

The adapter is not wired to this ABI yet. Its shared numeric handle table is
not an ownership registry: it can root values allocated by other application
graphs. Treating every rooted reference as core-owned would misroute foreign
objects. The adapter needs proven provenance, including returned child objects,
before the ordinary Deno module import can be claimed fixed. Rebuild both core
and application artifacts, then assert the actual evaluation result rather
than relying on the false-green upstream test.

Merge checkpoint 3400f570b5 incorporates loopdive/js2 main f6ff83a26c. Focused
Promise/Deno checks passed 70/71 after resolving the five conflicts and adding
the new Promise carrier field in main's species path. One existing inline
Promise-subclass test throws with species-aware construction; it was not
weakened or removed. This remains a follow-up, not a fully passing merge claim.

### Allocation provenance implementation plan

The adapter handle table cannot certify allocation provenance. Prototype an
opt-in final physical-module transform that adds an immutable owner-token slot
to GC structs and initializes it at every allocation. One immutable GC token
is created per module instance before other globals; it does not hold reverse
references to any allocated objects. An exported predicate compares the token
by reference identity after validating the carrier. This avoids an unbounded
strong-reference registry and keeps provenance unchanged when a foreign value
is rooted, returned, or inserted in another module's containers.

All physical readers/writers and subtype field prefixes must shift together.
The pass must handle constant global allocations, nested allocations, packed
fields, and subtype constructors; unsupported constant forms must fail loudly.
Identical module binaries instantiated twice are the key negative control:
their Wasm types are identical, but their owner tokens must differ. Validate
this before wiring Deno artifacts or making performance claims.

The opt-in standaloneAllocationOwnerExport pass is implemented. Each original
GC struct carries an immutable reference to a fresh per-instance token. The
pass remaps subtype field indices and defined-global indices, spills subtype
constructor suffix operands into reused locals, and reconstructs constant
initializer operand boundaries. It creates no allocation registry or reverse
references. Shared export descriptors are cloned before remapping, fixing a
double-shift exposed by the explicit host bridge's aliased global exports.

The same-module/two-instance negative control passes even after a foreign
object is inserted into the other instance's Map. Controls cover newly
allocated objects, captured closures, arrays, Promise/Error carriers, inherited
field reads, constant subtype constructors, packed fields, and exported globals.
Class enumeration is compared against unstamped output; simple-literal
enumeration retains its exact two-property positive control. The compiled
provenance predicate replaces the hand-maintained ownership Map in the linked
bootstrap test, so newly returned child objects do not need ad-hoc registration.

The unchanged pinned core bootstrap/hello-world stage checks pass both with
and without stamps (2/2). Stamped probe 87450 completes with no deferred provider
calls and preserves the full serde_v8 error diagnostic. Its raw module is
2,856,164 bytes, SHA-256
10e70545e609f5cfcaca594520f452d075b91e2df389d2f21af0fd83dc477cd7.
This is a compiler-stage module, not a native deployment footprint measurement.

Adapter wiring and native compiler-free replay remain open. Native shared
string readers inspect physical fields directly: AnyString's owner slot will
shift flat/rope suffix fields. Their ABI must be updated explicitly before
accepting stamped artifacts. Shared buffer roots are also length-only, so the
owner token shifts their concrete data-array slot from 1 to 2. All
linked graph artifacts must use the same stamped runtime type layouts.

Final focused run 30799 passes 17/17 across allocation provenance, linked
bootstrap bindings, shared exception identity, realm carriers, and the exact
upstream core-stage probe with and without stamps. TypeScript check 21214 is
the final check for this checkpoint. Native core/application packages have not
been rebuilt with stamps, and no full upstream harness completion is claimed.

### Adapter allocation-owner wiring checkpoint

Merged loopdive/js2 main 2ef807a68e in signed merge 141bb4dae9 without
overwriting unrelated local changes. TypeScript passes after the merge.
Focused allocation-owner, linked-bootstrap, and exact core-stage checks pass
8/8 (run 83542). The graph builder now opts into allocation stamping and
imports the core instance's ownership predicate and Reflect.get entrypoint.

The adapter runtime packager and namespace fixture now stamp allocations;
historical POC options stay immutable. Explicit dynamic providers receive the
same physical-layout transform, while AOT still packages no interpreter.
Native context import validation permits the ownership and getter functions.
Native string and transfer-buffer readers select stamped suffix offsets using
the generated context ownership export as an explicit ABI marker.

The first native value-transfer run (43183) failed loudly at the packet-array
slot, exposing the vector root's one-field prefix. It also used the namespace
fixture instead of the complete value-transfer fixture. Both were corrected;
the full value-transfer generator now supports --allocation-owner and its
Node assertions pass (59048). Corrected native run 42187 passes 1/1, checking
UTF-16 slices, ropes, deep concatenation, lone surrogates, packet retirement,
ordered property packets, and values surviving moving GC. This loads raw Wasm
using the build-time compilation feature; it is not compiler-free replay.

Adapter packaging tests pass 9/9, including loud rejection of an unstamped or
uninspectable runtime module, and cargo fmt --check passes. The source LOC,
function, and coercion gates pass, but the broader branch still fails the
dead-export/moved-runtime gate (three unused primordial-alias helpers and two
uninspectable dynamic import targets). An added return-type checker query was
replaced with the already-computed signature flag; TypeScript and the
checker-usage ratchet pass (83539). Clean core/application artifact rebuilding,
actual awaited application evaluation, compiler-free replay, the complete
upstream harness, and performance remeasurement remain outstanding.

### Clean stamped artifact and actual application-evaluation failure

Adapter checkpoint e075f68f8ddda05737031325c3b7e0c3c49a879a is signed and
committed. Clean detached build inputs are under
/private/tmp/deno-owner-release-build.tyjx9A, with compiler 694a8a51df and
unchanged Deno pin 1d4e6c1cb8. Raw AOT core generation 93851 passes with
18 native imports and no interpreter provider. Raw bytes: 2,770,538;
SHA-256 ccba4931c9aec828f2437929cb83e2964d85b796715cbf1a1b76eff97d3809c9.
Wasmtime precompile 82085 passes 1/1 in 285.87s. Precompiled bytes: 52,016,768;
SHA-256 e04081dd01a7a7a9358eb73b3f68e77e2aa271ae494c918b3f4616ee8f444dc2.
The attestation binds both hashes, Wasmtime 47.0.3 and macOS aarch64.

The adapter native core-routing test now evaluates an additional application
importing core, primordials and internals, asserts fulfilled evaluation, and
checks an exported ArrayPrototypeReduce result of 6. Run 59079 fails 0/1 with
Error: core missing during application __module_init. This is the same real
failure previously hidden by the upstream dropped evaluation future. The
application graph was built from the current working tree, not a clean pinned
compiler revision, and its source/byte binding is in module-graphs beneath the
build root. Do not claim compiler-free application integration from this run.

Temporary owner probe 18101 confirms the linked core global is owned (i32 1),
but application initialization still fails. The diagnostic probe was removed.
The compiler-level linked test now checks bindings at application top level,
uses entry-before-dependency manifest order and the adapter's direct-return
Reflect.get helper spelling; these strengthened checks pass 3/3 (54031), and
TypeScript passes. Thus manifest insertion order alone is not sufficient to
reproduce the native-core failure. Next inspect the actual core getter and
returned bootstrap value across the native linked boundary.

The compiler-free adapter binary passes 29/29 ordinary checks, with six ignored
and the failing core-routing/application test explicitly excluded. These do
not establish boot or application evaluation. The stronger native test remains
uncommitted and deliberately failing; do not weaken it. General classic Script
execution, full upstream conformance and performance remain open.

### Imported typeof alias fix and compiler-free application replay

Native getter probes 93493 and 9809 show that the owner getter returns real
objects for __bootstrap, core, internals and primordials. The failure was a
separate compiler defect: typeof importAlias was classified as undeclared
because TypeScript import-alias symbols have no valueDeclaration. Checking
core === undefined in the previous compiler test did not cover this spelling.
Changing it to typeof core === "undefined" reproduced the failure (53815).

Both materialized and comparison typeof paths now recognize runtime named,
default and namespace import declarations through the existing oracle.
Erased type-only imports remain unresolvable. New gc/standalone controls cover
renamed, default, namespace, undefined-valued, type-only and live-changing
imports plus genuinely undeclared names. Initial focused checks pass 5/5;
the broader typeof/import/provenance run passes 31/31 (90482). Removing three
unreferenced primordial-alias analysis helpers left by the main merge passes
24/24 Deno primordial/destructuring/import checks (48114). TypeScript passes.

Native build-time application packaging 60158 passes 1/1. Compiler-free binary
js2wasm_spike-a7f0ba6d34fa178f replays the source-bound application graph with
all compiler environment variables removed: 30/30, six ignored, no filtered
tests (59793). The additional application checks fulfilled evaluation and a
real imported ArrayPrototypeReduce result of 6. This is bounded adapter
verification, not the full upstream Deno harness or general Script support.
The application artifact used working-tree compiler changes, so a clean
release pin must still replace that development packaging checkpoint.

Adapter regression and replay notes are signed commit e8dfeb6. Temporary
native diagnostics were removed. After deleting the unused helpers, the
dead-export gate exits 0 under its existing preservation-only contract (3543).
Its dynamic-import targets remain unknown and strict modeled closure is not
certified; no audit baseline or verifier behavior was weakened.

### Unchanged WebIDL and live iterator checkpoint

Adapter checkpoint `da95a7f` shares NumberValue/IntegerValue ToNumber and lazily
adopts native arrays on intrinsic iterator lookup into the supplied context's
compiled realm. The clean `cc835a68c8c02255569b72271dd2527e076351c6` core and
application artifacts in `/private/tmp/deno-import-release-build.AWkP87` run
without a runtime compiler. Unchanged Deno WebIDL tests pass 13/17: integers,
sequence and constrained_sequence_one_of flipped from failure to pass. The
four remaining tests stop at unknown-classic-script refusal. No Deno tests
or sources were changed.

A stronger adapter regression finds stale iteration after indexed mutation:
the adopted array's GetIndex observes 3, while an existing iterator yields the
old 2. The assertion remains runnable and failing; the current bounded target
is 30 passing, one failing and six ignored, not green. Existing compiler
iterator normalization includes snapshot-copy carrier paths, but the exact
path still needs a compiler-level reproduction before changing it. Preserve
the actual receiver and read live elements on each step, rebuild clean AOT
artifacts, then rerun these controls. The adapter PR is explicitly unready.

The wider baseline population contains 431 tests. Its pre-fix Nextest sweep
has 211 passing, 216 failing, two ignored and two lazy TCP tests still running
after sandbox network denial. This is not a completed full-suite result.
All six TCP cases pass with networking permitted. No test processes were
stopped. General Script execution, application packaging, missing snapshot
and inspector APIs, and full integration verification remain open.

### Live receiver compiler repair

The direct standalone compiler control initially passes mixed arrays and fails
numeric arrays (iterator yields old 2 after indexed Get observes replacement 3).
Receiver-backed VEC records now retain the actual receiver in field 3, read
current length and indexed values through existing runtime readers, advance
before indexed Get, and latch exhaustion. Rest draining uses the same next
path instead of copying the old normalization. When those readers are present,
family construction no longer allocates the element snapshot. Canonical VEC
records and argument-object logical-length behavior retain their existing path.

Six direct controls cover mixed/numeric receivers, empty-array construction,
growth, exhaustion and remaining elements. The combined iterator suite passes
79/79 (five files). An earlier run lacked the exnref flag in Vitest's fork and
hit its default 512 MiB heap; that run is not regression evidence. The verified
run passes the flag through fork execArgv and uses a 4096 MiB heap. Native
adapter replay still requires rebuilding clean core artifacts with this repair;
the old artifact's stale-iteration failure has not yet been credited as fixed.
The additional five-file iterator, destructuring, multi-source and bootstrap
control set passes 39/39, bringing focused checks to 118/118. TypeScript 7
passes. No user changes were staged.

The first clean native rebuild at compiler `10588f480b59bb19ae72a8d6bdedf641a4301915`
still fails the adapter live-mutation assertion. This proves the direct family
fix alone is insufficient. A separate first-class `Array.prototype.values.call`
control reproduces the same stale 2; its reflective factory has an independent
snapshot implementation in `array-proto-iterator-value.ts`. The values factory
now constructs the same receiver-backed record without reading length or
copying elements at creation. Keys and entries still require live factory
support and remain explicitly in scope, not credited as complete.

The seven direct controls now pass 7/7. The broader cross-bucket file passes
11/12 both on baseline `10588f480b59bb19ae72a8d6bdedf641a4301915` and the
reflective candidate. Its species-constructor assertion pins an old incorrect
answer of 1, while both revisions produce the spec answer 11; the test was not
changed. TypeScript 7 passes. The native failed build is preserved at
`/private/tmp/deno-live-iterator-build.Z5JeM5`: raw core 2,781,038 bytes, SHA-256
`e843ba62db23c4b7f028d6298c492c14428837e9b8f5fd52b614c01c1758ac3e`,
precompiled core 52,180,664 bytes, SHA-256
`b6dea9d5b4eeb4dc7dcb48154d332b54658ff4780529138e1985f54162e10702`.
Precompilation passes 1/1 in 303.68 seconds; adapter replay fails at the same
live-mutation assertion. A second clean build is required with the reflective
factory repair before claiming native success. No graph package was produced
by the first replay, since it failed before module evaluation.

### Verified native replay and standalone realm contract

The second clean artifact at compiler `b37d12382a9a2632130c8b9b2088a1f14470a0fa`
precompiles successfully (1/1, 279.04 seconds). Native core is 52,164,280 bytes,
SHA-256 `44fd2f70daf0d403c015555df771f394ba2f449cf1a4692cb2ede625df9fcb5d`,
under `/private/tmp/deno-reflective-iterator-build.zaaiw7`. The development
packaging route passes 1/1 in 28.30 seconds. With compiler configuration absent,
the adapter binary passes 31/31 runnable tests, six ignored, in 1.98 seconds.
This includes the retained live-mutation assertion and core-import application.
It does not prove full Deno conformance or general Script execution.

The compiler PR smoke failure was a capability mismatch: the sidecar always
imported the shared context exception tag, but the CLI supplied no provider.
Explicit `--realm isolated` now owns its realm/tag and executes initialization;
the default shared mode preserves v8x imports, exception identity and deferred
initialization. Smoke checks pass 4/4 with Wasmtime available, including a
deliberately incorrect expected result that must fail at runtime. Missing CLI
availability is reported as skipped instead of silently credited as passing.

### Persistent Script boundary reproduced

Unchanged WebIDL replay against the second clean native artifact remains
13/17; four failures stop at unknown classic Script refusal. Direct compiler
probes at `83442252a6d` distinguish property transport from binding persistence:
explicit globalThis writes are visible in the owning realm, while Script var
initialization/assignment is not. Lexical declarations are also unavailable
to later independent Scripts. The regression file has one positive control
and two explicitly expected failures, which are not conformance credit.

The implementation contract and reader/writer inventory are recorded in
`plan/agent-context/4376-persistent-script-environment-2026-09-30.md`.
Canonical Context-owned bindings, declaration validation before effects,
genuine completion and source-bound AOT packaging are required together.
Mirroring private globals only at script exit, function wrappers and indirect
eval do not preserve the required persistent Script semantics.

### 2026-10-01 Context-owned dynamic var prototype

Experimental `standaloneScriptVarBindings` now routes exact dynamic Script
var storage through native getter/setter helpers using the owning realm's
actual object record. All emitted global accesses are rewritten before DCE,
including callback and IR bodies. Both private undefined-seeding paths decline
so initializer-free redeclaration preserves the existing value. Private dead
top-level elision also declines because later Scripts can observe the binding.
GlobalDef identity is retained until late string-global shifts have settled.

Focused verification across four files is 26 ordinary checks passing and two
expected failures retained. Positive checks include escaping callback reads,
cross-Script number/string changes, abrupt completion and separate contexts.
Additional controls preserve repeated global accessor reads and original
foreign getter exception identity. An untouched JS var without annotations
also works when its carrier is dynamic. Multi-source/project graph rejection
is enforced at the common pipeline boundary, not only the sidecar adapter.
TypeScript 7 and ratchet command exits pass; dead-export output still refuses
to certify unrelated complete runtime retirement due to open dynamic imports.
This does not enable the route in native Deno packaging or establish general
Script execution. Private typed slots and flattened module graphs are refused;
lexical cells, type-proof invalidation, declaration validation and genuine
completion remain required. No interpreter was added.

### 2026-10-01 Reflective keys and entries remain live

At merge commit `ec1375e79d8`, 4/13 native-array controls fail: reflective
keys misses growth, entries returns stale elements, indexed getters run at
factory creation, and draining returns stale entries. Nine controls pass,
including the existing live values route. These are compiler standalone
executions with zero host imports, not JS-host emulation.

All three first-class factories now retain their receiver without reading
length or copying elements at creation. Distinct keys/entries record kinds
reuse the live next cursor: keys boxes the index without indexed Get, entries
reads the current value and constructs a fresh pair. Cursor advance precedes
indexed Get, so an exception consumes that index. Exhaustion stays latched;
rest draining and prototype dispatch recognize both new kinds. No interpreter
or Deno source changes are involved.

The candidate passes 20/20 direct controls, including deferred length reads,
throwing getters, shrink/growth, fresh pair identity, draining and prototype
identity. The eight-file regression run reports 73/73: 71 ordinary successes
and two retained expected failures for general Script bindings. This does not
credit a new native Deno artifact or full deno_core conformance. Persistent
lexical cells, declaration preflight and completion values remain required.

## 2026-10-04 opt-in native lexical checkpoint

Follow-up fixes the first wide reference initializer by registering the native
union carriers before constant materialization. The native owner/Script probe
changes from baseline `b17fdc53504` (`exact: 0, zero: 1`) to candidate
(`exact: 1, zero: 0`). Focused tests now report 39 ordinary passes and the two
existing expected failures (41/41 reported). Positive, negative, signed-boundary
and folded initializers retain exact values across independently compiled Scripts.
The broader BigInt run has a separate `narrowedString` failure reproduced with
the exact fixture and positive controls on baseline and candidate. Wide updates
still deliberately throw; exact arithmetic is unfinished. See the handoff for
the full provenance, limitations and native Deno resume order.

Read-modify-write checkpoint now captures the Context Reference for compound,
logical and prefix/postfix updates. Focused tests report 35/36: 33 ordinary
passes, two existing expected failures and one ordinary wide-BigInt initializer
failure. The five-file run is 114/118, including the same two expected failures
and three previously recorded baseline failures. A native owner/Script probe
on published `b17fdc53504` and the candidate returns `exact: 0, zero: 1` on both
for the wide literal before updates. Keep this failure visible. Narrow BigInt
updates pass; wide carriers and overflow currently throw instead of silently
wrapping. Exact wide arithmetic remains required, not excluded from scope.
TypeScript 7 and budget/coercion/oracle checks pass; dead-export does not certify
runtime retirement. Draft PR #6468 and the persistent Script handoff capture
this compiler checkpoint. Native Deno packaging and full conformance remain open.

Current continuation adds compound/update controls and plans one captured
Context Reference for read-modify-write operations. Reads must precede RHS
effects, TDZ/missing-name reads must throw before them, and prefix/postfix
results and const writes must match JavaScript semantics. General native Deno
packaging is still part of this issue, not replaced by these compiler controls.

Follow-up work: merge the newer integration branch/main history and implement
later-Script lexical assignment. Before implementation, both new strict and
sloppy write controls fail with the cell retaining 41 instead of 42, while the
previous 20 tests retain their outcomes. The native assignment route must resolve
the reference before the RHS, evaluate that RHS once and preserve global-record
miss behavior. Provider packaging and full native Deno verification remain open.

Implemented simple `=` writes, plus the unresolved-read and top-level collection
seams required to observe them correctly. Focused controls report 22 ordinary
passes and two expected failures; the five-file regression run reports 103/106
successes, with the same three pre-existing failures documented in the handoff.
The merged main history is retained. Compound/increment/destructuring writes,
eval activation precedence and native Deno packaging remain follow-up work.

An experimental `standaloneScriptLexicalImport` now links Scripts to native
Context-owned lexical cells, independently of globalThis properties. Whole
declaration manifests are checked before cells are created or user code runs.
Own lexical reads/writes/initialization use exact declaration storage;
initialization metadata survives IR lowering. Later independently compiled
Scripts can read symbol-less identifiers from the same Context record.

The focused file reports 20/20 tests: 18 ordinary successes plus two retained
expected failures for the default API. TypeScript 7 passes. This is a bounded
compiler checkpoint, not fresh native Deno conformance evidence. The provider
is not yet wired into the adapter/artifact builder. Later-Script writes,
classes/destructuring, typed lexical storage, ambient shadows, function
descriptor rules, re-execution and completion values remain required.
See the updated persistent Script environment handoff for the operation ABI,
verification limitations and resume order. The full integration stays open.
