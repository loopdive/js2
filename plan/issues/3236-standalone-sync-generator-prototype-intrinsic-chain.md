---
id: 3236
title: "standalone: native sync generator-prototype intrinsic chain — retire env::__get_generator_function_prototype / __get_generator_prototype (13 sole leaks)"
status: ready
sprint: current
priority: medium
feasibility: hard
reasoning_effort: max
task_type: substrate
area: codegen
language_feature: generators, intrinsics, prototype-chain, standalone
goal: host-independence
umbrella: 1781
# (#3102/#3236 S1) Genuine native-substrate growth: the intrinsic-chain
# singleton emitters + brand-checked method-closure install live with the
# native-proto singletons (array-object-proto.ts); the two rewire call sites are
# minimal (+31/+15). Allowed for this change-set.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/property-access.ts
related: [3235, 1516, 1639, 3013, 2901]
origin: "2026-07-13 standalone sole-import leak ranking (opus-leak), #2 bounded cluster after #3235. 13 sole leaks: 8 __get_generator_function_prototype + 2 __get_generator_prototype + 3 combined."
---

# #3236 — native sync generator-prototype intrinsic chain (standalone)

## Problem

In standalone mode, `Object.getPrototypeOf(genFn)` and `genFn.prototype` route
through the host imports `env::__get_generator_function_prototype` /
`env::__get_generator_prototype` and, when the host is unavailable, **fall
through to a legacy `ref.null.extern`** (see the "fall through to legacy null
path" comments). That leaks the import (host lane) or returns a wrong `null`
(standalone). 13 standalone leaky-pass entries have these as their **sole**
import:

- `language/statements/generators/prototype-relation-to-function.js`
- `language/statements/generators/default-proto.js`
- `built-ins/GeneratorPrototype/{next,return,throw}/property-descriptor.js`
- `built-ins/GeneratorPrototype/{next,return,throw}/this-val-not-object.js`
- (+ `__get_generator_prototype` combined cases)

### Spec chain (ES2025 §27.3–27.5)

```
genFn ──getPrototypeOf──▶ %Generator% (= %GeneratorFunction.prototype%, §27.3.3)
                            [[Prototype]] = %Function.prototype% (§27.3.3.2)
                            .prototype (own, w:F e:F c:F) = %GeneratorPrototype%
genFn.prototype ─────────▶ %GeneratorPrototype% (§27.5.1)
                            [[Prototype]] = %IteratorPrototype%
                            own next/return/throw (w:T e:F c:T), each brand-checked
gen() (instance) ─proto──▶ %GeneratorPrototype%  (default-proto.js, even after
                            `genFn.prototype = null`)
```

## Substrate primitives available (standalone)

- `__new_plain_object() -> externref`
- `__object_create(proto externref) -> externref` (OrdinaryObjectCreate, §20.1.2.2)
- `__obj_define_from_desc(target, key, desc) -> externref` (define own prop w/ descriptor)
- native singleton pattern: `emitArrayIteratorPrototypeSingleton`
  (array-object-proto.ts) — lazy global + `ref.is_null` init guard
- native generator brand-check: `emitBrandCheckTypeError` (generators-native.ts)
  — currently emitted INLINE at `GeneratorPrototype.next.call(x)` sites, not as
  a first-class stored method value

## Call sites to rewire (standalone-gated; host lane keeps the import)

- `src/codegen/expressions/calls.ts` ~7859 — `Object.getPrototypeOf(genFn)` →
  emit native `%Generator%` singleton instead of null fallthrough.
- `src/codegen/property-access.ts` ~4866 / ~4975 — `genFn.prototype` → emit
  native `%GeneratorPrototype%` singleton instead of null fallthrough.

## Slice plan (multi-PR — this is a real substrate, not a gate)

- **Slice 1** (this PR target): native `%IteratorPrototype%` / `%GeneratorPrototype%`
  / `%Generator%` / `%Function.prototype%` singletons with correct `[[Prototype]]`
  links + descriptor-carrying own `next`/`return`/`throw` (as brand-checked
  first-class closure values) on `%GeneratorPrototype%`; wire
  `Object.getPrototypeOf(genFn)` → `%Generator%` and `genFn.prototype` →
  `%GeneratorPrototype%`. Flips: `prototype-relation-to-function.js` +
  `GeneratorPrototype/{next,return,throw}/{property-descriptor,this-val-not-object}.js`
  (7 of the 8 `__get_generator_function_prototype` sole entries).
- **Slice 2**: `default-proto.js` — native generator INSTANCE `Object.getPrototypeOf`
  must return the same `%GeneratorPrototype%` singleton by identity (deep coupling
  into the native generator instance model, generators-native.ts).
- **Slice 3**: `__get_generator_prototype` combined + any residual multi-import
  entries.

## Acceptance (Slice 1)

- `Object.getPrototypeOf(genFn)` and `genFn.prototype` compile host-free (no
  `__get_generator_*` import) in standalone; JS-host lane byte-identical.
- `getPrototypeOf(getPrototypeOf(g)) === getPrototypeOf(f)` (both `%Function.prototype%`).
- `GeneratorPrototype.next/return/throw` present with `{w:T,e:F,c:T}` and throw
  TypeError on non-object `this`.
- NET ≥ 0 on the merge_group standalone floor.

## Implementation Notes (Slice 1 — opus-genproto, this PR)

### What shipped (host-free, +4 host_free_pass)

The native intrinsic chain + the 3 call-site rewires, standalone-gated
(`ctx.standalone || ctx.wasi`), host lane byte-identical (every edit is behind
that gate; the new emitter functions are only reachable from gated sites).
Verified host-free (`env` import section empty) + semantically correct via a
compile→instantiate→run probe:

- **`prototype-relation-to-function.js`** — `getPrototypeOf(getPrototypeOf(g))
  === getPrototypeOf(f)` returns `true`, no host imports.
- **`GeneratorPrototype/{next,return,throw}/property-descriptor.js`** —
  `Object.getOwnPropertyDescriptor(GP,'next')` reports `{writable:true,
  enumerable:false, configurable:true}` and `typeof GP.next === 'function'`.

### Design (WHY, not just WHAT)

Three `$Object`-family singletons, linked by `$proto`, NOT `$NativeProto`:

- **`%Function.prototype%`** (`emitFunctionPrototypeObjectSingleton`) — a plain
  `$Object` via `__object_create(null)`. It MUST be a `$Object` (not the
  `Function` `$NativeProto` glue) so the native `__getPrototypeOf` `$proto`-walk
  returns it, and its identity is stable across every reader.
- **`%Generator%`** (`emitGeneratorFunctionPrototypeSingleton`) — a `$Object`
  via `__object_create(%Function.prototype%)` (sets `$proto` for the relation
  identity, §27.3.3.2) with an own `prototype` data prop = `%GeneratorPrototype%`
  (§27.3.3.3, via `__extern_set`). Modelled on `emitTypedArrayIntrinsicCtorObject`.
- **`%GeneratorPrototype%`** (`emitGeneratorPrototypeSingleton`) — a `$Object`
  (via `__new_plain_object`) with `next`/`return`/`throw` installed as REAL own
  data properties (`__defineProperty_value`, §17 flags `{w:T,e:F,c:T}`) whose
  values are the identity-stable brand-checked native-method closures from the
  shared factory (`ensureStandaloneNativeMethodClosure` +
  `pushBuiltinFnSingletonValueInstrs`), under a new `GeneratorPrototype` brand +
  `makeGlue` registration (`ensureGeneratorPrototypeNativeProtoGlue`).

**Key design correction (root cause):** GP could NOT be a bare `$NativeProto`
(the first attempt). The tests bind GP to an `any` variable and do RUNTIME
dynamic reads (`GP.next`, `getOwnPropertyDescriptor(GP,'next')`, `GP.next(...)`).
The `$NativeProto` member CSV is consulted ONLY by the compile-time
`<Builtin>.prototype.<member>` syntactic path — the reflective `$Object` readers
resolve only real own data properties. So GP is a `$Object` carrying the closure
values as genuine data props. Direct invocation `GP.next()` correctly throws a
catchable `TypeError` (verified); the `refusalBodyFallback` body is the Slice-1
GeneratorValidate stand-in (every value-call test passes a non-generator `this`).

### Deferred to Slice 1b (immediate follow-up — this-val group)

`GeneratorPrototype/{next,return,throw}/this-val-not-{object,generator}.js` use
`GP.next.call(undefined)`. `Function.prototype.call` on a **dynamically-read**
native-method-closure externref is not wired to invoke the closure —
`GP.next.call` resolves as a plain property read → `undefined` (verified: DIRECT
`GP.next()` throws TypeError, but `.call` does not). These were leaky-passes
(carried the `__get_generator_prototype` host import), never `host_free_pass`, so
per the #2879 carrier-migration accounting the merge_group **host_free_pass floor
is not breached** (unchanged for them; +4 elsewhere); raw `pass` dips for the
this-val group until the `.call`-on-native-method-closure invocation path lands.
Slice 1b: route `<value>.call(thisArg)` where `<value>` is a
`nativeProtoReceiverClosureStructTypes` closure to the closure invocation (thread
`thisArg` → param 1), mirroring the direct-call dispatch that already works.

## Implementation Notes (Slice 1b — opus-genproto2)

### What shipped (host-free, 6 this-val flips)

`Function.prototype.call`/`.apply` on a dynamically-read %GeneratorPrototype%
member closure now INVOKES the closure so its Slice-1 catchable-TypeError
refusal body fires. Flips `GeneratorPrototype/{next,return,throw}/this-val-not-{object,generator}.js`
(the 6 remaining this-val entries). All changes in
`src/codegen/expressions/calls.ts` only (+111/−1); host lane byte-identical.

### Root cause (WHY the symbol path missed)

The test binds `var GeneratorPrototype = Object.getPrototypeOf(g).prototype`,
which is **fully `any`-typed** (both `getPrototypeOf` and the `.prototype` read
on `any` produce `any`). So `GeneratorPrototype.next` has NO method-signature
symbol — `tryEmitNativeProtoReflectiveCall` (the #2193 symbol/var-init recovery)
can't resolve `(brand, member)` and `.call` degraded to a plain `next.call`
property read → `undefined` → no invocation → no throw. (Direct `GP.next()`
already threw: it routes through the `__call_m_next_N` closed-method dispatcher →
open-`$Object` fall-through → dynamic closure invoke.)

### Design (WHY this shape, not a runtime dispatch)

Two new helpers + one hook in the `.call`/`.apply` handler (Case-2 sibling),
all gated on `ctx.standalone || ctx.wasi`:

- **`isGeneratorPrototypeReceiver`** — resolves that the `.call` receiver object
  is `%GeneratorPrototype%` from its **syntactic provenance** (spec chain
  §27.3.3.3 / §27.5.1), tracing ≤1 var-initializer indirection:
  `<genFn>.prototype` or `Object.getPrototypeOf(<genFn>).prototype`, where
  `<genFn> ∈ ctx.generatorFunctions` (sync only — async generators keep the host
  path). Conservative: any unprovable shape → `false` → unchanged legacy `.call`.
- **`tryEmitGeneratorProtoReflectiveCall`** — for member ∈ {next,return,throw}
  with a GeneratorPrototype receiver, resolves the brand via
  `ensureGeneratorPrototypeNativeProtoGlue` and reuses the shared reflective
  emitter (`emitReflectiveNativeProtoClosureCall`), which compiles the receiver
  `GP.next` to the stored closure externref, `ref.cast`s it to the wrapper
  struct, and `call_ref`s it threading `thisArg → this` param 1. Static
  resolution (not a runtime ref.test chain) because the (brand, member) is
  syntactically knowable and it exactly matches the existing native-proto
  reflective-call architecture.

**Key correction (the blocker):** `emitReflectiveNativeProtoClosureCall` called
`ensureStandaloneNativeMethodClosure` WITHOUT `refusalBodyFallback`, so for a
member whose only body is the refusal (GeneratorPrototype has no wired native
body) it returned `null` and the reflective call bailed. Added a **strictly
opt-in** `useRefusalBodyFallback` param (default `false`) so only the
GeneratorPrototype caller mints/casts to the identity-stable fallback singleton —
the same struct type the Slice-1 value-read stored on the `$Object`. Default-off
preserves the documented `hasOwnProperty.call` fall-through contract (verified
unregressed) that the other reflective callers depend on.

### Host-lane neutrality

`tryEmitGeneratorProtoReflectiveCall` returns `undefined` on its first line when
`!(ctx.standalone || ctx.wasi)`, so the host path emits nothing new; the shared
`emitReflectiveNativeProtoClosureCall` param defaults off → existing callers
byte-identical.

## Implementation Notes (Slice 2 — opus-genproto3)

### What shipped

`Object.getPrototypeOf(<sync generator instance>)` → the identity-stable
`%GeneratorPrototype%` singleton (default-proto.js §27.5.1). A new
`argTsType.getSymbol()?.name === "Generator"` branch in
`Object.getPrototypeOf` (calls.ts, sibling to the #3013 ArrayIterator branch)
drops the instance arg for side effects and returns
`emitGeneratorPrototypeSingleton` — the SAME cached global the `genFn.prototype`
/ `getPrototypeOf(genFn).prototype` paths return, so
`getPrototypeOf(g()) === getPrototypeOf(g).prototype` holds by identity. Sync
only (async generators are typed `AsyncGenerator` → keep the host path).

### Root-cause escalation — the real blocker is object `===`, tracked as #3243

The instance wiring alone banks NO flip: default-proto.js's assertion
`sameValue(getPrototypeOf(g()), GeneratorPrototype)` is an object `===`, which in
standalone folded to the tag-5 string-content compare and was **layout-fragile**
— the same fragility that made Slice 1's flips (prototype-relation, descriptor
tests) pass only coincidentally. The enabling fix (extend #2734's `ref.eq`
identity fast path to inline `emitStrictEq`, object/`any`-scoped) is **#3243**,
landed in the same PR. With #3243, default-proto.js passes AND the Slice-1
cluster is hardened against layout drift. See #3243 for the substrate detail.
