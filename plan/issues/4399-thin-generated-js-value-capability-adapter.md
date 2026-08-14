---
id: 4399
title: "Extract a thin generated JavaScript value and capability adapter"
status: in-progress
created: 2026-08-13
updated: 2026-08-13
priority: critical
feasibility: hard
reasoning_effort: max
task_type: refactor
area: runtime, host-interop
language_feature: wasm-js-interop
goal: architecture
sprint: current
parent: 4395
depends_on: [4397, 4398]
required_by: [4401]
horizon: xl
related: [983, 1382, 1917, 1932, 1934, 1950, 1996, 2015, 2025, 2028, 3526, 4035, 4382]
---
# #4399 — Thin generated JS value and capability adapter

## Objective

Decompose the current monolithic JS runtime into a generated adapter whose
durable responsibilities are:

- instantiate and wire the module/import/provider graph;
- marshal values across JS/Wasm boundaries;
- preserve wrapper identity and object/array visibility;
- make exported Wasm closures callable from JS and JS callbacks callable from
  Wasm;
- translate exceptions without losing type, message, cause, or catchability;
- bind only the explicit platform capabilities the module requests.

ECMAScript semantic providers should leave this adapter family by family under
#4397. The adapter remains even when semantic host imports reach zero.

## Required value contracts

| Boundary value | Required JS behavior |
| --- | --- |
| primitive | exact value, including NaN, signed zero, BigInt, Symbol policy |
| native string | defined encoding conversion with malformed-surrogate policy |
| value record/DTO | current live wrapper by default; copy only for an explicit value ABI/WIT record |
| mutable object/class | stable current/generated wrapper/proxy; Wasm remains authoritative |
| opaque resource | explicit handle; never a misleading partial plain object |
| vector/array | declared copy or live-view policy, including mutation/write-back |
| struct/object | property visibility, prototype/class mapping, stable identity |
| closure | callable wrapper with `this`, arity, return, throw, and re-entry |
| exception | catchable translation with render/identity rules |
| callback | recursion-safe JS→Wasm→JS invocation and lifetime management |

Using the current JavaScript-backed wrappers, arrays, functions, `Error`
instances, caches, and proxies at a JavaScript boundary is intentional and is
the default migration path. `_wrapForHost` presents a live Wasm-owned value,
its WeakMap caches preserve stable wrapper identity, and `_unwrapForHost`
recovers the same Wasm reference on re-entry. The refactor confines this
machinery to the boundary; it does not replace it with copies.

The Wasm value remains the storage and semantic authority. Host sidecars may
cache adapter metadata and identity, but may not remain the only owner of
ECMAScript properties, descriptors, prototypes, or integrity state after the
corresponding native provider migrates. Copying is opt-in only for an explicitly
value-typed ABI/WIT record. Every aggregate boundary type still declares one of
three policies — live identity-bearing view (default), copied value, or opaque
resource handle — so mutation and `===` behavior are deliberate.

## Acceptance criteria

- [x] Generate the adapter from frozen import/capability/value-boundary
      manifests; do not scan import spellings in one giant resolver switch.
- [ ] Split value marshaling, capability binding, semantic legacy fallbacks,
      and instance lifecycle into separately owned modules with a versioned ABI.
- [x] A JS-hosted module using native semantics still exposes arrays, objects,
      closures, callbacks, and exceptions correctly.
- [x] Stable wrapper identity and unwrap-before-call/compare behavior are tested
      across repeated and cyclic round trips.
- [x] Every aggregate boundary type declares copied-value, live-view, or opaque-
      handle policy; generated adapters reject an undeclared aggregate policy.
- [x] The adapter contains no ambient capability not present in the compile
      manifest, aside from an explicitly versioned compatibility mode.
- [x] Per-family extraction reduces `runtime.ts` and its semantic import
      dispatch count; the adapter may grow only when it adds a real boundary
      type or capability ABI.
- [x] Multi-instance tests prove caches and export wiring do not bleed between
      instances.

## Migration rule

Never delete a runtime helper solely because the corresponding operation now
runs natively. First classify it as semantic provider, value bridge, capability
adapter, or lifecycle support; only the semantic-provider class is a retirement
target.

## Implementation progress — 2026-08-13

- `wrapExports(..., { marshal: "live" })` now returns the existing
  identity-cached `_wrapForHost` view and unwraps it before a typed export call.
  Wasm remains the authoritative object; no DTO copy is introduced.
- Successful compile results carry the frozen provider/interop profile.
  `wrapCompiledExports(result, instance)` selects the live boundary
  automatically for native-first JS builds and preserves copy compatibility
  for legacy builds. It fails closed if live wrapping is requested for a
  target whose host bridge is off.
- Focused tests prove repeated-return identity, live Wasm mutation visibility,
  host writes, and JS→Wasm recovery of the same object reference.
- Primitive-like native carriers remain values rather than live objects. Export
  metadata now routes native string parameters/results through the generated
  string bridge at the edge, while mutable Wasm objects retain their stable
  proxy identity.
- Native `$Object` values expose a narrow generated boundary MOP. The cached JS
  proxy delegates property reads, writes, `has`, deletion, and enumerable-key
  discovery to Wasm, so the property table remains authoritative and a copied
  shadow object is not introduced.
- The inverse object direction is also identity-preserving: a raw caller-owned
  JS object crossing an `any`/`unknown` export is recorded under an
  instance-unique generated helper authority and remains JS-backed. Native
  dynamic member reads/writes may call only the typed
  `__boundary_object_get`/`set`/`has`/`delete`/`keys`/`call` adapter, which
  rejects every object not admitted by that module instance. Values crossing
  through those operations use the same native primitive carriers and live
  Wasm wrappers; method calls retain the raw JS receiver as `this`; no property
  bag is copied.
- A two-instance test admits the same JS object through one wrapper, proves a
  raw call into the other instance cannot use that authority, then admits it
  explicitly through the second wrapper. The authority key is an
  instance-unique generated helper function rather than a module-global set.
- `src/runtime/boundary-object-adapter.ts` now owns the admitted JS-object MOP
  outside the monolithic resolver. It has no ambient capability access and can
  act only on objects admitted by the current module instance.
- The MOP covers descriptors, accessor/data definitions, prototype mutation,
  own string/Symbol keys, inherited `for-in`, raw arrays, and cyclic graphs.
  Wasm-native objects continue to use `$Object`; only the non-`$Object` edge
  consults the boundary adapter.
- JS callbacks use an explicit `boundary_callback` import intent. Returned Wasm
  closures and admitted callbacks are tested for callability and re-entry
  without falling back to the legacy generic host-call semantic helper.
- Export metadata declares primitive, copied-value, live-view, or opaque-handle
  policy. Native-first aggregates default to live views; typed-array inputs
  retain the current explicit copy contract.
- The adapter retains the caller's actual Proxy and integrity state. Supported
  `Reflect` operations fire that Proxy's traps, while freeze/seal/extensibility
  operations mutate and query the original JS object. An explicit admission
  probe prevents a random externref from acquiring this authority.
- The boundary MOP now covers `Reflect.apply`, `Reflect.construct`, and
  explicit-receiver get/set. Argument vectors are read through the same
  per-instance live/native conversion path, preserving `this`, `newTarget`,
  results, and Proxy traps without copying the target or receiver.
- The same boundary machinery is now the only JS edge for a Wasm-owned Proxy
  whose target is an admitted caller function. ProxyCreate stores the original
  JS reference and a two-bit callable/constructible classification; absent
  apply/construct traps forward through the existing live argument conversion
  and return the original JS result or instance. Inline compiled targets never
  enter this adapter.
- Wasm-owned vectors use the existing identity-cached live facade at the JS
  boundary. Generated writeback exports make numeric index and `length`
  mutation authoritative in Wasm, while compatibility builds retain their
  historical copied iterable path.
- Wasm-owned native Promises similarly become identity-cached real JS Promises
  only at the boundary. Two typed `boundary_promise` settlement adapters notify
  that view without moving Promise state or chaining semantics into JS.
  Caller-owned JS Promises take the inverse admitted-object path and are not
  copied or replaced; delayed fulfillment/rejection re-enters and drains the
  native microtask queue for that module instance.
- `buildCompiledImports(result, ...)` now binds from the successful compile
  result's frozen profile and validated capability manifest. Native-first
  binding disables ambient Iterator/RegExp compatibility mutations; the
  low-level compatibility API retains that behavior only as an explicit
  versioned compatibility default.
- Successful results now carry a recursively frozen v1 JavaScript adapter
  manifest containing the normalized target, exact typed imports, string pool,
  capability contracts, export signatures, and per-slot boundary policies.
  The generated `.imports.js` helper serializes that same plan and calls
  `buildCompiledAdapterImports`, so a native-first build cannot accidentally
  recover the low-level compatibility defaults after emission.
- `wrapCompiledExports` consumes the declared per-slot policies rather than
  inferring one copy/live choice for the whole module. Live slots unwrap the
  existing identity-backed facade on re-entry; copied TypedArray inputs retain
  their declared value ABI; opaque slots remain handles. Both import binding
  and export wrapping reject a missing or inconsistent aggregate declaration
  before publishing the adapter.
- Boundary object, callback, and Promise imports now leave the monolithic
  semantic resolver through one typed `boundary-value` dispatcher. Dedicated
  adapter modules own admitted-callback invocation and native-Promise
  settlement; they receive only per-instance admission/conversion callbacks
  and never inspect import spellings or ambient capabilities.
- Instance/export wiring and start-section deferral now live in a dedicated
  lifecycle adapter. It owns the current export view, validates genuine
  `WebAssembly.Instance` input, and drains per-instance deferred operations;
  runtime value conversion is supplied as a callback. The former dead
  callback-detection flag and the last by-name manifest-loop checks were
  removed. Host-exception recovery is now a typed `caught_exception` lifecycle
  intent instead of a special import spelling.
- `src/runtime/platform-capability-adapter.ts` now owns the dedicated capability
  intents for console, declared globals, dynamic import, timers, Web Storage,
  Node modules/functions/metadata, JSX, clock, and Math providers. It receives
  only a narrow closure-conversion service from the value boundary; it does not
  inspect or install compatibility semantics.
- Ambient Iterator helpers and Annex-B RegExp statics are installed only by
  `src/runtime/compatibility-adapter.ts`. An initial
  `compatibility-semantic-adapter.ts` also owns host dynamic operators, Date,
  Proxy construction, await identity, and compatibility string literals.
  Low-level native-first binding rejects every legacy/unknown import before it
  reaches either compatibility module.
- This extraction removed 536 lines from `runtime.ts` and added 441 lines in
  the three owned adapters, reducing the measured runtime source surface by 95
  lines. Focused capability, JSX, Node, Iterator/RegExp, dynamic-operation,
  Proxy, and native-boundary tests remain green.

Wasm-created `Proxy.revocable` no longer needs an adapter semantic fallback: its
Proxy, result object, and revoker are Wasm-owned, while an exported result still
uses the ordinary identity-backed live view. Still open: moving the remaining
mixed `extern_class` capability/compatibility arms and remaining per-family
semantic binders out of the monolithic resolver, completing the Proxy MOP
invariants tracked by #4402, and broader binary/startup measurement.
