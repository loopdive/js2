---
id: 4397
title: "Select native semantic providers in JavaScript environments family by family"
status: in-progress
created: 2026-08-13
updated: 2026-08-13
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: runtime, codegen, ir
language_feature: runtime-helpers
goal: architecture
sprint: current
parent: 4395
depends_on: [4396]
required_by: [4399, 4401]
horizon: l
related: [679, 682, 1524, 2094, 2514, 2879, 2961, 3526, 3681, 3912]
---
# #4397 — Native semantic providers in JS environments

## Objective

Make semantic provider choice independent of whether JavaScript instantiates
the module. A JavaScript embedder should be able to use native strings,
objects, collections, JSON, Promise state, and other Wasm providers while
retaining only the JS value adapter and explicit platform capabilities.

## Landing sequence

1. Extend #3526's provider definitions with explicit provider class and policy:
   backend-native, self-hosted inline, linked Wasm, host accelerator, or
   required platform capability.
2. Inventory existing dual implementations and select a low-risk, already
   native-complete family as the pilot. The pilot must be semantically closed;
   it may not leave half the operations on incompatible host representations.
3. Permit that native provider under the default WasmGC/JS environment behind
   a family-scoped policy switch.
4. Compare behavior, emitted imports, binary size, startup, steady-state cost,
   and host-boundary crossings.
5. Promote the native provider only after the JS-host, host-free, and
   JS-value-round-trip gates agree. Repeat family by family.

## Acceptance criteria

- [ ] Provider selection reads typed semantic/runtime requirements rather than
      emitted import names or the source AST.
- [x] At least one nontrivial family uses the same native implementation in a
      JS and non-JS environment.
- [x] Each migrated family removes its semantic `env` imports without removing
      required marshaling, callback, exception, or host-value adapter paths.
- [x] Differential tests cover values and observable errors, not only Wasm
      validation or the absence of imports.
- [ ] A host accelerator is retained only with a named capability, native
      fallback, and measured reason; otherwise the native provider becomes
      canonical.
- [ ] Test262 changes report both lane denominators and distinguish genuine
      behavior changes from harness/import classification changes.

## Non-goals

- Converting every family in one PR.
- Routing platform APIs such as DOM or filesystem through in-Wasm emulation.
- Treating a higher pass count with opaque/wrong JS values as progress.

## Implementation progress — 2026-08-13

- `CompileOptions.semanticProviders: "native-first"` selects migrated native
  families independently from environment, capability authority, and
  `hostBridge`. The CLI exposes the same policy.
- Native strings are the first completed family. A JS-target build uses the
  same native string implementation as host-free lanes, emits no
  `wasm:js-string` semantic provider, and retains only explicit console plus
  the `__str_*` value marshal when the program calls `console.log`.
- `tests/issue-4397-native-semantic-js-host.test.ts` executes string semantics,
  compares host-assisted and native values/errors, ratchets the pilot to zero
  `legacy-semantic`/`unknown` imports, and proves live JS object identity plus
  JS→Wasm unwrapping after the semantic switch.
- Export signature metadata now marks source-level string parameters/results.
  Native-first JS builds expose the existing generated string bridge only at
  that boundary, so JS still observes primitive strings while mutable
  Wasm-owned objects retain identity-stable live views.
- The native JSON codec now runs under the JS environment when native-first is
  selected. Differential coverage parses a JS string, mutates the resulting
  native object, stringifies it, checks malformed-input errors, and verifies
  that no `env::JSON_*` or other legacy-semantic imports remain.
- Boxing/`typeof` helpers and the open-object runtime now follow the semantic
  provider policy rather than the presence of a JS embedder. The live boundary
  delegates native open-object reads, writes, `has`, deletion, and key
  enumeration to narrow generated Wasm exports and converts native primitive
  carriers back to JS primitives.
- Dynamic addition, relational comparison, strict equality, and loose equality
  now select the native provider in both the direct and IR lowering paths.
  Focused differential cases cover primitive coercion, `null`/`undefined`, an
  internal object `valueOf`, and boundary round trips without importing
  `__host_loose_eq`.
- A caller-owned JavaScript object passed to an `any`/`unknown` export stays a
  raw JS object. A per-instance boundary authority permits only that admitted
  object to use the narrow `__boundary_object_get`/`set`/`has`/`delete`/`keys`/
  `call` value adapters; native `$Object` values never route through those
  imports. Boundary method calls preserve the raw receiver as `this`, marshal
  native primitive arguments, and preserve an object result's identity.
- The admitted-object MOP also covers own-property descriptors, data/accessor
  definitions, prototype reads/writes, string and Symbol own-key enumeration,
  and inherited `for-in`. Cyclic objects and raw JS arrays remain the original
  caller-owned values; mutations are not copied through a shadow bag.
- Returned Wasm closures remain directly callable in JS, and admitted JS
  callbacks re-enter Wasm through an explicit fixed-arity boundary-callback
  intent rather than the legacy generic call-function semantic fallback.
- Native-first implicit TypeError sites use the in-module Error provider even
  in a JavaScript environment. The focused object/callback lane now reports
  zero legacy-semantic and zero unknown imports while measured crossings still
  prove that the retained value adapter is exercised.
- The supported native-first `Reflect` subset routes through the same object
  runtime. Its non-`$Object` arm first proves per-instance admission, then uses
  the original JS object for get/set/has/delete, descriptors, definitions,
  prototypes, exact `ownKeys`, and extensibility. Caller-owned Proxy traps fire
  normally because the adapter invokes `Reflect` on the admitted Proxy itself.
- Object integrity operations use the boundary only for an admitted JS object.
  `preventExtensions`, `seal`, and `freeze` mutate that original value, and
  their predicates encode an explicit not-admitted/false/true result so
  Wasm-owned objects still fall through to native `$Object` flags.
- Symbol descriptions, identity, well-known symbols, and the global Symbol
  registry now remain native in a JS environment. A per-instance boundary map
  presents stable real JS Symbols, admits caller Symbols on re-entry, and does
  not reintroduce the legacy Symbol semantic imports.
- Native-first ref widening no longer calls the compatibility
  `__make_iterable` helper. Returned Wasm vectors use the existing cached live
  array facade, and numeric-index or `length` writes update the canonical Wasm
  vector rather than a copied host array.
- The admitted-object `Reflect` lane now includes explicit-receiver get/set,
  apply, and construct (including distinct `newTarget`). Native known functions
  stay on the native path; only statically unknown caller-owned targets use the
  boundary adapter. Focused cases exercise ordinary functions/constructors and
  Proxy apply/construct traps with zero legacy or unknown imports.
- Collections, Date, Number formatting, and BigInt arithmetic now have explicit
  JS-environment runtime parity cases under native-first. They execute the
  existing Wasm providers and assert that no `Map_*`, `Set_*`, `WeakMap_*`,
  `Date_*`, `number_*`, or `bigint_*` semantic import returns.
- Native Promise state, `Promise.resolve`/`reject`, `then`/`catch`, and
  async/await now use the existing Wasm Promise carrier in a native-first JS
  environment. At an exported boundary, the adapter creates one identity-cached
  real JS Promise per native Promise and observes its settlement through two
  typed value-adapter imports. In the reverse direction, a caller-owned JS
  Promise is admitted per instance, remains the original object, and drives the
  native continuation when it settles; fulfillment values and rejection
  reasons preserve normal boundary conversion and identity.
- Native array pipelines no longer fall back to `__array_from_iter` or a
  temporary host array. Closure-producing receivers such as
  `values.map(fn).join("-")` skip the unsafe double-compilation probe and feed
  their canonical Wasm vec directly into native `join`. Live boundary arrays
  mirror only the real-array facade's shape length; every element read/write
  still targets the identity-cached Wasm vec.
- `Object.keys`, `Object.assign`, and object spread now keep their result
  builders and property MOP in Wasm under native-first. Dynamically-routed
  closed structs gain the native enumeration arms previously enabled only for
  standalone, assign literals (including an empty target) are built as native
  `$Object`s, and the JS boundary consults an open object's MOP before any
  closed-layout getter that happens to share a property name.
- `parseInt`, `parseFloat`, URI encode/decode, and Annex-B `escape`/`unescape`
  now select their existing native providers in a JavaScript environment. The
  focused tests compare observable values and malformed-URI errors and ratchet
  the related legacy/unknown import count to zero.
- Object-rest `CopyDataProperties` now creates its language-mandated fresh
  result in Wasm under native-first. Closed structs materialize through the
  native object runtime; an admitted caller-owned JS source is enumerated and
  read through the narrow boundary MOP without copying or replacing the source.
  Compatibility retains its existing `__extern_rest_object` ABI.
- DataView byte windows are now native-provider state in a JS environment. The
  constructor stores offset/length in the Wasm `$__dv_window` carrier and no
  longer registers semantic state in the runtime WeakMap. A caller-owned real
  JS DataView remains the original admitted object and uses boundary method
  dispatch only when it crosses into Wasm.
- `Function.prototype.bind` now uses the existing Wasm `$__bound_fn` carrier in
  native-first JS builds. Target, bound receiver, and partial arguments remain
  in Wasm, including bound-of-bound composition. A chain rooted in a definitely
  compiled callable links no callback adapter; a dynamic caller-owned JS
  function keeps real JS bind behavior and invokes through the typed admitted
  callback boundary. The legacy `__bind_function`, generic `__call_function`,
  and temporary JS-array builders remain compatibility-only.
- BigInt string formatting now uses an in-module signed-i64 radix formatter for
  bases 2 through 36. Coverage includes zero and both i64 extrema; native-first
  no longer imports `bigint_toString` or `bigint_toString_radix`, while the
  compatibility provider remains unchanged.
- Native-first now selects the existing Wasm providers for RegExp-backed string
  split, extern-array join, and ordinary `String.raw` calls. Typed inline raw
  templates are adapted to the open in-module object representation, so these
  paths no longer recover `__array_join_any` or generic `__get_builtin` host
  semantics merely because JavaScript instantiates the module.
- `Proxy.revocable` now creates its Proxy, revocation state, `{ proxy, revoke }`
  result, and callable revoker in Wasm. Both standalone and native-first execute
  method-shorthand traps and repeated revocation without `__proxy_revocable` or
  callback-host semantic imports. A JS view is created only if the result later
  crosses an export boundary.
- Promise-subclass recognition is now target-independent. Native-first no
  longer hides `P extends Promise` from static dispatch and accidentally
  misclassifies `P.resolve` as an unrelated external capability. Full native
  subclass constructor/species/identity semantics are still open, so a
  native-first source containing this shape now fails before publication with
  the exact `__new_Promise`/class-tag compatibility imports named. The same
  source continues to compile under host-assisted compatibility.
- A compiler-wide post-codegen gate now makes that rule universal: no
  successful native-first result may contain a `legacy-semantic` or `unknown`
  import. This prevents an unprobed family from silently depending on the JS
  semantic engine while allowing typed value adapters, lifecycle hooks,
  platform capabilities, and declared accelerators.
- Native ProxyCreate now rejects primitive targets and handlers while accepting
  native callable closures and admitted caller-owned JS functions. Native
  `[[Call]]`/`[[Construct]]` dispatch distinguishes arrows from ordinary
  function expressions, preserves trap/forward behavior, and enforces that a
  construct trap returns an object. A trap-absent Proxy over an admitted JS
  constructor forwards through `__boundary_object_construct` and returns the
  caller's actual instance; it never materializes a Wasm copy. Fixed-arity
  construction drivers no longer require an unrelated native closure-method
  dispatcher when their only job is Proxy-to-boundary forwarding.
- Native `Reflect.get(target, key, receiver)` now binds accessors to the explicit
  receiver and threads it through nested/forwarding Proxies. Explicit receiver
  `Reflect.set` remains fail-loud until its native receiver/write invariants are
  complete.

Remaining work includes the remaining Proxy MOP invariant edges (#4402),
Promise subclass conformance, further family expansion, accelerator
measurement, and the representative Test262/npm evidence required before a
default flip.
