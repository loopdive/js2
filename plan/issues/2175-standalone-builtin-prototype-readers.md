---
id: 2175
title: "architect spec: standalone builtin-prototype object representation + native-method-closure dispatch"
status: in-progress
assignee: ttraenkler/se-2175
sprint: Backlog
created: 2026-06-16
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: standalone
language_feature: compiler-internals
goal: standalone-mode
related: [2161, 2158, 2159, 2101, 2100, 1907, 1888, 1914, 1539]
depends_on: [2101]
origin: "2026-06-16 — sdev5 #2161a refinement: RegExp.prototype-as-object refusal is the convergent gate across RegExp/class/TypedArray standalone reflection"
---

# #2175 — standalone has no host-free representation for a builtin prototype OBJECT or for native-method dispatch on a runtime receiver

## Problem

In standalone mode (the `nativeStrings` / `ctx.standalone` path — pure Wasm, no
JS host), the compiler skips the `__register_prototype` / `__register_class_object`
host-Proxy mechanism that JS-host mode uses to present a builtin's `.prototype`
object and its method-only own-key view. Two related capabilities are therefore
unrepresentable in standalone, and they converge on one architectural gap:

1. **Reading a builtin prototype OBJECT itself as a value** — `RegExp.prototype`,
   a class's `.prototype`/`.constructor` object, `Int8Array.prototype` /
   `%TypedArray%.prototype`, etc. Today `RegExp.prototype` (a `BUILTIN_CTOR_NAME`
   identifier `.prototype` read) reaches `reportUnsupportedStandaloneBuiltinValueRead`
   at `property-access.ts:1973` because `ensureStandaloneBuiltinStaticMethodClosure`
   has no `RegExp.prototype` pairs and there is no other native handler.

2. **Dispatching a native method/getter when the receiver is a runtime
   `externref`** rather than a statically-typed handle. The native engines today
   take statically-typed handles (`emitRegexExecArrayCall` consumes a
   `$NativeRegExp` recovered from a known *expression* via
   `loadStandaloneRegExpStruct`, `regexp-standalone.ts:709`). Reflective /
   dynamic forms — `RegExp.prototype.test.call(re, s)`, `re[Symbol.match](s)`,
   `Object.getOwnPropertyDescriptor(RegExp.prototype,"flags").get` — have no
   statically-typed receiver: the receiver arrives as an opaque externref through
   a closure call, so there is nothing to brand-narrow at the syntactic call site.

sdev5's #2161a entry-point triage (commit `4b0be0574`) pinned the exact refusal:
**it is the inner `RegExp.prototype` read, not the trailing member.** Every
reflective form — `.test`, `.flags`, `.flags.length`, the descriptor `.get` —
chains off that one refusal at `property-access.ts:1969-1976`, so there is **no
isolated slice**. The 126-test RegExp.prototype-reflection bucket breaks down by
test form as: **52** legacy `.call` (`RegExp.prototype.test.call(re,s)`),
**57** `Symbol.*` protocol members, **31** this-val brand-check, **26**
`.length`/`.name`, **7** prop-desc reflection. The same gap blocks **#2158**
(class/prototype/descriptor readers, ~1,388-test lane — its `## Suspended Work`
P0 `$ClassMeta` scaffolding on branch `issue-2158-classmeta` is the shared
backing) and **#2159** (TypedArray reflection, ~1,308-test lane).

## Root cause

The compiler represents a builtin prototype only as a **host-side Proxy** built
by `__register_prototype` (`extern.ts:197-201`). `nativeStrings` mode skips that
call, so standalone has **no object** to answer `.prototype`-as-value reads
against, and **no closure table** mapping a prototype member to a native
method/getter that accepts a runtime externref receiver. The static-dispatch
fast path (instance `re.flags`, `re.test(s)` at a syntactic call site) works
precisely because it *never goes through the prototype object* — it brand-narrows
a statically-typed receiver expression and reads struct fields inline
(`tryCompileStandaloneRegExpPropertyRead`, `regexp-standalone.ts:1425`). The
reflective forms cannot use that path because their receiver is dynamic.

---

## Implementation Plan (architecture spec — 2026-06-16, arch)

> Verified against `origin/main` @ `31cceedfa` and the `issue-2158-classmeta`
> branch @ `4b0be0574`. Line/symbol anchors are from those HEADs; re-grep if
> drifted. This is a **representation + dispatch contract + staged migration**
> spec, not a single PR. It composes with — and does **not** fork — the
> `$ClassMeta` model decided in **#2101**.

### Decision: one shared `$NativeProto` builtin-prototype object + a native-method-closure dispatch table, both host-free, both reusing #2101's `$ClassMeta` discriminator discipline

There are two distinct things standalone is missing, and they need two distinct
but linked structures:

1. A **prototype object** that a `.prototype`-as-value read can return and that
   descriptor/own-key ops can query (the "what `RegExp.prototype` *is*" problem).
2. A **method/getter closure** keyed by `(brand, member)` that can be invoked on
   a runtime externref receiver (the "dispatch `.test`/`@@match`/`.flags`-getter
   on an opaque `this`" problem).

The decision is to add **one** shared `$NativeProto` heap type for (1), and to
generalize the **existing** builtin-static-method-closure machinery
(`ensureStandaloneBuiltinStaticMethodClosure`, `property-access.ts:405`) into a
**brand-keyed native-method-closure factory** for (2). Both are emitted lazily
and are byte-identical-safe on the static fast path (nothing materializes until a
reflective read demands it). **Do not** invent a parallel descriptor struct, and
**do not** key any per-builtin identity by `ref.test` on a struct type — class
identity rides the `$tag` *value* per the #2101/#2009 constraint, and builtin
identity rides a small reserved-tag space in the same scheme.

#### (1) The `$NativeProto` struct — one shared heap type, brand-discriminated

```
(type $NativeProto (struct
  (field $brand     (mut i32))         ;; which builtin/class this proto belongs to
                                        ;;   — a value from a single tag space shared
                                        ;;   with $ClassMeta.$tag (see "Brand space")
  (field $isClass   (mut i32))         ;; 1 = user-class proto, 0 = builtin proto
  (field $ctor      (mut externref))   ;; .constructor link → __class_<Name> / builtin ctor handle
  (field $parent    (mut externref))   ;; [[Prototype]] → parent's $NativeProto (-link), or null at Object.prototype
  (field $memberCsv (mut externref))   ;; own enumerable+non-enumerable member-name CSV (native string)
  (field $name      (mut externref)))) ;; the proto's [[class]]/brand name string (for toString tag, diagnostics)
```

- **There is exactly one `$NativeProto` heap type**, so iso-recursive
  canonicalization is a non-issue *for the metadata itself* (nothing to collide
  with). Identity rides the `$brand` **value**, which is per-builtin data, immune
  to type merging — the exact discipline `$ClassMeta` already uses for classes
  (#2101 §"Recommended backing", #2009 constraint).
- For **user classes**, `$NativeProto` is **the same object** as #2101's
  `__proto_<Name>` singleton — do **not** allocate a second proto object. #2101 P1
  re-points `.prototype`/`.constructor` at `__proto_<Name>`/`__class_<Name>`; this
  spec says those singletons are backed by (an externref view of) a `$NativeProto`
  whose `$brand = classTagMap.get(Name)`, `$isClass = 1`, `$memberCsv` =
  `$ClassMeta.$methodCsv` (share the one CSV builder #2101 P0 mandates). So for
  classes, `$NativeProto` is a thin façade over `$ClassMeta`; it carries no new
  truth, it just gives the proto object a uniform reader-visible shape.
- For **builtins** (RegExp, `%TypedArray%`, `Int8Array`, …), `$NativeProto` is the
  *only* representation (builtins have no `$ClassMeta`). One lazily-materialized
  module global per builtin proto: `__native_proto_<Builtin>` (externref, mutable,
  null-init), mirroring `__proto_<Name>` exactly (`class-bodies.ts:543-550`).

#### (2) The brand-keyed native-method-closure factory

Generalize `ensureStandaloneBuiltinStaticMethodClosure` (which today handles only
receiver-less namespace statics: `Array.isArray`, `Object.keys`,
`Object.getOwnPropertyDescriptor`) into a factory that emits, per
`(brand, member)`, a closure whose **first user param is the receiver** (`this`):

- The closure is a `__fn_wrap`-style struct `(struct (field $func funcref))`
  produced by `getOrCreateFuncRefWrapperTypes` (`closures.ts:3147`) — the same
  shape the existing static closures and all HOF callbacks already use, so it is
  `call_ref`-dispatchable through the existing closure call path with **zero new
  call machinery**.
- Lifted signature: `(ref $wrapStruct, externref this, ...args) -> result`. The
  receiver is an **externref** (the dynamic case), recovered inside the closure
  body by the **brand-recovery prologue** (below).
- Keyed in `ctx.funcMap` as `__proto_method_<Brand>_<member>` (e.g.
  `__proto_method_RegExp_test`, `__proto_method_RegExp_get_flags`). The
  `get_`-prefixed variants are the accessor *getter* functions, returned as the
  `.get` of a descriptor.

**Brand-recovery prologue (the `this`-recovery contract).** Each native method
closure begins by narrowing the externref `this` back to the concrete backing
struct, reusing the **exact** brand-check the static fast path already trusts —
for RegExp that is `any.convert_extern` + `ref.test $NativeRegExp` + (on success)
`ref.cast $NativeRegExp`, the body of `loadStandaloneRegExpStruct`
(`regexp-standalone.ts:716-729`), refactored to accept an externref **local**
instead of recompiling a receiver *expression*. On `ref.test` failure the
prologue throws a catchable `TypeError` (the spec's brand-check failure, e.g.
§22.2.6.4.1 RegExpHasFlag step 2 on a non-RegExp `this`) via the existing
exception-tag path — **never** a raw `ref.cast` trap (mirror #2100's
null-`this` catchable-TypeError rule, M2). This is the single place "is this `this`
really a RegExp?" is decided for every reflective RegExp form; the 31 brand-check
tests gate on it.

> **Refactor required (shared core):** extract the externref→`$NativeRegExp`
> narrowing out of `loadStandaloneRegExpStruct` into a helper that takes a local
> holding the externref `this` and returns the cast struct local (or emits the
> catchable TypeError). `loadStandaloneRegExpStruct` keeps its expression-driven
> entry for the static fast path and delegates to the new helper for the externref
> arm. This keeps the static path **byte-identical** while the closures reuse the
> identical narrowing.

### Why the instance form works today but the prototype form doesn't (the precise contrast)

| | Instance form `re.flags` | Prototype form `RegExp.prototype.test` / `.call` / `@@match` |
|---|---|---|
| `expr.expression` | a `$NativeRegExp`-typed value | the `RegExp` ctor identifier; `.prototype` is the proto OBJECT |
| TS type at site | `isGlobalRegExpType(nonNull)` ⇒ true | the constructor type; no instance value exists |
| receiver recovery | `loadStandaloneRegExpStruct` brand-narrows the *expression* | no expression — receiver is a runtime externref in a closure call |
| field read | inline `struct.get` (`regexp-standalone.ts:1441-1463`) | needs a closure keyed by `(RegExp, member)` + brand-recovery prologue |
| current outcome | **compiles, zero host imports** | falls to `reportUnsupportedStandaloneBuiltinValueRead` (`property-access.ts:1973`) |

The instance form is fast precisely because it **never routes through a prototype
object**. This spec adds the reflective tier **without touching** that fast path:
`tryCompileStandaloneRegExpPropertyRead` and the syntactic `re.test(s)` /
`s.match(/re/g)` call paths are unchanged; the new `$NativeProto` + closure table
is consulted only when the *prototype object itself* is read as a value, or a
member is dispatched on a dynamic receiver.

### Changes — shared core (host-free, reusable across all builtins)

**File: `src/codegen/property-access.ts`**

- New module-level `registerNativeProtoType(ctx)` — registers the single
  `$NativeProto` struct type once, stashes its idx on
  `ctx.nativeProtoTypeIdx?: number` (new context field). Mirror the lazy
  one-time registration pattern of `ensureStandaloneRegExpStruct`
  (`regexp-standalone.ts:504`).
- New `emitLazyNativeProtoGet(ctx, fctx, brandKey)` — mirrors
  `emitLazyProtoGet` (`extern.ts:132`): `if (global is null) { struct.new
  $NativeProto{…}; extern.convert_any; global.set }; global.get`. **No host
  import** — the populate body is pure Wasm (`struct.new`, native-string member
  CSV via `addStringConstantGlobal` + `stringConstantExternrefInstrs`). One
  `__native_proto_<Brand>` global per builtin; for classes, reuse the existing
  `__proto_<Name>` global and back it with a `$NativeProto`.
- Generalize `ensureStandaloneBuiltinStaticMethodClosure` →
  `ensureStandaloneNativeMethodClosure(ctx, brand, member, kind)` where `kind ∈
  {static, method, getter}`. `static` is the existing receiver-less behavior
  (unchanged signatures — keep `Array.isArray` etc. byte-identical); `method` and
  `getter` prepend an `externref this` user param and emit the brand-recovery
  prologue. Returns the same `{ type: {kind:"ref",typeIdx}, funcIdx }` shape.
- At the refusal site (`property-access.ts:1966-1976`): when
  `propName === "prototype"` and `builtinName` has a registered native-proto
  brand, return `emitLazyNativeProtoGet(...)` (the proto OBJECT) instead of
  refusing. When the access is `<Builtin>.prototype.<member>` (a two-level
  property access whose inner is a builtin proto), resolve `<member>` to the
  native-method/getter closure via `ensureStandaloneNativeMethodClosure`.

**File: `src/codegen/closures.ts`** — no structural change; the new closures use
`getOrCreateFuncRefWrapperTypes` as-is (the `externref this` is just the first
user param). Confirm the closure call path's `call_ref` dispatch handles a
`(ref $wrap, externref, …)` lifted type — it does (HOF callbacks already pass
externref args).

**File: `src/codegen/object-runtime.ts` / `object-ops.ts`** — standalone
`Object.getOwnPropertyNames(proto)` / `Object.keys(proto)` / `in` read member
names from `$NativeProto.$memberCsv` (split on `,` into a `$ObjVec`, the existing
native enumeration vec, `object-runtime.ts:228-246`). `getOwnPropertyDescriptor(proto,
member)` builds a native **accessor-descriptor** (see Edge cases) whose `.get` is
the `get_<member>` closure from the factory. **No host import on any of these.**

### Changes — per-builtin glue (the contract each builtin implements)

Each builtin implements a small table consumed by the shared core. The contract
is: *(a)* a brand id, *(b)* a `$NativeProto` populator (member CSV + ctor link),
*(c)* a brand-recovery prologue (externref `this` → backing struct or catchable
TypeError), *(d)* per-member native bodies for method/getter closures.

**RegExp (`src/codegen/regexp-standalone.ts`, `native-regex.ts`) — land first.**
- Brand: a reserved builtin tag for RegExp (see "Brand space").
- `$NativeProto` member CSV: `exec,test,toString,compile,source,flags,global,
  ignoreCase,multiline,dotAll,unicode,unicodeSets,sticky,hasIndices,lastIndex`
  plus the well-known symbols `Symbol(Symbol.match)` … (the `@@`-keyed members
  are enumerated specially — see Symbol cell below). Reuse
  `STANDALONE_REGEXP_REFLECTION_PROPS` (`regexp-standalone.ts:1404`) for the
  getter set.
- Brand-recovery prologue: the extracted externref→`$NativeRegExp` narrower
  (refactored out of `loadStandaloneRegExpStruct`).
- Method bodies: `test`/`exec` delegate to the existing
  `emitRegexExecArrayCall`/`emitRegexSearchCall` (which already take a
  `$NativeRegExp` struct local — feed them the recovered local). Getters delegate
  to the field reads in `tryCompileStandaloneRegExpPropertyRead` (`.flags` →
  `ensureRegexFlagsStr`, `.source` → field 4, flag bools → `(flags & bit) != 0`).
  `@@match`/`@@replace`/`@@split`/`@@matchAll` route to the existing
  `tryCompileStandaloneStringMatch`/`Replace`/`Split` and the #1504
  `__regex_match_all_arrays` (the matchAll arrays helper sdev5 landed).

**Class (`src/codegen/class-bodies.ts`, `expressions/extern.ts`,
`property-access.ts`) — depends on #2101 P0-P1.**
- Brand: `classTagMap.get(Name)` (the existing class tag — already in the shared
  space).
- `$NativeProto` is the `__proto_<Name>` singleton backed by `$ClassMeta`: member
  CSV = `$ClassMeta.$methodCsv` (transitive method names, the #2101/#1991 shared
  CSV); `$ctor` = `__class_<Name>`; `$parent` = parent's `__proto_<Parent>`.
- Brand-recovery prologue: narrow externref `this` to the root hierarchy struct,
  read `$tag` (field 0) via `struct.get` after a `ref.cast` to the root struct —
  **never** `ref.test` on a leaf class struct (#2009). Method bodies dispatch on
  the `$tag` value through the existing `compileInstanceOf` tag if-chain pattern
  (`typeof-delete.ts:531-585`). This is #2158's standalone-reader core; this spec
  supplies the prototype-object + dispatch shape it plugs into.

**TypedArray (`src/codegen/array-methods.ts` / typed-array codegen) — #2159.**
- Brand: reserved builtin tags for `%TypedArray%` (the intrinsic) and each
  concrete view (`Int8Array`, …). `%TypedArray%.prototype` is the `$parent` of
  each concrete view's `$NativeProto` ([[Prototype]] chain
  §23.2.6 → §23.2.3).
- `$NativeProto` member CSV: the shared `%TypedArray%.prototype` methods
  (`map`, `filter`, `subarray`, `set`, `slice`, `every`, …) plus the
  per-view `BYTES_PER_ELEMENT` constant member; getters `length`,
  `byteLength`, `byteOffset`, `buffer`, `@@toStringTag`.
- Brand-recovery prologue: narrow externref `this` to the backing typed-array
  struct (whatever #1461/#1654 use); on failure, catchable TypeError
  (§23.2.3.x ValidateTypedArray). Method bodies delegate to the existing
  TypedArray method codegen by feeding it the recovered struct.

### The Symbol.* protocol cell (57 RegExp tests, the largest sub-bucket)

`re[Symbol.match](s)`, `RegExp.prototype[Symbol.replace]`, etc. The well-known
symbol IDs are already inlined (`property-access.ts:115-130`,
`WELL_KNOWN_SYMBOLS`). The `$NativeProto.$memberCsv` for a builtin uses a
**reserved sentinel encoding** for symbol-keyed members — e.g. `@@7` for
`Symbol.match` (id 7) — so own-key enumeration can present them and
`getOwnPropertyDescriptor(proto, Symbol.match)` resolves. Dispatch:
`obj[Symbol.X](args)` where `obj` is a runtime externref and `X` resolves to a
well-known symbol id routes to `ensureStandaloneNativeMethodClosure(brand,
"@@<id>", method)`. For RegExp these closures delegate to the existing
`String.prototype.match/replace/split/matchAll` native paths (the call form is
the same engine, just reached via the symbol member). Non-`@@`-named members and
the named-method `.call` form (52 tests) both resolve through the *same* closure
table — `.call`/`.apply`/`.bind` on a native-method closure value reuse the
existing `Function.prototype.call` lowering (the closure is a real funcref-backed
value), so once `RegExp.prototype.test` *evaluates* to a closure, `.call(re, s)`
is the ordinary closure-call path with the receiver as the first user arg.

### Brand space (shared with #2101, MUST stay coherent)

- **Classes** use `classTagMap` values (already unique, canonicalization-immune).
- **Builtins** get a **reserved low/high band** that does not collide with class
  tags. Recommend a `ctx.builtinBrandMap: Map<string, number>` seeded from a
  constant table (`RegExp`, `%TypedArray%`, `Int8Array`, … each a fixed negative
  or high-offset id) so a builtin brand is never confused with a user class tag,
  and `$NativeProto.$brand` is a single i32 namespace. The `$ClassMeta.$parentTag`
  "reserved builtin tag" mentioned in #2101's externref-backed-subclass edge case
  draws from this same band — unify them (one builtin-brand table, consumed by
  both #2101's externref-backed-subclass path and this spec's builtin protos).

### Staging (each stage independently mergeable; static fast path byte-identical)

- **S0 — shared core, inert.** Register `$NativeProto` (set
  `ctx.nativeProtoTypeIdx`); add `ctx.builtinBrandMap` + the brand table; add
  `emitLazyNativeProtoGet` and the generalized
  `ensureStandaloneNativeMethodClosure` (with the existing `static` cases
  preserved **byte-identical**). Nothing reads them yet.
  *Acceptance: existing standalone tests green; only the new type + (unused)
  helpers appear; `Array.isArray`/`Object.keys`/`getOwnPropertyDescriptor`
  closures emit identical bytes.*
- **S1 — RegExp (land first; tightest gate per #2161a).** Refactor the
  externref→`$NativeRegExp` narrower out of `loadStandaloneRegExpStruct`; wire
  RegExp into the brand table, the `$NativeProto` populator, and the
  method/getter closures (incl. the Symbol cell + descriptor `.get`). Route
  `RegExp.prototype` and `RegExp.prototype.<member>` reads at
  `property-access.ts:1966` through the new path before the refusal.
  *Acceptance: the 126-test RegExp.prototype-reflection bucket; standalone, zero
  host imports.*
- **S2 — Class** (depends on #2101 P0-P1). Back `__proto_<Name>`/`__class_<Name>`
  with `$NativeProto`/`$ClassMeta`; add the `$tag`-dispatch brand-recovery
  prologue; standalone `getOwnPropertyNames`/`getOwnPropertyDescriptor`/`Object.keys`/
  `in`/`instanceof`-on-`any` readers. *This is #2158's core* — #2158 consumes this
  stage rather than re-deriving it.
- **S3 — TypedArray** (#2159). Brand the intrinsic + concrete views; chain
  `%TypedArray%.prototype` as `$parent`; method/getter closures over the existing
  typed-array codegen.

Each stage MUST NOT regress the working static-dispatch path: instance `re.flags`
/ `re.test(s)` / `s.match(/re/g)`, instance `o.m()` / `o.field`, and the
`Array.isArray`/`Object.keys` static closures stay byte-identical (S0 acceptance
guards this).

### Edge cases

- **Property descriptors (`getOwnPropertyDescriptor(proto, "flags").get`, 7
  tests).** Builtin getters are **accessor** properties — the descriptor must
  carry a `.get` function and `undefined` `.set`/`.value`, `enumerable:false`,
  `configurable:true` (§22.2.6 attributes). Build a native accessor-descriptor:
  the `$ObjVec`-backed descriptor object whose `get` field holds the
  `get_<member>` closure value (from the factory). Reading `.get` returns that
  closure; **calling** it (`desc.get.call(re)`) is the ordinary closure-call with
  the receiver as `this` — closing the loop through the brand-recovery prologue.
  Method properties (`.test`) are data descriptors: `value` = the method closure,
  `writable:true`, `enumerable:false`, `configurable:true`.
- **`.length` / `.name` (26 tests).** `RegExp.prototype.test.length === 1`,
  `RegExp.prototype.test.name === "test"`. These are read on the *method-closure
  value*, not the proto. The factory must tag each emitted closure with its arity
  and name so the existing `.length`/`.name`-on-function reads (the bound-function
  path, `isBindResultExpr`, `property-access.ts:504`) resolve them — extend the
  function-metadata side-table to cover native-method closures (a
  `ctx.nativeClosureMeta: Map<funcIdx,{name,length}>`). Static, compile-time
  values; no runtime cost.
- **Brand-check failures (31 tests).** A native method/getter invoked on the
  wrong `this` (`RegExp.prototype.test.call({}, "x")`, `flags` getter on a
  non-RegExp) throws a catchable `TypeError` from the brand-recovery prologue —
  the spec's RegExpHasFlag/ValidateTypedArray step-2 throw. Never a `ref.cast`
  trap.
- **`@@toStringTag` / `Object.prototype.toString.call(re)`** → `"[object
  RegExp]"`. `$NativeProto.$name` carries the brand-name string; the toString-tag
  member reads it.
- **`.constructor` identity.** `RegExp.prototype.constructor === RegExp`,
  `(new A).constructor === A`. `$NativeProto.$ctor` is the canonical ctor handle
  (`__class_<Name>` for classes; a builtin ctor handle for builtins). Identity is
  the singleton, not a fresh object — matches #2101 P1.
- **[[Prototype]] chain walk.** `Object.getPrototypeOf(RegExp.prototype) ===
  Object.prototype`; `Int8Array.prototype`'s proto is `%TypedArray%.prototype`.
  `$NativeProto.$parent` links the chain; `getPrototypeOf` reads it. Terminate at
  an `Object.prototype` `$NativeProto` whose `$parent` is null.
- **Externref-backed builtin subclass (`class E extends Error {}`).** No
  `$ClassName` struct (#2101 edge case); its `$NativeProto.$brand` is the
  reserved builtin tag for the parent, `$ctor` is the externref forwarder. The
  brand-recovery prologue for these routes through the existing externref class
  path, not a struct cast.
- **Cross-realm.** Not applicable — standalone has a single realm; no
  realm-tagging needed. (Flag only if a test262 `$262.createRealm` cluster
  appears — those are already skipped.)
- **Shadowing.** The `BUILTIN_CTOR_NAMES` guard at `property-access.ts:1955`
  already checks `isShadowed` (local `RegExp` shadow); keep that gate before the
  new proto path so a user `const RegExp = …` is not misrouted.

### Test gates (per stage; standalone shard, zero host imports)

- **S1 (RegExp, the lead gate):** the 126-test `RegExp.prototype.<prop>`
  reflection bucket (#2161a), decomposed: 52 `.call`, 57 `Symbol.*`, 31
  brand-check, 26 `.length`/`.name`, 7 prop-desc. Concrete repros:
  `RegExp.prototype.test.call(/a/, "a") === true`;
  `RegExp.prototype.flags` getter via
  `Object.getOwnPropertyDescriptor(RegExp.prototype,"flags").get.call(/gi/)`
  → `"gi"`; `/a/[Symbol.match]("a")` non-null; `RegExp.prototype.test.length ===
  1`; `RegExp.prototype.test.call({}, "x")` throws `TypeError`. Add as standalone
  equivalence tests (`tests/issue-2175-*.test.ts`).
- **S2 (Class):** #2158's `built-ins/Object` compile-error count drops;
  `Object.getOwnPropertyNames(C.prototype)` / `getOwnPropertyDescriptor` /
  `Object.keys(proto)` return host-equal key sets standalone;
  `language/statements/class/*constructor*`. Estimated lane: a large fraction of
  #2158's ~1,388 (the proto/descriptor sub-bucket — PO to scope against the
  standalone shard breakdown).
- **S3 (TypedArray):** `built-ins/TypedArray` /
  `built-ins/TypedArrayConstructors` reflection sub-bucket of #2159's ~1,308 —
  `Int8Array.prototype.map.call(ta, f)`,
  `Object.getOwnPropertyDescriptor(%TypedArray%.prototype,"length").get`,
  `Object.getPrototypeOf(Int8Array.prototype) === %TypedArray%.prototype`.
- **No regression (every stage):** instance `re.flags`/`re.test(s)`/`s.match(/re/g)`,
  instance method/field access, `instanceof` typed path, the
  `Array.isArray`/`Object.keys`/`getOwnPropertyDescriptor` static closures —
  all byte-identical (S0 acceptance).

### Risks & open questions

1. **`$NativeProto` ↔ `$ClassMeta` fact: which is canonical for classes?**
   Recommendation: `$ClassMeta` (#2101) is the canonical *metadata*; `$NativeProto`
   for a class is a reader-visible façade backed by the same singleton, carrying
   no independent truth (member CSV is *the same* `$methodCsv`). The implementer
   must ensure they are populated from one source so they cannot drift. **Open:**
   do we even need a distinct `$NativeProto` heap type for classes, or can the
   reader uniformly accept "an externref that is either a `$ClassMeta`-backed
   `__proto_` or a builtin `__native_proto_`"? Leaning toward **one `$NativeProto`
   type, with the class case populating `$ctor`/`$memberCsv` from `$ClassMeta`** —
   uniform readers, single type. Confirm against #2101 P0's exact field layout
   before S2.
2. **Brand-band collision.** The builtin brand band MUST be disjoint from
   `classTagMap`'s range for all programs. Pick a band (e.g. high negative i32s)
   and assert disjointness at registration; a collision silently mis-dispatches.
   Needs a one-time invariant check in S0.
3. **`call_ref` on a `(ref $wrap, externref, …)` lifted type for an *exported*
   reflective entry.** HOF callbacks already use externref args, but verify the
   peephole/stack-balance passes don't special-case the static-closure signature.
   Validate in S0 with an emitted-but-called probe.
4. **Descriptor object backing.** Standalone descriptors currently come back as
   `$ObjVec`-shaped externrefs via `__getOwnPropertyDescriptor`
   (`property-access.ts:457`). The accessor-descriptor with a closure-valued
   `.get` must round-trip through the same native reader (`__extern_get(desc,
   "get")` → the closure). Confirm the native descriptor reader can hold a
   closure-struct ref as a field value (it holds externref; the closure struct is
   `extern.convert_any`-able). Likely fine; verify in S1's prop-desc gate.
5. **Symbol member enumeration ordering.** `Object.getOwnPropertyNames` excludes
   symbol keys; `Object.getOwnPropertySymbols` includes only them
   (§7.3.23 / §20.1.2.x). The `@@<id>` CSV sentinel must split into the two
   buckets correctly — string-named vs symbol-named — so each reflection API gets
   the right subset. Define the CSV encoding so the splitter is unambiguous (e.g.
   prefix `@@` for symbol entries).
6. **Out of scope (explicit).** `Symbol.hasInstance` override of `instanceof`
   (#2101 defers it); regex-engine *feature* work (v-flag `\q{}`, dynamic ctor
   patterns — #2161 sub (c)); `Proxy`/`Reflect` reflection (deferred). This spec
   is the **representation + dispatch** layer, not new engine features.

### What this spec does NOT do

- No implementation (S0-S3 PRs implement each stage).
- Does not change the static fast path (instance reads, syntactic method calls).
- Does not fork #2101 — it composes with `$ClassMeta` and the shared tag space.
- Does not add a host import — every new path is pure-Wasm (`struct.new`,
  `call_ref`, native strings, catchable exception tags).

---

## Implementation log — S0 + S1 (sdev se-2175, 2026-06-16)

PR: **S0 + S1 of 4** (S2 class / S3 TypedArray follow). Branch
`issue-2175-standalone-builtin-prototype-readers`.

### S0 — shared core (inert), what landed and WHY

New module **`src/codegen/native-proto.ts`** owns the host-free core:
- `registerNativeProtoType(ctx)` — the single `$NativeProto` struct
  (`$brand i32, $isClass i32, $ctor externref, $parent externref, $memberCsv
  externref, $name externref`), stashed on `ctx.nativeProtoTypeIdx`. One heap
  type ⇒ canonicalization is a non-issue for the metadata; identity rides the
  `$brand` **value** (the #2101/#2009 discipline).
- **Brand space**: `BUILTIN_BRAND_BASE = -0x40000000`, a HIGH-NEGATIVE band, so a
  builtin brand can never collide with a class tag (class tags are `>= 0`).
  `getBuiltinBrand` asserts disjointness at registration (Risk 2 — invariant
  check). `ctx.builtinBrandMap` seeded from `BUILTIN_BRAND_TABLE` (RegExp wired;
  %TypedArray%/views reserved as comments).
- `emitLazyNativeProtoGet(ctx, fctx, brand)` — pure-Wasm lazy materializer
  (`struct.new` + native-string member CSV + a `__native_proto_<brand>` module
  global), mirroring `emitLazyProtoGet` (extern.ts) **minus** the
  `__register_prototype` host call. Reference identity via the singleton global.
- `ensureStandaloneNativeMethodClosure(ctx, brand, member, kind)` — the
  brand-keyed factory. **WHY the wrapper indirection in property-access.ts**: to
  keep the existing `Array.isArray`/`Object.keys`/`getOwnPropertyDescriptor`
  static closures **byte-identical**, I did NOT fold them into the new factory.
  `ensureStandaloneBuiltinStaticMethodClosure` is untouched (same signature,
  same body); a thin `ensureStandaloneNativeMethodClosureLocal(...,kind)`
  delegates `static` → the old fn verbatim, `method`/`getter` → the new factory.
  **S0 acceptance verified**: the static-closure program compiles to the exact
  same 27028 bytes / sha256 `c09d0d34…` before and after S0+S1.
- Per-builtin glue is a **registry** (`registerNativeProtoBuiltin` /
  `getNativeProtoBuiltinGlue`) so the core has no RegExp/TypedArray import
  dependency — RegExp glue lives in `regexp-standalone.ts` and registers itself.

### S1 — RegExp, what landed and WHY

- **Refactor (required by spec)**: extracted the externref→`$NativeRegExp`
  narrower out of `loadStandaloneRegExpStruct` into
  `recoverRegExpStructFromExternref(ctx, fctx, thisExternLocal)` — the
  brand-recovery prologue. It does the identical `any.convert_extern` +
  `ref.test` + `ref.cast`, but driven from an externref **local** (the closure's
  `this`). On `ref.test` failure it throws a **catchable TypeError** via the
  shared in-module `__new_TypeError` + `$exc` tag (NOT a `ref.cast` trap — #2100
  M2 / §22.2.6.4.1 step 2). `loadStandaloneRegExpStruct`'s expression entry is
  unchanged ⇒ the static fast path stays byte-identical.
- **RegExp glue** (`ensureRegExpNativeProtoGlue`): brand, member CSV (string
  members + `@@7/@@8/@@9/@@10` symbol sentinels), getter/method classification,
  arity table, and `emitRegExpProtoMemberBody` which runs the prologue then the
  member body off the recovered struct local.
  - Getters (`flags`/`source`/flag-bools/lastIndex) reuse the **exact** static
    field-read sequence via the new `emitRegExpReflectionFieldRead` (factored out
    of `tryCompileStandaloneRegExpPropertyRead`, which now calls it — so the
    static path is unchanged). **WHY box string results to externref**: the
    `call_ref` closure ABI is uniform on externref/i32/f64; a native-string
    `ref` result (`.flags`/`.source`) must be `extern.convert_any`-boxed to
    survive the call boundary + the receiving `any` comparison. i32/f64 results
    pass through.
  - `.test` runs a **self-contained** search (`emitRegExpTestFromLocals`) driven
    by the recovered struct local + a flattened subject local — deliberately NOT
    routed through the expression-driven `emitRegexSearchCall`, so the static
    path is provably byte-identical (zero edits to it).
- **Routing** (`property-access.ts`): three handlers, all `ctx.standalone`-gated
  (JS-host mode is provably unchanged — still `__get_builtin`/`__extern_get`):
  1. inner `<Builtin>.prototype` value read → `emitLazyNativeProtoGet` at the
     #1907 refusal site (before the refusal);
  2. `<Builtin>.prototype.<member>` → native-method/getter **closure value**
     (`tryCompileStandaloneBuiltinProtoMemberRead`), placed **before** the #1914
     instance-reflection read — because `RegExp.prototype`'s static type is
     `RegExp`, #1914's `isGlobalRegExpType` guard would otherwise capture
     `RegExp.prototype.flags` and refuse (proto is not a backend-created *value*);
  3. `<Builtin>.prototype.<member>.length`/`.name` → compile-time fold from the
     glue (`tryCompileStandaloneBuiltinProtoMemberMeta`), tagged in
     `ctx.nativeClosureMeta`.

### Verified (standalone, zero `env` imports throughout)

`RegExp.prototype` value read · `.test`/`.exec`/getters as closure values · **direct
dispatch** `m(/ab/,"zab")===true` & non-match · all flag-bool getters
(`global`/`ignoreCase`/`multiline`/`sticky`) · `.flags`→"gi" & `.source`→"abc"
getters · `.test.length===1`/`.exec.length===1`/`.toString.length===0` ·
`.test.name==="test"` (typed binding) · **wrong-`this` → catchable TypeError** ·
instance `re.flags`/`re.test(s)` unchanged · S0 static closures byte-identical ·
JS-host `RegExp.prototype` unchanged (4 host imports). Tests:
`tests/issue-2175-regexp-proto-readers.test.ts` (12/12). Regression: #1914 (11),
#682 ABI (4), #1474 (14), #1539 regex (195), #2158 class-identity (15),
#2161 matchall (7), host regexp.test (10) — all green.

### Known boundaries (NOT regressions; in-scope follow-ups within S1's lane)

- **`.call(re,s)` on a closure value** routes through the existing
  `Function.prototype.call`-on-closure-VALUE lowering, which is a separate
  subsystem that does not yet fully wire the `(ref $wrap, externref this, …)`
  lifted signature — and is **broken at baseline even for the pre-existing
  builtin-static closures** (`const f = Array.isArray; f(x)` traps a Wasm
  validation error on unmodified main). S1 therefore proves the representation +
  dispatch contract via the **direct closure-call** form (`const m =
  RegExp.prototype.test; m(re,s)`), which exercises the identical brand-recovery
  prologue + native member body. Wiring `.call`/`.apply` end-to-end is the
  closure-call subsystem's job, tracked as the next S1 refinement.
- **`re[Symbol.match](s)` instance-element dispatch** hits a separate existing
  `@@match` engine refusal (`property-access`/`element-access` symbol-call path),
  not the proto read path; the `@@<id>` CSV sentinels + the closure table are in
  place for it, dispatch wiring is the next S1 refinement.
- `exec`/`toString`/`compile`/`@@match`/`@@replace`/`@@split` closures
  **materialize + brand-recover** (the reflective READ compiles, host-free) but
  emit a spec-shaped placeholder result body — their full engine bodies are the
  next S1 refinement (delegate to the existing `tryCompileStandaloneString*`
  paths + `emitRegexExecArrayCall`).
- `$NativeProto.$ctor`/`$parent` are null-init in S1 (`.constructor` identity +
  `[[Prototype]]` chain walk land with S2's class composition, which owns the
  shared `$ctor`/`$parent` semantics).
