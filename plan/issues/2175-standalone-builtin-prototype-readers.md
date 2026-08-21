---
id: 2175
title: "architect spec: standalone builtin-prototype object representation + native-method-closure dispatch"
status: ready
model: fable
fable_role: spec
sprint: current
created: 2026-06-16
updated: 2026-07-17
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: analysis
area: standalone
language_feature: compiler-internals
goal: standalone-mode
related: [2161, 2158, 2159, 2101, 2100, 1907, 1888, 1914, 1539, 2861, 2885, 2949, 2963, 2984, 3025, 3027]
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/property-access-dispatch.ts
  # +15 lines: the guard clause routing a non-callable builtin namespace
  # receiving bind/call/apply to a catchable TypeError. The rationale, the
  # namespace/invoker tables and the emit all live in the subsystem module
  # (src/codegen/function-prototype-callable.ts); what remains here is the
  # dispatch arm itself, which has to sit in the ordered chain.
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/context/create-context.ts::createCodegenContext
  # +12 lines — same arm; see the loc-budget note above.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  # +11 lines: the `<callable>.{apply,call,bind,toString}.length` spec-arity
  # guard clause. The table and the callability gate live in the subsystem
  # module (src/codegen/function-prototype-callable.ts); only the ordered
  # dispatch arm is here, and it must precede the generic signature count.
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
coercion-sites-allow:
  # 2026-08-21 lane D (arguments inside `new F(…)`): __box_number/__unbox_number
  # here are a REPRESENTATION transfer, not a hand-rolled ToNumber — numeric
  # ctor params ride the externref arguments vector and the mapped-arguments
  # writeback restores the declared param slot type. Same class as the
  # bound-fn-meta declaration (#4562): routing through the coercion engine
  # would coerce values §10.4.4 says must pass through unchanged.
  - src/codegen/fnctor-ctor-arguments.ts
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

#### PREP landed (2026-06-17, dev-1) — brand-table reservations for the whole wave

`BUILTIN_BRAND_TABLE` (native-proto.ts) previously reserved only `RegExp`
(S1) with the rest deferred in a comment. To let the glue slices (#1616/#2158
S1-S4) land in parallel without any slice touching the table or risking a
sibling-slice brand collision, **all builtin-constructor families are now
reserved up front** with stable append-only offsets: Array, the abstract
`%TypedArray%` intrinsic + all 9 concrete TypedArrays, ArrayBuffer/
SharedArrayBuffer/DataView, Object/Function, String/Number/Boolean/BigInt/
Symbol, Map/Set/WeakMap/WeakSet/WeakRef/Promise/Date/Iterator, and the Error
family. Math/JSON/Reflect/Atomics/Proxy are namespace objects (not
prototype-bearing constructors) and are intentionally NOT branded. Reserving a
brand is inert — `getBuiltinBrand` returns the id, but with no registered glue
the `.prototype`-as-value read still falls through to the refusal, so this is
behaviour-preserving (RegExp S1 tests + the byte-identical static path stay
green). Locked in by `tests/issue-2175-native-proto-brands.test.ts`
(uniqueness, full coverage, disjointness invariant). A glue slice now only
calls `getBuiltinBrand(ctx, <name>)` and registers its prologue + member
bodies — no table edit needed.

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

---

## Implementation Plan v2 — unified substrate spec (2026-07-04, arch/fable)

> Verified against `upstream/main` @ `6b2028dac`. This section supersedes the
> open questions of the 2026-06-16 spec and re-grounds it on everything that
> landed since: S0/S1 + the brand-table PREP (above), the #2861 glue wave
> (~30 builtins wired), #2885 (gOPD call-site synthesis + accessor
> descriptors + proto-identity arm), #2963 Phase 1
> (`pushBuiltinFnSingletonValueInstrs` identity singletons) + #3006
> (`emitBuiltinConstructorIdentity` ctor carriers), #2949 slices 1–2
> (`IrType.dynamic`, `JsTag`, and the banked adoption slices A/B/C), and the
> measured verdicts of #2984 (method-value placeholder), #3025 (struct
> receivers invisible to the dynamic reader), and #3027 (the ~1,552
> `$Object`-dynamic-reader residual — the largest standalone cluster).
>
> **The one-sentence thesis:** everything the syntactic layer can already do
> (proto value reads, member closures, gOPD synthesis, `.length`/`.name`
> folds) is invisible to the RUNTIME — `__extern_get`/`__extern_has`/
> `__getOwnPropertyDescriptor`/`__getOwnPropertyNames` understand exactly one
> receiver shape (`$Object`) and return null for every other GC struct. v2
> makes the runtime reader a real MOP: builtin protos get a reader-visible
> own-property table, method values become one identity-stable
> Function-classified closure per (brand, member) across every surface, and
> the reader gains receiver-class arms (proto / instance / closed-shape) with
> a defined prototype-chain walk.

### Measured ground truth driving v2 (all verified on current main)

1. `__extern_get` (`object-runtime.ts:1012`) gates on `ref.test $Object`
   (line 1051) and returns null externref otherwise. `__extern_has`
   (`:2247`) and the descriptor/names natives do the same. `$NativeProto`,
   `$NativeRegExp`, closed-shape nominal structs, vecs — **all invisible**.
   This single gate is the shared root of #3027's null/undefined residual,
   #3025's `with(structVar)` failure, and #2984 bucket (1)'s runtime forms.
2. `object-runtime.ts` contains **zero references to `$NativeProto`** — the
   entire #2175 S1/#2861/#2885 edifice is compile-time-syntactic. Any proto
   object that *flows* (bound to a variable, passed as an argument, returned,
   received as a closure param) drops off the reflective world.
3. `tryCompileStandaloneBuiltinProtoMemberRead` (`property-access.ts:1080`,
   method arm at `:1130`) still emits `pushBuiltinFnClosureValueInstrs` — a
   **fresh struct per read**. #2963 Phase 1 fixed identity only for the 3
   static-method closures (`property-access.ts:4165`). So
   `RegExp.prototype.exec !== RegExp.prototype.exec` standalone, and
   `gOPD(p,"exec").value !== p.exec` — exactly the #2984 "non-canonical
   `.value`" finding.
4. The standalone `__typeof` native (`index.ts:11854`) has arms for
   null/number/boolean/bigint/string and falls through to `"object"`. **No
   function arm** — a closure struct read back dynamically reports
   `typeof === "object"`, while the inline path const-folds `"function"`
   from the TS type. This is the #2984 "path-dependent `typeof`" defect, and
   it contradicts `JsTag.Function` (#2949 V1 tag-fidelity invariant) at the
   classifier level.
5. `$Object` is **final** (`object-runtime.ts:276-291`, the #1100/#2009
   canonicalization hazard) — "make the proto a `$Object` subtype with a
   brand field" is not available. The codebase's established alternative is
   the `$Proxy` pattern: a *separate* struct discriminated by its own
   `ref.test` arm ahead of the `$Object` cast. v2 follows that pattern.
6. `$PropEntry` already carries everything the proto table needs: anyref
   key (native string OR `$Symbol` carrier, #2866), anyref value, flags with
   `FLAG_ACCESSOR`, insertion seq, and anyref `$get`/`$set` accessor slots
   whose getters `__extern_get` already invokes **with the original
   receiver** (§6.2.5.5-correct, `:1088-1119`). No new entry representation
   is needed — only population and dispatch.

### The three contracts

#### C1 — builtin-prototype object representation

`$NativeProto` **stays** the identity anchor (one lazily-materialized struct
per brand behind `__native_proto_<brand>`; `RegExp.prototype ===
RegExp.prototype` continues to ride the global). It gains a **companion
own-property table**: a new trailing field

```
6 $props (mut anyref)   ;; lazily-attached (ref $Object) own-property table, null until first runtime reflective access
```

- **Why a companion table and not a replacement:** replacing `$NativeProto`
  with a bare `$Object` loses the brand (no field to put it in — `$Object`
  is final, fact 5) and with it every compile-time surface keyed on brand
  (member meta-folds, glue lookup, the #2885 identity arm). The table hangs
  *off* the same identity-stable struct, so all landed surfaces keep working
  unchanged while the runtime gains a real object to query.
- **Why `anyref`, not `(ref null $Object)`:** typing the field would force
  `registerNativeProtoType` to register the object runtime's types eagerly,
  changing type sections (and bytes) for every module that touches a proto
  value but never reflects. `anyref` + `ref.cast $Object` in the (rare)
  reader arms keeps proto-only modules byte-stable. The single
  `struct.new $NativeProto` site is `emitLazyNativeProtoGet`
  (`native-proto.ts:296-340`) — the layout change is a one-site edit
  (append `ref.null any` before `struct.new`) plus the S2-class site if
  #2158's classmeta branch lands its own `struct.new`.
- **Population** is a per-brand generated function
  `__nativeproto_populate_<brand>(ref $NativeProto) -> ref $Object`,
  emitted from the registered glue: for each CSV member, insert an entry
  with the **singleton** closure value (C2) — methods as data props
  `{writable:true, enumerable:false, configurable:true}`
  (`FLAG_WRITABLE`), getters as accessor entries (`FLAG_ACCESSOR`, `$get` =
  the getter singleton, `$set` null). **Reuse the standalone
  `Object.defineProperty` insert path** (the `__obj_insert` +
  grow-discipline wrappers) — do not hand-roll a second insert (D4 rule).
  Symbol-keyed members insert **real `$Symbol` carrier keys** with the
  well-known id — the `@@<id>` CSV sentinel stays only as the compile-time
  member list encoding; at the table layer symbols are genuine keys (the
  table already supports them, fact 6), so `getOwnPropertySymbols` /
  `gOPD(proto, Symbol.match)` fall out of the ordinary reader.
- **Trigger — lazy on first runtime reflective access** via a reserve/fill
  native `__nativeproto_ensure_props(anyref) -> (ref $Object)`: registered
  with the object runtime (default body unreachable), filled at FINALIZE
  with `struct.get $brand` → brand-switch arms calling each registered
  glue's populate fn — the same reserve/fill discipline as
  `fillBuiltinFnMeta`/`fillExternIsArray`. Only brands whose glue was
  registered during compilation get an arm, so binary cost stays
  demand-driven (a program that never mentions RegExp carries no RegExp
  populate).
- **Chain linking:** `emitLazyNativeProtoGet`'s init body fills the fields
  S1 left null: `$parent` = the parent proto's global (recursive
  `emitLazyNativeProtoGet` — Object.prototype for most brands;
  `%TypedArray%.prototype` for concrete views, per the v1 table), `$ctor` =
  the builtin's ctor carrier (C1-ctor below). Object.prototype's own
  `$parent` stays null (chain terminal). All emission is inside the
  existing `if (ref.is_null)` init body in `fctx.body` — shift-covered, no
  const-init `ref.func`/`call` hazard (the #2963 discipline).

**C1-ctor (constructor objects).** The `__builtin_ctor_<Name>` carriers
(`emitBuiltinConstructorIdentity`, `builtin-static-globals.ts:119`) are
already **plain `$Object`s** — the reader sees them today; their tables are
just empty. v2 populates them the same way: a per-name populate adding (a)
`prototype` → the brand's `$NativeProto` (as anyref via
`any.convert_extern`), (b) the wired static-method singletons, (c) nothing
else (absent members correctly read `undefined`). Dually, proto tables get a
`constructor` entry → the ctor carrier. This closes the loop
`RegExp.prototype.constructor === RegExp` at the RUNTIME layer and retires
#2984 bucket (2)'s `gOPD(Array,"isArray")` CE once `Array`/`Object` join the
identity-carrier set (today they're namespace-object carriers with a
different key — unify progressively, D7).

#### C2 — native-method-closure dispatch contract

**One value per (brand, member), everywhere.** The method/getter closure
value for a builtin proto member is THE #2963 singleton
(`pushBuiltinFnSingletonValueInstrs`, keyed by the meta typeIdx — already
rec-group/DCE-stable and late-import-shift-safe). Three surfaces must
converge on it:

1. syntactic value read — `tryCompileStandaloneBuiltinProtoMemberRead`
   method arm (`property-access.ts:1130`) switches from
   `pushBuiltinFnClosureValueInstrs` to the singleton;
2. the proto table — `__nativeproto_populate_<brand>` stores the same
   singleton (emit the identical lazy-init guard against the same global
   inside the populate body);
3. #2885's gOPD synthesis (`calls.ts` Site 2) — the descriptor's
   `value`/`get` args switch to the singleton.

Then `RegExp.prototype.exec === RegExp.prototype.exec`,
`gOPD(p,"exec").value === p.exec`, and the table read all yield one object —
the ES "a builtin method is ONE function object" invariant, by construction.

**Carrier & classification.** The table stores the **raw closure struct**
(anyref), NOT an `$AnyValue` box — identity must survive round-trips, and
`$PropEntry.value` is anyref already. Function-ness is the CLASSIFIER's job:

- Add a **function arm to the standalone `__typeof` native**
  (`index.ts:11854`): reserve the arm at registration, fill at FINALIZE
  with `ref.test` over every closure **base wrapper** struct type
  (`getOrCreateFuncRefWrapperTypes` registry — meta subtypes pass their
  base's test, and user closures are correctly `"function"` too), placed
  before the `"object"` fallthrough. Same fill pass exposes a shared
  `isClosureStructArms()` helper.
- The **same** arms feed the `$AnyValue` boxing classifier so a
  dynamically-read method value boxes as `JsTag.Function`, keeping
  `__typeof`, the #2040 tag classifier, and #2949's tag refinement in
  lockstep (V1 tag fidelity; one predicate, two consumers — never two
  tables).

**Invocation.** Recovery of a dynamically-held method value is #2949's
banked slice A contract: `tag.test(Function)` → unbox → `ref.test` against
candidate closure struct types keyed on the **exact struct typeIdx** (not
arity). The factory already registers every meta type in
`ctx.closureInfoByTypeIdx` and records receiver-taking closures in
`ctx.nativeProtoReceiverClosureStructTypes` (`native-proto.ts:503-507`), so
`m.call(re, s)` / `d.get.call(re)` thread `thisArg` into param 1 (the #2193
PR-B mechanism). v2 adds no new call machinery; it REQUIRES that the
receiver-recovery arms in `expressions/calls.ts` (~the `__callable_param_*`
region) and `__apply_closure` (`object-runtime.ts:6952`, the any-receiver
method-call path) treat `nativeProtoReceiverClosureStructTypes` membership
as "prepend receiver" uniformly — the implementer must probe both paths
(`const m = RegExp.prototype.test; m.call(/a/,"a")` and
`recv.test("a")` with recv externref) in the pilot slice.

**Getter invocation on the chain** needs no new contract at all: once proto
tables carry accessor entries, `__extern_get`'s existing accessor branch
invokes `$get` with the ORIGINAL receiver (fact 6). An instance receiver
gets the field value via the brand-recovery prologue; the proto object
itself gets `undefined` via the #2885 proto-identity arm. Both spec arms
compose for free.

#### C3 — the dynamic-reader MOP + prototype-chain walk contract

Restructure the reader natives around a **receiver-classification ladder**.
Contract (applies to `__extern_get`, `__extern_has`, `__hasOwnProperty`,
`__getOwnPropertyDescriptor`, `__getOwnPropertyNames`, `__extern_set`,
`__delete_property` — one semantics, per-native arms):

```
lookup(recv, key):
  1. builtin-fn meta arm (existing, #2896)                — fn values' name/length
  2. ref.test $Object   → own-table find                  — existing path
       hit  → resolve (data / accessor with recv as this)
       miss → recv' = o.$proto; if null → step 5 (implicit terminal); loop
  3. ref.test $NativeProto → t = __nativeproto_ensure_props(recv)
       own find in t; hit → resolve (this = the PROTO object — identity arm
       yields undefined for getters, correct); miss → recv' = $parent; loop
  4. instance arm: brand = __instance_proto_brand(recv)   — finalize-filled
       (ref.test $NativeRegExp → RegExp, vec types → Array, $AnyString →
        String, closure wrappers → Function, boxed num/bool → Number/Boolean,
        error structs → their NativeError brand, …)
       own layer FIRST via __instance_own_get(recv, key)  — finalize-filled
       (RegExp lastIndex/source own data props; vec "length" + indices;
        string "length" + indices; closed-shape struct fields — see below)
       then proto layer: the brand's $NativeProto table, walk $parent up
  5. implicit terminal: Object.prototype's table (guarded by a future
     FLAG_NULL_PROTO object flag for Object.create(null), D5)
  6. miss → null / 0 / undefined-descriptor (per native)
```

- **Closed-shape nominal structs** (user object literals compiled to
  nominal WasmGC structs — the #3025 root cause and a large #3027 subset)
  are one arm of step 4: a finalize-filled `__closedshape_get(any, key)`
  generated from `ctx.structFields`/`ctx.typeIdxToStructName` — per struct
  type, `ref.test` → key compare via `__str_equals` → boxed field read
  (box through the canonical `boxToAny`/`__box_*` family; native-string
  fields pass as-is — this is the direct fix for the
  `project_standalone_any_string_value_read_substrate` class where typed
  reads work but dynamic reads drop values). Their proto brand is `Object`
  (step 5 gives them `hasOwnProperty` et al.). Closed-shape **methods** stay
  with the #2151 `__call_m_<name>` dispatcher family for CALLS; the method
  VALUE read off a closed shape is out of v2 scope (flagged edge, below).
- **`__extern_set` on a proto receiver:** methods are `writable:true`, so
  assignment must genuinely write the table (after `ensure_props`).
  `__extern_set` on a closed-shape struct field: emit the per-type arm for
  fields (mutable fields only); non-writable / non-existent → current no-op
  semantics. `__delete_property` on a proto member (`configurable:true`)
  works for free once the table is real.
- **`with` (#3025):** the standalone `with` dynamic path's `__extern_has` +
  `emitDynGet` calls resolve struct receivers once step 4's closed-shape
  arm lands — no `with`-specific work. The **host-lane** `with` failure
  (#3025 is measured on the default lane, where `__extern_has` is a host
  import that can't see GC structs) is NOT fixed by this; #3025's Tier-1
  static-type extension remains the host-lane plan. Optionally the same
  closed-shape native can run as a pre-check before the host import there —
  note it in #3025, don't scope it here.
- **Perf discipline:** the ladder adds arms only on the *miss* path of the
  existing `$Object` test (step 2 is unchanged and first among struct
  tests); typed fast paths (instance `re.flags`, `o.m()` at syntactic call
  sites) never enter these natives. The byte-identity guard for untouched
  programs is `scripts/prove-emit-identity.mjs` (39-hash corpus), which
  every slice must keep IDENTICAL for modules that never pull the object
  runtime.

### Decision points (two-viable-designs, with recommendation)

- **D1 — proto representation.** (a) keep protos virtual + widen call-site
  synthesis case-by-case (#2885's original choice) vs **(b) companion
  `$props` table on `$NativeProto` (RECOMMENDED)** vs (c) replace
  `$NativeProto` with plain `$Object`s. (a) can never serve a *runtime*
  receiver (the #2984/#3027 measured wall — synthesis needs syntax); (c) is
  blocked by `$Object` finality (fact 5) and would orphan every brand-keyed
  surface. (b) is additive, keeps identity anchoring, and converts #2885's
  synthesis into a fast path rather than a dead end.
- **D2 — `$props` field type.** `(ref null $Object)` vs **`anyref`
  (RECOMMENDED)** — avoids eager object-runtime type registration from
  `registerNativeProtoType`, keeping proto-only modules byte-stable; the
  cast lives in reader arms that already paid for the object runtime.
- **D3 — population trigger.** Eager at proto materialization vs **lazy via
  `__nativeproto_ensure_props` on first runtime reflective access
  (RECOMMENDED)**. Materialization is common (every `X.prototype` value
  read); runtime reflection is rare. Lazy keeps the common path at one
  null-check. Cost either way: the populate fn + member closures exist in
  the binary for every glue-registered brand (~15 small delegating funcs
  for RegExp). Accepted; it is demand-gated by glue registration, and most
  closure bodies delegate to engine funcs the module already carries.
  (Per-member lazy population was considered and REJECTED: closures exist
  at compile time regardless, so it saves no binary size and adds a
  per-entry guard.)
- **D4 — table value carrier.** `$AnyValue`-boxed vs **raw closure struct
  anyref + classifier arms (RECOMMENDED)**. Raw preserves `ref.eq` identity
  with zero unwrap layers and matches how user-object closures are already
  stored; Function-ness is established at the classifier (fact 4's fix),
  which #2949 slice 3's boxing then consumes — one representation below,
  tags at the boundary (the #1852 invariant).
- **D5 — `$Object` chain terminal.** Widen `$Object.$proto` to anyref so
  plain objects can LINK to `$NativeProto` protos, vs **implicit
  Object.prototype terminal arm after the `$Object` walk exhausts
  (RECOMMENDED)** + a `FLAG_NULL_PROTO` bit in `$Object.$flags` for
  `Object.create(null)`/`setPrototypeOf(null)`. Widening the proto field
  touches every proto-walk site and re-opens the #2009 canonicalization
  minefield for marginal gain; the implicit arm is 10 lines per native and
  spec-equivalent for default-proto objects. Revisit widening only if
  user-defined `setPrototypeOf(obj, SomeBuiltin.prototype)` shows up as a
  measured cluster.
- **D6 — symbol members.** Keep `@@<id>` sentinels at the runtime layer vs
  **real `$Symbol` carrier keys in the table (RECOMMENDED)** — the table
  supports them (#2866); sentinels remain only as glue-CSV encoding.
- **D7 — ctor-object unification.** Keep the three ctor carrier families
  (identity set / namespace `$Object`s / null-extern defaults) vs
  **progressively unify on populated `$Object` carriers (RECOMMENDED)**:
  extend `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` per slice (Array + Object
  first — they gate #2984 bucket 2), fold `emitBuiltinNamespaceObject`'s
  populated-props mechanism into the same populate-table shape. Do NOT
  flip all names in one PR — each name changes the bare-identifier read
  path and needs its own regression sweep.

### Slice decomposition (each independently mergeable; Opus-executable)

- **V2-S1 (M) — `typeof` function arm + shared closure classifier.**
  `index.ts` `__typeof` native: finalize-filled `ref.test` arms over closure
  base wrapper types before the `"object"` fallthrough (reserve/fill like
  `fillBuiltinFnMeta`); export the arm-builder for the `$AnyValue`
  classifier + #2949 slice 3. Fixes the #2984 `typeof` instability and
  `typeof f === "function"` standalone generally. *Gate:*
  `typeof RegExp.prototype.exec`, `typeof (d.value)` inline AND
  const-bound both `"function"`; `typeof {}` still `"object"`;
  prove-emit-identity green on closure-free corpus files.
- **V2-S2 (M) — singleton unification.** Switch surfaces (1) and (3) of C2
  to `pushBuiltinFnSingletonValueInstrs`; getter closures get singletons
  too. Files: `property-access.ts:1130` region, `calls.ts` #2885 Site-2
  emission. *Gate:* `RegExp.prototype.exec === RegExp.prototype.exec`;
  `gOPD(RegExp.prototype,"exec").value === RegExp.prototype.exec`;
  swap-guard `… !== RegExp.prototype.test`; existing issue-2175/2885 suites
  green.
- **V2-S3 (L) — the proto table + `$NativeProto` reader arm.** C1 layout
  change (+`$props`), `__nativeproto_populate_<brand>` generator in
  `native-proto.ts` (glue-driven), `__nativeproto_ensure_props`
  reserve/fill in `object-runtime.ts`, step-3 arms in
  `__extern_get`/`__extern_has`/`__hasOwnProperty`/
  `__getOwnPropertyDescriptor`/`__getOwnPropertyNames`/`__extern_set`/
  `__delete_property`. Chain fields: `$parent`/`$ctor` filled at
  materialization. RegExp + Object pilot brands (Object.prototype table:
  `hasOwnProperty`, `toString`, `isPrototypeOf`, `valueOf`,
  `propertyIsEnumerable` — bodies may degrade to the #2193 catchable
  refusal where no engine exists yet). *Gate:* `const p: any =
  RegExp.prototype; p.exec` resolves; `"exec" in p`;
  `gOPD(p, "flags")` accessor descriptor with `.get.call(/gi/) === "gi"`
  through the RUNTIME path (no syntactic synthesis);
  `Object.getPrototypeOf(RegExp.prototype) === Object.prototype`;
  `delete`-then-`hasOwnProperty` round-trip on a proto method.
- **V2-S4 (L) — ctor objects populated + `__get_builtin` receiver refusal
  retired.** C1-ctor: populate `__builtin_ctor_<Name>` tables
  (`prototype`, static-method singletons, `constructor` back-link on
  protos); add Array/Object to the identity set (D7); route the builtin-
  ctor-as-dynamic-receiver path (the `__get_builtin` fallthrough,
  `property-access.ts` ~L192-208/403 refusal context) to the carrier.
  *Gate:* `gOPD(Array, "isArray")` compiles + returns a data descriptor
  whose `.value === Array.isArray` (#2984 bucket 2);
  `RegExp.prototype.constructor === RegExp`; #2963's identity tests stay
  green.
- **V2-S5 (L, decompose per class) — instance-chain arm.**
  `__instance_proto_brand` + `__instance_own_get` finalize-filled hooks;
  per-class sub-slices in order: RegExp (pilot — lastIndex own prop +
  proto-chain method/getter resolution on an externref receiver), vec/Array
  (own length + indices, then Array.prototype methods via the chain),
  String (`$AnyString` receivers), Function (closure receivers → the
  builtin-fn meta arm generalizes into this). *Gate per sub-slice:* e.g.
  `function f(r: any) { return r.test("a") } f(/a/)` host-free;
  `/a/[Symbol.match]("a")` non-null via the symbol-keyed table entry
  (retiring the S1 "next refinement" boundary); the 57-test Symbol.* and
  52-test `.call` RegExp sub-buckets.
- **V2-S6 (M) — closed-shape struct arm.** `__closedshape_get/has`
  generated from `ctx.structFields`; wire as step-4 arms + `__extern_set`
  field writes. *Gate:* `const o = {p1: 7, p2: "hi"}; with(o){...}`
  standalone; `const o: any = {v: "hi"}; o.v.length === 2` (the
  substrate-memory repro); #3025's standalone repro; a
  `Object.keys(structVar)` sanity (names arm optional here, flag if cut).
- **V2-S7 (S) — measure + re-scope #3027.** Re-run the standalone harvest;
  split the 1,552 into flipped-by-v2 vs residual (generator/async carriers
  #2864/#2865, iterator protocol, other); update #3027 + umbrella #2860.

Suggested order: S1 → S2 → S3 → S4 → S5(RegExp) → S6 → S5(rest) → S7.
S1/S2 are independent and can run in parallel; S3 is the keystone; S4–S6
depend on S3 only. Do not fold S3+S5 into one PR — the reader-arm blast
radius needs separate CI evidence.

### Coordination / conflict flags (in-flight work, read before dispatch)

- **#2949 slice 3** (fable-2949, branch `issue-2949-jstag-dynamic` may still
  be in flight): V2-S1's classifier arms are the SAME predicate its
  `tag.test(Function)` lowering needs — land V2-S1 as/with the shared
  helper and point #2949 slice 3 at it; never two closure-struct arm lists.
- **#2984** (assignee sr-gopd): V2-S3/S4 ARE its buckets (1)+(2) substrate.
  Re-point #2984 to consume these slices; do not dispatch a parallel
  descriptor-layer attempt (its own file warns this re-breeds the
  placeholder).
- **#2963 Phase 2** (any-callable scalar-param dispatch, `calls.ts`
  ~13230-13640): V2-S2 touches nearby singleton call sites; V2 does NOT fix
  the scalar-param candidate-selection bug (that stays #2949 slice A /
  #2963 P2 territory). Keep the PRs disjoint by function.
- **#2158 S2 (class protos)**: unchanged by v2 — classes plug into the same
  `$props`/populate contract with `$ClassMeta` as the population source
  once #2101 P0-P1 compose; v2's reader arms are brand-agnostic, so S2
  inherits them for free.
- **File-conflict surface**: `object-runtime.ts` (S3/S5/S6),
  `property-access.ts` (S2/S4), `native-proto.ts` (S3), `calls.ts` (S2/S4)
  — serialize slices touching the same file through the queue; each is
  `ctx.standalone`-gated so host/gc lanes stay byte-inert (validate on full
  `merge_group` + `check-standalone-highwater.mjs`, never a scoped sweep).

### Edge cases (beyond v1's list, which still applies)

- **Reader re-entrancy:** `__nativeproto_ensure_props` runs inside
  `__extern_get`; populate bodies must not call back into `__extern_get`
  (they use `__obj_insert`-level primitives — assert this in review).
- **`gOPD` non-own semantics:** step 3/4 proto-table hits are INHERITED for
  an instance receiver — `__getOwnPropertyDescriptor(instance, "exec")`
  must still return undefined (own-only). The ladder's own/proto layer
  split carries a per-native "stop after own layer" flag.
- **Frozen builtins:** `Object.freeze(RegExp.prototype)` → table flags
  already model FLAG-level immutability on `$Object`; ensure the companion
  table honors the same `$Object.$flags` bits.
- **Closed-shape method VALUES** (`const m = structVar.m`) — OUT of v2
  scope (needs per-struct method-closure reification; calls keep working
  via #2151 dispatchers). File as a follow-up if a measured cluster
  demands it.
- **Escape-hatch identity:** the singleton globals are per-module; two
  modules never share identity (fine — single-realm standalone).
- **DCE / index stability:** populate fns + ensure_props follow
  reserve-then-fill (#1719) and name-based funcIdx re-resolution after
  `flushLateImportShifts` (#2043 class); type registrations for `$Symbol`
  keys reuse `ensureSymbolCarrier` (never re-mint).

### What v2 explicitly does NOT do

- No host-mode changes (every arm `ctx.standalone`-gated); no new host
  imports anywhere.
- No `Proxy`/`Reflect.ownKeys`-completeness work; no `Symbol.hasInstance`.
- No second boxing/tag/insert engine — every new path routes through
  `$AnyValue`/`__box_*`, `__obj_insert`-family, and the one closure-struct
  predicate (June-audit D4).
- Does not fix #2963 P2's scalar-param value-call keying, host-lane `with`,
  or generator/async-carrier residuals of #3027 — those stay with their
  owners; v2 is the representation + dispatch + visibility substrate they
  sit on.

---

## Implementation log — V2-S1 (sdev opus-2984s1, 2026-07-04)

PR: **V2-S1 of 7** — `typeof` function arm + shared closure classifier.
Branch `issue-2175-v2s1`. Status: implemented, host-free, standalone-gated.

### Re-grounding correction to v2 fact 4 (IMPORTANT for later slices)

The v2 spec (fact 4) states the standalone `__typeof` native has "**No
function arm**". Verified against `origin/main @ 1b7632bda`, that is **half
right and half stale** — the distinction is load-bearing:

- The **PREDICATE** family `__typeof_function` / `__typeof_object` (used by
  the INLINE `typeof x === "function"` compare) **already recognises closure
  wrapper structs** — #1896 (`fillStandaloneTypeofClosureArms`,
  `index.ts`) splices `ref.test`-over-closure-base-wrapper arms into both at
  finalize. So `typeof x === "function"` was ALREADY correct standalone.
- The **MATERIALIZED** `__typeof` native (the tag as a NativeString VALUE —
  `const t = typeof x`, or `typeof` flowing through a param) had **no
  function arm** and fell through to `"object"`. THIS is the actual #2984
  path-dependence: inline said `"function"`, const-bound said `"object"`.

Empirically confirmed on unmodified main (inject/contrast proof, not
narrative): `const f = (x)=>x*2; const a:any=f;`
- `typeof a === "function"` → **1** (predicate, #1896)
- `const t:any = typeof a; t === "function"` → **0** (materialized, broken)
- `RegExp.prototype.exec` const-bound typeof → **0** (broken) / inline → 1

### What landed

- **New leaf module `src/codegen/closure-classifier.ts`** — the SINGLE
  home for the closure-base-wrapper list (`collectClosureBaseWrapperTypeIdxs`)
  and a reusable arm-builder (`buildClosureRefTestArms(ctx, anyLocalIdx,
  onMatch)`). It imports only types, so `index.ts` and `dyn-read.ts` (which
  are in an import cycle) can both depend on it without re-introducing the
  cycle. This retires the TWO divergent copies that existed:
  `collectClosureBaseWrapperTypeIdxs` (index.ts) and the byte-identical
  private `closureBaseWrapperTypeIdxs` (dyn-read.ts, added specifically to
  dodge the cycle). **One predicate, all consumers** — the spec's "never two
  closure-struct arm lists" invariant, now structurally enforced.
- **`fillStandaloneTypeofClosureArms`** (`index.ts`) extended: after
  patching `__typeof_function`/`__typeof_object` (unchanged, now via the
  shared builder → **byte-identical**), it splices a closure `ref.test` →
  `"function"` NativeString arm into the MATERIALIZED `__typeof` body,
  before the terminal `"object"` sequence. Robust splice point: the terminal
  is the last N instrs where N = `stringConstantExternrefInstrs(ctx,
  "object").length` (deterministic); an op-shape tail check gates the splice
  (skips the `ref.null.extern` stub when no native-string type). Finalize
  timing is REQUIRED — closures aren't all registered at `__typeof`'s
  registration point (same reason #1896 finalize-fills the predicates).

### Why byte-neutral except the intended change

- `buildClosureRefTestArms(ctx, i, [i32.const v, return])` emits IDENTICAL
  instrs to the old local `closureTestArms(i, v)` (same list, same order) →
  `__typeof_function`/`__typeof_object` bytes unchanged.
- `dyn-read.ts` repoint is aliased to the prior local name; the shared
  collector returns the same list (same algorithm, same Map iteration order)
  → the `.length`-arity arm bytes unchanged. #2580 suite (57 tests) green.
- Closure-FREE modules: empty list → `buildClosureRefTestArms` emits nothing
  → `__typeof` unchanged. `prove-emit-identity` deterministic (exit 0).
- Only NEW bytes: the `__typeof` function arm in closure-containing
  standalone/wasi modules — the intended fix.

### Gate — verified

- `tests/issue-2175-typeof-function-arm.test.ts` (5/5): closure +
  `RegExp.prototype.exec` report `"function"` inline AND const-bound;
  swap-guard (materialized closure is NOT `"object"` — proves the arm fires,
  not a coincidental pass); non-closure receivers keep their tag.
- Regression: #1896 typeof-closure, typeof-expression/comparison,
  #2104 value-tags, #2949 slices 1/2/3/3b (77), #2580 dyn-read (57) — all
  green. `tsc --noEmit` clean. Host mode untouched (all arms
  `ctx.nativeStrings`-gated).
- **Pre-existing (NOT this slice):** 4 getter tests in
  `issue-2175-regexp-proto-readers.test.ts` (`.flags`/`.source`/flag-bool
  getter VALUE reads) fail on `origin/main` too (8/12 pass on both baseline
  and this branch) — the S1 "getter engine body" boundary, unrelated to
  typeof. Not regressed here; belongs to the V2-S5 RegExp instance-chain
  slice.

### Banked for V2-S2+ (consume the shared classifier)

- **#2949 slice 3 / `$AnyValue` boxing classifier**: point `tag.test(Function)`
  and the runtime-ref → `JsTag.Function` boxing at
  `buildClosureRefTestArms` / `collectClosureBaseWrapperTypeIdxs`
  (`closure-classifier.ts`) — do NOT mint a third arm list. The `__typeof`
  arm and the boxing classifier are now guaranteed one predicate.
- **V2-S2 (singleton unification)**: independent of S1; switch
  `property-access.ts:~1130` method arm + `calls.ts` #2885 Site-2 to
  `pushBuiltinFnSingletonValueInstrs` (identity). Note: once method values
  are singletons, `typeof` of them is already correct via this S1 arm.
- **V2-S3 (proto table)**: the reader arms will read closure structs back as
  `$PropEntry.value` (raw anyref, D4) — their `typeof`/Function-ness now
  resolves through this same classifier for free.

---

## Implementation log — V2-S2 (sdev opus-2175s2, 2026-07-04)

PR: **V2-S2 of 7** — singleton unification of builtin-proto method/getter
values. Branch `issue-2175-v2s2`. Status: implemented, host-free,
standalone-gated, byte-neutral off-path.

### What landed

Switched the three C2 surfaces that reify a builtin-prototype method/getter
VALUE from a fresh per-read `struct.new` (`pushBuiltinFnClosureValueInstrs`)
to the #2963 identity-stable module singleton
(`pushBuiltinFnSingletonValueInstrs`):

1. **`property-access.ts` method arm** (`tryCompileStandaloneBuiltinProtoMemberRead`,
   the syntactic `RegExp.prototype.exec` value read).
2. **`property-access.ts` getter arm** (the getter self-struct operand for the
   `call_ref` that invokes an accessor getter — so the getter object invoked
   here is the same one gOPD's `.get` returns).
3. **`calls.ts` #2885 gOPD Site-2** — both the data-descriptor `.value` and the
   accessor-descriptor `.get`.

Removed the now-unused `pushBuiltinFnClosureValueInstrs` import from
`property-access.ts`; `calls.ts` swapped its import to the singleton.

### Why it is correct AND collision-free (the load-bearing invariant)

`pushBuiltinFnSingletonValueInstrs` keys its per-value module global on
`closure.type.typeIdx`. That typeIdx is the **UNIQUE per-(brand,member) meta
subtype** minted by `ensureBuiltinFnMetaType` under cache key
`proto:<brand>:<kind>:<member>` (verified: `builtin-fn-meta.ts:199-219`
memoizes on that key, one typeIdx per key). So:
- **same member, different surface** (syntactic read vs gOPD synthesis) →
  same cacheKey → same typeIdx → same global → **one object** →
  `gOPD(p,"exec").value` and `RegExp.prototype.exec` are the same singleton;
- **different member** (`exec` vs `test`) → different cacheKey → different
  typeIdx → different global → **distinct objects** → `exec !== test` holds by
  construction (the swap-guard is structural, not incidental).

### Proof (inject/contrast, not narrative — builtin-proto hides coincidental passes)

- **Surface-1 identity is genuinely fixed:** on baseline (`HEAD~1`, fresh
  struct.new) `const a:any=RegExp.prototype.exec; const b:any=RegExp.prototype.exec; a===b`
  → **0**; with the singleton → **1**. Swap-guard `exec===test` → **0** on
  BOTH (proves `===` discriminates; the `1` is not always-true, and the
  `typeof===\"function\"` guard proves it is not `null===null`).
- **Surface-3 materializes the RIGHT singleton:** `typeof gOPD(...).value ===
  \"function\"` and `.value.name === \"exec\"`; `typeof gOPD(...,\"flags\").get
  === \"function\"` and `.get.name === \"get flags\"` (§10.2.9). The function
  classification flows through the **V2-S1 shared closure classifier**
  (`closure-classifier.ts` via the materialized `__typeof` arm) — V2-S2
  consumes it, mints no new arm list.
- **Byte-neutral off-path:** `prove-emit-identity` — all 39 (file,target)
  corpus emits IDENTICAL across gc/standalone/wasi. The four sites are
  `ctx.standalone`-gated and only fire on a builtin-proto member VALUE read /
  gOPD synthesis, so host mode and every non-reflective program are unchanged.
- **No regression:** #2963 reification, #2896 fn-meta, #2861 glue wave (proto
  value reads), #2949 slice3/3b dynamic, #2580 dyn-read, #2885, #2175 typeof,
  #2175 native-proto-brands — 189+ tests green. The 4 pre-existing failures in
  `issue-2175-regexp-proto-readers.test.ts` (getter-engine-body boundary) fail
  IDENTICALLY on `HEAD~1` — not regressed here; they belong to V2-S5.

Test: `tests/issue-2175-v2s2-singleton-identity.test.ts` (6/6).

### KEY FINDING for V2-S3 (banked — this de-risks the keystone slice)

The end-to-end gate `gOPD(RegExp.prototype,\"exec\").value === RegExp.prototype.exec`
is **NOT** achievable by singleton unification alone, and the reason is NOT the
singleton: the descriptor stores the correct singleton, but its `.value` reads
back as an **externref-wrapped `$Object`**, and the standalone `===` lowering
does **not** `ref.eq`-compare an externref-wrapped GC ref against a raw anyref.
This is a **pre-existing, broad** value-representation gap, proven independent
of this change:
- `const o:any={z:1}; const a:any[]=[o,o]; a[0]===a[1]` → **0** (a plain user
  object referenced twice loses identity through the externref boundary);
- `gOPD(RegExp.prototype,\"exec\").value === gOPD(...).value` (same field, two
  reads) → **0**;
- yet `const o:any=RegExp.prototype.exec; const a:any[]=[o,o]; a[0]===a[1]` →
  **1** (anyref/GC-ref identity via `ref.eq` DOES work — the gap is specifically
  the externref-wrapped read-back, not `===` generally).

So this is squarely **C3 (the dynamic-reader MOP + value representation)**,
owned by V2-S3: once the reader returns closure structs back as **raw anyref**
`$PropEntry.value` (D4 — the spec already mandates this), the descriptor
`.value`/`.get` become GC refs, `ref.eq` fires, and the identity gate **flips
to 1 for free** — the descriptor already carries the right singleton (this
slice). `tests/issue-2175-v2s2-singleton-identity.test.ts` includes an explicit
`.toBe(0)` **characterization guard** for this boundary that will FAIL LOUDLY
when V2-S3 lands, prompting the flip to `.toBe(1)`.

### Banked for V2-S3+

- The three value surfaces are unified — V2-S3's proto table populate body
  (`__nativeproto_populate_<brand>`) MUST store the **same** singleton
  (emit `pushBuiltinFnSingletonValueInstrs` against the same closure) so the
  runtime-read value keeps identity with the syntactic surfaces. One value per
  (brand, member), everywhere.
- The externref/`$Object`-vs-anyref `===` gap above is the concrete substrate
  V2-S3's D4 (raw-anyref carrier) exists to close — carry the raw closure
  struct, not an `extern.convert_any` box, in `$PropEntry.value`.

---

## Implementation log — V2-S3a (sdev opus-2175s3, 2026-07-04)

PR: **V2-S3a of 7 — the raw-anyref carrier** (identity reconciliation).
Branch `issue-2175-v2s3-dynamic-reader` (stacked on `issue-2175-v2s2`).
Status: implemented, host-free, **standalone/wasi-gated (host byte-identical)**.

### The senior-dev scoping call (WHY this is S3a, not the full C3)

V2-S3 (C3) is two genuinely separable blast radii: **(a)** the raw-anyref
carrier that reconciles GC-object identity across representations — this is
what flips the banked `.toBe(0)` guard and fixes a broad #3027 identity class —
and **(b)** the `$NativeProto` reader-arm MOP (`$props` table + populate +
`ensure_props` + step-3/4 arms across the 7 reader natives) that makes a proto
object *flowing as a runtime value* answer reflective reads. The v2 spec itself
mandates keeping the reader-arm blast radius on its own CI evidence
("Do not fold S3+S5 into one PR"). The carrier (a) is small, provably safe, and
delivers the explicitly-requested acceptance signal; the reader arm (b) is a
large object-runtime change. Landing (a) alone as a tight, well-proven slice —
and **banking (b)** with the note below — is the disciplined call over one
sprawling PR that conflates two minefields (equality machinery + reader natives)
in a single CI signal. The equality machinery is the codebase's most
regression-prone area (documented −162/−788/−794/−1245 incidents in
`any-helpers.ts`), so it earns its own isolated evidence.

### Root cause (traced, not narrative)

`emitStrictEq` boxes both `any` operands to `$AnyValue` and calls
`__any_strict_eq` (any-helpers.ts). A GC object reaches `===` under **two
representations of the same reference**:
- **raw GC ref** (e.g. `RegExp.prototype.exec`, a `(ref $wrap)` closure struct)
  → `boxToAny` kind-`ref` arm → `__any_box_ref` → **tag-6** (`refval`, field 3);
- **externref-wrapped GC ref** (the value `__extern_get` returns —
  `object-runtime.ts:1134-1139`, `struct.get $PropEntry.value` +
  `extern.convert_any` — for a descriptor `.value`, an array element, any
  dynamic member read) → `boxToAny` kind-`externref` arm → `__any_box_string`
  → **tag-5** (`externval`, field 4).

`__any_strict_eq`'s `tagA != tagB → 0` gate (any-helpers.ts, right after the
numeric-class arm) then answers **0** for that tag-5×tag-6 pair even though both
point at the identical object. That is the measured wall behind
`gOPD(p,"exec").value === p.exec` and the broad
`const o:any={z:1}; const a:any[]=[o,o]; a[0]===a[1]` → 0 class (a large #3027
subset: any object that round-trips through the externref reader loses `===`).

### The fix

A **reference-identity reconciliation arm** inserted in `__any_strict_eq`
*after* the numeric-class arm and *before* `tagA != tagB → 0`: recover each
operand's reference payload to a common `eqref` (`refval` field 3 if non-null,
else `any.convert_extern(externval field 4)`), and if both are `eq` refs and
`ref.eq`-identical → return 1. This is the exact discipline of the #2734
`__extern_strict_eq` object-identity fast path, lifted onto the `$AnyValue`
path so the **whole `any === any` surface** honours it (not just array-search).
Reuses the `anyA`/`anyB` (locals 4/5) scratch already declared. **Gated on
`ctx.standalone || ctx.wasi`** — the split is a native-GC phenomenon; host mode
(objects = host externref proxies) already answers identity and stays
byte-identical (zero host blast radius; #1888's host `isSameValue` untouched).

**Why it cannot false-positive** (the safety argument): `ref.eq` is exact
identity. Distinct number/string/object boxes are distinct refs → `ref.eq` 0 →
falls through to the existing value arms unchanged (numbers already returned via
the earlier numeric-class arm; content-equal distinct strings still reach the
tag-5 content-eq arm). Only a genuinely identical reference short-circuits, and
`x === x` for the same reference is always `true` in JS. So the arm only ever
converts a *wrong 0* into a *correct 1*; it removes/flips no value comparison.
This is categorically different from the tag-5 VALUE classifier (`tag5ValueEqThen`,
flag-off) that unmasked −162: that changes value-equality of *distinct* boxes;
this changes only reference-identity of the *same* box under mixed tags.

### Proof (inject/contrast + anti-vacuity, host-free throughout)

Baseline (`origin/issue-2175-v2s2`, my branch point) → with the arm:
- `gOPD(RegExp.prototype,"exec").value === RegExp.prototype.exec`: **0 → 1**
  (the banked characterization guard, now flipped to `.toBe(1)`);
- `const o:any={z:1}; [o,o]; a[0]===a[1]`: **0 → 1** (#3027 identity class);
- `const o:any={z:1}; const p:any=o; o===p`: **0 → 1**.
- **Anti-vacuity (the arm DISCRIMINATES, is not always-1):** distinct objects
  `{x:1}==={x:1}` → **0**; swap-guard `gOPD(...,"exec").value === RegExp.prototype.test`
  → **0**; `exec !== test` → **0**; `a[0] === (a fresh {z:1})` → **0**;
  content-eq strings `"ab" === "a"+"b"` → **1** (content path intact);
  distinct strings → **0**; `23 === 23.0` → **1**; `1 === 2` → **0**;
  `null === null` → **1**; `NaN === NaN` → **0**; `"x" === {x:1}` → **0**.

Tests: `tests/issue-2175-v2s2-singleton-identity.test.ts` — the boundary guard
flipped to `.toBe(1)` + two new anti-vacuity cases (swap-guard on the descriptor
value; array-identity with a distinct-object negative) — **8/8**. Regression
(isolated, load-flake-free): `issue-2734`, `issue-2040-tag5-field4-eq`,
`loose-equality`, `issue-2063-switch-strict-equality`,
`issue-2158-class-identity-standalone`, `issue-2579`,
`issue-2583-any-array-method-brand`, `issue-2191-case-equals`, `issue-1888`
(×3 files), `issue-2175-typeof-function-arm`, `issue-2175-native-proto-brands`
— all green. `tsc --noEmit` clean. The 4 pre-existing
`issue-2175-regexp-proto-readers` getter-body failures fail IDENTICALLY on the
branch point (V2-S5 boundary, not regressed). Full #3027 blast radius validated
on CI merge_group + standalone floor.

### Banked for V2-S3b (the reader-arm MOP — the #3027 keystone breadth)

Everything in the C3 spec §"Slice decomposition / V2-S3" EXCEPT the carrier:
- **C1 layout**: append `6 $props (mut anyref)` to `$NativeProto`
  (`native-proto.ts` `registerNativeProtoType` + the single `struct.new` in
  `emitLazyNativeProtoGet` — append `ref.null any` before the `struct.new`);
  fill `$parent`/`$ctor` in the init body (chain linking).
- **Populate**: `__nativeproto_populate_<brand>(ref $NativeProto) -> ref $Object`
  generated from glue; MUST store the **#2963 singleton** per member
  (`pushBuiltinFnSingletonValueInstrs` against the same closure) so runtime-read
  values keep identity with the syntactic surfaces — the carrier arm here then
  makes `p.exec === RegExp.prototype.exec` hold for the *flowing-proto* read too.
  Reuse the `__obj_insert` path; symbol members = real `$Symbol` carrier keys.
- **Trigger**: `__nativeproto_ensure_props(anyref) -> ref $Object` reserve/fill
  at FINALIZE (brand-switch over registered glue), reserve-then-fill (#1719) +
  name-based funcIdx re-resolution after `flushLateImportShifts` (#2043).
- **Step-3 reader arm**: in `__extern_get` (`object-runtime.ts:1041+`, after the
  `ref.test $Object` gate at :1065 misses) add `ref.test $NativeProto` →
  `ensure_props` → own-table find → resolve (data/accessor with recv as this);
  miss → `$parent` walk. Mirror into `__extern_has`, `__hasOwnProperty`,
  `__getOwnPropertyDescriptor`, `__getOwnPropertyNames`, `__extern_set`,
  `__delete_property` (one semantics, per-native arms). This is what makes
  `const p:any = RegExp.prototype; p.exec` / `"exec" in p` /
  `Object.getPrototypeOf(RegExp.prototype) === Object.prototype` resolve at the
  RUNTIME layer — the #3027 driver.
- The reader-arm result (a raw closure struct read from `$PropEntry.value`) will
  itself be `extern.convert_any`-wrapped by `__extern_get`'s return path and box
  tag-5 — but **this S3a carrier already reconciles that** against the tag-6
  syntactic singleton, so identity holds the moment the reader arm lands.
  (Double-gOPD `gOPD(p,"exec").value === gOPD(p,"exec").value` currently throws
  a Wasm exception from a SEPARATE gOPD engine body — a pre-existing limitation
  unrelated to the carrier; resolved once the reader-arm MOP replaces the
  synthesized-descriptor path.)
---

## Reconcile + Implementation log — V2-S3b-1 (claude/es6-team-reflection, 2026-08-15)

> NOTE for the integrator: this worktree is `origin/main` @ `9e17d34f3`, which
> does not yet carry the "Wave-2 adoption note" added on the session branch by
> `a89bc2ff4` (docs-only). This section is the answer to that note's step 1-3.
> All code changes are UNCOMMITTED in
> `/home/user/js2wasm/.claude/worktrees/agent-a805762abeefbfd8c`.

### R0 — reconcile. Row 3 is **259**, not ~324.

Candidate list from `.test262-cache/test262-standalone-current.jsonl`
(baseline_sha `734fab88`, generated 2026-08-15 10:16Z), edition-classified with
`scripts/generate-editions.ts`. **I then re-ran all 311 candidates on HEAD**
through `runTest262File(..., "standalone")` rather than trusting the baseline:

- **52 already pass** — the entire `annexB/built-ins/String` block, flipped free
  by #4445. The `~324` figure predates it.
- **259 still fail**, 0 CE. Biggest cluster `built-ins/TypedArray/**` = **121**.

### R0.2 — root cause, isolated by probe (not by re-reading the spec)

`harness/testTypedArray.js:64` is `var TypedArray = Object.getPrototypeOf(Int8Array)`.
On HEAD: `Object.getPrototypeOf(Int8Array)` → the #2901 ctor carrier OK,
`TA.prototype` → the `%TypedArray%` `$NativeProto` OK, **`TA.prototype.find` →
`undefined`** FAIL. The syntactic surface is healthy the whole way
(`Int8Array.prototype.find` is a function; `gOPD(…, "name").value === "find"`).
All three error signatures in the bucket ("Cannot convert undefined or null to
object" x143, "isConstructor invoked with a non-function value" x55, `typeof` is
`"undefined"` x26) are that one `undefined`.

### R0.3 — v2's banked V2-S3b is LARGER than it now needs to be

`proto-index-store.ts` (#4160, generalized #4176) landed after the v2 spec and
already provides what C3 asked for: the per-brand `$Object` COMPANION table, a
`$NativeProto`-aware receiver-brand classifier (`__protoidx_brand_off`, generic
over the brand band — `proto-index-store.ts:849-878`), and receiver-aware
consults spliced into `__extern_get`/`__extern_has`. Verified live **before**
writing code: a write+read round-trip through a flowing `%TypedArray%.prototype`
already worked. The companion is just minted EMPTY.

So V2-S3b's `$props` field / `__nativeproto_ensure_props` / 7 new reader arms are
**not needed for the GET path**. What is missing is (1) POPULATION and (2)
ARMING — both existing reserve gates (`protoIndexDirty`, `protoNamedDirty`) are
*write*-shaped pre-scans, so a purely reflective READER reserved nothing.
**This supersedes v2 D1/D2/D3 for GET**, and is strictly better on the spec's own
invariant: no `$NativeProto` layout change, so `buildLazyNativeProtoGetInstrs`
stays byte-identical.

### R0.4 — v2 "Coordination / conflict flags", each re-checked

#2949 slice 3 **landed** (`closure-classifier.ts` is the single arm list);
#2984 **landed in part** (`refusalBodyFallback` + #3250 getter fallback are in
`native-proto.ts`); #2963 P2 untouched (I do not enter `calls.ts`); #2158 S2
inherits the brand-agnostic consults for free. v2's named file-conflict surface
(`property-access.ts`, `calls.ts`) is NOT touched by this slice. Stale anchors
in v2: fact 4 (corrected by the V2-S1 log), `BUILTIN_BRAND_TABLE` moved to
`builtin-brands.ts` (#4176), `property-access.ts` is now 5,835 lines,
`__extern_get` starts at `object-runtime.ts:1895`.

### What landed

- `context/types.ts` + `create-context.ts` — new pre-scan flag `protoMemberDirty`.
- `array-holes.ts` — `isProtoMemberValueUse`: a branded `<Builtin>.prototype` in
  VALUE position, or any `Object/Reflect.getPrototypeOf(…)` call. Excludes the
  `defineProperty(X.prototype, …)` write-target position (already covered by
  `protoNamedDirty`). Never sets `protoIndexDirty`, so the HOF hole visit-skip
  and typed element lanes keep their fast paths.
- `native-proto.ts` — `ensureNativeProtoCompanionSeeder(ctx, brand)` emits
  `__nativeproto_seed_<brand>(companion)`, installing each glue CSV member as a
  §17 data property (`__defineProperty_value`, flags `0xBD`) holding the **#2963
  singleton**, so the runtime-read value keeps identity with the syntactic
  surfaces. Doubly demand-gated: `protoMemberDirty` AND that brand's proto
  actually materializing.
- `object-runtime.ts` (1 line + import) — `flushPendingNativeProtoSeeders` at the
  END of `ensureObjectRuntime`.
- `proto-index-store.ts` — reserve gate accepts `protoMemberDirty`;
  `fillCompanionBody` gains (a) a seed dispatch on companion mint and (b) a
  force-`create` arm for seeded offsets.

### Two defects the work surfaced, both found by measurement

1. **Ordering.** A proto can materialize BEFORE `__defineProperty_value` exists.
   Traced: RegExp (brand offset 1) did; `Array` (offset 2) did not. Building the
   seeder eagerly silently skipped RegExp — reintroducing the exact defect for a
   subset of brands. Fixed by parking the brand and flushing at the end of
   `ensureObjectRuntime` — still ordinary body-compilation time, so no minting or
   type registration happens at finalize.
2. **`create=0` on the read probes.** Both `__protoidx_get_k`/`has_k` probe with
   `create=0` — right for #4176 (a companion exists only once written), wrong for
   a seeded brand whose members are waiting. `"exec" in q` answered 0 while
   `q.exec` answered a function. Fixed by forcing `create=1` for exactly the
   seeded offsets, so GET and `in` agree by construction.

### Accessors are deliberately NOT seeded (recorded regression + a corrected claim)

Seeding getters as accessor entries flips `tests/issue-2885.test.ts` "plain read
`RegExp.prototype.global` is undefined (Site 3 invokes the getter)" from pass to
FAIL. That test passes on unmodified main, so it is a genuine regression.
§22.2.6 requires the legacy accessor read with
`SameValue(this, %RegExp.prototype%)` to answer `undefined`.

**Correction, recorded deliberately.** My first write-up of this — in an earlier
revision of this section and of the in-code comment — asserted the cause was
"`__extern_get`'s accessor branch invokes `$get` with the original receiver,
defeating the identity arm". **That is not established, and the probe I based it
on measured the wrong path** (a plain-JS `RegExp.prototype.global`, which takes
the syntactic getter arm, not the dynamic one). Re-measured properly, with
accessor seeding ON:

- `const g: any = (RegExp.prototype as any).global; g === undefined` → **true**
  (correct);
- the INLINE form the test uses, `(RegExp.prototype as any).global === undefined`
  → **false**.

So the divergence is between the INLINE and MATERIALIZED read paths — the same
class of defect as the #2984 path-dependent `typeof` that V2-S1 fixed — and the
mechanism is **unidentified**. Whoever takes the accessor tier should start from
that inline/bound split, not from a receiver-binding theory.

Gate for the accessor tier: the four
`%TypedArray%.prototype.{buffer,byteLength,byteOffset,length}/prop-desc.js`
files, which fail identically before and after this slice.

### Measured result

| | before (HEAD 9e17d34f3) | after |
|---|---|---|
| `built-ins/TypedArray/**` reflection (121 files) | 0 pass | **96 pass** |
| remaining 138 row-3 files | 0 pass | 0 pass (unchanged — they exercise the SYNTACTIC surface, not the flowing one) |
| `scripts/prove-emit-identity.mjs` (60 file x target) | — | **IDENTICAL, all 60** |

Row 3 net: **259 → 163**. Zero lost anywhere.

Regression sweep (isolated runs; batched runs add load flakes):
`issue-2885`, `issue-2861` (+5 glue files), `issue-2896`, `issue-2963` x2,
`issue-2175-{native-proto-brands,typeof-function-arm,v2s2-singleton-identity}`,
`issue-4159`, `issue-4160` x2, `issue-4161`, `issue-4120`, `issue-2734`,
`issue-2580-m3-protochain` — all green. Pre-existing failures confirmed by
A/B against the unmodified base, NOT caused here: 3 getter-dispatch tests in
`issue-2175-regexp-proto-readers.test.ts` (3/12 on base and on branch), the
`issue-4176` "prepared IR for-in" case (1 failed / 12 passed on base), and all 5
host-lane `issue-2580-m3-protoextend` tests (5 failed / 5 on base).
Enumeration checked separately: seeded members are non-enumerable, so for-in over
`{a,b}` still yields 2 keys and over `[1,2,3]` still yields 3.

New test: `tests/issue-2175-v2s3b-proto-companion-seed.test.ts` (7/7), each
positive assertion paired with a negative that must stay 0 on the same binary.

### Remaining 25 of the 121, by owner

- **14** — statics on the `%TypedArray%` CTOR object (`of` / `from` /
  `Symbol.species` / `name` / `length`): the #2901 carrier owns only
  `prototype`. This is v2 **C1-ctor / V2-S4**.
- **5** — `Symbol.*` proto members: symbol keys deliberately do not participate
  in the store's key normalizer. **V2-S5**.
- **4** — accessor `prop-desc.js` (`buffer`/`byteLength`/`byteOffset`/`length`):
  the accessor tier above.
- **1** — `%TypedArray%.prototype.slice.length` should be 2; a
  `TYPED_ARRAY_PROTO_METHOD_LENGTH` table entry.
- **1** — `Symbol.toStringTag/invoked-as-func.js` null-pointer in `__module_init`.

---

## P1/P2 triage — builtin-prototype `defineProperty` (claude/es6-team-reflection)

Two defects handed to this lane as "P1 setter-never-fires on `Array.prototype`"
and "P2 no-own-property on `Date.prototype`". Both isolated by differential
probe; **no code written** (the fix sites spread past the two natives I could
measure in-window — see "Why banked" below). Probes `.tmp/p1.js`–`.tmp/p5.js`,
runnable via `npx tsx .tmp/p.ts --file <probe>`.

### P1 — an inherited ACCESSOR on a builtin prototype is ignored by [[Set]]

`Object.defineProperty(Array.prototype, "acc", {get, set})`, then on an array
instance (`.tmp/p4.js`):

| step | expected | actual |
|---|---|---|
| `arr.acc` (read, before write) | 42, getter runs | **42, getter runs** OK |
| `arr.acc = 7` | inherited SETTER runs, no own prop created | **setter never runs** |
| `arr.acc` (read, after write) | 42 (still the getter) | **not 42** |
| `hasOwnProperty(arr, "acc")` | false | **true** |

So the write creates an **own data property on the receiver**, shadowing the
inherited accessor — §9.1.9 OrdinarySetWithOwnDescriptor step 3 (an inherited
accessor's `[[Set]]` must be invoked, and no own property created) is not
applied for companion-held accessors. The READ side is already correct
(`.tmp/p3.js`: both the #4176 data path and the accessor getter work on an
instance receiver), so this is purely `__extern_set`'s chain behaviour: its
`$NativeProto` write arm covers "the receiver IS the proto"
(`Array.prototype.foo = 1`), not "the receiver INHERITS an accessor from a
brand companion".

### P2 — companion entries are invisible to the OWN-property views

`Object.defineProperty(Date.prototype, "p2", {value: 99})` (`.tmp/p5.js`):

| view | result |
|---|---|
| `Date.prototype.p2` (syntactic read) | 99 OK |
| `dp.p2` (flowing `$NativeProto`) | 99 OK |
| `"p2" in dp` | true OK |
| `hasOwnProperty(dp, "p2")` | **false** |
| `gOPD(dp, "p2")` / `gOPD(Date.prototype, "p2")` | **undefined** |

Brand-independent (`Object.prototype` behaves identically) and receiver-form
independent. This matches #4176's own documented consult list exactly: it wires
`__extern_get` / `__extern_has` (plus the vec/closure/closed-struct miss tails),
and does **not** wire `__hasOwnProperty` or `__getOwnPropertyDescriptor`.

**This CORRECTS my S3b-2 finding above.** That section says the consult tier
"has no work left in it", measured on `%TypedArray%.prototype.find`. That
measurement was only valid for **seeded** members, which gOPD answers through a
different mechanism (#2885 synthesis / builtin-fn meta) — not through the
companion. For entries **written** by `defineProperty`, the own-property views
genuinely do need the consult. S3b-2 is therefore NOT complete; its remaining
work is exactly P2.

### Scope

Regex-scoped against the standalone baseline (`.tmp/p1p2-scope.ts`), counting
only currently non-passing files: **P2 ≈ 125 candidates**
(`Object.defineProperty(<Builtin>.prototype, …)`), **P1 ≈ 11**
(descriptor with a `set:` on a prototype). These are candidates by source
shape, not confirmed yields — the fix must be measured against them before any
claim, per the repeated lesson in this issue.

### Why banked rather than implemented

P2's fix is an own-layer companion probe
(`ref.test $NativeProto` → `__protoidx_brand_off` → `__protoidx_companion(off, 0)`
→ `__obj_find`, own-only, no chain walk) added to the own-property views.
`__hasOwnProperty` is a contained single site (`object-runtime.ts`,
`emitHasOwn`), but `__getOwnPropertyDescriptor` is spread across several modules
(`builtin-static-gopd.ts`, `carrier-bag-visibility.ts`, `class-proto-object.ts`,
`dyn-read.ts`, …), so the change could not be implemented AND measured against
the 125 within the remaining window. Landing the `hasOwnProperty` half alone
would ship a half-consistent MOP (`hasOwnProperty` true, `gOPD` undefined) —
worse than the current uniformly-false state.

P1 is a separate site (`__extern_set`'s chain walk) and a separate slice.

Before writing S3b-2 I measured its premise, and the premise is false: with
S3b-1 in place, `__getOwnPropertyDescriptor` / `__getOwnPropertyNames` /
`__hasOwnProperty` on a **flowing `$NativeProto`** already work. Probe
(`.tmp/s13.js` / `.tmp/s14.js`), `%TypedArray%.prototype` bound through the
harness idiom:

```
gOPD(p, "find")            → a descriptor (not undefined)
  .value                   → a function
  .writable                → true
  .enumerable              → false
  .configurable            → true      // §17, exactly right
getOwnPropertyNames(p)     → non-empty
hasOwnProperty.call(p,"find") → true
gOPD(p, "nope")            → undefined  // negative control holds
```

They work because those natives share the same receiver-aware companion consult
that S3b-1 populated — no separate arms were needed. **So S3b-2 as scoped in the
v2 plan has no work left in it**; its only remaining item is the accessor tier,
which is blocked as recorded above.

One anomaly worth a follow-up, not chased here: in a single function that calls
`gOPD` twice, the conjunction `d !== undefined && typeof d.value === "function"`
read false for the first descriptor while an identical single-`gOPD` function
read true. That is consistent with the double-gOPD limitation the V2-S3a log
already banked ("`gOPD(p,"exec").value === gOPD(p,"exec").value` throws from a
SEPARATE gOPD engine body"). Not investigated further.

---

## S3b-3 triage (same lane, same session) — it is TWO defects, not one, and my
## "~32 files, ctor carrier owns only `prototype`" framing was wrong

I triaged before writing code, and the premise I reported for S3b-3 does not
survive measurement. The ctor carriers are **not** simply missing own
properties. Probes `.tmp/s17.ts`–`.tmp/s22.ts` (all `--target standalone`,
host-free):

**Defect A — `delete` and `gOPD` disagree on a builtin ctor's own props.**
This is what the 18 `built-ins/TypedArrayConstructors/<View>/{length,name}.js`
files actually fail on: `verifyProperty` proves configurability by DELETING the
property and confirming it is gone (hence the error text "length descriptor
should be configurable", which is not about the descriptor's shape at all — the
shape is already correct). Measured on `Int8Array`:

```
gOPD(C,"length")  → {value: 3, writable: false, enumerable: false, configurable: true}   // correct
gOPD(C,"name")    → {value: "Int8Array", …, configurable: true}                          // correct
delete C.length   → true
"length" in C     → false          // the delete IS observed here
gOPD(C,"length")  → STILL a descriptor   // …but NOT here
```

The ctor's own props are answered by **synthetic meta arms**
(`__builtinfn_get_meta` + the `$__ta_ctor` splice in `ta-ctor-meta.ts`, and
`builtin-static-gopd.ts`), which have no notion of deletion, so no amount of
"populating a table" fixes it while those arms still answer. Making delete/gOPD
coherent means backing the ctor VALUE with a real own-property `$Object`
instead of a `$__ta_ctor` struct + synthetic meta — which is exactly v2 **D7**,
and v2 explicitly warns: *"Do NOT flip all names in one PR — each name changes
the bare-identifier read path and needs its own regression sweep."*
**I am treating this as the architectural boundary for this lane** rather than
starting a carrier-representation change I cannot finish and validate in this
window.

**Defect B — the property-access `.length` read on a TypedArray ctor answers 0.**
Independent, much narrower, and NOT a descriptor problem:

```
C.length      → 0      // property-access form            WRONG (§23.2.5.1 says 3)
C["length"]   → 3      // element-access form             correct
gOPD(C,"length").value → 3                                correct
RegExp.length → 2  ·  Map.length → 0                      correct (not TA-specific carriers)
```

So it is specific to the **property-access `.length` lowering** reaching a
different arm than the generic path, only for `$__ta_ctor` receivers. Reproduces
both with and without vec types registered in the module, so it is NOT the
`dyn-read.ts` vec/undefined-guard chain (that chain only exists when
`vecEntries.length > 0`). This is ~9 of the 18 files.

**Defect C (incidental, recorded).** `typeof Int8Array === "function"` is
**false** in standalone — the #4120 branded-carrier `typeof` arm does not cover
`$__ta_ctor`. Relevant to the `not-a-constructor.js` / `invoked-as-func.js`
shapes, which start by asserting the value is a function.

## S3b-3 B+C — LANDED, and they flip ZERO test262 files. Read the scope note.

Implemented the two bounded defects. Both are real, both are pinned by unit
tests, and **neither flips a single file in the #4444 row-3 bucket today** — I
measured the target sets before and after and they are unchanged at 0 pass. They
are PREREQUISITES for defect A's files, not the fix for them.

**C — `typeof <TypedArray ctor>` was `"object"`.** #4120 fixed this class for
`Set`/`Map`/`TypeError`/… by branding `OBJ_FLAG_CALLABLE` into `$Object.flags`,
but a reified view constructor is its own `$__ta_ctor` struct
(`registry/types.ts`), which cannot carry that flag and so fell through to
`"object"` — the same silent wrong answer, for the eleven view ctors. Fixed by
adding a `ref.test $__ta_ctor` arm inside `buildBuiltinBrandTestArm`
(`builtin-callable-brand.ts`), the ONE predicate all three `typeof` natives and
`__reflect_is_constructor` share, so they stay in lockstep. The arm is emitted
independently of `brandedContexts`/the `$Object` runtime (a program whose only
reified builtin is `Int8Array` brands no `$Object` at all), and
`fillStandaloneTypeofClosureArms`' early-return gate was widened to match.

**B — `Int8Array.length` read `0`.** `emitStandaloneAnyLength`
(`property-access-dispatch.ts`) gated its `__builtinfn_get_meta` consult on the
receiver passing `ref.test <closureRoot>`. `ta-ctor-meta.ts` already splices a
`$__ta_ctor` arm into that native returning 3 (§23.2.5.1), but the gate made it
unreachable, so the read fell to `__extern_length` → 0. Fixed by asking the meta
native FIRST for any receiver, with the previous behaviour preserved exactly on
the miss path (closure ⇒ 0, else `__extern_length`).

Two things I got wrong mid-slice and corrected:
- A `ref.test $__ta_ctor` arm here would have been unreliable: this runs during
  BODY compilation and `$__ta_ctor` is registered lazily, so `ctx.taCtorTypeIdx`
  can be unset even for a program that reifies one — the same ordering trap that
  made the V2-S3b-1 seeder skip RegExp. Asking the meta native has no such
  dependency.
- The first cut only fired when the module had a closure root, so a closure-free
  program still read 0. The import ensure now also fires when `$__ta_ctor` is
  registered. There is a unit test for exactly this.

### Evidence

| | before (`9e17d34f3`) | after |
|---|---|---|
| `typeof Int8Array` (via `any`) | `"object"` | `"function"` |
| `Int8Array.length` (property access) | `0` | `3` |
| `Int8Array["length"]` / `gOPD(...).value` | `3` | `3` (unchanged) |
| `RegExp.length` 2 · `Map.length` 0 · `[1,2,3].length` 3 | correct | correct |
| 20 `TypedArrayConstructors/**` reflection files | 0 pass | **0 pass** |
| 25 `built-ins/TypedArray/**` residuals | 0 pass | **0 pass** |
| `prove-emit-identity` 60 (file,target) | — | IDENTICAL |

The 20 `TypedArrayConstructors` files fail on `verifyProperty`'s configurability
step (delete-then-recheck), i.e. **defect A**, and are unaffected by B or C. When
A lands, `length.js` will still need B's value — that is the whole reason to keep
these.

Regression: `issue-4120`, `issue-2580-any-length`, `issue-2896`,
`issue-2963-builtin-reification`, `issue-2861-ctor-length-name-value-read`,
`issue-2580-m3-protochain`, `issue-2885`, `issue-2175-v2s3b-proto-companion-seed`
— all green. New test `tests/issue-2175-s3b3-ta-ctor-value-meta.test.ts` (6/6).

**A third comment-sourced claim that failed measurement** (logging the pattern):
my anti-vacuity case asserted a plain closure's `.length` is 0, quoting the "flat
0" wording in `emitStandaloneAnyLength`'s #2580 comment. It is **1** — correct
per §20.2.4.1 — on base AND branch. The comment describes the fallback emitted
when no metadata is available, not what an arrow function reads. Test now
asserts the measured value.

### Revised slice plan (supersedes v2's V2-S3 for the GET path)

- **S3b-1** — DONE.
- **S3b-2** — consult tier: **no work required** (measured). Accessor tier:
  **blocked** on the inline-vs-materialized divergence, mechanism unidentified.
- **S3b-3 B+C** — DONE (above), 0 files flipped, prerequisites for A.
- **S3b-3 A** — split out to its own issue (D7 ctor-value-as-real-`$Object`).
  Original split rationale:
  - **B + C are the cheap half** (~9-11 files): route the property-access
    `.length` read and the `typeof` arm to recognise `$__ta_ctor`. Bounded, and
    `RegExp`/`Map` already prove the generic path is right.
  - **A is the architectural half** (~9 files, plus the 14 `%TypedArray%`-ctor
    statics): needs the D7 carrier change, which v2 says to do one ctor name at
    a time with its own regression sweep. Should be its own issue, not a slice
    of this one.
- V2-S5 (symbols / instance chain), S6, S7 unchanged.

---

## Implementation Plan — P2: own-property views consult the NativeProto companion (fable, 2026-08-15)

Implements the P2 defect banked in "P1/P2 triage" above (~L1559). P1 (inherited
accessor `[[Set]]`) is explicitly OUT of this slice — separate site, separate
plan. Scope base: **P2 ≈ 125 candidates** (`.tmp/p1p2-scope.ts`, regex-scoped
against the standalone baseline, 2026-08-15 — candidates by source shape, not
confirmed yields).

### Mechanism (from the triage, confirmed against source)

Entries written by `Object.defineProperty(<Builtin>.prototype, k, d)` live in
the brand companion and are visible to `__extern_get`/`__extern_has` (#4176)
but not to the own-property views. Add the same own-layer probe the read path
uses — `ref.test $NativeProto` → `__protoidx_brand_off` →
`__protoidx_companion(off, 0)` → `__obj_find` (own-only, **no chain walk**) —
to both own-property views:

1. **`__hasOwnProperty` / `__object_hasOwn`** — single site: `emitHasOwn`,
   `src/codegen/object-runtime.ts` ~L3442 (both names registered at ~L3485-86).
   Insert the companion probe after the existing miss arms, before the final
   false.
2. **`__getOwnPropertyDescriptor`** — the dispatch is spread
   (`builtin-static-gopd.ts` — `tryEmitStandaloneBuiltinStaticGopd` L282,
   `tryEmitStandaloneStructGopdKeyDispatch` L552; `carrier-bag-visibility.ts` —
   `buildBagGopdFallback` L225; `class-proto-object.ts`; `dyn-read.ts`). Do
   NOT patch every module. First run the `.tmp/p5.js` differential under a
   trace to find **which arm answers `gOPD(dp, "p2")` → undefined today** (dp
   = flowing `Date.prototype`), and insert the companion probe immediately
   before that undefined arm. Expected single funnel: the dynamic-receiver
   fallback (`buildBagGopdFallback` or the dyn-read miss tail) — verify, do
   not assume. If syntactic `gOPD(Date.prototype, "p2")` routes through a
   second arm (`tryEmitStandaloneBuiltinStaticGopd`), that arm gets the same
   probe — two insertions max; more than two means the funnel hypothesis is
   wrong, stop and record.

### Descriptor synthesis (the part reads don't need)

`__obj_find` yields the value; the descriptor also needs
writable/enumerable/configurable. `defineProperty`'s companion write path
stores flags — locate where the companion entry's flags live (same store the
`"p2" in dp` path ignores) and surface them. If flags are genuinely not stored
(write path discards the descriptor), record that as a measured finding and
synthesize `{writable:false, enumerable:false, configurable:false}` ONLY if
probing real `defineProperty` defaults confirms the stored entries are always
default-flag; otherwise the flag store is a prerequisite and this plan stops
at `hasOwnProperty` + a recorded blocker — do NOT ship guessed flags.

### Order/consistency constraint (lane's own, kept)

Both views land in ONE boundary. `hasOwnProperty`=true + `gOPD`=undefined is a
half-consistent MOP, worse than uniformly false. If gOPD turns out blocked on
the flag store, hasOwnProperty does NOT land alone either.

### RESULT (claude/es6-team-reflection) — implemented, every acceptance criterion
### met, and it flips ZERO test262 files. Keep/revert is a judgement call.

**Prerequisite resolved first, as the plan required.** Flags ARE stored: the
#4176 write arm for `__defineProperty_value` passes the caller's flag word
straight through to the companion's own `__defineProperty_value` call
(`proto-index-store.ts` `spliceInto("__defineProperty_value", …)`, `local.get 3`),
which runs the full normal flag translation into `$PropEntry.$flags`. Nothing
had to be guessed, so the plan's "do NOT ship guessed flags" branch never
applied.

**That turned the design into receiver SUBSTITUTION rather than a bespoke
probe.** New `protoIndexOwnViewSubstituteInstrs` replaces a `$NativeProto`
receiver with its brand companion `$Object`; each view's existing `$Object` path
then runs unchanged and builds the descriptor from the real stored entry.
Own-layer only: `create = 0`, no chain walk, non-`$NativeProto` receivers
untouched.

**Two insertion sites, as the plan predicted — the funnel hypothesis held.**
The differential trace found `__getOwnPropertyDescriptor` is a SINGLE native
(`object-runtime-descriptors.ts`); a `$NativeProto` fails its `ref.test $Object`
and falls into the non-object arm that answers `undefined`. Sites: `emitHasOwn`
(`object-runtime.ts`, covers `__hasOwnProperty` + `__object_hasOwn`) and that
gOPD native. No third site was needed.

**Acceptance — all met:**
- `.tmp/p5.js`: five views agree, both brands (`Date`/`Object`), both receiver
  forms (syntactic + flowing). 123 → 345.
- `.tmp/p6.js` (3725): flags round-trip — absent attributes read
  `{writable:false, enumerable:false, configurable:false}`, explicit
  `{writable:true, enumerable:true, configurable:true}` reads back true. A
  synthesized descriptor could not tell these apart.
- Negative controls on the same binary: absent key → `undefined`; inherited
  `toString` on a plain object still NOT own; own key still own; a brand never
  written to (`Map.prototype`) unaffected.
- `prove-emit-identity`: **IDENTICAL, all 60**. The scratch local is appended
  only when the arm emits — appending it unconditionally drifted 6 of 60, which
  is why it is conditional.
- Regressions: `issue-2175-v2s3b`, `issue-2175-s3b3`, `issue-2885`,
  `issue-4160-proto-index-store`, `issue-4447-forof-dstr-standalone`,
  `issue-2175-{native-proto-brands,typeof-function-arm,v2s2}` all green. The
  `issue-4176` IR for-in case and the 3 `issue-2175-regexp-proto-readers`
  getter-dispatch cases fail identically on base (verified earlier this session).
- New test `tests/issue-2175-p2-own-view-companion.test.ts` (4/4).

**Measurement — 0 flips.** The 125-candidate list: `pass=0 fail=121 ce=4`. A
refined set (tests that BOTH `defineProperty` a builtin proto AND use an
own-property view — 38 files): `pass=0 fail=34 ce=4`. Sampled failures are
unrelated semantics (Array holes, `some`/`lastIndexOf`, frozen-length). **My
regex scope was a poor proxy for what exercises these views** — that is a
scoping finding, not a correctness one.

**Recommendation (coordinator's call, not banked as a win):** KEEP. Unlike the
#4492 candidacy widening I reverted, this is byte-identical for every module
that does not write a builtin prototype, is unit-tested, closes a real spec gap,
and satisfies the plan's own "one boundary" constraint — both views land
together, so the MOP is never half-consistent. But it buys no conformance
movement today, so if the bar is "must move the number", revert it.

### FOLLOW-UP FIX — the first cut shipped INVALID WASM. Gate-design lesson.

The P2 commit above (`41bbeed43`) failed to instantiate for a real shape:

```
CompileError: Compiling function #156:"__hasOwnProperty" failed: Invalid types
for ref.test: any.convert_extern of type anyref has to be in the same reference
type hierarchy as (ref 59)
```

Repro `.tmp/p4.js` — `Object.defineProperty(Array.prototype, "acc", {get, set})`
on an array instance. Isolated by A/B: pre-P2 `3e69b1e34` runs it (`203`); with
P2 it is a CompileError. Never reached the queue — it existed only in this
worktree.

**Root cause:** `protoIndexOwnViewSubstituteInstrs` baked
`ctx.nativeProtoTypeIdx` into a `ref.test` at object-runtime REGISTRATION time.
A later type registration shifts indices
(`project_type_index_shift_and_deadelim`), so the baked `(ref 59)` ended up
naming a type outside the `any` hierarchy. **Every other arm in
`proto-index-store.ts` resolves that index at FINALIZE** (`fillBrandOffBody`);
these two sites were the only ones that did not.

**Fix:** the substitution is now a reserved helper `__protoidx_own_recv`
(`recv -> recv'`) whose stub RETURNS ITS ARGUMENT (an exact no-op) and whose
real body is written by `fillOwnRecvBody` at finalize. The call sites emit a
`call` and bake no type index at all — structurally identical to the module's
other arms, so the split cannot be reintroduced. The scratch locals are gone
(the helper owns them), which also simplifies the conditional-emission story.

**GATE-DESIGN LESSON — descriptor KIND is a mandatory axis.** Every P2 probe and
all four original tests used **value** descriptors. The battery covered receiver
form (syntactic vs flowing), brand (`Date` vs `Object`), and presence (absent
key, inherited key, unwritten brand) — and still missed an entire arm of the
feature, because **descriptor kind (value vs accessor) was never varied**. So
"all acceptance criteria met" was true of the criteria as written; the criteria
were incomplete. For any companion-consult work the gate battery must vary at
least: **descriptor kind × receiver form × brand**, with both kinds exercised on
ONE binary. `tests/issue-2175-p2-own-view-companion.test.ts` now carries that row
as a permanent regression guard naming the CompileError.

### Acceptance

- `.tmp/p5.js` probe: all five views agree (`hasOwnProperty(dp,"p2")` true,
  `gOPD(dp,"p2")` → `{value:99, writable:false, enumerable:false,
  configurable:false}` per defineProperty defaults, both receiver forms).
- Negative controls on the same binary: `gOPD(dp,"nope")` undefined;
  `hasOwnProperty(dp,"toString")` on a PLAIN object still false for inherited;
  seeded members (`gOPD(p,"find")` from S3b-2 correction) unchanged.
- Measure against the 125-candidate list, scoped standalone run; report
  flips with provenance. No regression in `tests/issue-2175-*.test.ts`,
  `tests/issue-4447-mg-regressions.test.ts`.

---

## Implementation Plan — P1 (fable, dictated 2026-08-15) — SUPERSEDED BY #4504

> **SUPERSEDED — see `plan/issues/4504-extern-set-inherited-accessor-chain-walk.md`.**
> The baseline check at the end of this section disproved the plan's premise: the
> defect is NOT companion-specific. `[[Set]]` skips inherited accessors on plain
> prototype chains too, by a deliberate #1888 S5b deferral. #4504 owns the
> general §9.1.9 proto-chain accessor walk; this companion case is one arm of it.
> Text kept below as the record of how that was found.

Implements the P1 defect banked in "P1/P2 triage" above: §9.1.9
OrdinarySetWithOwnDescriptor step 3 — `arr.acc = 7`, where `Array.prototype`
holds a companion ACCESSOR, must invoke that setter and create **no** own
property. Today it silently shadows: the setter never runs, an own data
property appears on the receiver, and the next read stops returning the getter's
value (`.tmp/p4.js`, measured).

Scope base: ~11 P1 candidates (`.tmp/p1-cands.json`, regex-scoped — candidates
by source shape, not confirmed yields).

### 1. Localize by TRACE, not assumption

The triage names `__extern_set`'s chain behaviour, but P2 taught this lane that
the arm that actually answers can differ from the one the mechanism suggests
(there the gOPD funnel was a single native, not the five modules the grep
implied). So: compile `.tmp/p4.js`, instrument, and find the arm that performs
the own-property CREATE on the set-miss path before writing any fix.

### 2. Fix shape

Before creating an own property on a set-miss, walk the receiver's prototype
chain's companion entries for an accessor **with a setter**; if found, invoke it
with the original receiver and create nothing. The P2 receiver-substitution
trick likely reuses here — substitute the proto's companion and let the existing
accessor-set path fire.

**Critical negative control:** an inherited **data** property must NOT divert.
Assigning over one still creates an own property on the receiver (§9.1.9 step
3.b). Only accessors divert.

### 3. Gates

- `prove-emit-identity` all 60, via conditional emission (the P2 pattern: the
  scratch local is added only when the arm emits).
- `.tmp/p4.js` flips: setter runs, no own property created, re-read yields the
  getter's value.
- Negative controls on ONE binary: inherited data property still shadows; an
  OWN accessor still works; a plain-object inherited accessor unchanged —
  **verify the plain-object case on base first** (one probe) so an
  already-working path is not credited to this change.
- Scoped run of the ~11 P1 candidates + `tests/issue-2175-*.test.ts` +
  `tests/issue-4447-forof-dstr-standalone.test.ts`.

### 4. Boundary

One boundary; keep/revert recommendation with the flip count stated plainly.
**0 flips is an acceptable outcome if the gates hold** — the substrate value is
the point (this unblocks #4491 step 3, #4490). No git mutations; stop and report
at the boundary or on any surprise.

### STOPPED AT STEP 3's BASELINE CHECK — the plan's premise is false. No code written.

The plan says the plain-object inherited-accessor path "presumably already
works — verify base first, one probe". **It does not work**, and that changes
what P1 is.

`.tmp/q1.js`, a plain prototype chain with NO builtin proto and NO companion
anywhere — `var proto = {}; defineProperty(proto,"acc",{get,set}); var o =
Object.create(proto); o.acc = 7`:

| assertion | result |
| --- | --- |
| setter runs | **no** |
| no own property created on `o` | **an own property IS created** |
| `o.acc` re-reads as 42 (the getter) | **no** |
| inherited DATA control: `o2.d = 5` creates an own prop, proto unchanged | yes OK |

Verified identical on the pre-P2 commit `3e69b1e34` (both 700), so this is
pre-existing and nothing to do with P2.

**The source states it explicitly.** `__extern_set` (`object-runtime.ts` ~L2846,
the #1888 S5b accessor write gate):

> "Inherited-accessor set (proto-chain) is out of scope for this slice;
> `__obj_find` walks only the own table."

So `[[Set]]` handles **own** accessors only, by design, and the inherited case
was deliberately deferred. The companion accessor that P1 describes is one
special case of that general gap — not a companion-specific defect.

**Why this must not be fixed as scoped.** Diverting only the *companion* case
would make `Array.prototype`'s accessor fire while a plain prototype's accessor
still silently shadows — a half-consistent `[[Set]]`, the same failure mode the
"one boundary" rule exists to prevent (and the reason P2 landed both own-views
together).

**Correct sequencing (recommended):** implement §9.1.9's prototype-chain
accessor walk in `__extern_set` generally — find the first proto-chain entry for
the key; if it is an accessor, invoke its setter with the original receiver and
create nothing; if it is a data property (or absent), fall through to today's
own-property create. P1's companion case is then ONE arm of that walk (the
receiver-substitution trick from P2 supplies it), and both land coherently. That
is a larger, spec-semantics slice than P1-as-written and should be re-planned
and re-scoped as such — the ~11 P1 candidates are a lower bound on its value,
since the general defect affects every inherited accessor, not just builtin
prototypes.

---

## 2026-08-20 — mutable seeded data methods after honest descriptor reification

PR #4658's merge-group run exposed 264 previously vacuous `propertyHelper.js`
passes after #4491 made attribute-only descriptor bags readable. The largest
real defect underneath them was not descriptor creation: `gOPD` already
reported the correct flags. It was the immutable builtin-prototype shortcuts:

- assignment updated the seeded companion entry, but flowing reads still
  returned the original singleton closure;
- deletion removed the companion entry, but the CSV `hasOwnProperty` shortcut
  still reported the method as present.

The bounded repair makes the seeded companion authoritative for data-method
reads and own-presence checks. It deliberately excludes accessors (not seeded)
and `constructor` (a separate carrier). An authentic replay recovered 221 of
222 direct `verifyProperty` data-method regressions; the one unmeasured direct
row needs the local QuickJS provider. The separate primordial-property row also
passes. Representative Array, Date, TypedArray, Set, String, and Annex B rows
all pass without narrowing descriptor reification again.

### Recorded residual implementation plan

Two related surfaces remain outside this bounded repair and must be kept as
explicit follow-up work rather than hidden by another vacuity shortcut:

1. Make syntactic `<Builtin>.prototype.<method>` reads consult the seeded
   companion before returning their static singleton whenever the module can
   mutate that method. Keep identity-fast output byte-stable for modules with no
   prototype mutation, and pin assignment, restoration, deletion, and
   inheritance from `Object.prototype`.
2. Make `propertyIsEnumerable` use the companion's real entry for seeded data
   methods. The current CSV arm always returns false, so delete-and-recreate with
   `{ enumerable: true }` disagrees with `gOPD`. Pin both true and false flags,
   deletion, and a same-named inherited entry to preserve own-only semantics.

Both follow-ups must use the existing finalize-filled companion helpers; do not
bake `$NativeProto` type indices early, and do not route own-property checks
through `__protoidx_has_r`, which intentionally walks on to `Object.prototype`.

## Progress — 2026-08-21: %Function.prototype% branded as a Function object

Two ES5 standalone rows for the `%Function.prototype%` intrinsic, measured with
the serial single-test probe on `claude/pull-from-upstream-zgdo0m`:

| test262 file (standalone)                          | before | after |
| -------------------------------------------------- | ------ | ----- |
| `built-ins/Function/prototype/S15.3.4_A1.js`       | fail (`[object Object]`) | pass |
| `built-ins/Function/prototype/S15.3.4_A3_T1.js`    | fail (`null`)            | pass |

Root cause was two independent holes in the intrinsic's object identity, not in
its callability (`function-prototype-callable.ts` already mints a real
`[[Call]]` entry):

1. **Brand.** `resolveObjectToStringTag` routed every `X.prototype` receiver to
   the §20.1.3.6 step-13 `Object` default unless the builtin appeared in
   `NATIVE_PROTO_BRAND_TAGS` (Number/String/Boolean/Array). `Function.prototype`
   IS a built-in *function* object (§20.2.3), so step 6 tags it `Function`.
   Added `["Function", "Function"]` to that table — which also lights the
   matching `$NativeProto` brand arm in the runtime classifier, so the stored
   `obj.getClass = Object.prototype.toString` idiom agrees with the fold.
2. **`$proto` link.** `Object.getPrototypeOf(Function.prototype)` answered
   `null` — the native `__getPrototypeOf` walk finds no `$proto` on the
   intrinsic. Worse than a miss: it made
   `getPrototypeOf(Function.prototype) === getPrototypeOf([1,2])` spuriously
   true. Added a narrow arm in `tryCompileEs5GetPrototypeOfEarly` that answers
   the identity-stable `Object.prototype` singleton this file already emits for
   `Math`/`JSON`.

The `getPrototypeOf` arm is deliberately `Function.prototype` **only**. Builtin
prototypes do not uniformly inherit from `%Object.prototype%`
(`Int8Array.prototype` → `%TypedArray%.prototype`, `TypeError.prototype` →
`Error.prototype`), and this hook runs *before* the typed-array / generator /
class arms, so a blanket branch here would preempt them with a wrong answer.

**Known residual, deliberately not fixed here:** `getPrototypeOf(Array.prototype)`
returns an object that is not `ref.eq`-identical to `Object.prototype`
(measured: `SameValue(«[object Object]», «[object Object]»)` fails). That is the
same class of defect for the other builtin prototypes and belongs with the
`$NativeProto` `$proto`-seeding work this issue tracks, not in a `getPrototypeOf`
special case.

Controls re-run before and after, identical results (6 `Object/prototype/toString`
rows + 3 `Object/getPrototypeOf` rows): 8 pass / 1 pre-existing fail
(`Object.prototype.toString.call-function.js`, unrelated — `Function()`
call-constructed function object, not the intrinsic prototype).

Gates: `check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet` all exit 0. `tsc --noEmit` clean on both touched files
(pre-existing TS2591 noise elsewhere).

**Validation debt:** scoped serial probes only — no vitest suite, no full
standalone ES5 run (a shared measurement run owns the box).

## Progress — 2026-08-21: `JSON.bind()` throws TypeError instead of hard-CE'ing

| test262 file (standalone)                              | before | after |
| ------------------------------------------------------ | ------ | ----- |
| `built-ins/Function/prototype/bind/15.3.4.5-2-7.js`    | compile_error (`'__get_builtin' … not supported in --target standalone`) | pass |

Traced the leak to `call-receiver-method.ts:4078` (the generic host-delegated
`Namespace.member()` path), not to the value-read module. A builtin namespace
object is not callable and does not own `bind`/`call`/`apply` — those live on
`%Function.prototype%`, which is not on a namespace's prototype chain (`Math`,
`JSON`, `Reflect`, `Atomics` inherit straight from `%Object.prototype%`). So the
call is a TypeError twice over, and refusing to compile turns a catchable
runtime error into a lost file.

New `tryEmitNonCallableNamespaceInvokerThrow` in
`src/codegen/function-prototype-callable.ts` (next to the `%Function.prototype%`
[[Call]] helper), dispatched from `compileBuiltinStaticCall` ahead of the
`Math.*` arm. Same reshape as the existing `%Function.prototype%` and Atomics
arms: degrade to the spec's TypeError rather than leak a host import.

Narrow on both axes, deliberately: only `bind`/`call`/`apply` (a blanket
"unknown namespace member throws" would preempt the `Math.<unknown>`
fallthrough that lets `Array.prototype.every.call(Math, …)` be rewritten as
`Math.every(…)`), and only the ambient binding (`isGlobalBuiltinIdentifier`),
so a local object named `JSON` keeps ordinary member-call semantics.

Controls, before/after identical: 8 sibling `bind/15.3.4.5-2-*` rows
(7 pass / 1 pre-existing fail `-2-6`); ad-hoc `Math.round` / `JSON.stringify` /
`Reflect.has` still pass; `Math.max.apply` / `f.bind(...)` fail identically
before and after (a pre-existing `illegal cast in __call_fn_method_3`,
unrelated).

Budget allowances granted above (`+15` file lines, `+12` function lines): the
tables, rationale and emit live in the subsystem module; only the ordered
dispatch arm remains in the god-file.

Gates: loc / func / coercion-sites / oracle-ratchet all exit 0; prettier and
biome clean; `tsc --noEmit` clean on both touched files.

**Validation debt:** scoped serial probes only.

## Progress — 2026-08-21: `<callable>.{call,bind}.length` reports the spec arity

| test262 file (standalone)                                | before | after |
| --------------------------------------------------------- | ------ | ----- |
| `built-ins/Function/prototype/call/S15.3.4.4_A2_T2.js`   | fail (`f.call.length` = 2, spec 1) | pass |

The receiver shape does NOT reach the `%Function.prototype%` glue table, which
is why the one-entry fix the triage suggested would have been a no-op — worth
recording, because the two paths disagreed and only one was wrong:

- `Function.prototype.call.length` → **1** (correct). Root is a reachable
  builtin, so `tryStandaloneBuiltinAndWasiMemberReads`' `<Builtin>.prototype
  .<member>` meta fold answers from the glue's `PROTO_METHOD_LENGTH`.
- `f.call.length` for a user closure `f` → **2** (wrong). Root is not a
  builtin, so the generic `<fn>.length` fold in
  `property-access-dispatch.ts::tryLengthAndNameReads` counts the LIB
  declaration's formals via `expectedArgumentCountOfSignature`.

Measured (`function f(a,b,c){}`, standalone), against §20.2.3:

| read              | before | spec | after |
| ----------------- | ------ | ---- | ----- |
| `f.call.length`   | 2      | 1    | 1     |
| `f.bind.length`   | 2      | 1    | 1     |
| `f.apply.length`  | 2      | 2    | 2     |
| `f.toString.length` | 0    | 0    | 0     |
| `f.length`        | 3      | 3    | 3     |

Two defects, both fixed:

1. **`expectedArgumentCountOfParams` counted the TypeScript `this`
   pseudo-parameter.** It is a type annotation, not a FormalParameter, so
   §15.1.5 never sees it. In `lib.es5.d.ts` a top-level `this:` parameter
   appears on exactly three signatures — `Function.prototype.{apply,call,bind}`
   — which is why the over-count by one was invisible everywhere else, and why
   `apply` (2 counted, 2 correct) hid it. `calls.ts`'s `countSpecLength` already
   skipped it; this is the same rule in the module that owns the count.

2. **Fixing (1) alone traded one wrong answer for another:** `lib.es5.d.ts`
   writes `apply(this, thisArg, argArray?)` with the second argument OPTIONAL,
   so §15.1.5's prefix walk stops there and answers 1 where §20.2.3.1 pins 2.
   That is the same "TS's param count can disagree with the runtime
   Function.length" divergence the fold's own comment records for
   `Array.prototype.toSorted`. `functionPrototypeMemberSpecLength`
   (function-prototype-callable.ts) states the four spec numbers and runs first,
   gated on the receiver being provably callable so a plain object owning a
   property named `call` keeps the ordinary path, and skipped for a
   `.bind(...)` result (whose length is `max(0, target.length - boundArgs)`).

Controls, 13 runnable rows before and after — identical except the target row:
5 `Function/prototype/call/*`, 3 `apply/*` (incl. `length.js` and `name.js`),
both `function/length-dflt.js` (the #4436 prefix-count rows), and
`Array/prototype/{map,filter}/length.js`. Two pre-existing fails
(`call/S15.3.4.4_A1_T1.js`, `apply/S15.3.4.3_A1_T1.js` — `typeof obj.call` on a
plain object reads `undefined`; a different, unfixed hole) are unchanged.

Budget allowance granted above (`+11` function lines).

Gates: loc / func / coercion-sites / oracle-ratchet all exit 0; prettier and
biome clean; `tsc --noEmit` clean on all three touched files.

**Validation debt:** scoped serial probes only. The `this`-skip in (1) is
spec-correct for user TypeScript that declares an explicit `this` parameter,
but that surface was reasoned about (no top-level `this:` in any other bundled
`lib.*.d.ts` method signature) rather than measured.
