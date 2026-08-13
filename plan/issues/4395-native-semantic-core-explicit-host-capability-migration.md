---
id: 4395
title: "Native semantic core with explicit host capability and value-interop providers"
status: in-progress
created: 2026-08-13
updated: 2026-08-13
priority: critical
feasibility: hard
reasoning_effort: max
task_type: epic
area: runtime, host-interop, compiler, linking
language_feature: compiler-internals
goal: architecture
sprint: current
horizon: xl
related: [1524, 2094, 2514, 2520, 2783, 2879, 2961, 3526, 3681, 4035, 4382]
loc-budget-allow:
  - src/codegen/any-helpers.ts
  - src/codegen/array-methods.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/binary-ops-typed-dispatch.ts
  - src/codegen/binary-ops.ts
  - src/codegen/class-bodies.ts
  - src/codegen/context/types.ts
  - src/codegen/dataview-native.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/json-codec-native.ts
  - src/codegen/native-strings.ts
  - src/codegen/object-ops.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/registry/imports.ts
  - src/codegen/regexp-standalone.ts
  - src/codegen/statements/loops.ts
  - src/codegen/statements/variables.ts
  - src/codegen/type-coercion.ts
  - src/compiler.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/any-helpers.ts::ensureAnyHelpers
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/expressions/assignment.ts::compileDestructuringAssignment
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/json-codec-native.ts::emitJsonParseText
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/property-access-dispatch.ts::tryBufferViewAttributeReads
  - src/codegen/statements/loops.ts::compileForInStatement
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/compiler.ts::compileSourceSync
  - src/compiler.ts::runPipeline
  - src/compiler/import-manifest.ts::classifyImport
  - src/runtime.ts::_wrapForHost
oracle-ratchet-allow:
  - src/codegen/array-methods.ts
  - src/codegen/binary-ops.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/property-access-dispatch.ts
coercion-sites-allow:
  - src/codegen/declarations.ts
  - src/codegen/object-runtime.ts
---
# #4395 — Native semantic core with explicit host capability providers

## Decision

Keep JavaScript-host interoperability, but stop growing the JavaScript host as
a peer implementation of ECMAScript semantics.

The long-term split is:

1. **Language semantics** execute through backend-native or self-hosted Wasm
   providers by default: objects, arrays, coercion, JSON, collections, Promise
   state, and other ECMAScript behavior.
2. **Platform capabilities** remain explicit imports: filesystem, network,
   clocks, randomness, timers, DOM, and application callbacks. A JS adapter,
   WASI module, or another Wasm provider may satisfy the same declared ABI.
3. **Value interop** remains a first-class boundary service. JS callers still
   need stable wrappers and marshaling for WasmGC arrays, structs, closures,
   exceptions, strings, and identity.
4. **Exceptional accelerators** may use a host provider only when measured and
   replaceable: for example Intl, dynamic code, or a deliberately accelerated
   RegExp/BigInt provider.

This is an incremental convergence program. Existing `gc`, `standalone`, and
`wasi` behavior stays compatible until each provider family meets its own
parity and retirement gates.

## Why the host cannot simply be deleted

`src/runtime.ts` currently combines two responsibilities that must be split,
not removed together:

- semantic fallbacks such as dynamic property/coercion/builtin operations;
- the JS/Wasm value bridge: `_wrapForHost`, `_unwrapForHost`, proxy identity
  caches, `__vec_*`, `__sget_*`/`__sset_*`, `__call_fn*`, exception rendering,
  callbacks, and instance/export wiring.

Without the second responsibility, JS receives opaque WasmGC references:
compiled arrays do not become ordinary JS arrays, compiled struct fields are
not readable through normal property access, and compiled closures are not
directly callable. Native semantics inside the module do not solve that ABI.

The migration therefore shrinks **host-backed semantics** while retaining and
making explicit a thin **host value adapter**.

## Program

- #4396 separates backend, execution environment, import authority, semantic
  provider policy, and host-value interop into one normalized target profile.
- #4397 makes native semantic providers selectable in a JS environment and
  migrates provider families behind parity gates.
- #4398 generalizes explicit platform-capability imports to swappable JS,
  WASI, and Wasm providers.
- #4399 extracts a thin generated JS value/capability adapter from the current
  monolithic runtime without regressing identity or callability.
- #4401 adds the fallback inventory, size/crossing ratchets, compatibility
  transition, and final retirement criteria for implicit host semantics.

Existing work remains authoritative rather than being duplicated:

- #3526 owns the typed semantic-runtime manifest and provider selection.
- #2514 owns shared core-Wasm runtime provider packaging and ABI versioning.
- #4382 owns the public capability/explain projection.
- #3681 owns whole-program differential behavior across targets.

## Implementation progress — 2026-08-13

The compatibility-neutral profile (#4396) is complete. A public/CLI
`native-first` policy now selects native strings, JSON, RegExp, Error,
boxing/open-object, and migrated dynamic-operator providers in a JavaScript
environment without disabling JS capabilities or value interop. The live
boundary path reuses `_wrapForHost`/`_unwrapForHost`; caller-owned JavaScript
objects remain raw identity-bearing host objects and are admitted to a narrow
per-instance object/callback adapter rather than copied into Wasm. That adapter
now covers reads, writes, calls, descriptors, prototypes, string/Symbol own
keys, inherited `for-in`, integrity state, explicit-receiver access,
apply/construct, cycles, raw arrays, and caller-owned Proxy traps while
preserving the original JS identity. Wasm-owned arrays use an identity-cached
live view with element and length write-back; native Symbol state stays in Wasm
and maps to stable real JS Symbols only at the boundary. Compiler results carry
their frozen policy profile, declared boundary-value policies, a typed import
inventory, crossing counters, and versioned platform-capability requirements
with provider ABI validation. Native-first import binding no longer installs
ambient compatibility semantics, and CI rejects any legacy or unknown semantic
import in the representative native-first lane. Native Promise state,
`then`/`catch` chains, and async/await also remain in Wasm; identity-cached real
JS Promises are created only when a Promise crosses an exported boundary, and
caller-owned JS Promises are admitted per instance without copying. Defaults
have not flipped. Object-rest now copies properties into a fresh Wasm-owned
result while leaving an admitted JS source untouched; DataView window state no
longer lives in a JS WeakMap; and native-first Function bind reuses the
Wasm-owned bound-function carrier. Only binds rooted in a dynamic caller-owned
JS function retain the explicit callback boundary, while compiled bind chains
link no callback helper. Generated `.imports.js` files now serialize the same
frozen v1 target/import/capability/value-boundary manifest returned by the
compiler, and aggregate slots without a declared copy/live/opaque policy fail
before the adapter exposes imports or exports.

The native-first surface now also formats BigInt values in Wasm, routes
RegExp-backed string split/array join and ordinary `String.raw` through their
existing native providers, and implements `Proxy.revocable` with a Wasm-owned
revoker carrier. JavaScript is not the semantic owner of those operations; only
an actual exported value uses the normal identity-backed live adapter.

Native Proxy creation, call, and construction now keep their target and handler
as canonical Wasm values. Inline arrows/function expressions are real native
closures at ProxyCreate, primitive targets/handlers fail before allocation, and
ordinary function expressions alone carry the native `[[Construct]]` bit. When
the target is a caller-owned JavaScript function, the Proxy stores that exact
admitted reference and uses the narrow boundary apply/construct adapter only at
the operation edge. The constructed JavaScript instance crosses back unchanged;
there is no copied constructor, target, argument bag, or result object.

Native-first is now enforced as a publication invariant rather than treated as
a best-effort preference. After code generation, the compiler inventories the
actual module and rejects any `legacy-semantic` or `unknown` import before
binary/helper publication, listing every rejected edge and its owner. The
low-level JavaScript adapter applies the same rule when ambient compatibility is
disabled. Unsupported families therefore fail explicitly and remain available
through the named host-assisted compatibility profile; they cannot silently
recover the monolithic JS semantic runtime.

Capability binding, ambient compatibility installation, and an initial set of
compatibility-only semantic providers now live in separately owned runtime
modules. The extraction moved console/globals/dynamic import/timers/Web Storage,
Node/JSX/clock/Math provider binding plus host dynamic operators, Date, Proxy,
and string-literal compatibility dispatch out of `runtime.ts`. The monolith
fell by 536 lines; the extracted modules contain 441 lines, a measured net
reduction of 95 runtime-source lines without deleting boundary behavior.

## Invariants

- No new ECMAScript feature is implemented only by an implicit JS `env` import.
- A native provider may be used in a JS environment; environment and semantic
  implementation are independent axes.
- Removing a semantic import must not remove JS value interop for the affected
  arguments, results, callbacks, exceptions, or identity relationships.
- A portable build may have imports. "Portable" means no implicit JS runtime,
  not "no declared capabilities."
- Missing providers and unsupported value mappings fail before publication;
  they never silently become `undefined`, empty, or an opaque wrong value.
- Legacy mode names remain compatibility aliases until the migration has
  measured adoption and published a removal path.

## Completion criteria

- [x] The compiler exposes independent backend, environment, capability, and
      semantic-provider decisions internally and in #4382's explain output.
- [ ] JS-host execution can select the same native semantic providers as a
      host-free build, family by family.
- [ ] Platform APIs are declared as explicit capabilities with at least two
      interchangeable provider classes where the platform permits it.
- [ ] The JS adapter is value/capability-focused; semantic fallback families
      remaining in it are explicitly inventoried, owned, and ratcheted down.
- [ ] JS→Wasm→JS round trips preserve stable identity, array/object visibility,
      closure callability, exceptions, and callback re-entry after semantic
      imports are removed.
- [ ] The current JS-host and standalone modes remain usable throughout the
      migration, with byte/behavior compatibility recorded for each slice.
- [ ] The final default-policy change is evidence-driven and retains explicit
      opt-in host accelerators where they provide measured value.

## Out of scope

- Removing JavaScript as a supported embedder.
- Pretending WasmGC references already satisfy the JavaScript object model.
- Replacing explicit platform imports with ambient authority.
- A big-bang rewrite of `runtime.ts` or simultaneous conversion of every
  builtin family.
