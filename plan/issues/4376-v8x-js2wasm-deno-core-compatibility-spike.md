---
id: 4376
title: "Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime"
status: in-progress
created: 2026-08-12
updated: 2026-10-06
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
  - src/codegen/closures/ordinary-new-target.ts
  - src/codegen/closures/rest-only-apply.ts
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
  # 2026-10-06: retained PR6341 implementation, main composition and finite proof successors.
  - plan/log/ir6341-main-composition-20261006.md
  - scripts/compiler-boundaries.json
  - src/backend/wasmgc/resources/native-promises.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/array-proto-iterator-value.ts
  - src/codegen/async-frame.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/async-value-sink-unwrap.ts
  - src/codegen/builtin-ctor-value-invoke.ts
  - src/codegen/class-bodies.ts
  - src/codegen/closed-struct-extern-set.ts
  - src/codegen/closures.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/closures/promoted-capture-value.ts
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/module-var-undefined-seed.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/function-body.ts
  - src/codegen/iterator-native.ts
  - src/codegen/mixed-return-widening.ts
  - src/codegen/native-construct.ts
  - src/codegen/object-builtin-effects.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime.ts
  - src/codegen/promise-combinator-drive.ts
  - src/codegen/promise-combinators.ts
  - src/codegen/promise-executor.ts
  - src/codegen/promise-finally-invoke.ts
  - src/codegen/promise-species-then.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access-exact-shapes.ts
  - src/codegen/property-access.ts
  - src/codegen/registry/physical-imports.ts
  - src/codegen/string-element-read.ts
  - src/codegen/typeof-delete.ts
  - src/compiler.ts
  - src/index.ts
  - src/ir/backend/lower-contracts.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/runtime/wasmgc/async/microtask-queue-bodies.ts
  - src/runtime/wasmgc/async/native-await.ts
  - src/runtime/wasmgc/promise/combinator-bodies.ts
  - src/runtime/wasmgc/promise/delay-bodies.ts
  - src/runtime/wasmgc/promise/reaction-order-bodies.ts
  - src/runtime/wasmgc/promise/rejection-event-bodies.ts
  - src/runtime/wasmgc/promise/resolution-bodies.ts
  - src/runtime/wasmgc/promise/resolving-pair-bodies.ts
  - src/runtime/wasmgc/promise/settlement-bodies.ts
  - src/wasm/physical/allocation-owner.ts
  - tests/helpers/ir-c1-authority-root.ts
  - tests/helpers/ir-c1-authority.json
  - tests/helpers/ir-deno-callback-inventory-successor.json
  - tests/helpers/ir-deno-callback-inventory-successor.ts
  - tests/helpers/promise-resolution-receipts.ts
  - tests/issue-3518-c1-current-source.test.ts
  - tests/issue-3518-canonical-3c6-inventory-successor.test.ts
  - tests/issue-3518-canonical-489d-inventory-successor.test.ts
  - tests/issue-3518-current-main-inventory-successor.test.ts
  - tests/issue-3518-lowering-analysis-preservation.test.ts
  - tests/issue-3518-nested-stackification-policy-evolution.test.ts
  - tests/issue-3518-number-prerequisite-policy-evolution.test.ts
  - tests/issue-3518-program-data-contract-boundary.test.ts
  - tests/issue-3518-program-validator-policy-evolution.test.ts
  - tests/issue-3518-promise-resolution-preservation.test.ts
  - tests/issue-3518-promise-settlement-body-ownership.test.ts
  - tests/issue-3518-runtime-data-contract-seam.test.ts
  - tests/issue-3518-runtime-program-policy-evolution.test.ts
  - tests/issue-3518-semantic-provider-boundary.test.ts
  - tests/issue-3518-validation-policy-evolution.test.ts
  - tests/issue-3518-wasmgc-helper-policy-evolution.test.ts
  - tests/issue-3518-well-known-symbol-policy-evolution.test.ts
  - tests/issue-3525-arraybuffer-isview-main-policy.test.ts
  - tests/issue-3525-main-inventory-source-successor.test.ts
  - tests/issue-3525-presentation-classification-policy.test.ts
  - tests/issue-4376-deno-callback-inventory-successor.test.ts
  - tests/issue-4376-ir-await-rejection-events.test.ts
  - tests/issue-4376-promoted-capture-value.test.ts
  - tests/issue-4376-super-method-abrupt-completion.test.ts
  - src/codegen/array/array-fill-proto-value.ts
  - src/codegen/array/live-array-iterator-value.ts
  - src/codegen/closures/ordinary-new-target.ts
  - src/codegen/closures/rest-only-apply.ts
  - src/codegen/declarations/shared-script-var-access.ts
  - src/codegen/expressions/builtin-native-dyn-construct.ts
  - src/codegen/object-model/closed-carrier-prototype-status.ts
  - src/codegen/object-model/closed-object-prototype-edges.ts
  - src/codegen/object-model/linked-realm-property-read.ts
  - src/codegen/registry/microtask-drain-boundary.ts
  - src/codegen/registry/microtask-notification.ts
  - src/codegen/registry/promise-handler-boundary.ts
  - src/codegen/registry/promise-rejection-dispatch.ts
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


## PR6341 actual-main composition plan — frozen 2026-10-06

This is a preservation refresh of existing PR6341, not a new Deno implementation or source-map migration. Root owns claim `4376:6341-main-composition-20261006`, the merge, publication and existing protected queue. The Deno owner explicitly released preservation-sensitive conflict review and the nine named integration files; the primary dirty lexical checkpoint and downstream draft6468 remain untouched. Handoff evidence is `.tmp/ir-coordination/deno-source-map-release-20261006.md` in the separate unmapped-emission worktree.

The isolated composition worktree is `worktrees/codex-6341-main-composition-20261006`, branch `codex/6341-main-composition-20261006`. Stage2/ours is the actual PR head `60f99e83450ea7eac7d6fe21a5ec2d4436cce6c5`; stage3/theirs is actual main merge input `abb3471c46bb9e7129b28812fe16313c857cda69`. The GitHub cached baseRefOid `1a160821…` is not the current main input and must not be used to reconstruct this integration. Root has already performed a three-way no-commit merge. Only three source files have unmerged stages; the many other staged main changes are not this worker's edits and must not be reverted or reimplemented.

The measured unmerged blob identities are:

| File | stage1 common ancestor | stage2 PR | stage3 actual main |
| --- | --- | --- | --- |
| src/codegen/class-bodies.ts | 02835b0fd474b75099c5707c1492588788c34618 | e9ffa45866aefa1be14be7ab143225e9ce7b3413 | c2a87c3e70289890e60e2812a6f7a22130472231 |
| src/codegen/expressions.ts | bc1d31eef4980cbdea092784176603a45241bcf8 | 27829617101c78504a06a468d6fb1db7c82cc8b2 | 91f0f1b25c0fcd463d55183f2c8990e3894e435a |
| src/compiler.ts | 4739028d9cc79afc9041d91b612049d9056d9838 | fa6b7b43639423acb14f731ecc012c8deae15bbf | d8ba85463e1708842063109dcc4da4cb8e0bdb41 |

### Implementation scope and conflict resolutions

Source worker owns only resolution of these three files and preservation verification of the already merged dependent code. Root owns the issue/claim authority, tests scope expansion, Git index, commit/push and PR. Do not use whole-file ours/theirs checkout, reformat unrelated declarations, update expected answers, amend baseline files or move the shared lowerer contracts. Additional source changes require a concrete composition defect and a root scope grant.

**1. `src/codegen/class-bodies.ts`, `collectClassDeclaration`, current conflict around1100.** Keep main's helper-based branch:

```ts
if (isRuntimeCollectionStructHeritage(ctx, parentStructTypeIdx, parentClassName)) {
  parentStructTypeIdx = undefined;
}
parentFields = parentStructTypeIdx === undefined ? [] : (ctx.structFields.get(parentClassName) ?? []);
```

The PR added a native collection/name/mapTypeIdx test to prevent a prewarmed runtime `$Map` carrier becoming a user-class nominal parent. Main's `src/codegen/classes/standalone-collection-carrier.ts:69` now owns that same check with actual type identity, an explicit defined-index guard and `!ctx.classSet.has(parentClassName)`. It preserves real compiled classes and is not limited to the old builtin-spelling/nativeStrings predicate. Keeping both old and new predicates would unnecessarily reintroduce the older classification. Main additionally prevents inheriting runtime carrier fields after clearing the parent index; retain that correction.

Preserve the surrounding alias resolution, circular-inheritance guard, `classParentMap` registration, unresolved-heritage tracking and `prepareCollectionSubclassHeritage` carrier/refusal logic. Relevant writers are structMap/structFields/classSet publication and collection carrier registration. Local consumers use parentFields to suppress duplicate own fields, compose final fields and tag offsets, and parentStructTypeIdx to set the actual Wasm supertype. The subtype must retain an exact mutable-field prefix; clearing only the index while copying stale parentFields is not equivalent. No change to classParentMap identity or collection allocation/dispatch is needed.

**2. `src/codegen/expressions.ts`, `compileExpressionInner` new.target arm, current conflict around1682.** Retain the PR's captured ordinary target first, then main's standalone object-value fallback:

```ts
const ordinaryTarget = fctx.localMap.get(ORDINARY_NEW_TARGET);
if (ordinaryTarget !== undefined) {
  fctx.body.push({ op: "local.get", index: ordinaryTarget });
  return { kind: "externref" };
}
if (ctx.standalone) return compileNewTargetValue(ctx, fctx);
```

Leave the subsequent existing non-standalone constructor/class-ID/undefined behavior intact. A local index0 is valid: the condition must remain `!== undefined`, not a truthy test. Preserve both imports. Do not move the standalone fallback above the ordinary binding, remove the ordinary branch or replace a target with a truthiness/class-ID approximation.

The two paths own distinct real data. PR's `ordinary-new-target.ts` creates/looks up the pending construction-target global by name to survive late global-index shifts; `ordinaryConstructTargetFrame` publishes the actual dynamic callable and restores prior state after success or thrown completion. `initializeOrdinaryNewTarget` consumes/resets it before parameter defaults in `function-body.ts:485` and non-arrow lifted bodies in `closures.ts:2878`. Closure construction adds `ORDINARY_NEW_TARGET` to captures for actual lexical-arrow reads (`closures.ts:3730`). Main's `expressions/new-target-value.ts` handles class constructor objects, synthesized fnctor constructor `newTargetValueNode`, and `NEW_TARGET_LEXICAL_LOCAL`; `new-super.ts:2801` supplies the synthesized constructor identity. Main's `snapshotArrowNewTarget`, `closures/arrow-phases.ts` capture planning and `newTargetSnapshotLocal` are already auto-merged and remain intact.

Do not combine those private bindings, change snapshot timing or rework their producers during conflict resolution. In a dynamic ordinary callback, its captured actual target is authoritative even though main can also allocate a lexical snapshot; in a class/synthesized constructor lacking that ordinary binding, main's object-valued path must still execute. Run both families' native value tests: merely validating a Wasm module cannot distinguish the two source semantics.

**3. `src/compiler.ts`, conflict around978, retain main's extracted pipeline.** Take the `PipelineOutputContext` declaration from stage3 at this location. Remove the obsolete stage2 `isWasmException`/runPipeline documentation/function opener from the conflict: the auto-merged file already contains the actual `isWasmException` around1090 and complete `runPipeline` around1110. Retaining the old opener would nest/misstructure main's extracted validator and duplicate functions.

Transplant the PR's exact public rejection into the retained `runPipeline`, immediately after destructuring input and before target-profile resolution or generation:

```ts
if (options.standaloneScriptVarBindings && multiAst) {
  throw new Error(
    "standaloneScriptVarBindings requires independent single-source Scripts, not a flattened module graph",
  );
}
```

Preserve the thrown error and text; do not silently return a compile diagnostic, disable Script binding transport or reject ordinary multi-source builds. Existing buildCodegenOptions restrictions around850 remain separate and unchanged. The private prepared presentation entry is new on main and has its own preparation/eligibility guards; do not add new eligibility, route changes or a Script feature there as part of this public conflict transplant. If a genuine private prepared fixture using these Deno-only options exposes an admission defect, retain the failure and have root assign that separate integration scope rather than relaxing guards.

Retain main's `validatePipelineSource`, public `runPipeline`→`finalizePipelineModule`, private `runPreparedIrPipelinePresentation`, source diagnostic handling and presentation finalization contract. Its early-error/safe/hardened passes must still gate on their **new** diagnostics rather than all preexisting TypeScript errors. Public compilation keeps its ordinary route and the private Prepared source-map guard stays unchanged. One final `isWasmException` implementation must remain, and both generation and emission catches must rethrow original WebAssembly exception identities.

The PR's allocation-owner injection has already auto-merged into `finalizePipelineModule` around1356. Keep `stampAllocationOwners(mod, options.standaloneAllocationOwnerExport)` after optional C-ABI transformation and **before** `widenNonDefaultableTypes(mod)` and main's `completePreparedPresentationFinalization(token)`. Preserve its source-anchored `Allocation provenance:` diagnostic/failure return and telemetry. Do not move stamping after binary emission, stamp a copied module, or call it twice. Main's completion receipt must continue to observe all preceding finalization work; any genuine prepared-ownership refusal remains meaningful, not a reason to loosen its validator.

### Preservation census beyond the three textual conflicts

These files auto-merged and are review/test operands, not additional edits by default:

- `src/ir/backend/lower-contracts.ts` retains optional `resolvePromiseRejectionDispatcher`; `src/ir/integration.ts:8157` supplies `promiseRejectionDispatcher(ctx)`. Keep all current-main IR source-origin, prepared program and backend legality changes around them.
- `src/ir/backend/wasmgc-emitter.ts:354` constructs five-field native Promise records; `async-scheduler.ts:438` is the canonical layout owner: state0, value1, callbacks2, bag3, handled4. Constructors must initialize bag and handled appropriately; allocation/read/mutation sites must keep slot4 as persistent handling state. The stale four-field explanatory comment in integration is not evidence of a four-field ABI; use the actual layout and native tests.
- `src/ir/lower-generic.ts:3439` async.throw emits the rejection dispatcher event when provided; await handling around3516 retains handled notification, carrier/exception identity and no-dispatcher behavior. Do not replace optional-dispatcher semantics with an unconditional helper import.
- `async-scheduler.ts` settlement/executor/thenable resource registration has deliberate helper ordering and recursion controls; preserve registration before lookup and current runtime/body ownership separation. Preserve `async-frame.ts` generated Promise ownership and microtask scheduling, the compiler/context options, and all callback construction/receiver/exception/rest-vector producers.
- `src/wasm/physical/allocation-owner.ts` and its finalizer call preserve actual allocation owners after layout changes. Do not delete instrumentation to obtain clean bytes or bypass native guards. The source-map projector and emitter tasks are in other worktrees and are not part of this merge.

Main's ES2015 class heritage/field carriers, `new.target` object values, pipeline presentation/ABI receipts, declaration/type preservation and current runtime-owner changes must all remain. Inspect the final three-file diff against **both** stage2 and stage3, not only against one parent. The root's actual merge commit will supply main ancestry; no independent fetch, GitHub poll or new PR is necessary.

### Decisive native tests and gates before publication

Run the exact eleven released regression files, retaining their original assertions and reporting each file's numerator/denominator:

```
tests/issue-4376-callback-new-target.test.ts
tests/issue-4376-ir-await-rejection-events.test.ts
tests/issue-4376-compiled-rejection-events.test.ts
tests/issue-4376-promise-handler-state.test.ts
tests/issue-4376-pending-reaction-order.test.ts
tests/issue-4376-single-microtask-drain.test.ts
tests/issue-4376-allocation-owner.test.ts
tests/issue-3518-native-promise-resources.test.ts
tests/issue-3518-promise-resolution-preservation.test.ts
tests/issue-3518-promise-settlement-body-ownership.test.ts
tests/issue-3518-promise-settlement-source-preservation.test.ts
```

The callback file has decisive dynamic constructor identity, escaping lexical arrow, ordinary nested-call clearing, throw restoration, parameter-default timing, runtime-sized constructor argv, rest/non-rest order and receiver/throw identity controls. The IR await test explicitly crosses await/async.throw with dispatcher enabled/disabled; keep all four cells. The Promise ownership/source tests distinguish real preservation from broad structural acceptance.

Add the existing directly intersecting native controls to the scoped run:

- `tests/issue-4376-prewarmed-collection-subclass.test.ts` and `tests/issue-6754-standalone-map-subclass-fields.test.ts`: first-use versus prewarmed Map type, field carrier/layout, clean unsupported-shape refusals and host-lane behavior.
- `tests/issue-6774-expressions-residue.test.ts` and `tests/issue-6774-r2-expressions-residue.test.ts`: preserve main's function/class/arrow new.target value tests, including a_fn_value, a_cls_chain_value and a_arrow_iife_and_closure. Do not drop non-conflict cells within these small files to disguise an integration regression.
- `tests/issue-6772-class-residue.test.ts`: surrounding derived-constructor/heritage behavior remains meaningful after the parent-layout resolution.
- `tests/issue-4376-persistent-script-environment.test.ts`, `tests/issue-4376-shared-exception-tag.test.ts`, `tests/issue-1927.test.ts`: preserve flattened-module rejection, source-independent Script storage, exact exception identity and existing pipeline diagnostic behavior. Retain any already-declared expected failures and report them separately from native success.
- `tests/issue-3525-prepared-pipeline-presentation.test.ts`, `tests/issue-3525-prepared-mixed-presentation.test.ts`, `tests/issue-3525-prepared-pipeline-boolean-presentation.test.ts`, `tests/issue-3525-prepared-wit-presentation.test.ts`: preserve main's split generation/finalization, source-free/private admission and receipt behavior. No Prepared guard relaxation for these tests.

Use explicit `/Users/thomas/.nvm/versions/node/v25.9.0/bin` PATH and actual native Wasm. The repository Vitest config overwrites fork execArgv, so if the engine requires `--experimental-wasm-exnref`, pass it to the **fork** together with the measured heap budget (the issue's earlier successful native runs used4096MiB); a flag supplied only to the launcher is not sufficient proof. Root/test runner selects the existing supported Vitest CLI execArgv override or a temporary ignored runner configuration; do not edit shared test configuration. Preserve the actual command, runtime version, parent revisions, logs and row denominators. If a case fails, compare its original PR/main inputs using the same runtime/harness before attributing it; no baseline refresh, skipped row or test expectation change is authorized.

Before root marks the existing PR ready for its protected queue: no conflict markers, exactly one public runPipeline/isWasmException declaration, resolved import/type check and formatting/lint; standard required hook gates, import cycles, line/function budgets, compiler boundary inventory, host-import/IR-preservation and core/dead-export controls appropriate to actual changed inputs; production `pnpm run build`; the native suites above with genuine exported values and actual import objects; and final diff review showing every preservation invariant survives. Metadata/authority conflicts discovered by actual gates belong to root as measured finite successors, not a speculative broad reseal in this source resolution.

This refresh does not publish a new Deno artifact, run the full431-test deno_core population, make general Script execution complete, retire old compiler paths or close the public source-map gaps. Root owns existing PR6341 update/queue actions and must preserve the released owner's dirty primary and draft6468.


### Regression provenance correction at specification freeze

The independent test audit initially flagged that the current eleven regression files equal the PR60f99 bytes and four issue3518 files differ from main. Root then verified the decisive three-way fact: for **all four existing3518 files, merge-base1a160821→actual-mainabb347 has no diff**. Thus their current PR changes are intentional branch changes, not conflict-free loss of newly added main tests. The seven named4376 regression files are absent from main and are PR additions. Do not automatically edit any of those eleven tests or duplicate historical suites because file lengths differ.

Root reports the Promise-resolution test retains all original titles plus a layout negative; source-preservation retains titles; native-resource count/title changes25/26→26/27 reflect the intended resolving pair. Independent review of the deliberate Deno body-ownership assertion/helper delta remains required before interpreting its green run as preservation. Check the actual before/after guard bodies and helper/receipt operand stage, not title/count equality alone. Preserve that audit and its eventual conclusion at `.tmp/pr6341-independent/audit.json` and snapshots. A detected weakening requires a concrete owner-scoped repair, not a blanket four-test transplant. This remaining test audit does not block implementing the three source conflict resolutions above; final publication still requires its closure and the actual native results.


## PR6341 measured inventory prerequisite — 18 rows and one type-only repair

### Evidence and scope

The retained inventory report is `.tmp/pr6341-integration/boundaries-inventory-original.log` (10,731,173 bytes including its diagnostic trailer). Its actual JSON counts are **1,855 tracked/discovered modules**, 1,837 policy rows, 18 unclassified modules, and two declared/excluded nonmodules. A separate git-ls-files count1,861 is not this checker's module denominator. The original report also contains4 unclean-active-layer errors,31 unclassified-target errors,10 parse errors from unresolved merge markers, and27 forbidden-transitive-path errors. Preserve all those rows; do not describe the baseline as only18 failures. Source conflict resolution and the classifications address different causes, and the final real gate must show their complete result.

The policy source is still the exact 4b442f64 epoch (588,351 bytes; SHA256 `4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05`; 1,837 files). Root identifies the same missing inventory in the earlier PR quality failure36985438337. This is a bounded registration prerequisite for existing PR6341. It does not change layer rules, roots, eligibility, tests' expected semantics or public source-map/private Prepared guards.

Source worker initially owns the three conflicts. Root has now **explicitly granted the fourth file `src/wasm/physical/allocation-owner.ts` solely for the type-only repair below**. Architect writes no source. Root separately grants metadata/proof/test ownership; no worker may silently expand from18 rows to unrelated module migrations or overwrite peers' policies.

### Exact classifications

For the following14 codegen paths, add one row per table entry with this exact shape:

```json
{"path":"<path>","state":"unmigrated","layer":"mixed-needs-split","destination":"<destination>","owner":"3518-coordinator","nextBoundary":"<nextBoundary>"}
```

| path | destination | nextBoundary |
| --- | --- | --- |
| src/codegen/array-fill-proto-value.ts | backend-wasmgc | Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction. |
| src/codegen/builtin-native-dyn-construct.ts | backend-wasmgc | Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies. |
| src/codegen/closed-carrier-prototype-status.ts | native-runtime | Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import. |
| src/codegen/closed-object-prototype-edges.ts | backend-wasmgc | Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies. |
| src/codegen/closures/promoted-capture-value.ts | backend-wasmgc | Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions. |
| src/codegen/linked-realm-property-read.ts | backend-wasmgc | Separate linked-realm late-import reservation and context-owned function filling from its native read body. |
| src/codegen/live-array-iterator-value.ts | backend-wasmgc | Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body. |
| src/codegen/microtask-drain-boundary.ts | backend-wasmgc | Separate scheduler-context and physical export registration from the canonical native microtask drain body. |
| src/codegen/microtask-notification.ts | backend-wasmgc | Separate context-owned late notification import and index shifting from native scheduling instructions. |
| src/codegen/ordinary-new-target.ts | backend-wasmgc | Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions. |
| src/codegen/promise-handler-boundary.ts | backend-wasmgc | Separate context-owned Promise handling boundary export and physical function registration from native handling instructions. |
| src/codegen/promise-rejection-dispatch.ts | backend-wasmgc | Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources. |
| src/codegen/rest-only-apply.ts | backend-wasmgc | Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies. |
| src/codegen/shared-script-var-access.ts | backend-wasmgc | Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources. |

These are actual codegen/context modules outside canonical active roots, not newly certified clean implementations. Even the small `closed-carrier-prototype-status` body still imports the migration-debt `ir/types` facade and is outside native-runtime roots; its precise future destination is native-runtime rather than inventing a backend context dependency it does not have. No relocation of those14 files is needed for this preservation refresh.

Add the following three rows as-is:

```json
{"path":"src/runtime/wasmgc/promise/reaction-order-bodies.ts","state":"clean","layer":"native-runtime"}
{"path":"src/runtime/wasmgc/promise/rejection-event-bodies.ts","state":"clean","layer":"native-runtime"}
{"path":"src/runtime/wasmgc/promise/resolving-pair-bodies.ts","state":"clean","layer":"native-runtime"}
```

All three are inside the existing active `src/runtime/wasmgc` root. Reaction-order and rejection-event bodies import only canonical Wasm-model types. Resolving-pair imports canonical Instr, the type-only `PromiseSettleClosureResources` from existing clean resolution-bodies, and the rejection-event body value. Existing native-runtime edges permit same-layer, wasm-model and wasm-physical dependencies. The resolution↔resolving-pair relation includes an erased reverse type edge, not a newly introduced runtime cycle. Do not suppress any actual cycle guard; verify it with the ordinary source gate.

After the authorized type-only repair, add:

```json
{"path":"src/wasm/physical/allocation-owner.ts","state":"clean","layer":"wasm-physical"}
```

The active physical root already covers this file. Preserve minModules5, native-runtime minModules99, all entries, roots, activationHistory, allowedEdges, existing files/order and nonModules. No activation record is required to register new files inside an already active directory. Insert these18 exact rows at stable measured positions alongside their corresponding populations; the raw successor receipt must record those actual positions. Final expected inventory size is1,855, not1,861. No row is removed, reclassified or silently normalized.

### Authorized canonical type dependency for allocation-owner

Metadata alone cannot make the current file clean: line2 imports `FieldDef, Instr, StructTypeDef, ValType, WasmFunction, WasmModule` from `../../ir/types.js`, whose policy row is unmigrated/mixed-needs-split. `check-compiler-boundaries.mjs:550–557` enforces type-only edges too. A clean row without a source repair would still fail; a debt row within this active root would fail unclean-active-layer. Do not add an edge exemption or misclassify the facade.

Use existing canonical owners only:

```ts
import type { Instr, ValType } from "../model/instructions.js";
import type { FieldDef, StructTypeDef, WasmFunction } from "../model/module-records.js";
import type { PhysicalModuleStorage } from "./module-reservations.js";
```

Retain the runtime import `indexPhysicalTypes` unchanged. Replace only the parameter type with:

```ts
mod: Pick<PhysicalModuleStorage, "types" | "imports" | "functions" | "globals" | "elements" | "exports">
```

This is the exact observed mutation/read surface: type-table indexing/struct fields/type additions; import counting; function bodies/locals and predicate append; global initializers/token insertion; element offsets; export descriptor shifts and predicate export. No other WasmModule field is used. `PhysicalModuleStorage` already declares all six arrays with canonical mutable element types, including an assignable exports array, and full WasmModule callers remain structurally compatible. Do not introduce a new module facade, cast, wrapper copy, optional property, readonly mutation escape, generic contract or allocation algorithm change.

Freeze before/after text and prove the function's runtime body and existing runtime imports byte-identical apart from import/type syntax. Independently transpile with the same TypeScript options and compare emitted JavaScript (exclude source-map/file-location-only metadata if produced); no runtime dependency on module-reservations may appear. Typecheck actual compiler/finalizer and direct allocation tests against the narrower parameter. Preserve all native cases in `tests/issue-4376-allocation-owner.test.ts`, especially cross-instance foreign handles, inherited fields, captured closures, native carriers, constant initializers and index/descriptor ownership. Maintain the earlier eleven-file Deno/Promise regression population. No test weakening or full-WasmModule clone is permitted.

### Finite current-policy proof and actual reader channels

Create a new test-only fixed18-row inverse component, receipt and independent test:

- `tests/helpers/ir-deno-callback-inventory-successor.ts`
- `tests/helpers/ir-deno-callback-inventory-successor.json`
- `tests/issue-4376-deno-callback-inventory-successor.test.ts`

Its public raw/semantic functions are `captureDenoCallbackInventoryPredecessorPolicySource(raw, readAuthority?)` and `captureDenoCallbackInventoryPredecessorPolicy(value, readAuthority?)`. They accept only the actual newly measured1,855-row policy and return the exact4b442f64/1,837 predecessor. Root supplies independently reviewed current pins **after** row formatting/freezing. Snapshot exact before/current raw bytes/SHA/blob, semantic whole-data/files profiles, exact18 rows/index/neighbors, UTF-8 source spans, and unchanged non-files fields. Prove raw inverse/replay, semantic remove/reinsert, and exact raw/semantic agreement. Never add current-or-old hash alternatives, change a historical receipt's current pin or silently drop unknown rows.

Preserve the existing `ir-main-inventory-source-successor.{ts,json}` eleven-row/eight-span proof from1,837→1,826. Preserve the still older `ir-runtime-program-policy-main-inventory-20261002.json` four-row epoch and all later/earlier policy algorithms, receipt pins, helper prefixes, historical artifacts and declarations. The new chain is actual1,855 → new Deno18 inverse → exact1,837 → existing eleven-row inverse → existing historical chain. The source-map projection component's separate one-row proof is not installed in this worktree by this plan.

Read-only census identifies these17 candidate actual-policy reader test files (paths all under tests): canonical-3c6-inventory-successor, canonical-489d-inventory-successor, current-main-inventory-successor, lowering-analysis-preservation, nested-stackification-policy-evolution, number-prerequisite-policy-evolution, program-data-contract-boundary, program-validator-policy-evolution, runtime-data-contract-seam, runtime-program-policy-evolution, semantic-provider-boundary, validation-policy-evolution, wasmgc-helper-policy-evolution, well-known-symbol-policy-evolution (each prefix `issue-3518-` and suffix `.test.ts`), plus `issue-3525-arraybuffer-isview-main-policy.test.ts`, `issue-3525-main-inventory-source-successor.test.ts`, `issue-3525-presentation-classification-policy.test.ts`.

This census is an implementation dependency list, not a claim of17 newly caused failures. Capture actual baseline rows; some readers already omit the existing eleven-row outer inverse and can fail on current4b442f64 before this registration. For every actually impacted initial healthy capture, apply the new Deno inverse to the actual raw/data operand before the existing eleven-row inverse, then retain the original downstream chain. If a reader already lacks that delivered eleven-row step, explicitly record the pre-existing failure and add that proof step as a measured prerequisite. Do not rename/omit original assertions or count a new early epoch failure as a later intended semantic/receipt guard.

Keep historical mutation injection **after** authenticated initial projection, using the exact historical declaration/operand bytes, and preserve paired healthy controls. Keep separate fresh-current mutation controls on raw1,855 data before the new inverse. Never wrap an entire mutating reader so a healthy authority replaces supplied corruption. The existing eleven-row helper's own independent proof receives authenticated1,837 input only for fixture initialization; keep its old eight spans/eleven rows and complete helper/receipt pins unchanged. The new independent test validates all18 real row additions, retained field/order preservation, raw/semantic reciprocity and typed/primitive failures using independently fixed expected rows/spans rather than inspecting the production receipt for expected values.

New proof controls must include healthy→corrupted→restored full policy and fresh receipt; boxed/accessor operands rejected without coercion; deleted/duplicate/renamed/reordered newly classified row; altered retained row or non-files rules; wrong current source formatting; malformed/missing authority and old1,837 source presented as current. Assert exact raw and semantic authority read counts separately; actual native inventory after registration is a required independent control. Preserve original logs/full denominators, and test the true current constructor input before any body/dependency mutation so a stale healthy prerequisite cannot falsely credit the later guard.

### Exact C1 intersections and eventual6866 composition

Of the17 candidate readers, only four are currently in C1 `currentInstruments` **and** have existing instrumentEdits recipes: `issue-3518-number-prerequisite-policy-evolution.test.ts`, `issue-3518-program-data-contract-boundary.test.ts`, `issue-3518-runtime-program-policy-evolution.test.ts`, and `issue-3518-well-known-symbol-policy-evolution.test.ts`. For each actually edited one, root replaces its measured live pin and composes its existing immutable-before→final-live recipe with exact whole-file inverse/replay. Preserve original artifacts/before pins and all non-target fields; do not append duplicate recipes or widen allowed hashes. Then update the actual manifest anchor and the independent external observation scalar under root review. No update to the historical runtime-program policy implementation is necessary merely to add the outer adapter, and unedited current instruments require no successor.

If composition imports the separately delivered6865 initial-graph/C1 correction, retain that exact peer recipe rather than resetting the manifest to an older checkpoint. Authority/source pin changes beyond the four measured reader intersections require an actual reader finding, not a blanket reseal. The18 production additions do not become new historical C1 population members merely because they now have classification rows.

Prioritize Deno6341 delivery. When the independent canonical `src/ir/program/source-map-position.ts` component later composes, its net inventory becomes1,856. Root must derive its one-row epoch from the **then delivered1,855 predecessor**, preserving all18 Deno rows, and apply that new outer inverse before this Deno inverse. If its unpublished proof was initially built on4b442f64/1,837, rebase its new proof to the measured delivered predecessor; do not shrink policy to1,838, accept both epochs at one boundary or rewrite this delivered18-row history. No projector source behavior change is implied by this policy composition.

Before existing PR6341 publication, run normal and inventory boundary gates on the final source+rows, require zero unclassified/unclean/forbidden errors and exactly1,855 actual module rows, retain the full report, run the new independent proof/affected readers plus measured C1 authority successor gates, and repeat the allocation-owner native/type/JavaScript-preservation controls. The three conflict resolutions and earlier native regressions/production build remain required. Strict retirement and public IR source-map gaps stay open. No hook or quality-baseline bypass, Deno primary/draft6468 edit, new PR, or eligibility relaxation is authorized.


## 2026-10-06 measured flat-directory and import-cycle prerequisites (architect freeze)

This amendment supersedes the preceding sentence that no relocation of the fourteen new codegen modules is needed. It does not supersede their implementation, their honest mixed classification, the immutable policy predecessor or the preservation requirements. Root measured codegen's flat population at842 against the unchanged829 ceiling. Exactly thirteen new top-level leaves account for the increase; `closures/promoted-capture-value.ts` is already nested. Root separately measured the import-cycle gate at largest SCC705 versus697, codegen→IR297 versus295, IR→codegen75 versus74 and IR→runtime10 versus9. Directory relocation fixes only the flat population. Neither baseline may be increased, reseeded or bypassed.

### Independent failure attribution and release order

Root's actual old-PR native baseline has195 rows,189 pass and6 fail. The candidate's same195 names/statuses/full normalized diagnostics agree. Those six Promise instrument failures are pre-existing on60f99e83450ea7eac7d6fe21a5ec2d4436cce6c5: four resolution VM failures referencing `arrayThenObservable`, plus two settlement-body preservation failures (retained declaration digest and the once-only inverse missing `closureBagInit`). They require explicit instrument/root-cause correction with healthy controls and original receipts; they are not fixed by moving modules. Fresh main's natural232-row population is193 pass/39 fail and is not the candidate's denominator.

The class6772 population is a true composition regression: main passes51/51 using the same test blob, candidate passes50/51; the failed result47 instead of63 omits the fifth16-point `super(super.method())` clause. Root must fix and verify that actual compiler composition before publication, retaining both main and Deno callback/new.target controls. Do not remove the clause, change63, treat it as an old-PR instrument failure, or grant green from the other fifty cases. This appendix grants no implementation direction based merely on that error signature.

Order: preserve full before snapshots and attribution; root releases the13-file path transport; independently repair the class composition and six authenticated instrument problems under their explicit scopes; release each dependency-cut group below after its caller/dependency mapping is reviewed; freeze final actual source/policy/test bytes; build the one final unpublished inventory proof and measured authority successors; run normal gates and complete native populations. A green path-only checkpoint is not publication approval while the cycle or semantic gates remain red.

### T1: exact thirteen-path transport, no implementation edits

All destinations below already exist as directories. Old paths are `src/codegen/<basename>.ts`; no compatibility forwarding module remains at an old path, since that would retain the flat count and duplicate module identity.

| basename | final path |
| --- | --- |
| array-fill-proto-value | src/codegen/array/array-fill-proto-value.ts |
| builtin-native-dyn-construct | src/codegen/expressions/builtin-native-dyn-construct.ts |
| closed-carrier-prototype-status | src/codegen/object-model/closed-carrier-prototype-status.ts |
| closed-object-prototype-edges | src/codegen/object-model/closed-object-prototype-edges.ts |
| linked-realm-property-read | src/codegen/object-model/linked-realm-property-read.ts |
| live-array-iterator-value | src/codegen/array/live-array-iterator-value.ts |
| microtask-drain-boundary | src/codegen/registry/microtask-drain-boundary.ts |
| microtask-notification | src/codegen/registry/microtask-notification.ts |
| ordinary-new-target | src/codegen/closures/ordinary-new-target.ts |
| promise-handler-boundary | src/codegen/registry/promise-handler-boundary.ts |
| promise-rejection-dispatch | src/codegen/registry/promise-rejection-dispatch.ts |
| rest-only-apply | src/codegen/closures/rest-only-apply.ts |
| shared-script-var-access | src/codegen/declarations/shared-script-var-access.ts |

Array builders belong with array leaves; dynamic constructor dispatch with expression leaves; object/prototype and linked-realm access with object-model; physical export/import registration and dispatcher lookup with registry; ordinary construction activation/rest-call state with closures; Script declaration access with declarations. This is organization of existing context-bound codegen, not clean-backend certification. `closures/promoted-capture-value.ts` remains in place.

Rebase each moved module's static relative import/export specifier against its old resolved target, then apply the finite old→new target mapping. Preserve `.js` specifiers, imported/exported names, type-only flags, order, all declaration/body bytes, module-level state, default parameters, diagnostics, telemetry strings and initialization order. Census found no `import.meta`, dynamic import, require or dirname dependency in these13 modules. Still assert this before editing; an unexpected occurrence is a changed prerequisite, not license for a broad text replacement. In particular preserve the single `accessPlans` WeakMap in shared-script-var-access and the ordinary new.target global name. Retain the profiling labels `fill-closed-object-prototype-edges` and `fill-linked-realm-property-read` in index.ts unchanged.

The actual production importer set is twelve files: `src/codegen/{async-scheduler,iterator-native,array-object-proto,object-runtime,closures,expressions,object-runtime-prototype,index,function-body,native-construct}.ts`, `src/codegen/expressions/new-super.ts`, and `src/ir/integration.ts`. There are nineteen static import declarations targeting the moved leaves: async-scheduler4, index3, object-runtime2, expressions2, and one each in the remaining eight files. Recount from the final AST; do not count index's two profiling labels as imports. Importers may change only these specifier literals in T1. This narrow grant includes importer literals in the already frozen conflict files without reopening their implementations.

Three direct test imports need the same literal transport: `tests/helpers/promise-resolution-receipts.ts`, `tests/issue-3518-promise-settlement-body-ownership.test.ts`, and `tests/issue-4376-compiled-rejection-events.test.ts`, all importing the dispatcher. Preserve every assertion and fixture. Other Promise tests consume those helper functions and source declarations indirectly. `requireBindings` in settlement-body-ownership authenticates the scheduler's actual canonical settlement import and forwarded export lists, and its mutators change supplied source operands; T1 does not change that canonical native import, list or guard. Existing resolution donor JSON/SHA, settlement declaration receipts, semantic inverse edits and historical source text stay immutable. Whole-current-file hashes/read inventories change only where actual paths/specifiers change; a whole-file successor must reverse only those exact literal edits before applying an existing historical declaration adapter. Never replace a mutated operand with a separately reread healthy file.

T1 proof: retain all13 old whole-file byte/SHA snapshots; a bijective old/new path manifest; exact import-literal spans; all19 importer edits and3 test-import edits. Authenticate source pins, reverse the bounded literal edits and require byte equality for each old module/importer; replay forward and require final equality. Resolve both ASTs' type/value imports to the same mapped target identities and symbol names. Transpile with identical TS options, normalize only authenticated module-specifier changes and source-location metadata, and compare JavaScript bodies/exports. Confirm13 old files absent,13 new files present exactly once, no old-path source/test imports, and flat842−13=829. Do not normalize arbitrary strings or use function-only equality to miss module state.

### T2: actual eight-node SCC cuts, separate from path-only proof

The gate graph's eight new giant-SCC members and their complete outgoing dependencies into that SCC were independently read using `buildGraph` from the actual gate implementation. The following table is the finite service seam. Dependencies not listed are presently outside the giant SCC and need no speculative conversion.

| moved/current leaf | SCC services to supply from its actual existing producer |
| --- | --- |
| array/array-fill-proto-value | `clampRelative`, `requireObjectCoercible`, `resolveSliceDeps` from array-slice-native; producer array-object-proto |
| expressions/builtin-native-dyn-construct | `emitStandaloneArrayConstructor`, `emitStandalonePromiseFromExecutorValue`, `isStandalonePromiseActive`, `reserveBuiltinConstructorIdentityGlobal`; producer expressions/new-super |
| object-model/closed-object-prototype-edges | `nextModuleGlobalIdx`, `canonicalUndefinedExternInstrs`; producer index |
| closures/promoted-capture-value | `localGlobalIdx`; producer closures/funcref-as-closure at its call around310 |
| array/live-array-iterator-value | `ITER_KIND_ARRAY_KEYS`, `ITER_KIND_ARRAY_ENTRIES` from iterator-native; producer iterator-native |
| closures/ordinary-new-target | `undefinedExternInstrs`, `ensureExnTag`; initialization producers function-body/closures, construction-frame producer native-construct |
| closures/rest-only-apply | `classifyClosureDispatchRest`, `buildClosureResultBoxing`, `ensureCurrentThisGlobal`, `installableReceiverInstrs`, `ensureExnTag`; producer object-runtime |
| declarations/shared-script-var-access | `emitGlobalEnvironmentKey`, `emitGlobalEnvironmentObject`, `ensureGlobalEnvironmentOperation`, `localGlobalIdx`; producer index |

Use an explicit final dependency parameter per affected exported operation, typed with erased `typeof` imports of exactly these existing functions (numeric readonly fields for the iterator constants). Destructure the parameter into the existing local function names at entry; retain every original call, argument, branch and invocation time. `isArrayFillVariadicMember`, lexical AST detection and exports that do not consume a service retain their signatures. For ordinary new.target split the dependency shape by operation: initialization needs only undefined-value emission, construction frames only exception-tag registration. For shared Script vars, only operations actually reading those services gain the parameter; its WeakMap and prepare/finalize sequencing stay unchanged. Pass the original canonical function objects; do not compute their results eagerly, copy mutable ctx state, replace handles with positional indexes, cache an allocated global or use optional callbacks that silently skip behavior.

Each producer may define one module-scope readonly dependency object containing function references (no ctx capture), or pass primitive constants/direct functions where only one dependency exists. No per-instruction closure/object allocation, lookup registry, dynamic import, additional Wasm call, or missing-registration fallback is needed. Additional producer imports must resolve to the exact existing owners. Measure their edges too: a cut is not established if a new producer import creates another forbidden cross-directory edge. Existing `registry/expression-helper-delegates.ts` demonstrates the reason these leaves must not import back into owners, but this plan does not expand that mutable registration framework.

Replace the two value imports of `buildStandardTryTable` in ordinary-new-target/rest-only-apply with the canonical `wasm/physical/exception-control.js` owner at their new relative paths. Actual `ir/try-table.ts` only re-exports that same function: this preserves function identity and eliminates both measured extra codegen→IR edges. This canonical retarget is an explicitly bounded exception to T1's same-resolved-file rule; prove the old export identity and unchanged callee implementation. Do not replace a real runtime dependency with `import type` merely to change the graph.

Expected structural result after all eight seams: none of these eight leaves reaches the existing giant SCC through a value import, so their introduction does not increase its697 ceiling. Assert the actual graph and all baseline dimensions rather than assuming eight arithmetic subtractions prove it. The nested promoted-capture leaf now has explicit additional source ownership under this separately root-authorized scope; it was not part of T1.

### T3: dispatcher and native-reaction resource injection — required distinct gate work

Actual extra edges are integration.ts→codegen/promise-rejection-dispatch.ts at line79 and lower-generic.ts→runtime/wasmgc/promise/rejection-event-bodies.ts at lines86–89. The former serves `resolvePromiseRejectionDispatcher` around8158; the latter builds async.throw event0 around3455 and await handling around3515. Moving the files leaves both edges intact. Merely moving the latter import into an IR emitter also leaves the IR→runtime count10 and is not a fix. A new backend facade would add an IR→backend edge against that separate25 ceiling; do not assume it is free.

The existing context-owned native Promise provider is async-scheduler.ts, already value-imported by integration for `getOrRegisterPromiseType`/`isStandalonePromiseActive`. Extend that existing producer with an explicit typed emission-binding factory. It returns the live dispatcher resolver and canonical native rejection-event/reaction-handled builders; the resolver closes over ctx once at function/resource binding construction and calls the existing authenticated dispatcher lookup only when requested. It must not resolve/mint a dispatcher or run a native builder at factory creation. This is real resource construction, not a bare re-export to conceal an edge. Integration consumes this one binding object and installs its methods into the existing lower resolver; it removes its direct codegen dispatcher import. Preserve `resolvePromiseRejectionDispatcher` and its opt-out/error contract exactly.

Before source release, freeze the finite lower-resolver extension and census actual native direct-lowering tests/callers. Required behavior: event0 with a present dispatcher and handled/rejected event1 use the supplied canonical builders, preserving field4, mark-before-dispatch, event order, scratch locals, argument identities and optional extern conversion. A missing callback when a present dispatcher requires it must be a loud contract refusal, never silent opt-out. The ordinary no-dispatch await case must still emit the exact three-instruction handled marker (receiver conversion/cast if extern, i32.const1, struct.set field4), including with old direct resolvers; do not introduce an unconditional new resolver requirement or drop the handled write. The async.throw no-dispatch case remains byte-inert beyond its pre-existing promise construction. The no-dispatch marker can remain explicit in the already Wasm-specific await arm; it is precisely the current canonical builder's undefined-dispatch branch, not a generalized second Promise implementation. Compare its exact recursive Instr tree with that canonical branch in independent controls.

The exact binding names are `createPromiseRejectionEmissionBindings(ctx)` in async-scheduler, and `resolvePromiseRejectionDispatcher`, `buildPromiseRejectionEvent`, `buildPromiseReactionHandled` in the returned object. Preserve the existing first method in `IrLowerResolver`; add the latter two as optional methods typed with the canonical builders' exact argument/return domains through erased imports: `(dispatch: FuncHandle | undefined, event: 0 | 1 | 2 | 3, promise: readonly Instr[], value: readonly Instr[]) => Instr[]` and `(dispatch: FuncHandle | undefined, typeIdx: TypeHandle, local: number, carrier?: "gc" | "extern") => Instr[]`. Optionality preserves ordinary direct resolvers; only a present dispatcher activates the two required-method checks. Integration spreads/assigns these exact three bindings into its resolver in place of its old dispatcher closure. Do not overwrite unrelated resolver properties or resolve the dispatcher during the spread. The factory's two builder values are the canonical imported functions themselves; only its dispatcher callback captures ctx. Compare present-dispatch callback argument lists and thrown errors independently, including invalid physical dispatcher and unsupported async signature before any emission.

The factory and resolver adapter must not allocate callbacks per IR instruction or per event. Native builder references are module singletons; one ctx-bound dispatcher callback is created at the same resolver lifetime as the existing callback. Preserve the actual call count/timing of dispatcher authentication. Generic lowering consumes only erased types and injected functions; no value edge to native-runtime remains. No new module, activation rule, representation schema, generated-Wasm dispatch or optional widening is needed. Root must review this extension and its direct-resolver compatibility controls as a distinct source release; T1/T2 implementation must not invent it while repairing imports.

### Ownership, metadata and preservation closure

Disjoint source groups after T1 freeze: A owns array fill/dynamic construction/iterator leaves plus array-object-proto, expressions/new-super, iterator-native; B owns ordinary-new-target/promoted-capture leaves plus closures/funcref-as-closure, function-body, closures, native-construct; C owns closed-prototype/rest-apply/shared-Script leaves plus object-runtime. Root alone integrates C's two index call sites and all shared index imports. D owns dispatcher/native-binding changes in async-scheduler, integration, lower-contracts and lower-generic after its concrete contract review. The class composition owner retains class-bodies; tests/metadata have separate explicit owners. Do not concurrently give two workers the same producer; route the promoted-capture producer to B and any index collision through root.

Metadata owner must use retained `.tmp/pr6341-inventory/policy-before.json` and the frozen current draft/profile during the independent17-reader baseline's temporary policy replacement. Do not read that temporary1,837 file as the current1,855 candidate. For T1/T2/T3 there are still exactly18 newly classified modules: change only the13 path strings in their existing new rows. Their state/layer/destination/owner/nextBoundary fields remain the preceding exact profiles; nesting does not cure context ownership. The three native Promise rows, nested promoted-capture row and clean allocation-owner row remain unchanged. Preserve all1,837 predecessor rows, non-files fields, allowed edges, activation roots/history and order. If later work actually changes module count or classification, stop and measure/review that distinct delta rather than silently certifying18.

Update only the new unpublished Deno inventory proof's actual current values: `tests/helpers/ir-deno-callback-inventory-successor.{ts,json}` and `tests/issue-4376-deno-callback-inventory-successor.test.ts`, plus `scripts/compiler-boundaries.json`. Its fixed before policy remains exact4b442f64/1,837. Recompute current raw/semantic profiles,18 row positions/neighbors and bounded spans after final formatting; independently reverse to that same predecessor and replay to exact final1,855. Preserve the prior top-level-path proof/logs as ignored evidence, not as a second accepted current epoch. Root's proposed metadata receipt base must be actual merge inputabb3471c46bb9e7129b28812fe16313c857cda69, not a cached GitHub comparison base or another lane's revision.

The17 reader adapters consume unchanged proof API names; do not edit them merely because current row paths changed. The known four C1 current-instrument/existing-recipe intersections remain only the actually changed number-prerequisite, program-data-contract-boundary, runtime-program-policy-evolution and well-known-symbol readers. These path moves do not themselves authorize refreshing their pins again. Check direct imports/source-file inventories for every actually edited test helper against the current manifest before composing any extra finite successor. Retain all historical artifacts/before pins, all old mutation rows and exact outside-span bytes. Promise donor/declaration authorities do not acquire replacement historical hashes to accommodate service injection: inverse only measured new parameter/destructure/call arguments at exact declarations, then run the unchanged old guards; separately mutate the fresh live binding graph before inverse and require healthy→bad→restored controls.

Required final checks use Node25 and the ordinary scripts: check:flat-dir-budget, check:import-cycles (also retain verbose graph), check:compiler-boundaries and inventory, check:loc-budget, check:func-budget, check:coercion-sites, check:oracle-ratchet, production build/typecheck and normal changed-root hooks. Retain the eleven Deno/Promise regression files and class6772's entire51-row population; retain all other already captured native rows with real row-by-row attribution. Source transport requires paired same-input binary/WAT/runtime comparisons; service injection additionally compares mutable ctx/local/global/function/counter effects and exact canonical callback arguments/order. Measure warmed compiler time on the same genuine source fixture population before/after with a fixed engine and repeated samples; report overhead rather than waive it because Wasm bytes match. No request-only eligibility, private Prepared guard weakening, baseline allowance, retirement claim or loss of main/old-PR assertions is authorized.


## 2026-10-06 concrete class composition repair: retain abrupt super-method completion

### Authenticated native diagnosis

This is the one class regression previously separated from the six old-PR Promise instrument failures. No tracked compiler/test/metadata file was changed to diagnose it. Root authorized `.tmp/class-composition-probe/root` as an isolated ignored probe root. All1,857 copied src files match the candidate's `.tmp/pr6341-independent/candidate/before.json` source vector. For the21 source paths temporarily mutated by the policy-reader baseline, copying used only `.tmp/pr6341-inventory/original17-source-copies/src`, never the live fault targets. Source custody and all four held candidate pins are in `source-custody.json`; `after-custody.json` confirms all1,857 copied sources unchanged after probes. Actual policy was neither read nor needed. Main compilation used the separate immutable `/private/tmp/js2-ir6341-main-20261006` root atabb3471c46bb9e7129b28812fe16313c857cda69.

The actual Node executable was `/Users/thomas/.nvm/versions/node/v25.9.0/bin/node`, with `--experimental-wasm-exnref --max-old-space-size=4096 --import tsx`. `probe.mjs` imports each root's genuine public compile entry, uses the original runProbe options (standalone/probe.js/allowJs/skipSemanticDiagnostics/deferTopLevelInit), compiles and instantiates the actual WebAssembly module with `{}`, calls `__module_init` and `readResult`, and independently evaluates the source in Node. Every reported native module compiled successfully with zero diagnostics, compiler imports[] and actual WebAssembly.Module.imports[]. No interpreter replacement, host runtime import, producer stub or modified compiler was involved.

The unchanged original six-clause body, extracted from `tests/issue-6772-class-residue.test.ts` around78 and wrapped exactly like runProbe, has source SHA256 `45ab0d29e9a9218e0a9ac398561200355dd5c21a0b3fa913e6f1c10b73ecd181`: Node63, main63, composed47. The original assertion, source body and test file remain unchanged. Evidence is under `.tmp/class-composition-probe/{main,candidate}/original-results.json`, with original process stdout, actual binaries and WAT retained.

A diagnostic variant preserves all six class declarations and replaces only the fifth clause's reporting. It distinguishes no throw1024 from a caught error mask: ReferenceError1, TypeError2, Error4, typeof-object8, typeof-string16, name-ReferenceError32. Node45 and main45 identify an object ReferenceError with the expected name; composed1024 identifies successful completion with **no exception**, not a wrong error class. See each lane's `diagnostic/results.json` and `diagnostic-fixtures.json`. Extracting just the fifth class is an essential countercontrol: Node16 but both main0 and composed0. Thus the isolated shape already had a latent defect on main; the composition newly exposes that same mechanism in the original six-clause population. Do not claim the isolated shape regressed only in the PR.

Actual original-fixture WAT is decisive: main's `__anonClass_C_4_init` contains the ReferenceError construction and `throw 0`; the candidate's corresponding function instead supplies a default operand, runs the parent's init and returns its receiver. The bounded excerpts are `{main,candidate}/fifth-init.wat`. Other method/constructor dispatchers need not be guessed from the error signature.

### Cause and exact implementation

The Deno change in `class-bodies.ts` around2587 correctly supplies `enclosingClassName: className` to every constructor context. Retain it, including anonymous/underscore-containing names and the separate host Promise constructor site around4014. Main's prior display-name parsing accidentally lost the synthetic anonymous-class identity in the original six-clause fixture, so its super-method fallback happened to preserve the throw. Reverting the explicit identity would reintroduce Deno constructor bugs and leave the isolated latent defect.

The actual causal chain is:

1. `compileSuperMethodCallCore` in `src/codegen/expressions/new-super.ts` around1302 calls `emitUninitializedThisGuard`, which emits the proven unconditional GetThisBinding ReferenceError but discards the boolean classification result.
2. It continues compiling unreachable method lookup. With the now-correct class identity, parent Base is found but method is absent. The collection helper declines for this ordinary class; the host-only external method helper declines for standalone. The function reports missing method and returns null around1386.
3. `compileExpressionBody` in `src/codegen/expressions.ts` around1012 treats null as failed speculative emission. Its existing `rollbackSpeculative` erases the throw and diagnostic and emits a default argument. Parent construction then completes normally. Neither collection admission nor native construction caused the missing throw.

**Source owner edits only `src/codegen/expressions/new-super.ts`, function `compileSuperMethodCallCore`.** Replace its initial void guard call with the existing boolean-returning primitive:

```ts
if (emitSuperUninitializedThisCheck(ctx, fctx, expr.expression)) return VOID_RESULT;
```

The module already imports both that primitive and VOID_RESULT; reuse them. Remove the now-unused `emitUninitializedThisGuard` named import if this was its sole local use; retain the canonical guard-module dependency and every other import. This is an abrupt-completion result, not a fabricated value or a relaxed speculative guard. The existing expression wrapper specifically preserves VOID_RESULT; if a surrounding expression requires a type it may append its established unreachable default after the throw, without rolling back the throw. No global changes to null semantics, speculation, error stickiness, class resolution, collections, constructor drivers, allocator behavior or source-map guards are warranted.

The boolean primitive already applies standalone and derived-constructor classification. Its `always` branch emits the error and returns true; `runtime` emits the conditional flag check and returns false; `never` emits nothing and returns false. Consequently only the statically terminating case exits early. Runtime-initialization checks and ordinary method lookup continue unchanged. Do not change `classifyUninitializedThisAccess`, suppress an exception merely because a method is missing, treat every `super` use as uninitialized, or evaluate key/method-call arguments after a proven abrupt GetThisBinding completion.

Both literal property calls and already-resolved computed-literal super calls use this shared core. Preserve existing computed-key sequencing at its caller; this patch does not broaden dynamic-key lowering. The earlier T1 move owns only import literals in this same file, while this source owner owns the single core-function behavioral change. Serialize these two writes or have root compose them; no simultaneous file ownership. The four held class-bodies/expressions/compiler/allocation-owner implementations need no change for this repair. Root releases source only after the active policy-reader custody window closes.

### Independent acceptance and bounded fanout

Keep the entire original51-row `tests/issue-6772-class-residue.test.ts` population and all old source bodies/assertions. The original six-clause row must become63. A separately owned new `tests/issue-4376-super-method-abrupt-completion.test.ts` can carry the isolated shape and identity/order controls without editing historical assertions. Capture its original candidate result before source release. Required independent cases:

- Exact isolated `super(super.method())` with missing parent method: catch a real native ReferenceError (instanceof/name/object identity checks) and preserve bit16. This is an honestly labeled latent-main correction through the same mechanism.
- The six-clause diagnostic reporting preserved as a separate witness: mask45, not1024, with original main/candidate baselines retained.
- Side-effect order: a base constructor increments a counter, a super-method argument increments another, and a parent prototype getter increments a third. Access before super must throw before any of those effects; assert all counters remain zero. Do not infer ordering from the error name alone.
- Healthy resolved super method after successful super returns the parent method's value, with one parent invocation and arguments evaluated once. A loop-based runtime initialization case and an arrow created before super but invoked afterward remain healthy using existing class6772/5350 coverage; do not replace their old guards with unconditional throws.
- Preserve ordinary/base constructors, the original second-super and nested-super rows, anonymous and underscore-containing class identities, and the existing Deno callback/new.target plus Promise-constructor regression populations.

Use actual standalone compilation and WebAssembly.instantiate with no imports for these controls. Preserve original public compile options/default routing. After the one-function patch, require all51 original class cases, the independent new controls and the existing Deno callback/native construction controls to pass; retain row-level failure attribution for the six still-open original Promise instrument failures. Production type/build and normal changed-root source gates remain required. The ordinary main/PR artifact equality checks apply to unaffected healthy fixtures; the formerly wrong class body's throw/bytes must change and must be compared semantically against Node rather than pinned to the bad binary.

No tracked source/test/authority was modified by this architect task, no graph or policy gate was run during physical mutations, and no baseline, historical receipt, private Prepared guard or migration-retirement condition is waived.


## 2026-10-06 six pre-existing Promise preservation guards: finite instrument repair

### Frozen scope and attribution

These six failures reproduce with identical names/statuses/full normalized diagnostics in oldPR60f99e83450ea7eac7d6fe21a5ec2d4436cce6c5 and the composed candidate's195-row shared population (189 pass/6 fail). They are not the separately repaired class regression. Keep the original failure rows in `.tmp/pr6341-six-guard-spec/original-six-failures.json` and all original baseline artifacts. Root reports the class repair complete108/108; this task neither changes nor reruns it.

Four failures are the resolution suite's `fills the registered lookup object before live omitted/wrong-fill mutations` and `classifier finalization full`, `empty`, `no-any`. All stop before their intended assertions with `ReferenceError: arrayThenObservable is not defined`. Two failures are settlement-body-ownership's immutable retained-declaration checks for `emitStandalonePromiseResolve` and `emitStandalonePromiseThen`. Actual source extraction shows both current declarations equal oldPR byte-for-byte; no new production corruption is indicated by these six failures.

Architect wrote no source/tests/metadata/Git state. Read-only extraction and inverse/replay analysis is retained under `.tmp/pr6341-six-guard-spec`. Current input pins after T1's dispatcher import transport are:

| file | bytes | SHA256 |
| --- | ---: | --- |
| tests/helpers/promise-resolution-receipts.ts | 30960 | 392b1192aa978ebe14073b087c5e0eedac18a8570f3a60f4587aaad95381d467 |
| tests/issue-3518-promise-resolution-preservation.test.ts | 10144 | 9f04e99b8b0cbfb0a527d1a3f5b181dda8a5a657b5a0fa4d1f4fa2e376904c9e |
| tests/issue-3518-promise-settlement-body-ownership.test.ts | 47194 | d7ef0d7f54c186cdd6b0fdfb800e31bc32d50278bb640ae0995c776edc16dd4d |
| tests/fixtures/issue-3518-promise-resolution-donors.json | 39148 | da7c7a907726732488dec5e80a8a06c8bb0ed88c644fea32e0da15abef70a646 |

These are measured before values, not proposed future pins. Preserve the donor JSON byte-for-byte. Production reader/input pins are in `input-pins.json`. The only direct consumers found for the resolution helper are these two issue3518 tests. No matching C1 current instrument/recipe/authority path was found for these three test files; do not reseal C1 merely because the tests were repaired. Recheck actual direct-reader intersections if a later peer introduces one.

### G1: bind the actual array-then predicate and retain the healthy prerequisites

**Owner G1: `tests/helpers/promise-resolution-receipts.ts` and `tests/issue-3518-promise-resolution-preservation.test.ts` only.** The producer `src/codegen/closed-method-dispatch.ts` imports the real `arrayThenObservable` from `./promise-species-then.js` and uses it around2160 when collecting `vecTypeIdxs`. The predicate's actual implementation around509 is:

```ts
return ctx.standalone === true && (ctx.protoIndexDirty || ctx.protoNamedWrittenMembers.has("then"));
```

`classifierFixture` around204 and `verifyActualLookupFill` around391 extract/evaluate `fillPromiseThenableHelpers` in a VM but omitted this dependency. Import `arrayThenObservable` from the actual production module in the test helper and supply that exact function reference in both VM binding dictionaries. Do not use `() => false`, a reimplemented getter, a function extracted from a stale donor, or a closure that changes the predicate's result. Preserve the old donor evaluation and its existing declared dependencies; the new binding does not alter its source.

Make the predicate's consumed context fields explicit in each healthy fixture: `standalone`, `protoIndexDirty`, `protoNamedWrittenMembers` and `vecTypeMap`. For the existing historical-equality populations use a genuine non-observable configuration (standalone true, dirty false, an empty written-member Set, and an empty vector Map). This retains their intended no-new-array-arm semantics without depending on missing fields or undefined mode flags. Preserve full/empty/no-any/unreserved variants, the reserved lookup object's identity, signature104, all earlier inventory rows, actual-object writes, locals/body assertions and read ordering. No expected results or historical donor bodies change to accommodate the missing binding.

Before counting an omitted/wrong-fill mutant, run the healthy VM fixture to completion and verify its exact current object effects. Existing negative tests must then mutate the same authenticated source operand, not a newly read healthy replacement. In particular the old fill mutants cannot claim coverage merely because a shared missing global made every invocation throw.

Add finite positive predicate controls separate from the old historical comparison: (a) standalone false with dirty true, (b) standalone true with both observability inputs false, (c) dirty true, (d) named `then` written with dirty false. For true cases supply a Map whose values include two distinct vector handles in reverse order and one duplicate; assert exactly the two sorted distinct vector rows at the actual finalization point. Include late Map insertion before finalization so early capture cannot pass. For no extern getter, assert the canonical builder's documented suppression of vector Get arms; for an actual getter and open-object resource, assert the independent expected ref.test/extern-get arm order and original captured-value identity. Expected arms must not be synthesized by calling the builder under test. Preserve `verifyIndependentLookupBody`'s existing hand-written oracle and its old mutants.

Authenticate the dependency connection independently: parse the live production driver's import declaration and require the exact non-type named binding `arrayThenObservable` from `./promise-species-then.js`, with no alias replacement. Use the actual imported function object in the VM. Add missing/type-only/substituted-owner-or-symbol import controls plus healthy restoration; these controls validate production dependency identity, not merely a same-spelled VM variable. Do not change the production import or predicate. Native witnesses below establish that the real producer is exercised beyond this instrument fixture.

### G2: two explicit source epochs, thirteen bounded edits, original hashes unchanged

**Owner G2: `tests/issue-3518-promise-settlement-body-ownership.test.ts` only.** The original retained hashes are pinned to `e3de0f3ff7d7828c66b3fea7946f08e593bf77d8`, not fresh main. Its complete async-scheduler source is215633 bytes/SHA256 `7220f0474d3d3c7009876d4d463f2b8c8182d49793f5957570fb0a27da1dfd4f`. Read-only Git extraction independently reproduces both literal retained hashes. Permanent tests must remain self-contained and not require historical Git objects.

| declaration | current/oldPR | fresh main after Deno inverse | immutable original donor |
| --- | --- | --- | --- |
| emitStandalonePromiseResolve | 3130 / 4f3eb6c40cf52784c1cdc006821f0dc0019492cef46b561144a1c43889615275 | 3042 / f648618c442bc2a21867e63a5fb21eeaf490aa1b7a6aae390772c36130308f40 | 2684 / 5c0aa24ffc4cd304ffa515da77ce819b2e433d4aeedfb910f821dc5fff3bc510 |
| emitStandalonePromiseThen | 12021 / ce2db569273715caed0ab25dfb77cb5e7fdc7dfcb5a4925a22d8f06916886a82 | 11871 / 3d3c6c54230fa80e5baf9fde0d74b2dd46c53f5e74272ea9204aa9ebb1012b08 | 10947 / 6496dc53cdf1956ea2cfb7a6553915755dcbb2acfb5846f74c08851d6044ccfc |

Numbers are UTF-8 bytes; hashes are SHA256 of the complete `getText()` declaration. Do not confuse TypeScript UTF-16 source positions with UTF-8 offsets. The existing Resolve Deno inverse is already correct: it produces exact fresh-main f648..., so replacing the expected original5c0... with f648... would erase the unaccounted species/constructor transformation.

Keep `undoDenoRetainedDelta` for the Deno epoch, and add a narrowly named declaration adapter such as `undoDeliveredPromiseSpeciesDelta` for the already delivered main→original epoch, invoked only for these two names. Preserve existing retained rows and hashes, canonical headers, layout checks, all other inverse cases and mutation titles. Use exact once-only spans with fixed surrounding context or a fixed bounded recipe; no regex/global replacement, whole-function substitution or allow-list of current hashes. A separate healthy control must assert both full intermediate main pins, both final original pins and full reverse/forward reconstruction, including unchanged outside-span bytes.

The exact13-edit recipe is `.tmp/pr6341-six-guard-spec/exact-declaration-stages.json` (6949 bytes/SHA256 `67b0453d92b56eb64e8e259af48b8ff6ef0a3e2bb5015fe3c246038a9556344f`). It contains independently extracted before/after literal text and actual UTF-8 offsets, with complete inverse/replay verified in each direction. Transfer only its finite literal edits/pins into the test instrument; this ignored evidence file is not a runtime authority dependency. The stages are:

1. **Resolve current→main:2 edits.** Remove exactly the handled-field i32.const0 statement after the closure-bag initializer in the legacy direct mint, and exactly the handled-field0 array item in the pending adoption mint. Existing behavior is already correct; retain it.
2. **Resolve main→original:3 edits.** Remove the early vLocal allocation plus the constructor-check comment/passThrough binding; restore the original vLocal declaration immediately before pLocal; remove only the exact conditional passThrough i32 guard between ref.test and the original if. These account for delivered `promiseResolvePassThroughInstrs`, not a change to current production semantics. Complete output must match2684/5c0... exactly.
3. **Then current→main:3 edits.** Remove the actual reaction-handled call after switching into nativeBody; remove the handled-field0 **array element inside mintChained**, not a nonexistent standalone `fctx.body.push` pair; restore the exact old FIFO comment. Exclude Then from the common sequential-push inverse branch that currently stops early. Move its intrinsic-parameter and own-then-condition inverses out of this stage because those already exist in fresh main. Complete output must match11871/3d3... exactly.
4. **Then main→original:5 edits.** Remove the intrinsic parameter; remove species/speciesFwd preparation; reverse the exact mintChained+sp/speciesChained selection block to the original six sequential pushes; reverse only the speciesForwardAndResultInstrs result block to original local.get/extern.convert_any; restore the original own-then availability condition. Complete output must match10947/6496... exactly. This is the delivered species/own-then epoch, not a new Promise behavior change.

For reproducibility, the13 stage-relative byte spans `(beforeOffset,beforeBytes → afterOffset,afterBytes)` are: Resolve Deno `(1432,51→1432,0),(2650,37→2599,0)`; Resolve species `(768,257→768,0),(1565,0→1308,96),(1968,197→1807,0)`; Then Deno `(4320,113→4320,0),(4666,35→4553,0),(7868,159→7720,157)`; Then species `(223,105→223,0),(375,255→270,0),(4376,582→4016,325),(8517,400→7900,80),(9843,96→8906,109)`. These are full fixed literal replacements, not permission to delete arbitrary ranges of those lengths.

### Required mutation staging and independent production witnesses

Retain every original assertion and mutation. Correct the Then mutation row that was falsely satisfied by the unrelated missing-push failure: first normalize the healthy Then declaration through both stages and require the original hash, then inject its existing `promiseLocal + 1` mutant and require the intended exact reaction-call refusal. Apply the same healthy-first discipline to the other explicitly accounted Deno mutations. Do not add an unconditional whole-current hash check before every mutant that makes all old semantic/span controls fail at a new earlier prerequisite. Whole-current/intermediate pins belong in separately labeled healthy authority/replay controls; mutated input must actually exercise its designated bounded span or final immutable-declaration guard.

Add targeted bad/missing/duplicate/shifted-span controls for both epochs; mutation of field4's initializer value, a wrong receiver or native function argument, extra/missing/moved handled writes, species argument changes, wrong constructor-check position, and unrelated unchanged-region edits must refuse. Assert replacements are exactly once, ordered/nonoverlapping and complete; reverse and replay both complete declarations. A mutant inside an adapted span must fail that span's exact-match guard; a mutant outside all spans must survive the span transforms and fail the unchanged original whole-declaration hash. For each, restore healthy input and demonstrate success. Preserve the original declaration population, headers, modifiers, callable layout/marker assertions and donor receipts. Do not use an arbitrary new whole-body inverse that happens to return the expected text.

The real native source controls already exist in `tests/issue-5197-r3-promise.test.ts`: p1 reads constructor exactly once and preserves thrown getter identity; p2 species constructor throws and restored species works; p3 Promise.resolve respects changed constructor and retains intrinsic identity; p5 observes installed Array.prototype.then on Promise.all's aggregate; p17 propagates a poisoned array-then getter by object identity. Preserve their original source/options/expected values and run the actual file as a native witness (its full original population, rather than relabeling VM fixtures as source coverage). Also retain `tests/issue-5197-own-then-indirection.test.ts`, `tests/issue-6651-d7-promise-finally-invoke.test.ts`, the two repaired issue3518 suites and all already required eleven Deno/Promise regression files. These source tests compile standalone and check actual Wasm imports/instantiation/draining; no fake getter substitutes for real array-then or species semantics. Any failure newly observed there needs its own measured attribution; these instrument repairs do not certify unrun cases.

G1 and G2 can implement concurrently because their files are disjoint. An independent tester may own one new `tests/issue-4376-promise-preservation-instrument-controls.test.ts` for actual-import/epoch corruption/healthy restoration checks; if it needs private adapter access, follow the existing AST declaration extraction pattern and independently fixed literal receipts, without importing a test module to duplicate registrations or exporting production internals. Root integrates final actual pins only after all owners freeze. No compiler source change, historical fixture update, broad policy/C1 reseal, baseline waiver, private-guard weakening, eligibility adjustment or retirement claim is part of these six repairs.


## Final PR6341 inventory transport and bounded C1 instrument successor (2026-10-06)

This amendment implements the metadata consequence of the already frozen T1/T2/T3 source composition. It does not authorize source edits, alter the eighteen classifications, relax activation or allowed edges, change historical authority, or grant IR retirement. The exact base is `abb3471c46bb9e7129b28812fe16313c857cda69`; the earlier draft's `f02ded0...` was already corrected in the installed unpublished proof. Use the installed proof as the preparation input, not that stale draft provenance.

### Measured inputs and source intersection

Architect read-only evidence is `.tmp/pr6341-final-epoch-spec/{review.json,policy-candidate.json,receipt-candidate.json,reciprocal-review.json}`. These candidate files are ignored review operands, not an installed policy or published authority. All 21 current source pins still equal `.tmp/pr6341-cycle-cut/freeze.json`. The complete measured source-path union is 68: 55 paths in the tracked diff from the actual merge input plus the 13 transported destinations (also checked against the final cycle freeze). None intersects the current C1 manifest's source path population/LinearOptions closure or `ir-runtime-program-relocation.json` source population. All twelve current instrument pins presently equal the existing manifest. Therefore no production-source epoch adapter, C1 source-pin replacement, or source inverse is required for this change.

Specifically, `src/ir/backend/lower-contracts.ts` is 14587 bytes, SHA256 `f174986c105638ca8d06c07d784bf021cd53758b3639589b03ec3bcc63846a8b`. It is read by `issue-3518-lowering-cycle.test.ts` (including every import being type-only) and `issue-3518-lowering-relocation-coverage.test.ts` (the five-path pushRaw domain). The wasmgc-helper policy receipt references its unchanged **classification row as a neighbor**, not its source hash. Preserve that neighbor literally. Do not turn this source dependency into an invented C1 source pin or modify an old receipt. Root confirms no separate lower-contracts pin failure was observed.

### M1: thirteen path-only replacements in the eighteen unpublished rows

Owner scope: `scripts/compiler-boundaries.json`, `tests/helpers/ir-deno-callback-inventory-successor.{json,ts}`, and `tests/issue-4376-deno-callback-inventory-successor.test.ts`. No source or other policy row may change. At each zero-based files index below replace only the listed row's `path`; preserve its position, state, layer, destination, owner, and nextBoundary. Canonical placement and injected context services do not establish clean-layer migration for these codegen implementations.

| Index | Old path | Final path |
| --- | --- | --- |
| 195 | `src/codegen/array-fill-proto-value.ts` | `src/codegen/array/array-fill-proto-value.ts` |
| 267 | `src/codegen/builtin-native-dyn-construct.ts` | `src/codegen/expressions/builtin-native-dyn-construct.ts` |
| 326 | `src/codegen/closed-carrier-prototype-status.ts` | `src/codegen/object-model/closed-carrier-prototype-status.ts` |
| 328 | `src/codegen/closed-object-prototype-edges.ts` | `src/codegen/object-model/closed-object-prototype-edges.ts` |
| 708 | `src/codegen/linked-realm-property-read.ts` | `src/codegen/object-model/linked-realm-property-read.ts` |
| 710 | `src/codegen/live-array-iterator-value.ts` | `src/codegen/array/live-array-iterator-value.ts` |
| 841 | `src/codegen/ordinary-new-target.ts` | `src/codegen/closures/ordinary-new-target.ts` |
| 878 | `src/codegen/promise-handler-boundary.ts` | `src/codegen/registry/promise-handler-boundary.ts` |
| 941 | `src/codegen/rest-only-apply.ts` | `src/codegen/closures/rest-only-apply.ts` |
| 957 | `src/codegen/shared-script-var-access.ts` | `src/codegen/declarations/shared-script-var-access.ts` |
| 1657 | `src/codegen/microtask-drain-boundary.ts` | `src/codegen/registry/microtask-drain-boundary.ts` |
| 1658 | `src/codegen/microtask-notification.ts` | `src/codegen/registry/microtask-notification.ts` |
| 1785 | `src/codegen/promise-rejection-dispatch.ts` | `src/codegen/registry/promise-rejection-dispatch.ts` |

The five other new rows remain exact: native-runtime clean rows at indices 47 (`reaction-order-bodies.ts`), 48 (`rejection-event-bodies.ts`), and 1498 (`resolving-pair-bodies.ts`); wasm-physical clean `allocation-owner.ts` at 1522; and unmigrated/mixed-needs-split `closures/promoted-capture-value.ts` at 898. All fourteen codegen rows retain their reviewed debt profiles; no row is removed to make a gate green. No sorting/reordering is necessary or authorized.

The physically prepared candidate is **594018 bytes**, SHA256 `59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694`, Git blob `dfd1b16089d1d66982e0eef5d79b50f74fd6d869`; 1855 rows. Its compact JSON data hash is `07d3bc5470d5864ae6f1e7d199eed523b382119aace6366db92804a7c7c63380`, files hash `f30f8e6a86c56fc16e6c9ad768d52930b70f73beef57feffae69ad932d5bf78c`. These are measured candidate pins, to be independently verified against installed bytes after release. The previous unpublished 1855-row input is 593888 bytes / `0ae3c7c3748a15ccb7580eec388d806a5999250faa726db7d682b9412acbed15`. Its copy stays in ignored custody evidence, not in an allowed-hash set.

Keep the immutable predecessor at **588351 bytes / `4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05` / blob `c5da824f89dded25e85e7e315825d2d61d97f906` / 1837 rows**. Removing the same eighteen inserted rows from the candidate must reproduce every predecessor row in order, and all non-files fields must be deeply equal. In particular, allowedEdges, layers, activationHistory, nonModules, evidence, moves, externalPackages, requireGitProvenance, and top-level key order remain untouched.

Rebuild the existing fixed eighteen-row receipt directly from the unchanged predecessor to the final candidate, not as a generalized relocation registry. Preserve all eighteen `index` values and `beforeOffset` values. Replace mapped paths in inserted row text, compute each `afterOffset` from actual preceding UTF-8 insertions, and refresh `previous`/`next` from the final array (including newly renamed adjacent inserted rows). Keep eighteen empty-before insertion spans. The ignored prepared receipt is 27453 bytes / SHA256 `b35c6b605ea4fd36f7c5cb2a4b46aff8eee49de4cfb675aa78a0d1dc5934e7d9`; both its complete raw inverse and forward replay were independently checked exact. No tracked installation has occurred. If formatting changes its bytes, measure that final serialization and review it rather than accepting this pin blindly.

In the helper update only the fixed current profile, exact eighteen row/neighborhood records, and complete receipt byte/hash literal to match the final receipt. Leave `captureData`, `authenticate`, `beforeSemantic`, `beforeRaw`, profile checks and exported API behavior intact. Do not add old-flat/current-path alternatives, accept partial profiles, cache successful authority, or relax descriptor checks. Retain the independent test's actual extra blob checks and non-files-rule mutation added after its original draft: installed test has **31 passing case identities**, not the older draft population. Recalculate its independent final profile, eighteen insertion strings/coordinates, exact receipt pin and complete formatted helper pin from physical bytes. Preserve all 31 cases, getters/coercion/holes/boxed/physical corruption controls and exact fresh read counts. Add one bounded test iterating the explicit thirteen mapping rows: assert exactly one final path at its fixed index, zero old-path rows and real final source presence/old source absence; substitute each old path in a copy of the final policy and require refusal between healthy captures. Assert loop population thirteen. The manifest proof is a policy proof; the final native/compiler gates provide source behavior evidence.

### M2: seventeen readers, twenty-four exact operand sites

Owner scope is the exact seventeen existing tests below. The preserved original files live in `.tmp/pr6341-inventory/original-readers`; implementation candidates and AST operand census are in `adapter-drafts` and `adapter-channel-proposal.json`. Treat them as reviewable deltas, not permission to overwrite later peer edits. Add the outer fixed eighteen-row inverse at actual current policy capture, then compose the already delivered eleven-row main-inventory inverse where the historical reader lacks it. This is **19 raw + 5 semantic sites = 24**, not a wholesale rewrite of read helpers.

In the table, **add11** means `existingConsumer(main11(deno18(actualOperand)))`; **existing11** means insert only `deno18` immediately inside the already present `main11`; **independent11** means remove Deno18 and leave the test's independent eleven-row fixture/replay intact. Raw uses `captureDenoCallbackInventoryPredecessorPolicySource` and `captureMainInventoryPredecessorPolicySource`; semantic uses the corresponding functions without `Source`. Preserve each operand's original raw/parsed distinction and original downstream call.

| Test (under tests/) | Original line sites | Raw / semantic | Composition |
| --- | --- | --- | --- |
| `issue-3518-canonical-3c6-inventory-successor.test.ts` | 1430 | 1 / 0 | add11 |
| `issue-3518-canonical-489d-inventory-successor.test.ts` | 368 | 1 / 0 | add11 |
| `issue-3518-current-main-inventory-successor.test.ts` | 52 | 1 / 0 | add11 |
| `issue-3518-lowering-analysis-preservation.test.ts` | 737 | 1 / 0 | add11 |
| `issue-3518-nested-stackification-policy-evolution.test.ts` | 340 | 1 / 0 | add11 |
| `issue-3518-number-prerequisite-policy-evolution.test.ts` | 114, 946, 1354, 1886, 2247 | 5 / 0 | add11 |
| `issue-3518-program-data-contract-boundary.test.ts` | 167 | 0 / 1 | existing11 |
| `issue-3518-program-validator-policy-evolution.test.ts` | 713 | 1 / 0 | existing11 |
| `issue-3518-runtime-data-contract-seam.test.ts` | 2669, 3387 | 2 / 0 | existing11 |
| `issue-3518-runtime-program-policy-evolution.test.ts` | 92, 170 | 1 / 1 | add11 |
| `issue-3518-semantic-provider-boundary.test.ts` | 428 | 0 / 1 | add11 |
| `issue-3518-validation-policy-evolution.test.ts` | 68 | 0 / 1 | add11 |
| `issue-3518-wasmgc-helper-policy-evolution.test.ts` | 1073 | 1 / 0 | existing11 |
| `issue-3518-well-known-symbol-policy-evolution.test.ts` | 72 | 1 / 0 | add11 |
| `issue-3525-arraybuffer-isview-main-policy.test.ts` | 162 | 1 / 0 | existing11 |
| `issue-3525-main-inventory-source-successor.test.ts` | 308, 519 | 1 / 1 | independent11 |
| `issue-3525-presentation-classification-policy.test.ts` | 136 | 1 / 0 | existing11 |

Stage every old semantic/source mutation **after** authentic current capture has reached its historical operand. Do not wrap an already historical mutant through the new current-only adapter, replace a supplied mutant with healthy disk text, normalize a physical-current corruption before authenticating it, or count an earlier fixed-pin failure as the intended later guard. Keep the dedicated raw-current/authority corruptions in the new proof. Imports and capture wrappers are the only changes in these initial adapters; old receipt literals, expected old rows, assertions, case registrations, and physical fault restoration remain intact. Preserve original case identity and status rows from `original17-baseline-cases.json`: 2433 original cases, 889 pass / 1544 fail at the missing eleven-row prerequisite, with full diagnostic evidence retained. A new failure after this prerequisite is removed must be attributed to its actual operand/guard, not called a regression from an unexecuted old assertion.

There is one **known separate actual-fixture dependency**: the two semantic-provider healthy fixture failures diagnosed in issue6866. The authentic canonical closure there requires the exact additional 31 source modules (174→205, 977 edges), preserving historical 106/174 populations and all original guards. Its implementation is being independently frozen in the other worktree. Root must compose that single-test fixture patch with this test's Deno18→main11 wrapper; do not overwrite it with the stale draft, project actual source back in time, or report the seventeen-reader cohort fully green without those two healthy paths. The source-map-position component's one-row policy successor is not part of this 1855-row PR epoch; do not import its policy, helper, C1 seal, or unrelated test transport. Only reuse the approved actual-source fixture repair with explicit before/after custody and retained case names.

### M3: root-owned finite C1 reseal, four current instruments only

Current manifest is **402517 bytes / SHA256 `c0a10ae0c0bfc4d27fc24bea20401edc2cac683254fc1664781889c98f63ed66`**. The exact intersection with the seventeen adapters is:

- `tests/issue-3518-program-data-contract-boundary.test.ts`
- `tests/issue-3518-runtime-program-policy-evolution.test.ts`
- `tests/issue-3518-well-known-symbol-policy-evolution.test.ts`
- `tests/issue-3518-number-prerequisite-policy-evolution.test.ts`

Root owns the successor preparation/installation after final formatting and reader freeze. Rebuild only these four existing `instrumentEdits` recipes from their original immutable `beforePin` operands to their final formatted adapters. Recover original bytes by applying the current valid full inverse, then verify the original pins; never label current pre-adapter bytes as historical. Keep all `beforePin` records unchanged. Update only their four `afterPin` records, four span arrays, and four matching `currentInstruments[].pin` records. The other eight instrument pins and six recipes remain byte/data exact; population remains twelve instruments, ten recipes, seven historical artifacts and eleven immutable authorities.

Each rebuilt recipe must satisfy the actual `validateInstrumentEdits` contract: strictly increasing, nonoverlapping UTF-8 before/after offsets, in-bounds spans, unequal before/after texts, and correct original/final complete pins. Coalesce adjacent edits where necessary; a zero-length duplicate offset is not acceptable in C1 instrument recipes even though the separate insertion-only policy receipt allows consecutive insertions at one predecessor offset. Independently run full inverse and replay for **all ten** recipes, not just the four changed ones. Deep-restore the permitted four pin/recipe records into the candidate manifest and require exact equality with every other original manifest field. Preserve schema/base literals, all historical artifacts/immutable receipts, population, declarations, LinearOptions closure/resolver topology, and original mutation tests.

Do not modify `ir-c1-current-source.ts`, `ir-c1-historical-authority.ts`, the runtime-program relocation receipt, or any source-model frozen tables: no measured source intersection justifies it. No new helper is appended to the fixed twelve-instrument population. The new eighteen-row helper is bound by its independent complete-helper proof and receipt authentication, not falsely represented as an old C1 instrument.

Only after the reviewed candidate manifest is complete, root updates `tests/helpers/ir-c1-authority-root.ts`'s manifest SHA scalar and the external `independentFreeze` string in `tests/issue-3518-c1-current-source.test.ts`. Inside that external record change only manifestSha256, anchorSource, anchorPin; preserve declarationPin. Prove all bytes outside the one designated string and the one anchor scalar unchanged. Do not copy the other worktree's `51ae...` manifest or the separate unmapped-emission model/initial-graph successor: those are different integration inputs. Candidate hashes must come from final measured bytes, never from future-pin placeholders or widened accepted lists.

### Release order, gates and custody

1. Root completes the in-flight final native 26-file source/test/config snapshot before releasing any metadata/test writer. Architecture planning and this issue append do not mutate those inputs. Final production build is reported complete; its effect evidence remains root-owned.
2. Metadata writer performs M1, verifies the finite policy/receipt/helper reciprocal proof and all retained 31 independent cases plus the one thirteen-path control. Run actual Node25 `scripts/check-compiler-boundaries.mjs --mode inventory` after the metadata is installed; retain the exact denominator and errors array. Expected classification remains 1855; six declared nonmodules and raw discovery counts remain separately measured. Run the normal `check:compiler-boundaries` mode too. No budget or graph baseline update.
3. Install the reviewed M2 deltas and root-compose the independently frozen semantic fixture repair. Collect the original 2433 names before running the seventeen readers, plus explicitly enumerated additional fixture/proof cases. Preserve every original assertion and intended diagnostic. Physical-fault tests must be serialized with native compilation and other source readers, with byte custody for every touched source/authority before and after.
4. Freeze final reader files; prepare M3 in ignored candidates, independently inspect all ten inverse/replays and unchanged-field proof, then root installs the finite manifest/anchor/external freeze. Run `tests/issue-3518-c1-current-source.test.ts` and the seventeen readers with Node25, using the frozen full list (not a guessed glob). Check exact original case identities and original 889 passes retained. Do not promote missing/transitively unexecuted cases or earlier healthy guard failures to success. No generic assertion-floor reduction.
5. Root keeps the final 26-file native preservation result, production build, dead-export preservation result, source LOC/function budget, oracle/coercion checks, flat-dir gate (829 baseline), and import-cycle gate (unchanged baseline) tied to the same frozen source. Rerun source gates only if subsequent inputs actually change; test/metadata gates and required changed-root hooks still run normally. Include the lowering-cycle/relocation source contracts in the scoped source evidence, without changing their assertions or resealing lower-contracts. No published claim that an OPEN graph/retirement gate is closed.

Implementation ownership is disjoint from the two independently frozen PR6341 API tests and the other worktree's ongoing semantic fixture writer. The architect changed only this issue and ignored candidate evidence. Root handles all integration, final authority mutations, Git operations and the existing PR6341; no new PR or shared source dispatch is implied.


## T2 corrective amendment: preserve live service bindings across module initialization (2026-10-06)

The final native 26-file run is terminal **553/560**, with all 7382 custody inputs exact. Preserve its raw results at `.tmp/pr6341-independent/final-native/results.json`; extracted exact seven names/diagnostics are in `.tmp/pr6341-t2-live-binding-spec/original-seven.json`. The earlier six Promise instrument failures and original class regression are fixed; these seven are a separate new T2 regression and may not be reclassified as those historical failures. Five actual `issue-4376-callback-new-target.test.ts` failures explicitly report `Codegen error: ensureExnTag is not a function`; the two `issue-6774-expressions-residue.test.ts` rows stop at their compile-success assertion. Keep both their original diagnostic texts, without inventing a deeper recorded stack for the latter.

### Causal defect and exact correction

T2 moved cycle-heavy imports out of leaves correctly, but four producer-side singleton objects now snapshot imported function values while the large compiler module cycle is initializing. This differs from the old call-time access to an imported binding. The failing path is `object-runtime.ts::restOnlyApplyServices` (~322) → `buildRestOnlyApply` (~6373) → its destructured `ensureExnTag`. The production binding is imported from `registry/imports.ts`, which imports/re-exports the actual function in `registry/physical-imports.ts`. `buildRestOnlyApply` calls it to build exception handling after an admitted full-vector rest closure. A module-initialization snapshot can retain an unresolved re-export even though the live imported function is valid when compilation later starts. Do not substitute a dummy function, move exception registration, omit the call, or treat a TypeScript pass as evidence for initialization order. The precise correction must be confirmed by restoring the original seven actual native cases.

**Source ownership: exactly these four producer files, object initializers only.** The service API/callee implementation, call sites, canonical import targets, source eligibility and T3 lowering are unchanged. Convert every imported-function shorthand property in the following singleton objects into a read-only accessor returning that same live imported binding:

| File / object | Exact imported-function properties | Count |
| --- | --- | --- |
| `src/codegen/array-object-proto.ts::arrayFillServices` (~182) | clampRelative, requireObjectCoercible, resolveSliceDeps | 3 |
| `src/codegen/expressions/new-super.ts::builtinNativeConstructServices` (~226) | emitStandaloneArrayConstructor, emitStandalonePromiseFromExecutorValue, isStandalonePromiseActive, reserveBuiltinConstructorIdentityGlobal | 4 |
| `src/codegen/index.ts::nativeLeafServices` (~772) | nextModuleGlobalIdx, canonicalUndefinedExternInstrs, emitGlobalEnvironmentKey, emitGlobalEnvironmentObject, ensureGlobalEnvironmentOperation, localGlobalIdx | 6 |
| `src/codegen/object-runtime.ts::restOnlyApplyServices` (~322) | classifyClosureDispatchRest, buildClosureResultBoxing, ensureCurrentThisGlobal, installableReceiverInstrs, ensureExnTag | 5 |

For example, the exact pattern is `get ensureExnTag() { return ensureExnTag; }` within the existing `as const` object. This returns the canonical function object; it is not `(...args) => ensureExnTag(...args)`, which would substitute service identity and add a wrapper call to every invocation. Apply the same pattern to the complete fixed eighteen-property population, not merely the first function that failed in this entry order. No fallback, optional service, memoization, mutable singleton cache, registration API, or dynamically importing resolver is needed.

All four service objects and their eighteen accessor functions still allocate once per module evaluation. There are no per-instruction/per-call service objects or callback allocations, and no generated-Wasm dynamic dispatch. Existing leaves destructure the service at invocation, giving the same canonical callable reference available from the actual producer import at that time; the accessor itself is a side-effect-free binding read. Keep all existing `typeof import(...)` parameter contracts and all call argument order. Do not add a new graph edge or revert the physical try-table imports.

**Inspected exclusions:** `iterator-native.ts::liveArrayIteratorServices` (~111) has two same-module numeric constants initialized immediately above the object (11 and 12); it has no imported-function capture and stays unchanged. `promotedCaptureValueInstrs` receives `localGlobalIdx` directly at the producer call. `initializeOrdinaryNewTarget` and `ordinaryConstructTargetFrame` likewise receive their functions at invocation. `async-scheduler.ts::createPromiseRejectionEmissionBindings` (~112) creates its object when the resolver is constructed, not at module evaluation, and already defers dispatcher lookup; leave it unchanged. Thus the repair is four initializers / eighteen properties, not a new service architecture.

The exact four pre-edit pins are:

- `src/codegen/array-object-proto.ts`: 209040 bytes / `dcb0663660781a068f0ad995f78d380eb81249db352da105f4c0e0cc3a045544`.
- `src/codegen/expressions/new-super.ts`: 418654 bytes / `3755392b4c574e46fb801a3a40f2af504f1c5f405a5de859cb20ddf394f61d76`.
- `src/codegen/index.ts`: 772546 bytes / `1547b46009f41a04d4d474ced0ecb52be3703701c347652f1c520ebc34c6ce24`.
- `src/codegen/object-runtime.ts`: 552378 bytes / `339d6a3b989d632b12b9765264fd59853a4194cefeed980ee9354aad2bb55d5e`.

### Decisive validation and preserved controls

The existing nine-case callback test is a genuine standalone/Deno public compiler path: `compile(source, {target:"standalone", platform:"deno", hostBridge:"off"})`, then native `WebAssembly.Module`/`WebAssembly.Instance` with `{}`, followed by exported `run()`. Preserve that harness and all expected values. Five failed names are:

- rejects construction in a dynamic rest callback without entering the host
- preserves new.target through a runtime-sized constructor argument vector
- keeps non-rest array formals out of the full-vector rest shortcut (reversed=false)
- keeps non-rest array formals out of the full-vector rest shortcut (reversed=true)
- preserves receivers and thrown identity in full-vector rest calls

The two expression failures are the unchanged `S7 rest_binding_pattern_closures` and `S7 rest_binding_pattern_params` cases. Run these seven first under the same Node25/Vitest path, then both full original files (**9+21=30 cases**). Preserve the four previously passing callback controls: actual dynamic-constructor identity, escaping-arrow lexical target, construction-state clearing after throw, and target binding before parameter defaults. No source fixture simplification, host stub, interpreter substitution or removed assertion is permitted.

For a causal A/B, retain the frozen pre-correction failure rows; compare candidate native values against the same 30 actual source cases, and require all formerly passing cases retained. The source inverse is finite: replace only the eighteen getter spans with the exact original shorthand spans and require each complete four-file pre-pin. This makes unrelated source changes detectable. If root requests a kill-switch replay, perform that bounded inverse only in an ignored isolated source copy, not by faulting live source while metadata/native work runs.

A focused independent binding check may extract the four actual object initializers using TypeScript AST into an ignored diagnostic module, importing the same real canonical production namespaces. Read every property and assert strict identity with its actual canonical imported function, `typeof === "function"`, and repeated reads return the same function identity. Verify the production initializers are accessor declarations (no call expression or allocating wrapper in their return) and all eighteen properties are exercised. This is supporting source/identity evidence, not a substitute for the native public compiler cases. Do not expose a new production export solely for the test. If a cold import-order control is used, start a fresh process, actually import `src/index` and the canonical source modules through the supported Node25 loader, then compile the original native fixture; do not model the cycle with fabricated undefined functions.

Retain final native 560-case population and exact names when rerunning the frozen cohort after this correction; all original 553 passes must remain, all seven failures must become genuine native passes. Retain relevant existing T2 dynamic Array/Promise construction, array fill, linked prototype/shared Script variable, iterator and promoted-capture native controls. No blanket performance waiver: compare the existing source-preservation and representative compile-timing evidence on the same inputs, and require identical Wasm bytes for previously passing unchanged fixtures. Added work is at most eighteen trivial property reads across the existing invocation sites, not a per-instruction allocation; measure representative compile timing rather than treating that estimate as a pass. Exception tag allocation and generated imports/body instructions must retain their original order and identity.

Run ordinary strict TS, format/lint, build and actual unchanged-baseline import-cycle/flat-directory gates. Because these initializers add source lines and accessor bodies, run actual LOC/function gates against the real merge input; no implicit budget grant is issued here. Preserve the original class fix in `new-super.ts`; do not copy a whole older file. Refresh the four final source pins in the integration freeze after reviewed source completion; keep the original 21-row freeze as before evidence. Source-path membership, compiler-boundary classification rows and policy path transport are unchanged. The metadata worker can continue its authorized 21-file scope, but physical source-fault tests remain held until root releases custody. This correction does not add any C1 source intersection or change the four-instrument reseal plan above.

The architect modified only this appendix and ignored diagnostic evidence; root releases the four-file correction to the existing Sol source owner. Production source, tests, policy and C1 authority were not edited by the architect.


## Fresh delivered-main 6844 row composition, fixed outer successor (2026-10-06)

Publication preflight found actual delivered main `cdc0255882d45181072342d9fd57f291aca93092`, after merge input `abb3471c46bb9e7129b28812fe16313c857cda69`. PR6524 delivered issue6844's externref-backed class field initializers. PR6521 is still not an ancestor; do not use its prepared source as main. Neither existing branch policy proof may be published pretending its synthetic merge omits the new main row. Root preserves both prepared branches; it creates the position component's fresh composition worktree from exact cdc and integrates the Deno branch through a checked checkpoint and real main merge. This appendix authorizes metadata implementation after that source composition, not a source overwrite by the metadata owner.

### Exact new main input and two candidate policies

Read-only evidence is `.tmp/pr6341-main6844-spec/review.json` and the two ignored `*-combined-policy.json` files in the PR6341 worktree. The actual abb→cdc policy diff is **one 328-byte insertion**, with all other raw bytes identical. The row is:

```json
{"path":"src/codegen/classes/externref-class-fields.ts","state":"unmigrated","layer":"mixed-needs-split","destination":"backend-wasmgc","owner":"3518-coordinator","nextBoundary":"Separate AST/context-driven generation, physical resources and generated native runtime."}
```

It sits between `src/codegen/error-subclass-proto-chain.ts` and `src/codegen/class-proto-toplevel-write.ts`; both full neighbor rows are unchanged. Original main is 1837 rows / 588351 bytes / SHA256 `4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05` / blob `c5da824f89dded25e85e7e315825d2d61d97f906`. Delivered cdc policy is 1838 rows / 588679 bytes / SHA256 `e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e` / blob `6066caa751c06e8726076ee622311f509bdd5f77`. Its added row index is 1647 and raw before/after insertion offset is 542771. Preserve the exact indented insertion and trailing comma/newline from actual main; do not serialize the whole policy or sort rows.

| Lane | Own frozen policy (the output of new outer inverse) | Combined current candidate | Added-main row index / UTF-8 offset |
| --- | --- | --- | --- |
| PR6341 | 1855 rows; 594018 bytes; `59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694` | 1856 rows; 594346 bytes; `4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a`; blob `e70ee1b32f53de5d5935aa0ac52987959effc64a` | 1664 / 548059 |
| Position component6866 | 1838 rows; 588471 bytes; `a2e9c7243c13ae37b293f02ae19eba03f072db30195ce0479f0926488fa3de98` | 1839 rows; 588799 bytes; `3d497f1ec140ecd7056155e6e0a993801e126b93304af1a581820d779a979122`; blob `9c248ee6471ee50973d5da74ba2d7d06e9eee92f` | 1648 / 542891 |

These candidate bytes were constructed and inverse-checked in ignored evidence; they are not an installed merge result. After the actual merge, independently verify the final policy equals the corresponding candidate. If it differs, stop at the measured difference rather than changing a pin to whatever happened to merge. Deno compact data/files hashes are `5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7` / `fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9`; position hashes are `8c91785b4302f8f9b88641f325643e374484b54909c3bbc086c0456b5a6bdc9a` / `7ede92f695b2c32bbc8cb5dea5e59a3e2f89a24bf37852f757866601ad01a62a`.

### Finite implementation, separate ownership per worktree

Add a **new outer one-row proof**, preserving each existing own-step helper and receipt byte-for-byte. Use distinct files to avoid sibling lane authority collisions:

- PR6341: `tests/helpers/ir-deno-class-fields-main-successor.{ts,json}`, `tests/issue-4376-class-fields-main-inventory-successor.test.ts`. Export `captureDenoClassFieldsMainPredecessorPolicySource` and `captureDenoClassFieldsMainPredecessorPolicy` (raw string / descriptor-validated data channels).
- Position component: `tests/helpers/ir-position-class-fields-main-successor.{ts,json}`, `tests/issue-6866-class-fields-main-inventory-successor.test.ts`. Export corresponding `capturePositionClassFieldsMainPredecessorPolicySource` and `capturePositionClassFieldsMainPredecessorPolicy`.

Each helper has exactly one admitted current profile and one output profile from the table, and exactly one known main row/index/neighborhood and raw span. It freshly authenticates its own independently pinned complete receipt on each operation, using the already reviewed fixed-successor descriptor-first patterns. Validate primitive raw input and plain owned dense data before coercion/getters; retain raw/data/files/full-before/full-current hashes, exact top-level keys, every non-files field, detached output, complete one-span inverse and forward replay. No generic row finder/remover, glob, optional historical success, mutable registration, accepted-hash union, or cached proof. Keep current raw corruption distinct from historical operand mutation.

The new receipt also binds the exact **delivered-main lineage witness** above (abb/cdc identities, old/main complete pins, the main index/offset and identical 328-byte insertion). Independently prove that applying that insertion at 542771 to the complete original1837 text returned by the unchanged own step yields the exact delivered cdc raw pin. Thus the outer row is demonstrated to be delivered main, not merely a convenient row omitted from a candidate. No old artifact is rewritten or added as fictional current source; no network/Git lookup is needed inside the production test helper.

The Deno own eighteen-span receipt remains 27453 bytes / `b35c6b605ea4fd36f7c5cb2a4b46aff8eee49de4cfb675aa78a0d1dc5934e7d9`. The position own one-span receipt remains 2437 bytes / `b2afd57a2583d7a103b07ce1bcc577475023ee29f54ee433f115a6fcf43572b0`. Retain their helper bytes and complete independent expected profiles/spans. The common eleven-row `ir-main-inventory-source-successor` and every earlier authority remain unchanged.

For each lane's existing seventeen historical readers, wrap the **actual current operand** immediately inside the own-step inverse: `older(main11(ownStep(newMainRow(actual))))`, omitting only stages the particular independent historical proof deliberately constructs itself. The earlier exact 24-site census (19 raw, 5 semantic) governs; do not run a broad text replacement over mutation operands. The same four C1 reader files intersect. Preserve current source-reader fixture fixes, all old names, all receipts and intended guard diagnostics.

Adapt the own-step independent proof at its healthy current capture only: Deno `healthy()` currently ~737; position `independent()` currently ~117. Feed the freshly authenticated outer inverse result into all unchanged own-step profiles, original inverse/replay, authority trace and historical mutation controls. Add separate new outer tests over **actual combined raw/data**; do not make own-step tests silently accept a second epoch. Preserve Deno's 32 original proof cases and position's 23 original proof cases.

**Important physical-fault staging:** Deno's original physically-corrupted-full-policy case (~985) currently writes actual policy and invokes the own-step helper directly. Simply wrapping that faulted read in the new outer inverse would fail at the wrong guard; directly passing the combined profile to the old helper would fail even without the mutation. Preserve its old assertions and authority read counts by first obtaining the authentic own1855 operand through healthy outer capture, placing those exact full bytes in an isolated temporary policy file, then performing the same physical corruption/read/restore against that old-step operand. The own helper must see and reject the actual mutated file bytes. Preserve the original case identity; document its authentic own-step epoch. New outer proof separately performs corruption of the actual combined policy/authority after a genuine healthy capture, checks its precise failure and fresh read count, restores exact bytes, then proves healthy again. Do not project a corrupted actual current policy into a healthy old copy. Other historical semantic/raw mutants remain downstream of healthy capture, never passed through the current-only outer inverse.

The new independent proof must cover at least: exact combined→own→1837→delivered-main lineage/replay; unchanged1837 rows/non-files; missing/duplicate/renamed/moved/changed-profile main row; mutation of a retained own row; wrong-lane own-only/delivered-main-only inputs; raw prefix/tail/whitespace changes; malformed/boxed/missing fresh receipt; descriptor getter/coercion/sparse refusal; real physical current-policy and authority corruption followed by restoration. Record actual case denominators after collection; no invented future count or replacing old cases. Bind the new formatted helper completely in the independent proof.

### Actual source composition and C1 boundaries

Delivered cdc changes only two compiler source files: `class-bodies.ts` and new `classes/externref-class-fields.ts`. The new leaf is 5377 bytes / SHA256 `684aef792a744e765fbedef53131fe10b5438dcad9329cd86d148d79632ac51f`. Delivered `class-bodies.ts` is 231067 bytes / `bbe97df68729bde304d434bd76f592a6352861b0b47e6d33f8ef4051a3de9eb0`; use it as the main-side donor, not as the required composed Deno file hash. Its actual additions are the canonical leaf/type import, native string helper import, `emitExternrefFields` injecting existing operations, and once-only initialization routing for externref-backed non-collection classes. Preserve Deno callback/class state and the true before-super fix in composition. Never replace the whole composed class file with main. The position worktree starts on cdc and already owns this delivered source. The delivered five-case `issue-6844-error-subclass-field-initializers.test.ts` is 4988 bytes / `8dcc4c011175023c3d968b436fe39954a50c777f22799fb386d08b504b1cce53`; retain it unchanged and run its actual JS-host controls together with the Deno/class native preservation gates after source merge. No metadata helper may stand in for that source composition.

Neither new main compiler path belongs to the measured C1 source population/LinearOptions closure. Recompute the explicit intersection after merge; do not invent a new model/source seal. Only four existing reader instrument pins/recipes change again: data-contract-boundary, runtime-program-policy-evolution, well-known-symbol-policy-evolution, number-prerequisite-policy-evolution. Start from each lane's own current manifest: Deno now 405616 bytes / `085828915a6b2e531fcc283168bb371552df2fb025658f70065eb20d64a128df`; position 405820 bytes / `51ae067a17aeaad95417c8fbb3b7443c2a0952cd35a568934e55cec1755328f0`. Do not copy the other lane's manifest.

Root reseals only four current pins and their four existing recipes after final reader formatting, proving every unchanged immutable beforePin and all ten full inverse/replays. Keep seven artifacts, eleven immutable authorities, twelve instruments, ten recipes, all remaining fields and original declarations exact. Update anchor and external independentFreeze's manifest/anchor fields last with outside-scalar bytes exact; no source helper or old authority edits. The main eleven-row receipt, own eighteen/one-span receipts and prior full helper profiles stay immutable. New helper/proof tests are separately authenticated, not appended to a historical fixed instrument population.

### Release and validation order

1. Root completes the in-flight frozen native cohort before any source merge or physical source/policy fault. Preserve its exact inputs/results. Make the normal checked local Deno checkpoint, merge exact cdc, and resolve actual source/metadata conflicts with both old-main and Deno behavior preserved. For position, transport only its exact own component/adapters/approved fixture delta into the new cdc composition worktree; retain the old worktree as custody evidence.
2. Per-worktree Sol metadata owner installs only the combined policy/new fixed outer proof, 17 operand-site adapters and own-proof capture/fault-stage adaptations. Source remains root-owned. The candidate policy must match the measured table; no original1837 row/rule/activation change. Run new proof plus retained own-step 32/23 cases and exact real compiler-boundary inventory/normal mode. Counts are Deno1856 / position1839 classified modules, not the prior1855/1838. Do not confuse classified modules with raw discovered files/nonmodules.
3. Root prepares/reviews the four-instrument C1 successor, installs the anchor/scalar last, runs the C1 test and all17 readers with original names/statuses preserved and current fixture repair present. Actual source/policy-fault tests are serialized with native compilation and custody checked. Do not claim the new merge ready from old epoch results.
4. Run delivered6844's five real tests and the relevant final source/native preservation gates after Deno class composition. Normal changed-root hooks, budgets, import-cycle/flat-dir gates and production build use the actual fresh main as appropriate; no copied LOC baseline, allowed-edge expansion or retirement credit. Source-map public producer gaps/private Prepared guard and PR6521 remain separate.

This is a finite delivered-main prerequisite. The two lane-specific outer proofs deliberately do not claim to authenticate a future combined Deno+position merge. Re-ground that actual integration if/when both land; do not pre-authorize unseen rows or pin unions now. Architect wrote only these issue appendices and ignored candidate evidence; metadata implementation and publication are root-released work.


## PR6341 actual semantic fixture closure: three native Promise owners (2026-10-06)

The in-flight full run's healthy fixture failure is a test population defect, not permission to alter production imports. Preserve `.tmp/pr6341-current-main-full-validation/first-healthy-failures.json` and the eventual complete run unchanged. The 205-module fixture omits three actual Deno native owners, producing six unresolved imports and sixteen transitive failures before the intended semantic guards. Do not count those early failures as successful negative tests.

**Measured safely:** ignored `.tmp/pr6341-three-runtime-closure-spec/` in the OLD `codex-6341-main-composition-20261006` worktree contains `custody.json`, `review.json`, `eleven-edges.json`, `negative-review.json`, and real CLI stdout/stderr. All 208 frozen source files and the actual `check-compiler-boundaries.mjs` were independently hash/length checked against the current full run's `before-custody.json`; no current production file was read or faulted. The checker has no local script imports. An initial over-broad script-tree preflight stopped on the legitimately different LOC baseline before fixture construction; no result from that aborted attempt is credited. The completed bounded probes use the actual Node25 CLI with unchanged fixture rules and copied authentic production source.

### Only test file to modify after full-run terminal custody

`tests/issue-3518-semantic-provider-boundary.test.ts`; preserve all **353 case identities** and original historical receipts/assertions. No policy/receipt/C1/helper/production source changes. This file is not one of the four C1 current instruments.

Keep `priorLiveFixtureGroups`/`priorLiveRequired` (174), `groups`/`required` (106), and the exact 31 `sourceMapValidatorFixtureAdditions` unchanged. Retain the current composed 205 population as an explicit intermediate (for example `validatorLiveFixtureGroups`/`validatorLiveRequired`). Add a separate explicit `denoNativeFixtureAdditions` tuple containing only:

- `src/runtime/wasmgc/promise/reaction-order-bodies.ts`
- `src/runtime/wasmgc/promise/rejection-event-bodies.ts`
- `src/runtime/wasmgc/promise/resolving-pair-bodies.ts`

Compose final `liveFixtureGroups["native-runtime"]` from its existing 48 entries plus these three, preserving order and all other groups. `fixture()` continues to derive local clean rows, local layer minima/activation entries, and authentic file copies from those groups. Native runtime is 51; full copied population is **208**. Assert additions are three unique disjoint paths, final minus three equals the exact previous205 groups, and previous205 minus31 equals original174. Do not rename the 31-module validator domain to an unexplained 34, auto-discover an accepted expectation, or change a production activation rule.

### Exact report populations and unchanged original guards

`assertLiveFixtureClosure` must still require real CLI status0, graphComplete/inventoryValid, zero errors/unknown/unresolved/forbidden/transitive edges, and each module hash equal to actual source. Measured complete population: **208 modules / 988 resolved edges / 480 type-only / 508 runtime**, all twelve layer populations unchanged except native-runtime48→51.

Preserve prior counts as induced subgraphs of the actual complete report: edges with both endpoints in the original205 set remain exactly **977 / 476 type / 501 runtime**. Within that subgraph preserve original174's **783 / 404 / 379**, then the exact previously identified nodes→ir-unit-inventory type edge removal yields the unchanged historical **782 / 403 / 379** assertion. Preserve the 31-module validator increment **194 / 72 / 122** against prior174. The additional three-module edge complement is exactly **11 / 4 type / 7 runtime**; assert its explicit endpoint/type population from `eleven-edges.json`, not merely a lower bound.

Those eleven edges are six runtime incoming references: native-await→rejection-event; combinator-bodies→rejection-event; resolution-bodies→rejection-event and resolving-pair; settlement-bodies→reaction-order and rejection-event. The new owners add three type-only imports to wasm/model/instructions, resolving-pair's type-only import to resolution-bodies, and resolving-pair's runtime import to rejection-event. No additional dependency remains unresolved. Do not change any actual production import to type-only to shrink this graph.

Retain the input→validation runtime-edge assertion and both existing bypass mutations. Adjust only their exact measured totals for the authentic208 closure: removing the import gives **987 / 480 / 507**, type-only spelling gives **988 / 481 / 507**. Both real CLI runs exit0/errors[] and omit that runtime edge, so the stronger healthy-closure assertion must still reject both, followed by exact source restore and healthy208/988 pass. Keep the old205/977 baseline assertions separately; do not replace historical counts wholesale.

The original formatter negative was measured against the complete closure: healthy208/988 pass; adding its original `@forbidden` backend dependency gives exit1, **209 modules / 989 edges / 481 type / 508 runtime**, with the intended frontend-ts→backend-wasmgc forbidden-clean-edge plus migration-debt and transitive refusal; restore returns healthy208/988. Preserve the original assertions and healthy-first order. All208 ignored source pins were restored exactly after these probes.

### Acceptance boundary

Root waits for the current full2841 run to terminate and checks custody before implementing this one-file delta. Retain that run's original failure rows. First run the three existing affected cases (complete closure; input-validator bypass; formatter/backend negative) with their actual CLI and source fixtures, then the complete unchanged353-case file. No new case aliases, assertion floor reduction, original mutation removal, or full2841 rerun is necessary solely for this unbound test fixture correction when all other tested inputs remain exact. Any further unexpected closure/guard failure is reported at its actual stage; this amendment authorizes only the measured three owners and eleven edges. No retirement or source-map producer coverage credit follows.


## Current-main full authority cohort terminal — fixture correction release (2026-10-06)

The single actual current-root20-file cohort terminated exit1 with2838/2841 passed, exactly three known semantic healthy-fixture failures, zero pending/skipped. All2433 original registration identities and duplicate ordinals remain present (2431 pass/two original fixture failures); the added validator-removal witness shares the missing healthy fixture prerequisite. The complete C1current-source343, original own32 and new outer32 cases pass. Preserve full results, errors and original-case-attribution in `.tmp/pr6341-current-main-full-validation`; this is not a whole-suite green claim.

After-body custody matches all7755 declared inputs in SHA256, bytes, mode, inode and device, including every1858 source file, with no source addition. Actual termination and custody now satisfy the previously conditional release: edit only the existing semantic-provider test fixture according to the208-module/988-edge plan; preserve all353 case identities/assertions, run original three failing cases first and then the entire353-case file. No production, policy or C1 change or repeated2841 body follows from this fixture correction. Native565/565 remains attributed to its separate frozen run. Delivery of existingPR6341 remains pending predecessor composition, applicable checks, normal signed commit/push and exact protected admission.


## Fresh-main source-only composition after the Deno proof freeze (2026-10-06)

### Measured scope and release condition

This appendix is the finite source plan for existing PR6341, not a policy/C1 refresh or a new architecture. It uses the quiescent current Deno tree `codex-6341-current-main-composition-20261006`, the cached old-main object `cdc0255882d45181072342d9fd57f291aca93092`, and cached main `bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1`. Root authenticated that main; this static task read cached objects with `GIT_NO_LAZY_FETCH=1` and made no new delivery or ancestry claim. PR6535 being ready/auto-armed is not delivery. Root must authenticate actual main ancestry and contents, including the actually delivered source-position owner/row, before releasing a fresh regular integration worktree or any downstream metadata composition. If that actual main changes these operands, remeasure the changed intersection before implementation. Never restore an older source/policy/C1 snapshot over delivered main.

**Correction of the proposed conflict premise:** `.tmp/current-main-transplant/report.json` has **141 total rows, 81 source rows**, not 141 source rows. Of those source rows, 68 are existing files and 13 are retained deletions. Every one of the 81 current outcomes is byte-exact to its recorded transplant result. The exact intersection between those 81 paths (or all141 paths) and the five cdc→bba source paths below is **empty**. All four existing live Deno source files below equal cdc byte-for-byte; the new finally leaf is absent in both. In particular, there is no Deno-owned `exceptions.ts` textual conflict to resolve. The Deno typed-service and physical-cycle cuts are in other files and must remain whole. Do not manufacture an exceptions service object or retarget its unchanged `ir/try-table.js` import as part of this update.

The frozen current source inventory is 1858 files. Ignored `.tmp/pr6341-bba-source-composition-plan/` contains `source-pins.json`, `transplant-source-audit.json`, all1858 source and5522 test-file pins in `preserved-source-test-pins.json`, the literal cdc/prepared/bba operands, five ignored candidate sources, and `exceptions-reciprocal.json`. These are planning operands, not installed sources or compiler/test success evidence. All five candidate sources equal actual bba blobs.

| Source | Current Deno = cdc bytes / SHA256 | Required bba bytes / SHA256 |
| --- | --- | --- |
| `src/checker/oracle.ts` | 27313 / `67cbf9b425bba984f9e464c1047dc276736923332a58aaa829f164cd88aba370` | 27343 / `83aa8ba5ee5550eb4113425e19647d8dde6da169ee59cd3da19e350b227fd911` |
| `src/checker/type-mapper.ts` | 27354 / `7211764a0103f75ddb69a77ee262b216386c625c9821e64b9628e4cfe4a4bdf9` | 27321 / `5816dcbd6fa6c5ce07ae9af769f094aa9ed4cda5692c87173d6f4b04dff48295` |
| `src/codegen/statements/exceptions.ts` | 39684 / `d6746e9d53db210a3aaf0d45a77013d01811f4b01777ea382b66cd7be637451f` | 39769 / `134f950290b797d53ef9cd72ce9f4d50537ec2a56b7f06788340b721671fe6f2` |
| `src/codegen/statements/finally-private-local.ts` | absent | 517 / `60d0da5027c4f525bdd138f33b6788635966968add54b9ee8d41ef87f6240086` |
| `src/ir/passes/monomorphize.ts` | 36127 / `9d04e4f0598fda871e64cba20651fa67ec20d7ed692856b499374334b77351af` | 37589 / `beac92656855188abf73937042194d19985decd2935391dd26138a41af86b0e5` |

### Exact exceptions and allocator composition

The smallest three-way result for `exceptions.ts` is exactly bba because ours equals the common cdc operand. The saved reciprocal has two fixed UTF-8 byte spans; offsets are zero-based and measured against complete pinned files:

1. Insert the literal 71-byte `import { allocFinallyPrivateLocal } from "./finally-private-local.js";` plus newline at before/after offset1442, immediately after the existing createFinallyRanGuard import (new line25).
2. At before offset21653 replace the 49-byte `createFinallyRanGuard(fctx, tagIdx, stmt, allocLocal)` with the 63-byte `createFinallyRanGuard(fctx, tagIdx, stmt, allocFinallyPrivateLocal)`; its after offset is21724 (new line436).

Apply in descending before-offset order, verify the complete39769-byte candidate hash above, reverse in descending after-offset order, and require the entire39684-byte original. That exact +85-byte change already succeeded as ignored static construction. No row search, fuzzy context fallback, normalized token match, or guessed current operand is an acceptable replacement for those complete-file preconditions. Copying the whole authenticated fresh exceptions blob is also equivalent here because the measured Deno/common-base equality is exact.

Install the delivered517-byte `finally-private-local.ts` alongside that caller. Its function accepts the existing allocator signature, allocates `params.length + locals.length`, appends a local named `finally@private$${index}` with the supplied type, and returns that index. It has only erased type dependencies on the IR ValType and FunctionContext declarations. It does not add a registry, closure, context capture, service fallback or dynamic binding. This private name deliberately does not begin `__`, so existing `deduplicateLocals` (which merges only `__` names) cannot alias the guard with a source temporary. It does not enter `localMap` or the temporary free list. Existing rollback truncates the local vector; the delivered tests cover remapping, rollback, parameter collision, closure reads and direct eval. Leave `context/locals.ts`, `finally-ran-guard.ts`, catch temporaries and ordinary allocLocal calls byte-exact. The guard's existing async no-op remains; this change does not claim to fix await-rejection semantics.

`oracle.ts` and `type-mapper.ts` take their exact delivered StringLike changes. `monomorphize.ts` takes its exact delivered specializationSite and recursive allocation-fork changes, including the early malformed-return check before minting clone allocation facts. Preserve generated owner retargeting, actual donor/cause, parent-first nested allocation order, alias handling and unchanged/no-map semantic controls together. Do not hand-port only the simple instruction map or only the new helper declaration. No Deno hunk exists in these three files.

### Preservation and ownership

Root is the single integration owner. After verified predecessor delivery, create/reuse an explicitly released fresh regular worktree, carry the existing Deno vector and its reviewed metadata as historical operands, and assign one Sol6.1 Medium source implementer the five sources above plus exact inheritance of the three delivered tests `issue-5267-finally-reentry.test.ts`, `issue-6868-template-literal-string-types.test.ts`, and `issue-3525-source-map-specialization-origins.test.ts`. Their saved bba pins are respectively26428/e9a7983a0c5b5437430a4e560ac765bd9c0e65cb9573e45e20c9247ed87c76d2,2202/95995b38e7c2ccd4d296adc2fe47b3b2f3c65812968a72c864566184227802fa,25316/2194021ab05c768491f1c1ffec05fa68653550dc13625af8cc2c06effc883820. Normally fresh main already supplies them; the task is to retain their exact delivered contents. Do not add duplicate regressions or rewrite their assertions. A separate Sol6.1 Medium read-only validator may inspect this source vector, collect selected tests and read source-bound instruments without concurrent source writes. Serialize actual source execution with any physical source-fault bodies.

Require every unaffected source and test byte to match the saved vector or the explicitly authenticated subsequent-main delta. In particular preserve the entire original81-row Deno source outcome, including deleted old leaf locations; the18 live-binding getters in array-object-proto/new-super/index/object-runtime; canonical services and two physical exception-control imports in relocated ordinary-new-target/rest-only-apply; class-bodies' enclosingClassName propagation; new-super's proven abrupt GetThisBinding return via VOID_RESULT; ordinary classes, super sequencing and actual ReferenceError behavior; and T3 async dispatcher/runtime-builder injection. None is in the five-path write set. No separate6772 claim changes, stale whole-file copies, restored deleted aliases or compiler routing changes follow. The normal legacy/public compilation path stays supported until full parity, with no retirement credit from this composition.

A source-reader owner has **no automatic tracked edit** in this release. Static search found one relevant old receipt: `tests/issue-3518-typed-async-preparation.test.ts:54` expects22 declarations/digest `ae9b7b3d2efe29a83b8cafa983c8aa96d3b267d30a7b5db6b1b52f38c475a0e5`. The complete test is unchanged between live Deno and bba (12888 bytes / `e223f825591af1d1c980088a06d2f6d47b2416abffea3446584b815576ed1686`). Using its exact TypeScript AST extraction rule, cached cdc already has22 / `8f4e85e1308cb1bb6ae27380195252ac615672b6242a2d75d74252e98f696d15`, and bba has24 / `333d8d183461a65f11f403367327313681374be4816dcbdcd3db5907643e11f2` (new specializationSite/forkSpecializationAllocations). `declarations.json` preserves that static measurement; no test body was executed here. Preserve and report the original assertion if selected: it is pre-existing source-receipt debt, not proof of a new Deno regression. Do not repin22→24 or replace the historical digest to conceal it. Any requested reader repair requires a separately bounded, reviewed finite source successor from the real historical declaration operand, retaining its original receipt and a whole inverse; that historical source closure is not established by this appendix. This restriction does not block independent review of the five exact source blobs.

Policy path readers also mention exceptions/finally-ran-guard as classification neighbors. Those are policy DATA operands, not evidence that either source body is C1-authorized. Do not refresh their receipts, install guessed row unions, rebase historical C1 recipes, or copy the old prepared C1 metadata into new main. The subsequent actual source-position delivery and delivered finally row must be composed by root's separately released exact authority plan. This appendix supplies no new C1 source-intersection claim for that future vector.

### Bounded acceptance on the eventual released source vector

Run meaningful source checks after all five files and the authentic predecessor are present, preserving complete registration identities and actual diagnostics. Existing saved passes remain evidence for their measured old source epoch; they are not a substitute for these affected controls and do not authorize a default full2841 repeat.

- Run the complete delivered `issue-5267-finally-reentry.test.ts`: actual native default/standalone execution, all exit modes, nested/repeated entries, exception identity, host exception route, loop depths, private-slot dedup/rollback and direct-eval/parameter collision controls. Retain `issue-1858-finally-else-break.test.ts` and `issue-2061-finally-clone-depth.test.ts` as bounded existing branch-depth controls. Keep their real imports and native instantiation; a compile-success assertion alone is insufficient.
- Run all three delivered template-literal cases with standalone, native-first and default options, retaining length5, mapped length3 and concatenation `ab-cd!`. Include `issue-4607-typeof-string-carrier.test.ts` to protect the adjacent existing string-carrier behavior. No host stub or alternative route may substitute for the requested compiler path.
- Run the complete delivered specialization-origins suite and existing `issue-3520-monomorphize-identity.test.ts` and `issue-3520-monomorph-program-abi.test.ts`. Preserve genuine frontend sourceMap capture separately from productive DATA-builder clone cases. The ABI test deliberately injects contract-shaped clones; report it as that seam, never as naturally observed frontend specialization. Require mapped/unmapped and legacy-site controls, unchanged canonical semantic bytes/counters, generated instruction and terminator owner retargeting, distinct nested allocation identities, preserved original registry rows, unresolved/stale failures, and malformed-return rejection before registry mutation. Run `issue-3525-source-map-safe-passes.test.ts` for its actual source/no-map pass invariants. No success here implies completed public physical source-map rendering or byte-offset coverage.
- Recheck the original T2 nine callback/new.target plus21 expressions-residue cases (30 total), then the existing seven super-method abrupt-completion controls,51 ordinary-class residue cases and five main error-subclass initialization cases. Preserve the exact six-clause original63 and diagnostic45/ReferenceError assertions and all previously healthy rows. Add the existing four IR await/async.throw rejection-event controls and38 compiled rejection-event cases to cover the unchanged Deno dispatcher on the newly composed compiler; their values/carrier identity/imports must be real. This bounded135-case Deno subset is drawn from the frozen565 population, not a redefinition of it. The remaining frozen430 old cases are retained as historical evidence unless an actual changed dependency/failure requires expanding the run.
- Capture emitted bytes/import lists for the unchanged healthy selected fixtures where the prior harness already supports comparison. Require byte equality only when semantics and compilation inputs are unchanged; the formerly incorrect finally/private-local or monomorph origin/allocation cases must use the corrected semantic/identity expectations, not pin wrong old output. Compare sourceMap-off/default controls and actual instance results. Keep timing held until root releases a separate stable-vector measurement window; no inferred performance pass.
- Run normal strict TypeScript, build, formatting/lint and actual changed-root import-cycle, flat-directory, LOC/function and inventory gates against the real predecessor. Added finally leaf has no runtime outgoing dependency and source-only typed imports do not excuse a failing actual gate. A newly observed source graph or receipt failure is classified and recorded before broadening scope. Do not change old budgets, source assertions or identity floors to obtain a pass.

Preserve the complete prior evidence chain: original seven T2 failures (five actual ensureExnTag-not-a-function diagnostics plus two compile-success assertions), their repaired30 and560 evidence, the separately frozen565/565 result with all original560 identities retained, and the frozen207 guard record without changing its population. Preserve original2433 metadata registration identities/duplicate ordinals and the actual2841 run's2838 passes/three original fixture failures. The observed one-file repair is independently terminal:3/3 focused then353/353, unchanged353 identities/ordinals,7755 input restoration exact with only the authorized semantic-provider test changed, all1858 sources/policy/helpers/C1 exact. Its composed2488+353=2841 unique observed passes is not a second whole-cohort run. Keep those original failures and the exact353 repair recipe; no automatic replay of unrelated long physical fault bodies follows merely from these five delivered source paths. Conversely, new source inputs must never be silently attached to old custody receipts.

Architect output is append-only issue text plus ignored static evidence. No source, test, policy, C1, Git state, claims, network state, benchmark or test body was modified/executed by this task. Final delivery remains root-owned and conditional on real predecessor admission, source composition, applicable authority checks and normal protected PR admission.


## Delivered 431 main: finite Deno source conflict composition (2026-10-06)

### New source epoch, preserving the earlier plan

Root has now authenticated `431aa4ed7a7be13c922332ab14a85ff05de1ac44` as main and verified the source-position PR6535 head46d9 and merge18d811 as ancestors,33/34 delivered files byte-exact, and all1840 owned policy rows retained alongside four unrelated main rows. This is root's recorded delivery authentication, not a new GitHub query by this architect. The prior “wait for actual source-position delivery” condition is satisfied for this named epoch; final assembly still requires root's fresh ancestry/content and authority check at release. Do not commit the old prepared Deno tree's pending cdc merge or substitute its policy/C1 state for current main.

Use the completed independent inventory, without replacing or silently relabeling its earlier10f6 checkpoint: `.tmp/pr6341-new-main-overlap-10f6/final-inventory.json`, SHA256 `f88d14b31020194ef8f79fed82118e6f344938631a54a5b074f8127fa8fb07ad`; final-boundary-review SHA256 `5f599f87654a96816e803a22dcf86b902b98cbb3ab8b1a54ee95f36623d17df8`. Its exact cdc→431 population is24 source paths, intersecting the81 Deno source outcomes in exactly **three**: closures.ts, context/types.ts and typeof-delete.ts. The source-position projector is the24th new-main source path beyond the earlier23-path10f6 inventory; it is not a fourth Deno overlap. All81 old Deno outcomes remain pinned before composition (68 files/13 deletions).

The earlier five-source bba plan remains intact. Limited cached431 reads prove all five ignored candidates still equal current431 byte-for-byte; in particular exceptions.ts still has the exact two-span +85-byte finally change, and finally-private-local.ts remains517/60d0da5027c4f525bdd138f33b6788635966968add54b9ee8d41ef87f6240086. Preserve that complete prior appendix, its operands and its controls. The other current-main sources, including the delivered19589-byte source-map-position.ts (`7d01bc176fa419d8249078ee68328daa8e6d8831992f723d40a3407e57a2f1b9`), remain exact current-main inputs. This appendix adds only the three-overlap composition and one existing main leaf extension; it neither invents a broader Deno conflict nor retires a compiler path.

### Reader/mutator boundary and semantic conflict

`compileTypeofExpression` and `compileTypeofComparison` are separate code-generation ladders. Each reads checker/oracle declaration facts and may emit an unresolvable-name constant; fixing one ladder cannot fix the other. Their cdc conflict lines are1842 and2269. Deno's expressions are `!!sym?.valueDeclaration || importedIdentifierHasRuntimeBinding(ctx, ident)` and its logical negation; main's are `typeofOperandIsDeclared(ctx, ident, sym)` and its negation. Main adds one static import for that existing leaf. Deno adds a12-line local runtime-import-syntax predicate. These are real same-line semantic conflicts, not interchangeable spellings.

The oracle APIs deliberately answer different questions. `valueDeclarationOf` returns the local symbol's valueDeclaration or first declaration (oracle.ts:432–450); import aliases therefore expose their ImportClause, NamespaceImport or ImportSpecifier syntax. `aliasedValueDeclarationOf` follows the checker alias and returns the target valueDeclaration or first declaration (452 onward). It catches lookup failure and answers undefined. Main's1032-byte `expressions/typeof-import-binding.ts` first accepts a symbol's valueDeclaration, otherwise requires Alias and a non-undefined target declaration. Deno accepts the three local runtime import forms even when no target declaration is available and explicitly rejects their type-only forms. Neither predicate reads an import's runtime value, updates the binding, registers a host import, emits instructions or owns source-map authority. Oracle caching is the existing owner behavior; introduce no new cache or symbol registry.

| Observed binding facts | Deno local predicate plus old valueDeclaration arm | Current main predicate | Required composition |
| --- | --- | --- | --- |
| Ordinary symbol with valueDeclaration, no import syntax | declared | declared | unchanged main fallback |
| Named/default runtime import with a target declaration | declared | declared | declared |
| Runtime namespace import | declared from local syntax | depends on available target declaration | declared from local syntax |
| Recognized runtime import with unavailable alias target | declared from local syntax | undeclared when target lookup is undefined | declared binding; preserve real downstream resolution/diagnostic behavior |
| Explicit type-only ImportClause/NamespaceImport/ImportSpecifier with a resolved value target | erased by Deno syntax rule | may be declared through target resolution | erased; target existence cannot restore a removed local binding |
| Other alias with a target declaration, outside the three Deno import forms | no new Deno admission | declared | retain main's alias-target fallback |
| Truly absent symbol/declaration | undeclared | undeclared | undeclared |

These are predicate-domain implications of the inspected code, not newly executed fixture results. A runtime import's declaration does not prove successful linking; do not turn an unresolved module/export into a successful program, fabricate an undefined imported value or swallow checker/lowering errors. Conversely, missing target metadata is not permission to fold an existing runtime binding to undeclared. This plan covers the exact three import forms already handled by Deno; it does not introduce new import-equals/re-export erasure rules or general alias support. Re-exports consumed through these local imports must retain their actual live values through the normal resolver.

### Smallest exact source composition

Use the existing main leaf as the one shared predicate. Before its current `if (sym?.valueDeclaration) return true;`, obtain `const declaration = ctx.oracle.valueDeclarationOf(ident);`. When that declaration is present, decide the same three syntax forms with Deno's exact checks, in this order: ImportClause returns `!declaration.isTypeOnly`; NamespaceImport returns `!declaration.parent.isTypeOnly`; ImportSpecifier returns `!declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly`. For every other declaration, continue through main's entire unchanged valueDeclaration / Alias / aliasedValueDeclarationOf fallback. Syntax returns must precede that fallback so a type-only alias to a real function cannot be re-admitted. Do not combine the existing predicates with an unconditional OR.

Keep main's two call sites and its import in typeof-delete.ts. Remove the now-duplicated Deno local predicate from that file after transporting its complete domain into the leaf. This yields an exact-current-main typeof-delete.ts, with the preserved Deno semantics centralized in the existing main leaf. No call-site traversal, resolver API, code-emission ordering, ambient-global unavailable checks, with-scope/Annex-B handling, eval binding fallback, return type or operator semantics change. In particular the nearby unavailable-host checks and undeclared-name comparison branches stay whole.

closures.ts and context/types.ts have **disjoint** base spans. Merge both sides literally rather than choosing either whole file. In closures retain Deno's initializeOrdinaryNewTarget typed-service call, lexical arrow new.target capture, and the undefined-valued getter carrier/explicit contextual-Void distinction. Retain main's host-boolean-callback import, callback result normalization, FunctionContext flag initialization, and Boolean-specific expression boxing branch. In context/types retain both Deno standalone realm interface expansions (exceptionTag/owns/get, microtask notification and Script-var binding controls) and main's optional hostBooleanReturn field in FunctionContext. The latter is consumed by main's delivered callback/control-flow code; do not drop its producers or consumers while importing Deno's context file. All other main callback, optional-formal, Date host-method and prototype argument fixes remain actual431 bytes.

Ignored `.tmp/pr6341-431a-source-composition-plan/candidate-review.json` records a concrete static candidate; none was installed:

| Candidate path | Bytes / SHA256 | Static construction |
| --- | --- | --- |
| `src/codegen/closures.ts` | 236920 / `04ee166d90dc0ecadea690e7ace2a3f325a701efe990bac2eefd0ccb614056b8` | all8 Deno and5 main base spans disjoint; exact literal union |
| `src/codegen/context/types.ts` | 274352 / `e1b3037944d8ef5197819fd1e23a086fe75761625dd3a150e7ff35e4502e4f41` | both Deno spans plus the1 main span, disjoint |
| `src/codegen/typeof-delete.ts` | 126616 / `f72eb98de3061cc1ddca639ca75380913e6100b00883e77ca71969435e44dd8f` | exactly431 caller/import body; local duplicate removed |
| `src/codegen/expressions/typeof-import-binding.ts` | 1572 / `4a28c54896c1d7a0ff9508411b85a6f05c9dc36cdb97f3bba337043060aeebb4` | one540-byte insertion at UTF-8 offset837 of1032/`f42d2b49835fdcd98038448a0c67f065093f331b0a6d85260324198e0f35ce0b` main leaf |

The saved reciprocal records fully replay/invert five closures spans, one context span and four typeof-delete spans against the actual prepared files; removing the leaf insertion recovers the complete actual main leaf. These exact bytes are review operands, not runtime acceptance. An implementer may adjust formatting/comments if normal gates require it, while retaining the precise domain and recording final pins. Preserve the original candidate operands and all main/Deno source pins so a new implementation delta remains reviewable.

### Ownership and genuine acceptance

Root alone owns fresh regular-worktree integration and actual predecessor admission. One Sol6.1 Medium source owner gets exactly the four paths in the candidate table; the earlier five-source transport remains the separately specified exact-main inheritance. Another Sol6.1 Medium test owner may write only a new `tests/issue-4376-imported-typeof-composition.test.ts` for the missing boundary controls below. It must leave the existing Deno and main tests byte-exact, read the source owner's frozen vector, and coordinate execution with root; parallel file preparation does not authorize concurrent physical fault mutation. Root separately owns policy/C1/current-reader composition derived from the actual431 policy and delivered position component. No metadata or old receipts are rewritten in this source task.

Required smallest source controls, keeping their public/native harnesses and original expected values:

1. Run both existing `issue-4376-imported-typeof.test.ts` gc/standalone rows unchanged. They cover default and renamed runtime imports, callable, namespace, bound undefined, missing name, erased type-only Shape, mutable object→undefined import, direct/materialized and comparison forms, and the module-initializer guard; both must still return42 using the real result.importObject/instance binding. Do not replace imported declarations with same-file variables.
2. Run the complete13-row delivered `issue-6417-axios-residual-mechanisms.test.ts` unchanged. Its imported-function materialized result must be `function`, comparison `true`, absent global property `undefined`; expression/block host boolean validators must return `ok`, the false validator must still throw. Retain all optional-formal, Date/object-tag and prototype toString controls as well: they share the actual compiled package and establish that preserving the other main source bodies had a real effect. Keep its allowJs/experimentalIR/gc/web compileProject path, real WebAssembly instantiation, compiled imports and export wrappers. Neither this suite's property-absence control nor its JS package fixture replaces Deno's bare missing identifier and native standalone controls.
3. The new finite gc/standalone composition witness should exercise explicit `import type` of a real callable/default value/namespace and inline `import { type callable as Erased, callable as Live }`, using actual modules with skipSemanticDiagnostics as in the old test. Require both materialized typeof and equality/inequality forms to report erased names as undefined while Live still calls the real function and reports function. Include a runtime namespace and renamed live export through an actual re-export module; perform a real owner update and observe the changed imported value through both typeof forms. Preserve bare missing-name behavior. These missing controls distinguish syntax-first composition from a superficially passing OR of the old predicates; the old type-only interface alone does not prove a value-bearing alias remains erased. Do not add success expectations for malformed/unlinkable modules. For unavailable-target predicate coverage, use an actual checker/oracle source diagnostic witness and retain the resulting compile refusal; any supporting isolated predicate check must use its real declaration/symbol facts, not a forged successful compiled module. Record the actual collected population; this plan does not invent a new pass count.
4. Re-run all9 existing callback-new-target rows and the unchanged persistent-script-environment suite to cover the disjoint closures/context combination: ordinary vs lexical new.target, thrown construction-state restoration, full-vector rest callbacks, escaping reads of live shared state, original-realm getter exceptions, foreign typed-slot refusal and the opt-in-inactive control. Do not recopy an older new-super/object-runtime/index/array-object-proto file: the18 live-binding getters and physical exception-control dependency cuts stay whole. Retain the earlier bounded class/super/finally/template/monomorph source controls as already specified; new source-dependent failures may justify further named cases, not an automatic complete old-corpus replay.

Freeze the final sources before execution; check real imports/results, preserve every old registration identity/assertion and retain all failures at their observed stage. A disjoint source merge is not behavioral proof. Normal source TypeScript/build, format/lint, actual import-cycle/flat-directory and changed-root budget gates remain required without weakened baselines. There is no fresh runtime, timing or compiler-equivalence result in this static appendix.

Historical565/565 native evidence and the actual2841 metadata run's2838 passes/three fixture failures keep their original epochs and custody. Preserve the separately observed3/3 plus353/353 fixture repair and2488+353=2841 unique observed composition, not a fictitious whole rerun. The new13 main cases and missing-domain controls must be measured on the final composed vector rather than borrowed from old565, and the unchanged metadata proof does not automatically authenticate new source or policy. Keep all original T2 failures, the207 guard freeze, class ReferenceError evidence and prior source-map limitations. Legacy/public compilation stays available; no retirement, broad row acceptance or performance claim follows.

This architect reused the independent final inventory and inspected only relevant cached immutable source/test blobs plus the old prepared source. Only this appendix and ignored `.tmp/pr6341-431a-source-composition-plan` evidence were written. No source/test/policy/C1, Git state, claims or network changes and no test/timing runs occurred.


### Root's concrete fresh-worktree release

Root has created `worktrees/codex-6341-post-6535-main-composition-20261006`, branch of the same name, at HEAD60f99 with the active merge input exactly431aa4ed. The existing4376:6341-main-composition claim was updated and effect-verified for that root-owned integration branch; the old prepared worktree/merge input remain preserved. Raw Git conflicts are compiler.ts, class-bodies.ts, expressions.ts and typeof-delete.ts, saved by root under `.tmp/post-6535-main-composition/original-conflicts`. The first three already have reviewed resolutions in the old81-outcome Deno vector. They are not three additional cdc→431 semantic intersections; keep the old resolutions while using the three-way prepared/cdc/431 operands above.

For this concrete release root assigns **one Sol6.1 Medium source owner** the81 prepared source outcomes, existing main typeof-import-binding.ts leaf and existing `tests/issue-4376-imported-typeof.test.ts`. This supersedes the proposed separate new-test-file lane above: retain the original two rows and every original assertion byte-for-byte, appending the bounded missing-domain witnesses in that already assigned test file if needed. Only the measured three overlapping source files plus leaf require new composition logic; the other prepared source outcomes retain their exact reviewed contents/deletions, and unowned main files retain431. Root owns other tests, policy/C1 and final assembly. This source implementation may proceed now; the separate replay-helper typing PR6538 has no runtime-JavaScript change and is not a source-composition dependency. Its eventual strict-typecheck improvement remains separately attributed. No new implementation or extra worktree action was performed by the architect.


## Post-source-position Deno metadata and C1 composition (2026-10-06)

### Source checkpoint qualification and scope

Root reports a real40/40 source checkpoint (4 imported-typeof controls,13 axios controls,9 callback controls,14 persistent-Script controls) and source TS7 exit0. The subsequently added fifth imported-typeof witness uses a real unresolved ImportSpecifier with TypeScript diagnostic2307, no resolved alias target, and the syntax-first predicate returning true. Actual compileMulti calls with both typeof-only use and a missing-function call return success in the existing external-host behavior. **Withdraw the earlier proposed compile-refusal expectation for that witness.** Preserve the failed test-attempt reports and genuine checker/predicate witness without inventing a malformed-import refusal, requiring fixture hunting, or expanding this task into a module-linking repair. This corrects the earlier plan premise, not the compiler result. The final five-control run, formatted source pins and complete final source-vector reconciliation are still pending the source owner/root freeze;40/40 is that actual checkpoint, not a prospective41-case claim.

This appendix owns metadata planning only. Root is the sole4376 integration/authority owner in `codex-6341-post-6535-main-composition-20261006`. Source-position PR6535 is actually delivered and its claim completed; its previous wait condition is released. Replay-helper typing PR6538 is separately owned and not a runtime-source prerequisite. The source worker remains owner of the81 source outcomes, typeof-import-binding leaf and imported-typeof test. No changing source body was read as a final authority here. The measured policy data and delivered test-authority files below are stable predecessor operands, while any final source/declaration/closure hash acceptance remains **pending root's source freeze**.

### Exact four policy operands

Current main policy is1844 rows,590452 bytes, SHA256 `31dbefa4d9ed8b3d429932c96d936315b08d0d1457080e9cabbb7aa7f5ffe584`, blob `13d33314077927422c0cd8ee3d6e985941f50371`. Old prepared Deno policy is1856 rows,594346 bytes, SHA256 `4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a`, blob `e70ee1b32f53de5d5935aa0ac52987959effc64a`. Their shared rows are deeply equal in the same relative order; every non-files field is equal. Exactly18 Deno rows are absent on main, and exactly6 main rows are absent from old Deno. There is no changed classification row or allowed-edge/layer repair to invent.

An ignored exact composition inserts those18 original Deno row objects, in their preserved relative order/neighbor locations, into actual main. Candidate: **1862 rows,596119 bytes, SHA256 `99b1c972702656d37aa70a993953b367efba19f3907eb76aed83864c1b77442e`, blob `9e8d4f0cac4690e7ccb1daf2e5cf85dd5339b0f4`**. Compact data hash `098ac5f16c3568e524c69fd8df087808f08b743f63db26fe9603824f09a4988c`; files hash `eb22b758ec730e77ffe380a09ad7bd6e2558324cc563079aa665a8077745ac11`. All four operands retain non-files hash `3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce`. Actual raw formatting is preserved, including compact arrays outside files; a whole-file JSON pretty-print is not equivalent.

The18 rows are exactly those in the preserved Deno successor: reaction-order/rejection-event/resolving-pair native bodies and physical allocation-owner, plus the14 existing mixed/debt rows at the already approved canonical Deno paths. Preserve the13 earlier relocations and their old-path absence. Keep every current-main row, including the clean source-map-position projector, finally-private-local owner5267, and these four later main leaves: object-model/proxy-forward-carriers, expressions/callable-property-omittable-param, closures/host-boolean-callback and expressions/typeof-import-binding. Those four carry their actual main mixed-needs-split/owner3518-coordinator/backend-wasmgc profile. Source implementation changes do not license declaring any of them clean.

`.tmp/post-6535-metadata-plan/policy-profiles.json`, `policy-projections.json` and four saved policy operands establish three exact data/raw relationships:

| Exact subtraction from the one1862-row candidate | Exact output | Purpose |
| --- | --- | --- |
|18 Deno rows,16 coalesced raw insertion spans | actual431 main1844/590452/31dbefa4… | lineage proof that all main bytes survive |
|18 Deno rows plus the4 later main leaves,18 coalesced raw spans | delivered position predecessor1840/589117/`58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857` | input accepted by existing position-finally successor |
|6 main-only rows (position,finally,the4 later leaves),4 coalesced raw spans | exact old Deno1856/594346/4ee416b7… | input accepted by existing Deno class-fields successor |

These are fixed named transformations of one complete measured current profile, not a general row-union acceptance algorithm. Neighbor/index records and literal full raw spans are already in ignored evidence. Source membership is not newly certified by this static candidate: root must reconcile the18 real paths/deletions and entire source inventory after the source freeze, then install the reviewed policy once. Never copy old1856 policy over main1844 or accept both arbitrary policy hashes as current.

### One bounded outer successor, immutable inner authorities

Add only `tests/helpers/ir-deno-post-position-main-successor.ts`, its fixed JSON receipt of the same stem, and `tests/issue-4376-post-position-main-inventory-successor.test.ts`. The helper has two explicitly named predecessor routes, each with raw and semantic entry points:

- `captureDenoPostPositionMainPredecessorPolicySource` / `captureDenoPostPositionMainPredecessorPolicy`: current1862 → exact position1840.
- `captureDenoPostPositionDenoPredecessorPolicySource` / `captureDenoPostPositionDenoPredecessorPolicy`: current1862 → exact old Deno1856.

There is no public target-profile argument, registry, inferred epoch, automatic row search, cached authentication or permissive fallback. Both routes accept only the fixed1862 complete current profile and use independently pinned fixed predecessor/receipt constants. The receipt binds both full predecessors and the actual1844 main lineage proof, exact row objects/neighborhoods, non-files data, raw spans and reverse replay. A private finite implementation may share the existing descriptor capture/hash/span arithmetic; it must not introduce a reusable successor framework or weaken a guard. Do not derive expected authority from the supplied receipt, caller hash or current file under test. The independent new proof freezes complete formatted helper/receipt pins and independently asserts the measured operands.

Preserve the existing raw-primitive/semantic-descriptor-first refusal order: no getters, coercion, holes, boxed primitives, nonplain structures or input mutation. Authenticate actual receipt bytes afresh on every API call before accepting a profile; missing/corrupt/wrong-reader authorities must fail after a healthy warm capture and recover only after exact restoration. Validate entire current and predecessor raw pins, parsed profiles, ordered keys/rows/non-files fields, in-bounds exact UTF-8 spans, whole inverse and whole replay. Preserve the actual historical main/deno before pins; a future main profile requires a new measured release, not relaxed acceptance.

Transplant the old Deno18 and Deno class-fields helper/receipt files **byte-exact** from the prepared worktree. Leave all delivered position own1, class-fields and finally helper/receipt bodies byte-exact. Keep their existing independent negative controls and fixed read counts. They are not rewritten to recognize1862. The two output chains are:

`1862 → new main route1840 → existing finally1839 → existing position-class-fields1838 → existing position-own1837 → existing main11/historical consumers`.

`1862 → new Deno route1856 → existing Deno-class-fields1855 → existing Deno18 successor1837 → existing main11/historical consumers`.

Both end at the same1837/588351/4b442f64… operand. The second route exists for preserving the actual Deno32+32 proof populations and physical controls, not for replacing main's delivered initial-reader chain. No duplicate class-fields adapter or alternate unverified policy family is added.

###17 initial readers,24 sites; preserve fault boundaries

A static TypeScript AST census of the delivered main tests finds exactly17 initial-reader files and24 actual raw calls to `capturePositionFinallyMainPredecessorPolicySource`. The older Deno19-raw/5-semantic census describes its historical epoch; main already captures raw before JSON.parse at those five sites. Preserve main's current raw/semantic downstream ordering. At each of the24 actual initial operands, add only the new main-route wrapper immediately inside the existing finally wrapper. Keep the existing finally/class-fields/own/main11 chain and old mutations/assertions whole. Do not wrap inner already-historical mutants, replace them with healthy disk data, or normalize physical corruption before its intended authentication.

| Reader under tests/ | Current finally-call lines | Site count |
| --- | --- | --- |
| issue-3518-canonical-3c6-inventory-successor.test.ts |1438 |1 |
| issue-3518-canonical-489d-inventory-successor.test.ts |376 |1 |
| issue-3518-current-main-inventory-successor.test.ts |60 |1 |
| issue-3518-lowering-analysis-preservation.test.ts |744 |1 |
| issue-3518-nested-stackification-policy-evolution.test.ts |348 |1 |
| issue-3518-number-prerequisite-policy-evolution.test.ts |122,964,1382,1924,2295 |5 |
| issue-3518-program-data-contract-boundary.test.ts |173 |1 |
| issue-3518-program-validator-policy-evolution.test.ts |718 |1 |
| issue-3518-runtime-data-contract-seam.test.ts |2675,3401 |2 |
| issue-3518-runtime-program-policy-evolution.test.ts |100,187 |2 |
| issue-3518-semantic-provider-boundary.test.ts |490 |1 |
| issue-3518-validation-policy-evolution.test.ts |76 |1 |
| issue-3518-wasmgc-helper-policy-evolution.test.ts |1078 |1 |
| issue-3518-well-known-symbol-policy-evolution.test.ts |79 |1 |
| issue-3525-arraybuffer-isview-main-policy.test.ts |168 |1 |
| issue-3525-main-inventory-source-successor.test.ts |313,529 |2 |
| issue-3525-presentation-classification-policy.test.ts |142 |1 |

The separate five successor proof files also need their initial healthy operand adapted. Use the main route for existing6866 position own/class/finally proofs and the Deno route for existing4376 Deno own/class proofs. Keep exact old policy targets, all32+32 Deno registrations (confirmed in the raw old2841 result), and delivered23+31+39 position registrations. In physical policy-fault cases, stage the genuinely authenticated output bytes in a dedicated ignored physical file, verify its complete historical pin, then let the old test mutate/read that actual file with its original inner helper. Preserve every original fault and expected inner error/read count; preparation reads occur before the original counted fault interval. Never fault a fabricated JS object while calling it a physical file test, never pass a corrupted historical operand through the new current-only wrapper, and never count a new outer-pin failure as the old intended guard. Existing receipt faults still target their real unchanged receipt paths. The new proof alone supplies current1862 physical-policy and new-authority faults, serialized under root custody.

There is one separately established fixture transport inside the17 readers: the semantic-provider test. Main is72568/`7610923c8bbec55eabd2b2a5ffd002b3a70c32aadbb8608d6737f917bfb77335`; old repaired Deno is76418/`a6b980d86619b5ae2cd6929904d091848460279b716c375d39a320f57e4c2c26`. The saved diff separates capture-wrapper differences from the three native-owner additions and11 exact edges. Preserve main's capture chain and port only that already reviewed fixture body: keep the205-validator population/977 edges and add three owners/four type-only plus seven runtime edges to208/988. Preserve all original353 identities, validator-removal witness, formatter/backend negative and all original floor/assertion logic. This is not permission to assert a stale graph matches current source: after source freeze run the actual fixture and retain any newly observed dependency difference at its real stage. Do not copy the entire old Deno test over main or repin an unexplained new closure.

### Root-only C1 reseal from the actual delivered authority

Actual main C1 is409047 bytes/SHA256 `7866e5631d0c18a1226dec77fce73733a0140253f3ee959fca45289ae6c93d00`; old Deno C1 is407235/`923c016361ae48b6e1941c4a4cdb3eec279dabf64acf1cc31cf2df12f92bd33e`. Static independent inversion/replay of all10 recipes in each manifest succeeds and recovers identical complete historical before operands for the corresponding paths. Schema, historical/current base literals, seven artifacts, eleven immutable authorities, population and all LinearOptions data are equal. Only four current instruments/recipes differ between these two predecessor epochs. These facts and recovered immutable bytes are saved in `c1-predecessor-audit.json` and `historical-operands/`; they authorize no new final seal by themselves.

The exact four C1 self-intersections with the17 adapters remain:

- tests/issue-3518-program-data-contract-boundary.test.ts (current33018/00d3c535…;11 recipe spans).
- tests/issue-3518-runtime-program-policy-evolution.test.ts (28405/514c7b79…;8 spans).
- tests/issue-3518-well-known-symbol-policy-evolution.test.ts (29317/96c027fb…;8 spans).
- tests/issue-3518-number-prerequisite-policy-evolution.test.ts (111635/9b39eea0…;26 spans).

These are before-edit measurements, not required final span counts. After final reader formatting, root rebuilds each of those four recipes from the **same immutable historical beforePin** to the exact final reader, updates only its afterPin/span array and matching currentInstruments pin, and proves full inverse/replay for all10. Preserve all8 other instrument pins,6 other recipes, all7 artifacts/11 immutable authorities, population12 instruments/10 recipes, every beforePin and all semantic profiles. Coalesce adjacent edits where needed to satisfy strictly increasing nonoverlapping UTF-8 offsets; do not carry an intermediate main/Deno edit as if it were a historical original. Root restores the four permitted records in the candidate and requires every other manifest field to equal actual main. No old407235 manifest install and no blind union of recipes.

The structured path-set intersection of the declared C1 LinearOptions sourcePath, bindings, closureInputs and resolver fields with the81 Deno source paths plus the new typeof leaf is empty. This is a **static membership observation**, not final source-pin acceptance. Root must verify the actual final declaration/closure/source hashes after source freeze; until then no replacement declarationPin/raw-source hash is invented or installed. If the final intersection remains empty and all actual existing pins match, preserve LinearOptions and all source-bound declarations verbatim. A newly measured mismatch requires a separate explicit finite source receipt review; it is not solved by widening policy or rehashing whatever happens to be present.

Only root may prepare/install the final C1 manifest, change the single manifest-SHA scalar in ir-c1-authority-root.ts and update the single external independentFreeze string in issue-3518-c1-current-source.test.ts. Within that string change only manifestSha256, anchorSource and anchorPin; declarationPin remains unchanged unless separately authorized by an actual source-intersection proof. Prove all anchor bytes outside its one scalar and all test bytes outside that one string exact. Do not change ir-c1-current-source.ts, ir-c1-historical-authority.ts or add the new helper to the fixed12-instrument population. Bind the new helper via its own complete independent proof/receipt, not a fabricated C1 historical instrument.

### Finite implementation order and actual validation

1. Root receives source freeze and independent complete source-vector review, reconciles the18 Deno rows and13 deletions against actual paths, and releases metadata installation/custody. No source read during active writes is accepted as the final declaration inventory. Preserve the old53k-corpus linkage/custody and frozen native/metadata source operands; do not recreate their success on a different source epoch by renaming reports.
2. One Sol6.1 Medium metadata owner implements only the measured policy candidate, the one new fixed helper/receipt/proof,17 initial-reader adapters and five preserved-proof capture/staging adjustments. Transplant old Deno helper/receipt bodies byte-exact. That owner composes the already reviewed semantic fixture delta in its one reader. Root owns the issue and C1 files; no simultaneous edits there. An independent validator may inspect the frozen candidate/recipes without changing files or executing physical faults while the source owner is active.
3. After final formatting, root alone constructs the C1 candidate from delivered main and requests independent static review of all10 inverse/replays,12 current pins, field-level preservation, anchor scalar and external string. Only then install and release actual checks; rejected current/stale/foreign operands never become a fallback accepted vector.
4. Run the complete **new outer proof** with independently pinned positive raw/semantic captures on both routes, exact-main18-row lineage, all six/22 row index/profile/neighbor controls, duplicate/missing/reordered/foreign/non-files/whitespace/span faults, stale1856/1844/1840 rejection as current, malicious descriptors/boxed inputs and warm physical receipt/policy corruption plus exact restoration. Collect its actual new case population; no numeric pass count is specified in advance. Preserve all five existing full successor-proof populations (32+32+23+31+39=157 identities), C1 current-source343, and the complete semantic-provider353 after the three previously failing healthy/negative fixtures are reached. These are planned execution floors, not new pass claims.
5. For the other initial readers, preserve/reconcile all2433 original identities/duplicate ordinals by collection. A bounded current capture audit must exercise all24 genuine initial sites and compare their exact historical outputs with the frozen old operands, then run selected existing healthy and post-capture negative cases covering each changed reader's actual mutation boundary. Record the literal selected names before execution; avoid a new synthetic success-only test that bypasses the reader body. Byte-exact inner bodies and proven historical input equality justify keeping unrelated old fault results as old-epoch evidence. A changed inner body, output mismatch or new diagnostic expands that specific affected population; it does not justify silently skipping it. There is no default full2841 or entire original fault-corpus repeat just to re-observe unchanged inner assertions.
6. Run the actual current inventory/architecture and normal source/type/build/format/lint/budget delivery gates against the frozen final source and policy, plus the separately released native source controls. Keep all physical authority/source mutations serialized with compilation, exact before/after bytes/modes/inodes/devices and declared corpus inputs. No timing retry, scheduler/cache architecture, blanket waiver or legacy/public retirement is authorized.

Keep the original2433 attribution and actual2841 run (2838 passed/three failures) unchanged. Preserve the observed one-file3/3 then353/353 correction, original353 identities,7755 input restoration and the composed2488+353=2841 unique observations. Likewise565/565 native and207 guarded cases retain their frozen epochs. New proof execution must say what current inputs it used; old passes are neither erased nor promoted to new source-current proof without execution. Root carries existing PR6341 through the normal signed/protected admission after these finite checks; this appendix is not a new issue or a completion/retirement claim.

Architect outputs are only this appendix and ignored `.tmp/post-6535-metadata-plan/` profiles, fixed projection records, predecessor C1 audit, reader census and immutable operand copies. No source/test/policy/C1/Git/network/claims installation or test/gate/timing run was performed here.


### Received source freeze; module and file domains remain distinct

Root has now supplied `.tmp/post-6535-source/freeze.json`, SHA256 `ddf172f453ef009404ce0b1667f9021379788d13b233b14945b0e32331e094d0`, and `.tmp/post-6535-main-composition/source-domain-qualification.json`. The source-vector domain is1862 TypeScript/module files; the all-src-files domain is1864 because it additionally includes `src/ir/backend/README.md` and `src/ir/dialect/README.md`. Correspondingly, main has1844 module-policy rows/1846 all-src files and old Deno1856 module rows/1858 all-src files. These denominators are not interchangeable, and no README policy row is added.

The architect compared the saved1862-row candidate path set against the frozen1862-module vector: exact equality, no missing or extra module. The saved C1 LinearOptions closure-input byte/SHA pins were compared only with the frozen vector, not with changing source bodies; see `frozen-source-domain-review.json` for the actual comparison count/results. No new declaration pin was invented or extracted. Root's independent full source review and actual final C1 declaration/closure acceptance remain the release conditions; the source freeze is now available for that review. This is static reconciliation, not additional source/test pass evidence.


### Post-source-position source composition and native terminal (2026-10-06)

Root received independent approval of the frozen source composition against authenticated main431aa4ed7a7be13c922332ab14a85ff05de1ac44. All1795 unowned main files remain byte-exact;82 owned outcomes are69 files and13 authenticated move-deletions, preserving both disjoint closure/context edits and the syntax-first existing typeof-import-binding leaf before its unchanged alias-target fallback. All13 removed raw files match positively authenticated originalPR60f99 preimages and relocated destinations/exports. Module domain is1862 TypeScript source files; two unchanged README files make1864 total src files. Original imported-typeof test2167-byte prefix is exact; final five-case test7344 bytes SHA256 bc4878d7f3716f4580c805e027d427a2f33f3255d3d0f072f6d84fb859b34b9f. Recorded41 distinct focused controls passed; sourceTS7, source/test formatting and lint passed. The diagnostic/refusal attempts and corrected external-host qualification above remain retained.

The broader actual Node25.9.0 serial body collected and executed793 cases, all793 passed, terminalexit0. All565 original native registration and executed fullName identities match exactly;228 distinct delivered main controls comprise finally70, template literals3, specialization17, source capture34 and source projection104. This is a freshly measured body, separate from all historical565/2841/353/2935 evidence. All1925 declared inputs (1862 source modules, two READMEs,61 selected tests/transitive helpers/fixtures/config/package/build script inputs) match complete bytes/hashes after execution. The initial ignored receipt assembler used incompatible name separators and exited1; its error is retained, and the corrected actual ancestorTitles/title comparison verifies all565 original identities without rerunning the body.

Normal production build completed allthree package stages with terminalexit0: Vite, declaration pruning and test262 CLI build. The same1925-input vector is exact before/after build. This vector does not claim runtime corpus, installed-library or hook coverage outside its declared domain, and these ordinary correctness/build results do not claim performance or complete IR/legacy parity. Evidence is frozen in .tmp/post-6535-native-validation; independent static approval in .tmp/post-6535-source-independent. Old prepared worktrees and all earlier failures/fixtures remain intact. Root now releases bounded metadata installation/review; current-policy/C1 proof and normal exact-head publication of existingPR6341 are still pending.


### Current metadata collection, process failure and scoped retry (2026-10-06)

Independent review approved the corrected29 metadata paths and root's four-file policy/C1 installation. All24 real initial capture sites are adapted; the hidden array-index descriptor and two initial-capture/physical-staging findings were corrected before installation. Root installed exact1862-row policy596119 bytes SHA99b1c972702656d37aa70a993953b367efba19f3907eb76aed83864c1b77442e and C1 authority411855 bytes SHA9bc6ea2485d9706a8cdfe7bc180ecc2d17a7ec465563b0d0d709fe0bdab37426. Twelve actual source closure pins and LinearOptions declaration1633/5294c0fce2be6c6974b61a3686c05e60aa66d5bb4599fc97cb315ee53cab71be remain exact.

Actual24-file collection exited0 with3162 registrations. Current17 readers retain all2434 saved actual identities exactly, with no additions/removals. Historical2433 attribution remains intact: the extra already-present identity is semantic-provider “rejects bypass of the actual input-to-source-map-validator dependency”, duplicateOrdinal0; it is not newly introduced by this composition. Five complete oldproofs contribute157, C1 contributes343 and the new outer proof228. The complete semantic-provider353 remains part of the17 reader population.

The authorized ordinary eight-file serial body ran all1081 assertion rows:1081 passed, zero failed/pending. However the actual process exited1 after Vitest reported an unhandled [vitest-worker]: Timeout calling “onTaskUpdate”. Despite JSON reporter success:true, this is a FAILED ordinary run and cannot justify admission. Preserve exact stderr, command, result and process-failure.json under .tmp/post-6535-metadata-validation. All7790 declared custody paths, including1862 source modules, two READMEs and33 installedmetadata files, are restored in bytes/modes/inodes/devices with zero additions. Corpus scope is the pinned clean linked Git head/tree/path-set, not a hash of every53933 test/harness file or an executed corpus result; the measured corpus Gittracked pathset56970 and testtracked53889/testJS53869 have distinct domains.

Root authorized one failure-isolation rerun of the SAMEeight COMPLETE test files in eight sequential fresh ordinary Node25 Vitest processes, under the same pool/reporters/heap/timeout/assertions. No setting increase, suppression, fixture/test/source change or repeated full3162 body is authorized. Every actual process must exit0 without unhandled errors, preserve the exact1081 identity union and restore custody; another failure is retained and requires root's scoped diagnosis rather than an automatic repeated retry. This rerun is ACTIVE, with zero new pass credit at this record, in .tmp/post-6535-metadata-isolated-rerun.

The separately frozen original186-case/17-file reader selection maps all24 initial sites to real healthy and post-capture negatives, including both sourcePath reads and lowering application controls. Its bounded parameter/physical-target omissions are explicit. No selected body has run; it and repository gates remain held until the physical retry is terminal and all files are restored. ExistingPR6341 is freshly verified OPEN/ready/base main/exactremote60f99, noautoMerge/noqueueentry; preserve its delivery vehicle, no duplicatePR. Full IR/legacy equivalence, performance and retirement remain open.


### Prepared delivery preservation audit (2026-10-06)

A scoped read-only audit partitions the old141-path prepared vector into81 source outcomes and60 non-source paths. Twentyfour original metadata/root paths are intentionally superseded by the approved current29+four authority files;33 safe remaining paths match complete prepared bytes, the import-test2167-byte prefix remains, and the issue's append-only current plans supersede its older prepared snapshot. The sole missing historical delivery file plan/log/ir6341-main-composition-20261006.md was transported with its complete4321-byte SHA8a30eead54e90471da7329dbeb4b1d36e8d7b350570a3bd6b87822faee65db62 prefix intact, followed by an explicit current qualification. All36 safe comparisons had identical authenticcdc/431 main operands, with no unrelated delta requiring a merge. Evidence .tmp/post-6535-prepared-delivery-inventory. No native test, source or current authority edit occurred; the active physical retry inputscope excludes plan/issues andplan/log.


### Isolated retry attribution correction and runner diagnosis (2026-10-06)

Root read the actual per-file command records rather than inferring success from passing assertion rows. The first isolated new-outer228 process again exited1 with the unhandled Vitest onTaskUpdate timeout; all228 assertions passed, but the file is not qualified. The next six complete files (32+32+23+31+39+343=500 assertions) exited0 with no unhandled error and exact custody. The final semantic-provider353 process is still active at this entry. An earlier agent progress message incorrectly called seven processes successful; the immutable command/review/stderr records already contained the failure and remain unchanged. This correction supersedes that progress message. No further retry or timeout/reporter/assertion weakening is authorized.

Root assigned independent read-only diagnosis of the failing outer proof and installed runner RPC implementation. The selected186 reader body and admission remain held until physical mutation ends and custody is restored. The current native793/build evidence remains separately scoped, with no promotion of either failed1081 or228 process to a passing ordinary run.


## Outer proof worker RPC progress: complete-case cooperative yield (2026-10-06)

### Terminal evidence and causal boundary

The isolated retry is now terminal. Its exact eight-file union remains1081 identities: the outer228 assertions all passed but their process exited1 with the same unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`; the other seven complete files contributed853 assertions with actual exit0 and no unhandled errors. The final semantic-provider353 is included in those853, superseding the earlier entry that still marked it active. All7790 custody paths are restored, with zero changed or added inputs. Both the combined1081 process failure and isolated228 process failure remain failed evidence; JSON `success:true` and passed assertion counts never override actual exit1. Commands, complete results, stderr, progress correction and custody remain under `.tmp/post-6535-metadata-validation/` and `.tmp/post-6535-metadata-isolated-rerun/`.

Independent read-only diagnosis inspected the installed Vitest3.2.4 implementation. Its worker RPC timeout is60000ms (`dist/chunks/index.B521nVV-.js`, RPCDEFAULT_TIMEOUT); the worker's `resolveTestRunner` forwards `onTaskUpdate` through RPC (`index.CwejwG0H`), and `@vitest/runner`'s `sendTasksUpdate` queues that returned promise without awaiting it, tracking pending updates until `finishSendTasksUpdate`. Update batching uses a100ms timer. Fork reply dispatch is a Node `process` message listener (`utils.CAioKnHs`); Birpc resolves a received reply and removes its pending timeout. These are installed-code observations, not proposed dependency changes.

All228 existing outer callbacks are synchronous. Their complete independent inverses, semantic profiles, fresh authority reads and negative assertions run through repeated `healthy()` calls. The existing runner's promise/microtask sequencing does not itself guarantee a turn for Node message delivery between such callbacks. Recorded isolated durations are361786.49ms for the file and361769.50ms summed across its228 cases, with individual cases1394–3377ms; the combined attempt shows360059.94ms versus360044.29ms. The tiny differences support sustained worker event-loop starvation, but these durations are neither an event-loop trace nor a performance measurement. In particular the failure stack proves that the worker's RPC timeout expired; it does **not** prove when the parent received an update, completed its asynchronous reporter work or sent the acknowledgement. Parent acknowledgement timing remains unobserved. The narrower, code-backed hypothesis is that this proof's synchronous case chain deprives worker reply handling of timely macrotask opportunities; do not claim a traced parent defect or a universally proved cause.

### Single-file implementation and unchanged proof authority

After root releases the active186-case reader body and its exact physical restoration, root or one explicitly assigned Sol6.1 Medium implementer may edit only `tests/issue-4376-post-position-main-inventory-successor.test.ts`. Root remains the sole integration owner. The pre-edit file is86995 bytes, SHA256 `423973e39bcb81f22df2feaa8e822c50d601874b33a773bd47fec5a24d9177a5`; its complete copy and static operand manifest are in `.tmp/post-6535-rpc-spec/outer-proof-before.ts` and `before.json`. Agents are not alone in this worktree and must preserve concurrent owned changes.

Import `setImmediate` from `node:timers/promises`, add `afterEach` to the existing Vitest import, and register one suite-local hook inside the existing `describe("fixed post-position main and Deno predecessor routes", ...)`:

```ts
afterEach(async () => {
  await setImmediate();
});
```

Add a short comment explaining that the yield allows runner RPC replies between complete synchronous proof cases. This is an awaited event-loop turn, not an arbitrary delay or a changed timeout. Do not use `Promise.resolve()`, `queueMicrotask` or `process.nextTick`: those do not provide the intended macrotask boundary. Do not introduce a yield inside `healthy`, capture/projection helpers, a test callback, a mutation/restoration interval, or an assertion sequence. Keep the existing callbacks synchronous and byte-exact, including their try/finally restoration and post-restoration `healthy()` calls. The hook follows each callback after its body and synchronous finally have completed; it neither replaces restoration nor catches or clears assertion failures. A failed restoration still fails the run.

Preserve all228 full names, duplicate ordinals, registration order, routes and assertions, every independent pin/profile/inverse/replay, exact read-path/count checks, malicious descriptor non-observation, warm receipt faults and actual policy faults. Preserve the helper79234-byte SHA `ecdd9ad0e6732e5b2664017241f1c1466329177d126bbfc518062e9c5b5fb14a` and receipt72255-byte SHA `500e54c202e92cbf0164974840e90f2f00db49994a0cb8523600fc45779d15c0` exactly. No authentication caching, reduced repetition or reused healthy capture is authorized. The new outer proof is not one of C1's12 current instruments; this import/hook change supplies no reason to reseal the authority manifest, anchor, external freeze string or any immutable authority.

No source, shared helper, policy, package/dependency, Vitest configuration, reporter, pool, heap, timeout or environment-setting change follows. No skip/filter, assertion deletion, ignored unhandled error, RPC interception, dependency patch or broad scheduling abstraction is authorized. If the file-local correction fails, retain its diagnostics and return to scoped diagnosis instead of enlarging this write set or retrying unchanged inputs.

### Acceptance after the actual correction

1. Review the final diff against the complete saved preimage. Removing only the added timer import, the `afterEach` import token and the hook/comment must reconstruct all original bytes. Run the normal applicable file formatting/type/lint checks, and collect the full file to compare exact228 registration identities and duplicate ordinals against the failed attempt. A hook does not add a test identity. No original callback or assertion may move or change.
2. Freeze the corrected proof as the sole intended difference in the7790-path custody vector. Keep the previous failed vectors intact; do not overwrite their receipts or call the changed test file an unexplained restoration mismatch. Recheck the fixed helper/receipt and unchanged policy/C1 inputs. Root serializes physical execution with the reader body and all other source/policy readers or writers.
3. Execute the complete228-case file once after the genuine reviewed change, with the recorded ordinary Node25.9.0 Vitest command: fork pool, min/max one fork, no file parallelism, verbose plus JSON reporters, VITEST_MAX_FORKS1 and VITEST_FORK_MAX_OLD_SPACE_SIZE4096. Only the output destination changes. Capture the actual process exit/signal, full stdout/stderr and all assertion rows. Acceptance requires actual exit0, no unhandled errors, exactly the same228 identities all passed with zero failed/pending/todo, and exact restored custody against the corrected freeze. Reporter success alone remains insufficient.
4. The two preserved failing attempts versus this one-property scheduling correction provide bounded attribution if that acceptance passes. Report that the cooperative yield resolves this reproduced ordinary-process failure under the recorded settings; parent acknowledgement timing remains unmeasured. Do not infer a compiler speedup, throughput guarantee, dependency defect or successful full1081 rerun. The seven unchanged files'853 actual successful rows remain separately scoped evidence; root may compose their exact identity union with a qualified corrected228 while stating that the observations came from separate processes and test-file epochs. No duplicate853/793 body is required merely because this local hook changed.
5. A process failure, identity mismatch, changed assertion, unhandled error or custody difference leaves the outer proof unqualified and blocks its admission. Preserve the new failure without automatic retry. Root's normal exact-head publication checks and existingPR6341 delivery remain required; this test-runner correction does not retire legacy compilation, complete IR parity or settle performance.

This appendix and ignored static operand copies are the architect's only writes. No test/probe/gate, dependency mutation, Git/claim/network operation or source/test/policy installation was performed by the architect. Implementation and actual acceptance are pending root's physical-custody release.


### Terminal isolated cohort, source custody and normal gates (2026-10-06)

All eight isolated processes are terminal. Seven complete files qualify853 actual cases (157 retained successor-proof,343 C1,353 semantic-provider), with actual exit0 and no unhandled errors. The new outer228 file remains a process failure despite all228 passing assertions. The exact1081 identity/duplicate-ordinal union and every7790-path custody vector are restored; neither failing combined1081 nor isolated228 attempt is relabeled. The separate progress-message correction is preserved in .tmp/post-6535-metadata-isolated-rerun/progress-correction.json and pinned handoff/freeze.

Root independently rechecked all1925 original native/build inputs after restoration, including website/playground/examples/js/async.ts omitted from the broader7790 domain: complete bytes/hash/mode exact, zero changes. The793 native cases and three-stage production build therefore retain their explicitly scoped frozen-input evidence. No additional execution credit or corpus claim follows from this custody check.

The twelve ordinary repository gates each exited0 with explicit Node25.9 and LOC_GATE_BASE431aa4ed7a7be13c922332ab14a85ff05de1ac44: IR dialect, kind neutrality, JsTag seam, IR layering, import cycles, flat-directory budget, compiler-boundary inventory, dead exports, LOC budget, function budget, coercion sites and oracle ratchet. Exact commands/raw outputs are in .tmp/post-6535-publication-gates/results.json. These checks do not settle complete architecture/IR coverage, performance or legacy retirement. Normal commit/push hooks still remain mandatory.

Root released only the frozen186-case existing-reader selection across17 literal files after physical restoration and gate termination. That actual process is active under its original parameters, with source/test/policy writes held until terminal/restored custody. The scoped RPC correction above is specified but not yet implemented or executed.


## Fresh main6998: finite TypedArray and replay-helper composition (2026-10-06)

### Authenticated input and preservation of the pending checkpoint

Root reports a successful refs-only refresh to main/FETCH_HEAD `6998bf0b290c065249e01861ffdbec2dd268662a`, while this worktree still has the uncommitted merge of `431aa4ed7a7be13c922332ab14a85ff05de1ac44`. The architect read those immutable Git objects and frozen ignored operands only; active reader tests retained physical source/policy custody. Do not abort, reset, replace MERGE_HEAD or discard the assembled431 proof to disguise the newer main. After the active186 reader body is terminal/restored and the scoped RPC correction is reviewed and actually qualified, root first records the reviewed431 composition in the normal signed checkpoint, then performs an ordinary merge of freshly authenticated6998. That local checkpoint is not publication or completed admission. Source/metadata implementation starts only after root releases physical custody; previous tests, fixes, failures and receipts remain attributable to their actual input epochs.

The exact431→6998 change has21 paths: seven source paths, one policy file, one new native test file, the replay helper, two existing issue records and nine benchmark result files. The delivered replay-helper change belongs to PR6538 / issue6837, “Modular IR analysis and optimization pipeline with measured performance parity”; retain its exact delivered type corrections. The source and new native test belong to issue6651, “ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census”. Transport the complete main issue and benchmark changes through the normal merge, without regenerating reports or crediting their recorded results as new Deno execution. No new issue, duplicate PR or competing source lane is required.

### Seven source paths, exactly two Deno intersections

`.tmp/post-6535-fresh-main-6998-plan/source-intersection.json` compares all seven immutable main deltas with the frozen1862-module source vector. Only `src/codegen/iterator-native.ts` and `src/codegen/object-runtime.ts` differ between frozen Deno and main431. Their saved `prepared/` operands match the full frozen byte/SHA profiles. Static three-way composition into ignored files reports no conflicts and yields iterator-native287238 bytes / SHA256 `940df6c4fdd85311ef2ef8f32611f11ae7e0041076d9d3547b2702e3d51932d4`, and object-runtime552957 / `d68c792c2884b767abe934632d5be50c9e6bdd4e6512c097d74fcceec8a4715e`. These are measured candidate bytes, not installed/compiler-tested results. `source-static-merge.json` and the complete three operands preserve the derivation.

Retain main6998's exact full blobs for `array-methods.ts` (497385 bytes), `dataview-native.ts` (450407), `expressions/arraybuffer-isview-static-decision.ts` (2165), `ta-dyn-proto-methods.ts` (50894), and new `array/ta-iter-detach.ts` (5359,133 lines). The first four were exact main431 in the frozen Deno vector, so they need no invented Deno port. The new leaf has only type imports. All other existing frozen source paths, including every authenticated deletion, remain unchanged. The composed domain becomes1863 modules and1865 total src files including the two unchanged READMEs; neither README becomes a policy row. The ignored `expected-source-vector.json` records this exact static seven-path successor.

In iterator-native retain Deno's live receiver normalization, userIter receiver slot, live keys/entries kinds, current-length/indexed-read dispatch, cursor-before-Get semantics, one-way exhaustion and rest-draining path. Retain all main additions: the two imports, `prependTaIterDetachArm` immediately after `prependIterRecIdentityArm` and before the anyIterNextPending early return, and the entire guarded once-per-context finalization body. Main's dynamic TypedArray helpers now put a branded canonical-vec subtype carrying the dynamic view in IterRec.vec, with userIter null. Deno's canonical branch remains selected for that null receiver and can consume its canonical prefix; Deno's live receiver records instead have vec null, so main's subtype `ref.test` does not claim them. Main's guard retains the exhausted-cursor check and real in-module TypeError construction. These inspected field/branch relationships justify literal disjoint composition; they still require native controls after installation. Do not merge the two representations, redirect ordinary live iterators to snapshots or move the finalizer ordering.

In object-runtime retain every Deno live service getter, `buildRestOnlyApply` reservation/dispatch, linked-realm reader reservation and canonical relocated imports. Main's new `ensureStandaloneTaSubclassParentCtor` import and call inside `emitStandaloneVecBuiltinConstructor` are disjoint. Keep the call after the existing cache lookup and before identity-only fallback; it delegates number-element TypedArray parents to the delivered constructor, while its undefined result preserves the prior fallback. Preserve all main dataview-native savedBodies handling, externref view materialization/writeback, receiver validation and arity behavior without speculative cleanup. Existing Deno callback/new.target and ordinary-class behavior remains required. The import-cycle and actual initialization checks must assess the resulting graph; static lack of text conflicts does not prove initialization safety.

### One exact policy row; evolve the existing outer proof

The entire main policy delta is one318-byte insertion at old-main UTF-8 offset384119. Inserting those same bytes into the frozen Deno policy at offset388452 yields the ignored `candidate-policy.json`; its exact row is `src/codegen/array/ta-iter-detach.ts`, unmigrated / mixed-needs-split / backend-wasmgc / owner3518-coordinator with the delivered generic nextBoundary. Its main row index is1046; composed index1059. `policy-one-row-evolution.json` pins its actual previous/next neighbors and literal bytes. No row reorder, normalization, other-field change or broader policy regeneration is necessary.

| Operand | Rows | Bytes | SHA256 |
| --- | ---: | ---: | --- |
| Delivered main6998 |1845|590770|`b606727c951331096a458b46ef344e8042018089b04e0e1fa587d7045fad3d13`|
| Composed Deno plus main6998 |1863|596437|`a93b6e37ab492e3b3cb591e1f10a394291580bd1aea17b2b01062244e977a966`|

Both retain the exact non-files digest `3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce`. Full source/Git-blob/semantic/files profiles are in `policy-profiles.json`. The existing outer helper can retain all four public capture APIs and its complete capture/authenticate/profile/inverse/replay algorithms. Update only its fixed expected literal and receipt pin, its own receipt JSON and the independent outer proof literals required for this new operand. The three direct projections remain:

- mainLineage: current1863→exact delivered-main1845, removing the same18 Deno-only rows at their current indices;16 raw insertion spans in the independently built candidate.
- mainPredecessor: current1863→unchanged historical oldPosition1840, removing23 rows (the earlier22 plus the TypedArray row);19 raw spans.
- denoPredecessor: current1863→unchanged historical oldDeno1856, removing7 rows (the earlier6 plus the TypedArray row);5 raw spans.

`policy-projections.json` statically verifies every semantic inverse, complete raw inverse and complete forward replay from immutable before operands. A different valid minimal span segmentation may be used only with the same whole-file proofs. Do not merely increment counts or rehash arbitrary current input: both historical target blobs remain exact, and the lineage target must be the authenticated6998 blob. Refresh affected indices/neighbors/offsets from these complete operands. Every retained row and every non-files byte must survive. Do not append another large helper chain, introduce a fourth public route, admit both current epochs through a fallback, or alter the immutable inner authorities. All24 existing initial capture sites and their17 reader adapters continue to receive the same historical raw/semantic outputs; their code need not change.

Retain the independent proof's full controls and the complete-case RPC yield. Add the new row's two historical-route row/previous/next negative controls and reject the former1862 composed operand as current, alongside stale main and historical operands. Its raw previous-current operand can be reconstructed by reversing the one fixed318-byte insertion, with the complete old596119-byte profile checked. All raw/semantic inverse, fresh-read count/path, malicious descriptor non-observation and physical receipt/policy restoration controls remain mandatory. Current row indices above1059 move, so index-derived test titles can change even when their logical control is retained. Record an explicit old→new mapping keyed by route, row path and neighbor role, and separately list added current-epoch controls; never relabel the historical228 registrations/results as the new population or silently drop an old fault. If stable old titles are retained, they are historical labels only; assertions must use actual new coordinates. Collect and report the real new population, without guessing a count in advance.

### C1 and delivered replay-helper boundary

The static structured-path intersection of the installed-candidate C1 manifest with the seven changed sources plus `tests/helpers/ir-whole-program-replay.ts` is empty; see `c1-intersection.json`. This checks exact path-valued fields throughout the manifest, including LinearOptions source/bindings/closure inputs, population declarations and current instruments, rather than treating source path mentions inside policy strings as authority. Its12 current instruments,10 edit recipes,12 closure inputs and LinearOptions declaration therefore have no new source member or edited instrument in this finite change. Keep the current C1 manifest, anchor and external freeze string byte-exact; no automatic reseal follows an outer-helper data update. Reconfirm those existing pins against the final installed source and instrument bytes. Any actual mismatch must be classified before a separately bounded receipt edit, not patched by blind rehashing.

The delivered replay-helper changes are type annotations/casts around the existing emitted Uint8Array, native Tag-capable import map and instantiate call; preserve all runtime statements and the exact main delivery. It is outside the fixed C1 instrument population. Existing historical proof helpers/receipts and all17 reader source bodies also remain exact. Thus this plan's intended metadata write set is only policy plus the existing outer helper, its receipt and independent test; root should refuse incidental C1/reader churn. Preserve the independently measured d97 delivery authentication and test attribution rather than reopening that type-fix task.

### Bounded actual acceptance and publication

After normal merge/install and independent static review, one explicitly released Sol6.1 Medium implementer or root owns this finite source/outer-metadata successor. Other agents preserve that ownership. Freeze the new source/test/policy vector and keep all physical source/authority mutations serialized. Verify all unaffected frozen bytes, the two exact composed sources, five exact new-main source blobs, all13 retained move-deletions, the complete new module/policy path-set equality and unchanged C1 pins. Keep the original431 native793/build, original failed combined1081/isolated228, successful other853, reader186 and RPC-correction results attached to their original epochs.

Run all four delivered `issue-6651-v3-typedarray-residue.test.ts` cases unchanged against the composition: detached keys TypeError/value3, externref-backed set/write-through value7, genuine TypedArray subclass value15, and undetached values/entries control3. Their existing eval import stubs are explicit fail-if-called controls; this is not new eval-engine execution. Include the existing Deno live-array iteration controls, callback/new.target/rest-only controls and ordinary-class/super controls that reach the two composed files, with names selected from the frozen native population before execution. Preserve actual native instantiation, exception identity and healthy default paths; do not substitute compilation-only success. Use the existing replay-helper-focused controls for its delivered type fix where already measured/current or genuinely affected, without inventing unrelated code changes. Any interaction failure expands only the affected control set after diagnosis.

Execute the complete revised outer proof once on its corrected final profiles, preserving the same ordinary RPC settings and requiring actual exit0/no unhandled error, complete collected/executed identity accounting and exact final custody. Audit all24 real reader capture outputs against their unchanged historical operands. Their unchanged inner algorithms/inputs and the unchanged C1 authority justify retaining prior complete inner fault/C1 evidence with honest old-epoch attribution; do not automatically replay853 long fault cases or793 native cases. A mismatch, changed source-bound assumption or new diagnostic expands the specific affected proof before admission. Run the applicable current normal inventory, architecture, source/type/build/format/lint/budget gates against the merged6998 source vector, since new source/imports invalidate reuse of earlier whole-tree gate results as exact-current evidence.

Root then verifies the fresh main ancestry, actual existingPR6341 head and the reviewed final content before normal signed/protected publication. Another main change is first measured by its actual path/authority intersection; it does not authorize stale overwrite or unbounded proof regeneration. This appendix claims no executed successor tests, compiler speedup, full IR equivalence, legacy retirement or completed Deno runtime. Architect writes are this append and ignored static operand/candidate/projection records only; no live source/test/policy write, test/gate execution, Git-state mutation, network action or new claim was performed.


### Mandatory431 checkpoint amendment: formatting, genuine hole control and two C1 recipes (2026-10-06)

Root's actual metadata checks found seven Prettier failures and one Biome error, preserved in `.tmp/post-6535-rpc-correction/metadata-format.stderr` and `metadata-lint.stderr`. The latter is `lint/performance/noDelete` on the outer proof's `if (kind === "hole") delete mutant.files[1]`; the11 reported explicit-any warnings are not authorization to weaken a gate or broaden the repair. The full228 RPC acceptance run remains held until these concrete failures are fixed and independently reviewed. This amendment is a separately bounded correction to the pending431 checkpoint, before the main6998 merge above.

Permit exactly one additional semantic-equivalent statement change in the outer proof: `if (kind === "hole") Reflect.deleteProperty(mutant.files, "1");`. Here `mutant.files` is the ordinary array produced by `structuredClone(current)`, and index1 is an existing configurable ordinary own property; both deletion forms remove that property without changing array length. Preserve the conditional, evaluation target, all subsequent capture/assertion operations and both main/Deno malicious-hole cases. In particular retain rejection before authority IO with zero reads and zero sentinel observations. Biome's proposed unsafe assignment-to-undefined repair is forbidden: it retains the own property and ceases to test a hole. Do not suppress the lint rule, catch failures, alter captureData or replace this negative with an undefined-value test. The prior RPC plan's byte-exact callback requirement is relaxed only for this one reviewed operation; all remaining original callback bytes stay exact except separately proven formatting. Reverse the explicit statement delta plus hook/import additions to reconstruct the original outer preimage.

Run the repository's existing Prettier writer only for the seven reported files: `issue-3518-canonical-3c6-inventory-successor.test.ts`, `issue-3518-canonical-489d-inventory-successor.test.ts`, `issue-3518-current-main-inventory-successor.test.ts`, `issue-3518-nested-stackification-policy-evolution.test.ts`, `issue-3518-number-prerequisite-policy-evolution.test.ts`, `issue-3518-wasmgc-helper-policy-evolution.test.ts`, and `issue-3518-well-known-symbol-policy-evolution.test.ts`, all under tests/. Capture complete before/after bytes. Require parsed TypeScript AST equivalence after excluding source positions/trivia, while preserving literal values, template semantics, declaration/call ordering and all executable operations. Compare exact registration names/duplicate ordinals and unchanged capture calls, file IO, mutations and finally restoration boundaries. Do not conflate the deliberate outer deletion-expression change with this whitespace-only proof. An unexpected executable difference is rejected rather than called formatting.

Only two of those seven formatting targets belong to C1's12 current instruments: number-prerequisite-policy-evolution and well-known-symbol-policy-evolution. Root alone updates their two currentInstruments pins and the matching two instrumentEdits afterPin/span arrays, deriving each complete formatted after-image from the same existing immutable historical beforePin. Verify the complete inverse and replay for every one of the10 recipes after final formatting, with increasing/nonoverlapping UTF-8 coordinates; preserve the other eight recipes, ten instrument pins, all beforePins, population counts, artifacts, immutable authorities and every LinearOptions declaration/binding/closure/resolver field. Source authority has not changed. This is mechanical formatting custody, not a new C1 instrument or historical authority.

Then root changes only the manifest-SHA scalar in the authority anchor and the corresponding manifestSha256/anchorSource/anchorPin fields inside the existing external independentFreeze string. Preserve the declarationPin and every byte outside these bounded fields. Do not edit ir-c1-current-source.ts or ir-c1-historical-authority.ts. Independent review must prove the two-instrument-only manifest difference, all10 whole inverses/replays and the anchor/external-string boundary before installation. Re-run the actual metadata formatting/lint checks and applicable type validation; acceptance is the real command exit status with no error, with remaining warnings reported honestly.

After that static release, execute the full228 outer proof once under the unchanged ordinary settings, including both preserved hole controls and the complete-case yield. Qualify the revised C1 authority through the complete existing343-case C1 proof once on its final resealed bytes; retain original identities, actual exit0/no unhandled errors and exact physical custody. Formatting-only reader edits need collection/AST/capture-equivalence evidence and their unchanged fault assertions, not an automatic repeat of the entire prior853 or full metadata corpus. Existing reader186 and older fault results keep their measured pre-format epoch. Any real unexpected diagnostic expands only the affected control after attribution.

This amendment supersedes the earlier “keep C1 byte-exact” direction only for the two required formatting recipes and their root anchor/external freeze updates. Once this431 checkpoint is qualified, its resealed C1 bytes become the fixed input for main6998: that separate seven-source/one-policy-row change still has an empty C1 source/instrument intersection and warrants no further blind reseal. Preserve every prior failed command and every original fixture; publication remains conditional on both checkpoint repair and the subsequent finite fresh-main acceptance.


### Mandatory checkpoint corrections installed; scoped acceptance active (2026-10-06)

The ordinary33-file formatting and28-TypeScript-file lint checks first failed and their raw diagnostics remain in .tmp/post-6535-rpc-correction. Sol formatted exactly seven authorized files: each removed one generic trailing comma from <T,> to <T>; complete TypeScript ASTs, all registration nodes and all assertions remain identical. Root's earlier informal inference of an extra blank line was incorrect; independent byte-offset comparisons identify the actual comma removal. No source or shared helper changed.

Root installed the reviewed file-local afterEach macrotask yield and the single equivalent Reflect.deleteProperty operation that still produces a genuine missing index1 on the ordinary cloned array. Reversing only those authorized changes reconstructs the entire86995-byte old proof. Final correctedproof87220/SHA9f2c40c6c72b48afedc4cd5766356a234630dfd4f51abfe4137d1d044cbf9a37; no timeout, dependency, assertion, error suppression or authority-caching change occurred.

The Number/WKS format-byte changes required exactly two existing source-pin/recipe updates from the same immutable before operands. Independent review verified all10 strict inverse/replay records, all12 live candidate pins, unchanged other10 instruments/eight recipes/authorities/artifacts/declaration closure, SHA-only anchor replacement and external freeze's three existing scalar fields. Root installed manifest411293/SHAaaeaf4079f22c3d76bc1257159c1f4b9f1c0f528e12e871314b847b9fcedfbc1 and its two existing seal consumers. The final33-file format and28-file lint commands each exited0; existing warnings are not errors. Full old failed process records remain unchanged.

Actual full correctedouter228 plus updatedC1343 acceptance is now active as two sequential fresh ordinary processes with exact571 original identities and current7790 custody, under the original settings. No new pass credit is claimed yet. The separate186selected reader body already exited0 with exact186 identities and restored7790 paths; its2248 deliberately unselected registrations are not called passing. Root holds all physical source/test/policy writes until corrected acceptance is terminal/restored.

Fresh refs-only Git verified upstream/main6998bf0b290c065249e01861ffdbec2dd268662a. PR6538 exactd97cb31763f98845801997b3d9326a1705da89f2 and mergebe34114e16157bee892c00887e6526d289cdf44d are ancestors, and both delivered paths match complete main bytes. Only its finite typed-replay-helper claim was marked done and independently read back from upstream/issue-assignments6c0ed0841b4ce24ac24632fd5cd06dc1c288804d. The4376 composition claim remains held by root. ExistingPR6341 still has remotehead60f99, ready/noqueue/noauto; its GraphQL baseRefOid1a1608 is an old October2 ancestor, not current main. No merge used that stale field.

Astra's finite6998 spec and Sol's four-file ignored candidate preserve the new TypedArray main fixes, both disjoint owned source integrations, existing proof algorithms and all three complete projection histories without adding a helper chain. Candidate construction does not install code or count as delivery. Root first completes the reviewed431 checkpoint, then normally merges authenticated6998 and accepts the bounded successor; no duplicatePR, fixture loss, broad scope or compiler retirement is authorized.


### Corrected checkpoint acceptance terminal (2026-10-06)

The reviewed correctedouter228 and updatedC1343 each completed their full ordinary fresh process with exit0, empty stderr, no unhandled error and all cases passing. Their exact571 original identities/duplicate ordinals match; all7790 before/after per-file and terminal custody paths are restored, including Node/dependency/corpus identities,1862 source modules, two READMEs and33 metadata files. Earlier combined1081 and isolated228 process failures remain immutable and accurately labeled failures. The corrected cooperative yield resolves the reproduced process failure under unchanged settings; parent acknowledgement timing remains unmeasured and no compiler speedup or full1081 same-epoch rerun is claimed.

Root rechecked the complete1925 native/build input vector after terminal ownership release: every byte/hash/mode exact. The793-case native body and three-stage build retain their scoped evidence. The separate186-reader process and seven prior853-file cases remain separately attributed observations; no unselected or stale epoch is promoted. Current formatting/lint pass and normal signed commit/push hooks still apply.

Independent review approved the four-file6998 candidate and exact two source compositions. Candidate mappings retain228 historical identities and16 separate added controls;244 is only a static expected population until actual collection/execution. No candidate has been installed yet. Root will first commit the completed431 checkpoint, then perform the normal merge of authenticated main6998 and release bounded current acceptance. ExistingPR6341 remains the only delivery vehicle.


### Fresh main6998 integration accepted; publication pending (2026-10-06)

The signed checkpointabe6579620c26a75ad30095b682e8d0e432b33d6 saved the completed431 composition, with exact original60f99/431 parents and normal full hooks. Natural changed-root145>20 self-skip is recorded; no hook bypass environment was set. The staged139 live pins and thirteen positively authenticated relocation deletions match the committed tested source tree. Manual git diff-check reported only three byte-exact inherited main paths and intentional whitespace inside the preserved super-regression source fixture; the latter's normal formatter check passed without changing its input text.

Root then normally merged actual6998bf0b290c065249e01861ffdbec2dd268662a with no conflicts. Both owned source results match complete independent three-way candidates; five other source changes, the replay helper and V3 test match complete main bytes. Git's actual policy merge equals the reviewed1863-row candidate596437/SHAa93b6e37ab492e3b3cb591e1f10a394291580bd1aea17b2b01062244e977a966. Only the three existing outer metadata files were installed; all existing capture algorithm bodies,24 reader adapters, inner authorities and current411293 C1 seal files remain preserved.

Fresh actual native collection and body each exited0,33 files/797 passed with no failed/pending/todo or unhandled error: original793 registrations/executions exactly retained, plus four measured delivered V3 tests. Whole1928 source/test/helper/config/build input vector remained exact,1863 source modules/two READMEs and no source addition/removal outside the authenticated new main module. The ignored inherited wrapper failed only after the successful body on incompatible name separators; its raw failure is retained, and structured ancestorTitles/title+duplicate ordinal comparison independently qualifies all797 without rerunning.

SourceTS7, three normal conditional production-build stages, all twelve bounded repository gates, ownedTS/JSON format/lint and issue integrity each exited0 on the integrated source. The separate actual complete-mode architecture report exits1 with errors[], inventoryValidtrue and graphCompletefalse: migration is intentionally incomplete. The initial incorrectly named complete-architecture mode exited2 and is preserved as a CLI usage error, not architectural evidence.

Actual readonly collection measured244 outer plus343 C1=587 registrations. Every228 historical mapping and16 added control matches independently approved rows; all343 C1 identities remain exact. Two complete fresh ordinary processes then each exited0 with empty stderr/no unhandled error:244/244 and343/343. All7792 per-file and terminal custody paths restore bytes/hash/mode/inode/device and declared Node/dependency/corpus identities, with no additions. This domain is measured old7790 plus the two exact main source/test paths; the inferred7791 ignored preflight error happened before any Vitest spawn and remains retained.

Root rechecked all1928 native/build declared inputs after physical ownership release: exact. Local acceptance therefore qualifies the actual integrated source and the bounded successor; it does not execute test262 or settle full IR/legacy equality/performance/public maps. Prior source/metadata epochs and genuine failures remain unchanged. Evidence .tmp/post-6998-native-validation, .tmp/post-6998-publication-gates and .tmp/post-6998-metadata-validation. Final signed normal mergecommit, existingPR6341 push and protected exact-head admission remain pending; only verified main delivery will close the finite composition claim.


### Actual main77f composition: source review and retained metadata epoch (2026-10-06)

Before publication, actual main advanced from6998bf0b290c065249e01861ffdbec2dd268662a to77f00492c7abe920368dc748d9127df33460fa32. The signed accepted6998 composition is df901ead8d58067755b827f0689ed64b74225469. Independent static review of its clean normal merge reconstructed all11 incoming source bodies from complete cached base/branch/main operands; every independently spliced result equals both index and live bytes. The three shared files retain disjoint edits: arrow-phases preserves Deno IIFE/rest handling plus main's free-name capture guard; index preserves Deno realm/script finalization plus main's block-slot preallocation; object-runtime preserves Deno rest/realm dispatch plus main's linked builtin signature guard. All1854 other source files remain exact, with no source path addition/removal:1863 modules and two READMEs. The complete incoming15-path delta also contains the existing execution-plan update, edited U1b test and new V0/V5 tests.

The structured C1 LinearOptions sourcePath, bindings, closureInputs and resolver fields enumerate36 distinct path values; their intersection with these11 changed source paths is empty. All12 closure-input pins,12 current-instrument pins, three resolver configuration pins and the exact1633-byte declaration pin remain valid. All33 installed metadata paths and eight further current-instrument paths equal the accepted df90 bytes. Policy remains1863 rows/596437 bytes/SHAa93b6e37ab492e3b3cb591e1f10a394291580bd1aea17b2b01062244e977a966; existing helper, receipt, outer proof and all three C1 seal files are unchanged. No successor chain, recipe update, declaration replacement or reseal is justified by this delta.

Retain the actual244+343=587 passing ordinary cases and restored7792-path custody as qualified **6998/df90 source-epoch evidence**. The11 changed compiler bodies lie outside the declared C1 closure and unchanged policy path/role metadata, but inside the old whole-source custody domain: therefore neither587 nor7792 is relabeled as a fresh77f execution/restoration. Prior assertion, process, custody and review records remain hash-exact; the wrapper stdout has its exact frozen938-byte prefix plus the final270-byte terminal log emitted after the runner wrote its freeze. The current acceptance floor is fresh execution of the full prior797 native identities plus the actual delivered V0/V5 and edited U1b controls, exact declared current input custody, and normal current source/type/build/repository delivery gates. Those root-owned runs are not claimed complete by this static appendix. Evidence is .tmp/post-77f-source-review; prior epochs and actual failures remain intact.


### Final77f live-binding composition accepted (2026-10-06)

The live publication guard reported actual main77f00492c7abe920368dc748d9127df33460fa32 after the signeddf901ead8d58067755b827f0689ed64b74225469 checkpoint. Root fetched that exact authoritative main and normally merged it without conflict. Astra independently reconstructed all11 incoming source results, including three shared files with disjoint old-Deno and V0/V5 main sites. The entire1865-file source domain (1863 modules/two READMEs) matches the staged live tree;1854 files remain unchanged. C1 structured intersection is empty, all12 closure and12 instrument pins, three resolver config pins and the same1633-byte declaration verify; no reseal is justified.

All seven policy/outer-metadata/C1 seal files remain full df90 bytes. The qualified587 cases/7792 custody therefore remain explicitly attributed to the prior6998/df90 epoch and are not relabeled as current whole-source custody. Independent retention review additionally accounts for the exact frozen run.stdout prefix plus its known post-freeze270-byte terminal append, without rewriting old records. No repeat metadata body occurred.

Fresh full35-file native collection and body each exited0:811/811 passed, no failed/pending/todo/unhandled diagnostics, empty stderr. All prior797 identities and duplicate ordinals remain, with eight actual V0 and six actual V5 cases. Full1930 declared input paths, source1863/two READMEs, restore bytes/hash/mode with zero additions/removals. The separately changed U1b regression file was collected and run once in its own ordinary process: six/six passed, exit0/empty stderr/exact identities, full1931 custody exact. These are separately measured populations, with no811 rerun or inferred denominator.

Current sourceTS7, normal three-stage production build and all twelve bounded gates each exited0 with77f as the explicit ratchet base. Current14-file source/test formatting and lint pass. Legacy/public compiler, full IR/artifact/performance parity and public source maps remain open. Root now carries the normal signed current-main commit through existingPR6341 only; verified exact main delivery is still the finite-claim completion condition. Evidence .tmp/post-77f-source-review, .tmp/post-77f-native-validation and .tmp/post-77f-publication.


## Current c26 capture-cell composition

After signed checkpoint 97ee6b18e7d94e717a22485891b349749a33e9ef, root normally merged verified main c26aa72d6e27489f0baa4c558b8bdca62e7365c1 without conflicts. The only incoming source change, arrow-phases.ts, matches an independent three-way reconstruction preserving Deno repairs and distinct capture-cell pointer slots. Installed source: 71740 bytes/SHA b1a2553e2ffab06715fd66b07c8e6bc5d868032e085090da18fa4db82465bfc6.

Fresh ordinary collection, test body and wrapper each exited0: 827/827 across36 files, retaining every prior811 identity/duplicate ordinal and adding16 measured authored capture-cell controls. All1950 declared input paths retain bytes/hash/mode, including exact assert.js, sta.js and runtime-script inputs. This is not an official test262 corpus run. Separate U1b6 remains attributed to77f. Source typecheck, production build, two-file formatting/lint and all12 repository gates passed against c26; existing explicit-any warning is unchanged.

Independent static review confirms no structured C1 path intersection and all12 closure pins exact. Policy/metadata/C1 inputs remain unchanged; qualified587/7792-custody observations retain6998/df90 epoch and are not current whole-source results. No redundant metadata body occurred. Evidence: .tmp/post-c26-native-validation/{review,static-review,epoch-delta}.json and .tmp/post-c26-publication.

Existing ready PR6341 is the only publication vehicle. Final signed commit/push/protected admission are pending at this record; only verified main ancestry/content closes the finite claim. All prior failures/fixtures/prepared packets remain preserved. Legacy compiler and full IR behavior/artifact/performance equality remain open.


## Implementation Plan — actual58d source composition and finite metadata successor (2026-10-06)

Architect: Codex GPT-6 Astra High. Root supplied authenticated main58d36ecb0a29d9508c5902214351efc491fc96f8 and published9937d36f7d9817c2cb9be7310202b60617eec3bb; their actual merge base is c26aa72d6e27489f0baa4c558b8bdca62e7365c1. The saved successor-base-selection record identifies existingPR6341 as OPEN, head9937, no queue entry, with auto-merge armed and quality failed. Root owns current PR/claim state and publication; this source review neither changes that state nor declares delivery. No new PR or allocation-analysis packet is authorized by this plan.

### Complete source and collision accounting

The incoming delta has36 paths, including11 source paths. Its intersection with the published branch delta is exactly five paths: compiler-boundaries.json plus class-bodies.ts, native-construct.ts, object-runtime-prototype.ts and object-runtime.ts. There is **no add/add source conflict**: classes/missing-super-return.ts is absent in both base and published branch and is an incoming-only addition. Do not manufacture an add/add resolution or reuse a similarly named helper as its operand. Independent complete cached base/ours/theirs line-splice reconstructions for all11 source outcomes and policy equal read-only git merge-file results, with zero intersecting base-line edits and zero conflicts. All operands and candidate pins are saved in .tmp/post-58d-source-spec/source-policy-review.json. These are scratch candidates, not installed source.

Root may normally merge the authenticated58d after preserving the separately owned quality repair. Accept Git's clean outcomes only after comparing all12 measured source/policy candidates; do not replace shared files wholesale with either side. Preserve the other25 incoming non-source paths through the normal merge, including both new regression files, execution-plan records, budget baseline and benchmark/public reports. No other incoming path overlaps the published branch delta. Retain every original Deno relocation/deletion, original test fixture and all previous source epochs. The final source domain becomes1864 module files plus two READMEs=1866 source files; only missing-super-return.ts is new. The independent lower-generic quality fix is an additional body change, not a thirteenth incoming path.

Four shared-file contracts are load-bearing:

- **class-bodies.ts:** retain Deno's unconditional enclosingClassName in both ordinary and host Promise-subclass constructor contexts. Independently adopt main's import and use of missingSuperReturnIsTypeError, including its oracle primitive/null classification and its deliberately narrow single-return shape. Preserve the existing missing-super replay/ReferenceError behavior outside that shape; do not broaden object-return behavior as an incidental repair.
- **native-construct.ts:** retain both Deno ordinaryConstructTargetFrame wrappers, ensureExnTag dependency, accumulated driverLocals and low-arity missing-dispatch apply fallback. Adopt main's coherent peer-first constructBoundaryPairs loops in both argv and fixed-arity drivers, and proxyNewTargetProtoInstrs in the trap-absent forward. Keep the proxy target read before the prototype trap can revoke it. Main's canBoundaryConstruct now gates vector availability while its actual loop additionally requires pairs; preserve that distinction when Deno uses this boolean for local allocation. Do not recreate the old independent boundary-kind/construct null-coalescing pair, remove the target frame, or change local indices.
- **object-runtime-prototype.ts:** retain Deno's closedCarrierPrototypeStatus arm and its currentProto/proposedProto locals in __setPrototypeOf. Adopt main's optional peer-first __getPrototypeOf arm and appended peerProto scratch, after the existing fnctor/array locals and before the JS boundary. These are different helper bodies and must retain their own local layouts.
- **object-runtime.ts:** retain Deno rest-only apply services/arm and reserveLinkedRealmPropertyRead at the existing reservation site. Adopt main's peer-first property read, unconditional reverse-peer capture, optional peer-first prototype binding and factored method-call arms. Preserve main's null-result ownership handling and peer→boundary→reverse ordering; a real peer null must not become a missing answer.

The other seven source outputs are complete58d blobs: missing-super-return.ts, object-runtime-proxy-construct-chain.ts, object-runtime-proxy.ts, standalone-link-boundary.ts, linked-provider-runtime.ts, runtime/wasmgc/values/object-get-bodies.ts and temporal-provider.ts. Their coupled behavior includes proxy prototype-trap/revocation ordering, coherent boundary pairs, peer-first reads/prototype/methods, rendered provider-init errors with original cause and unrenderable-error identity, native-regime raw export carriers and the native Intl shim/cache-key input. Preserve the delivered residual limitations and tests rather than claiming complete proxy realm or Temporal coverage.

### Measured policy successor and unchanged C1 declaration authority

Actual main has1846 rows/591096 bytes/SHAaf43508deba915273295751c8bc0487e5febb8c36bd8ced5a22dde06cde2d898. The only policy delta is the exact326-byte eight-line insertion for missing-super-return.ts, state unmigrated/layer mixed-needs-split/destination backend-wasmgc, at main row375. The independent normal-merge candidate is **1864 rows/596763 bytes/SHAb14d7e1d560ab263f0cfbdd1ae4d90e8f84a8aeba082296e58a497152ae5b848**, with that row at381. Removing it recovers all prior1863 row objects/order and every non-files field exactly. Do not call this new source clean or change other classification/ownership fields.

Update only the same existing outer helper, receipt and independent outer test, in addition to the normally merged policy. Preserve the helper's four public APIs and all capture/authentication/inverse/replay algorithms, all24 initial sites/17 reader adapters and all inner historical authorities. Rebuild the three fixed projections from complete immutable before operands to this exact final policy:

| Existing receipt projection | Complete target | Removed current rows | Independently measured raw spans |
| --- | --- | ---: | ---: |
| mainLineage | actual58d1846/591096/af43508d… |18 Deno-only rows|16|
| mainPredecessor | unchanged oldPosition1840/589117/58ae19c3… |24|20|
| denoPredecessor | unchanged oldDeno1856/594346/4ee416b7… |8|6|

Complete semantic inverse, raw inverse and forward replay already hold for all three scratch projections in projection-review.json. Span segmentation may vary only with identical complete operands and full reciprocal proofs. Update actual indices, neighbors, byte offsets and pins; never merely increment counts. MainLineage now authenticates actual58d, so name that new test-side operand honestly. Retain the complete old main6998/c26 policy1845 as an explicit historical/stale operand, reconstructable by reversing the fixed326-byte new-main insertion. Likewise retain old composed1863 by reversing the corresponding current insertion. Existing older1862/main431 reconstruction controls must first receive the exact former operand they were written against; prove its whole hash before their original deletion. Do not silently redirect an old main6998 assertion to1846 or erase old epoch controls. No new outer helper chain or permissive multi-current fallback is authorized.

Preserve all244 original outer controls by semantic identity, recording an explicit old→new title/duplicate mapping when row indices change. Add the new row's main/Deno current-row and previous/next negatives, actual58d lineage controls, and rejection of exact former1863/1845 current candidates. Keep malformed descriptor non-observation, physical policy/receipt corruption with finally restoration, strict whole-raw/semantic checks, genuine hole deletion and the complete-case RPC yield. Collect the actual new population; no future pass count is guessed here.

The structured C1 manifest path intersection with all11 incoming sources plus lower-generic.ts is empty, including population current8/dependency38, LinearOptions source/bindings/closure/resolver and current instruments. The relocation receipt also has no matching structured string. All12 closure pins,12 current-instrument pins and three resolver-config pins verify unchanged. Existing helper source mentions of object-runtime.ts belong to historical source-composition utilities, not an invented new C1 declaration dependency; no such historical helper is modified here. Thus preserve the411293-byte C1 manifest, anchor and external freeze string, all10 recipes and declaration authority. No automatic C1 reseal is justified. Recheck actual final pins after installation and stop on a genuine mismatch instead of rehashing it away.

This empty declared-source intersection does **not** keep the outer proof current: policy bytes and its helper/receipt/proof operands change, and C1's existing adapted policy capture passes through that outer route. Prior244+343=587 cases and7792 restored custody remain qualified6998/df90 evidence, not58d acceptance. Fresh complete updated outer proof and existing343-case C1 body are required after final freeze, with actual process exit0/no unhandled error and exact custody. Prove the24 real initial reader captures still recover the same full historical raw/semantic operands; unchanged inner bodies and identical historical outputs do not require an automatic replay of unrelated historical fault populations. A real mismatch expands only its affected proof.

### Reviewed quality repair and bounded acceptance

The saved quality failure is check:pushraw at the three rejection-event sites in lower-generic.ts. Sol owns only that routine source repair: replace the raw local.set/get with emitter.emitLocalSet(rejectedScratchPromiseIdx, out) and emitter.emitLocalGet(rejectedScratchPromiseIdx, out), whose WasmGC implementations emit the same local instructions. Keep the resolver-produced native event fragment on emitter.pushRaw and immediately annotate it `// pushraw-ok(#4376): native WasmGC rejection-event resolver fragment; async.throw is rejected by other backends.` The backend allowlists default-reject async.throw. Do not invent a nativePromiseCarrierActive guard: it belongs to the await path, not this condition. Preserve dispatcher authentication, optional absence, malformed-present refusal, all promise instructions and original tests. No out.push bypass, baseline waiver or changed gate is allowed.

After source/metadata review, freeze the complete current source/test/policy/helper/config/dependency domain with actual path counts. Root serializes physical-authority faults with compiler/native work. Refresh actual native evidence for the prior827-case36-file population, include the separately retained U1b controls and the two full unchanged delivered V4/provider-init test files, and preserve exact identities/duplicate ordinals. The V4 file covers null/undefined/super completion and prototype-trap revocation; provider-init covers exception rendering/healthy init, linked regime class construction/accessor/static/instance behavior and shim-dependent Intl initialization. Include existing callback/new.target, super/constructor and closed-prototype controls already in the frozen native body. Run the original change-scoped pushRaw gate and targeted rejection-event tests for the quality correction; count overlapping executions honestly. Runtime behavior, exception identity and unhandled diagnostics matter, not compilation alone. Any new interaction failure is diagnosed before an additional bounded change.

Run current source typecheck, ordinary production build, applicable normal repository inventory/architecture/format/lint/budget gates against actual58d and the final composed vector. Preserve the established distinction between a valid current inventory and the deliberately incomplete full architecture graph. Keep old827/811/797/native, all metadata epochs and actual process failures unchanged. Only root performs normal signed publication and protected admission through existingPR6341 after fresh exact-head/base checks; current CI successes on9937 do not certify this new source. Full Deno completion, full IR/legacy equality, compiler performance and legacy retirement remain open.

Architect output is this append plus ignored .tmp/post-58d-source-spec operands/candidates/projections; no source/test/policy/C1 installation, Git-state/network mutation or test/build/benchmark run was performed.


### Actual58d implementation and validation completed (2026-10-06)

Root Codex GPT-6.1 Sol High integrated the independently reviewed constructor/provider main58d36ecb0a29d9508c5902214351efc491fc96f8 and narrow rejection-event pushRaw repair. Sol6.1Medium measured native837/837 across38files plus separateU1b6/6, preserving all prior827 identities and scoped1953/1954 input custody. Source TypeScript7 and ordinary production build, final metadata TypeScript7, full repository formatting/lint,15local architecture/quality gates and five explicitactual58d change-scoped checks all exited0. Previous CI quality failure is preserved and the actual pushRaw gate now passes.

AstraHigh independently approved the exact three-file policy successor with all244 old identities and16 additions. Actual complete collection260outer+343C1=603 qualified. Both fresh full ordinary processes ran once and exited0:260/260 and343/343, no failed/skipped/pending/todo or unhandled errors, exact603 identities/duplicate ordinals, full7798 scoped inputs restored byte/hash/mode/inode/device. Source1864modules+twoREADMEs and all C1 authority/closure/instrument/config pins remain exact; no C1 reseal. Frozen evidence: .tmp/post-58d-native-validation/{review.json,u1b/review.json}, .tmp/post-58d-outer-independent/review.json, .tmp/post-58d-outer-validation/{final-review.json,final-freeze.json}, .tmp/post-58d-publication/. Official corpus identity is custody evidence only; no full test262 execution or merge delivery is claimed.

Existing ready PR6341 is the sole delivery route. Root now performs normal signed commit/push and protected exact-head admission, with no hook/protection bypass. Finite claim remains held until actual main ancestry/content proves delivery. All historical failing processes/epochs remain recorded; complete IR/Deno/public-map/performance equality and legacy retirement remain open.

### 2026-10-06 exact 0bead407 main delivery refresh

Existing ready PR6341 exact published f22b431356 remains unmerged. One purposeful delivery-base read found all70 checks completed without terminal failures but the PR DIRTY against actual0bead4077c273bc05a9657819ade8049457bd32d. Fresh fetch independently returned the same main SHA; cached refs/baseRefOid were not used to merge. Clean integration worktree staged that exact merge. Sole conflict was two additive imports in `expressions/new-super.ts`; union retains old super/new-site helpers plus main uninitialized-this/effective-this helpers, preserving Deno and delivered ES2015 changes. No downstream Source-Map work was merged into this PR.

Root source TS7 at the merged epoch passed. Native refresh retains the prior837 identities plus separateU1b6 and adds the three delivered main V6/V7/string-receiver files; exact collected/body populations and current input custody must qualify before commit. Current source policy is1866 rows with two exact added main rows (extern-get-string-receiver and module-namespace-exotic), a671-byte inverse to prior596763/b14d7e1d policy. C1 remains411293/aaeaf407 with all instrument/immutable/closure/config/population pins exact; no blind C1 reseal is authorized. File-disjoint existing outer3-file successor is delegated in a newly isolated same-base worktree under claimed4376:6341-post0be-metadata-successor-20261006; preserve all260 outer and343 C1 identities, old endpoints/faults/fixtures and source guarantees. No hook/protection bypass, forcepush, duplicatePR or main delivery claim.


### Actual 0be composition qualified for existing PR publication (2026-10-06)

Root integrated authenticated main0bead4077c273bc05a9657819ade8049457bd32d into published f22b431356bda8dec7ea21c834adf790e414aba9. Independent review reconstructs all1,868 source/README outcomes, preserves both parents including the four-name new-super import union, and finds no SourceMap6865 leak. Fresh ordinary native collection/body qualify858/858 across42files: original837 plus separateU1b6 retained,15actual V6/V7/native-string cases added; all7,794 declared inputs remain exact. Source TS7, ordinary three-stage production build, full repository format/lint and15 architecture/quality gates against actual0be all exit0.

Astra independently approved only the three existing outer successor files. Two new main rows produce current1866-policy597434/SHA458d779de0e7078b08626a240c936bfd710f6b5f18453b19f9b4ddd4ede8246a; exact671-byte inverse restores prior1864 policy. All historical routes and260old case identities remain, with28real additions. Original stale-profile baseline260failures/exit1 remains preserved. Current root actual collection631 is exact:288outer+343C1. Both complete fresh ordinary bodies each exit0, all631 pass, no failed/pending/todo/unhandled errors; all7,803 declared inputs and Node/dependency/corpus identities restore bytes/hash/mode/inode/device. No physical authority remains faulted. All C1 instruments/immutable/closure/config pins and411293-byte manifest remain unchanged; no reseal.

Evidence: .tmp/post-0be-main-refresh/{native-review.json,metadata-installation.json,metadata-static.json,gates.json,build.command.json}, outer-independent and composition-independent frozen reviews; .tmp/post-0be-metadata-validation/{registration.json,review.json,freeze.json}. Native858 and metadata631 are measured local populations, not official full test262 execution, complete Deno/IR parity or delivered main. Root now uses normal signed commit/hooks and the existing ready PR6341 branch only, then exact-head protected admission. Finite claims remain held until actual main ancestry/content verifies delivery. No hook/gate/protection bypass, forcepush, duplicatePR, downstream refresh or legacy retirement.


### Actual protected-queue hold discovered before publication

Fresh purposeful publication guard confirms existing PR6341 stillOPEN atf22, basemain0be, but now bot-held andautoMerge disabled. Actual timeline records a failed required merge-group test262 verdict: run37510995236/job112437743141, failingstep Fail on regressions, parked18:51:47Z. Local current858/631 passes do not supersede that full-corpus verdict. Root assigned a readonly row-level run/log/artifact diagnosis to the existing native Sol agent; no new source scope, no hold removal or admission yet. Preserve exact baseline/harness/lanes and original failures. The current independently approved0be merge can be signed and published through the existing heldPR to retain concrete progress, while protected admission stays blocked until the actual conformance cause is fixed or proved addressed. No main delivery is claimed.
