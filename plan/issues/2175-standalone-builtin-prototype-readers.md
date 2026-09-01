---
id: 2175
title: "architect spec: standalone builtin-prototype object representation + native-method-closure dispatch"
status: in-progress
model: fable
fable_role: spec
sprint: current
created: 2026-06-16
updated: 2026-09-01
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
  # +6 lines: the generic class-expression evaluation route must emit the
  # shared unresolved computed-accessor-name effect at its actual runtime site.
  - src/codegen/expressions/new-super.ts
  # +2 net lines: singleton class-expression materialization owns the same
  # effect when it deliberately bypasses the generic expression route.
  - src/codegen/statements/variables.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/property-access-dispatch.ts
  # +15 lines: the guard clause routing a non-callable builtin namespace
  # receiving bind/call/apply to a catchable TypeError. The rationale, the
  # namespace/invoker tables and the emit all live in the subsystem module
  # (src/codegen/function-prototype-callable.ts); what remains here is the
  # dispatch arm itself, which has to sit in the ordered chain.
  - src/codegen/expressions/call-builtin-static.ts
  # +27 lines: bounded RegExp.prototype.exec closure body delegates to the
  # existing capture-array engine from the per-builtin glue site.
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  # +60 lines: the shared Object-prototype helper builder owns the explicit
  # null-prototype terminal and inherited GetMethod/Proxy behavior together.
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  # +19 lines: the ordered `in` operator route must distinguish the exact
  # Proxy trap result from an ordinary terminal prototype-chain miss.
  - src/codegen/binary-ops-in.ts::compileInOperator
  # +2 net lines: singleton class-expression materialization owns its runtime
  # computed-name effect when it bypasses compileClassExpression.
  - src/codegen/statements/variables.ts::compileVariableStatement
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

## Suspended Work — builtin-prototype readers (2026-08-22)

Merged via #4723: `arguments` inside `new F(…)` (the __extras_argv/__argc
protocol at the ctor call site, `fnctor-ctor-arguments.ts`) and instanceof
boolean branding. Wave-5 T9 later seeded `constructor` into the builtin-proto
companion — which turned out to also break the QuickJS provider canary until
#4491's T10 stopped `constructor` taking the `Object.prototype` fallthrough in
the proto-index walk.

Open, with prices attached in #4491: the `memberCsv` exclusion is load-bearing
(a CSV entry would mint a brand-keyed closure, making `Error.prototype.
constructor` a callable refusal stub); `Date`/`Function` decline the seed for
want of an identity-stable carrier (#4200 follow-ups); `Iterator` needs an
accessor pair. Four `tests/issue-4200.test.ts` guards are now stale against the
seed and need #4200's owner to adjudicate.

Resume from #4491's "Suspended Work" section.

## Progress — 2026-08-25: RegExp.prototype.exec first-class method body

This bounded follow-up resumes the RegExp portion of S1 without reopening the
shared `$NativeProto` representation. Upstream `main` at `8a75a22ca4` already
materialized `RegExp.prototype` and routed its `exec` member to an
identity-stable native-method closure, but the closure body returned the
placeholder `null`. The existing expression-driven `emitRegexExecArrayCall`
engine already builds the spec capture-array shape, so the fix feeds it the
closure's recovered `$NativeRegExp` and runtime string argument.

### Scope

- `src/codegen/regexp-standalone.ts`: implement the `exec` method arm in
  `emitRegExpProtoMemberBody` using `emitRegexExecArrayCall` with
  `regexpOverride`, an externref subject flattened to a native string, and
  `gyLastIndex: "runtime"`; box the match vector back to the closure's
  externref ABI.
- `tests/issue-2175-regexp-exec-reflection.test.ts`: three host-free allowJs
  regressions covering capture-array fields through `.call`, runtime `g`
  `lastIndex` success/failure transitions, and catchable wrong-`this` branding.

### Measured result

The focused branch-point test was 1/3 on upstream: the capture-array case was
a compile error (`match-result property reads on values not produced by this
standalone backend`), the `g/y` case returned the placeholder, and the wrong-
brand control passed. The branch is **3/3**, with no `env` imports in each
binary. This slice leaves the parent issue open: direct dynamic closure calls
through the generic JS/allowJs dispatcher, RegExp symbol-protocol methods,
and the existing accessor proto-identity behavior remain separate follow-ups.

### Test Results

- `tests/issue-2175-regexp-exec-reflection.test.ts` — **3/3 passed**.
- `tests/issue-1539-standalone-regex.test.ts`, `tests/issue-1914.test.ts`,
  `tests/issue-2161-matchall.test.ts` — **199/199 passed**.
- `tests/issue-2161-regex-symbol-protocol.test.ts`,
  `tests/issue-2161-regex-tostring.test.ts` — **21/21 passed**.
- `tsc --noEmit --pretty false` — passed.
- `tests/issue-682-regexp-standalone-abi.test.ts` remains a pre-existing
  collection failure at `collections-brand.ts:100` (`COLLECTION_KIND` is
  undefined); `tests/issue-682.test.ts` also retains its unrelated upstream
  1/17 failure. No code in this slice touches those paths.

## D5 residual handoff — null-prototype OrdinaryToPrimitive (2026-08-31)

### Ownership and boundary

The four class accessor residuals discovered while validating #5195 are an
exact, bounded #2175 D5 slice. D5 already chooses an implicit
`Object.prototype` terminal for ordinary `$Object` chains and names
`FLAG_NULL_PROTO` for `Object.create(null)` / `Object.setPrototypeOf(o, null)`.
#5195's tracker explicitly excludes generic MOP and `Object.create` identity
work, so this must not be folded into its runtime-computed-class-key bridge.

This slice is deliberately narrower than the eventual all-reader D5 work: it
only makes `OrdinaryToPrimitive` distinguish an implicit ordinary-object
terminal from an explicit null prototype. It does not widen `$Object.$proto`,
does not materialize a general Object.prototype table, and does not change
unrelated `get`/`has`/descriptor/enumeration behavior.

No GitHub issue was created.

Before the next runtime replay, the focused file will add a balanced WAT
function extractor plus numeric-call resolver and prove separately that the
named `declarationProbe` and `expressionProbe` bodies each call
`__to_property_key`. The expression probe uses the exact comma-expression
shape. This is a reachability assertion over each emitted function body, not a
module-wide substring, so a helper elsewhere cannot make the control vacuous.

No GitHub issue was created.

### d60 residual implementation checkpoint — terminal-aware fixed-name in (2026-08-31)

**Verdict: still BLOCKED pending the released runtime lane.** This is a
semantic port plus the root-filed residual repair in the clean worktree
/Users/thomas/Code/js2/.codex-worktrees/final-2175-null-proto-d60-20260831,
branch codex/2175-null-proto-d60-20260831, exact base
d60aa73f9b3405dcdc1f832a511acb2366c7de00. It does not replace the historical
b91 **18 / 19** checkpoint: no compiler, Vitest, Test262, TypeScript, hook,
commit, push, PR, or GitHub action has run for this d60 repair checkpoint.

The read-only d2c7305c0f..d60aa73f9b comparison is empty for the five D5
paths. That delta adds only the unrelated #5246 tracker, so the reviewed b91
slice was reconciled path-by-path rather than merged or copied wholesale.
src/codegen/object-create-class-instance.ts and
tests/issue-5239-object-create-class-prototype.test.ts are also byte-identical
to the b91 source and remain untouched. #5239's bridge returns before emitting
in standalone/native-hostless modes; D5's marker is written only by the
standalone $Object allocator for a raw null prototype. Therefore this terminal
classification cannot bypass #5239's class-instance dispatch.

#### Residual implementation

- The prior companion-only route in binary-ops-in.ts is replaced for a
  standalone fixed %Object.prototype% name only when the receiver is a mutable
  $Object representation or an approved fnctor. Immutable/proven-safe receiver
  shapes retain the original constant fold.
- The private __extern_has_with_implicit_object_proto(obj, key) answer first
  preserves the existing real __extern_has own/inherited result. On a real
  $Object root or an approved fnctor's actual prototype root, only a miss then
  consults __object_terminal_allows_implicit_proto: an ordinary implicit
  terminal answers true; an explicitly marked terminal answers false; an
  explicit own/inherited entry remains true.
- The helper performs no extra JavaScript property probe. Its structural Proxy
  branch runs a present has trap once, forwards an absent trap directly to the
  target (including nested proxies), and dispatches a revoked Proxy once to
  preserve its abrupt completion. Other non-$Object/non-fnctor carriers retain
  the old permissive fixed-name answer.
- The existing D5 writer and reader work is retained exactly: raw-null
  classification survives same-encoded-null transitions, accepted non-null
  failed-$Object casts clear the marker, refusals do not mutate it, and the
  direct/fnctor proto-index tails plus OrdinaryToPrimitive continue to use the
  final-terminal predicate. proto-index-store.ts, its ABI, Test262, and #5239
  files remain unchanged.

#### Expanded focused controls

The standalone/import-free focused file now has **25** independent it controls,
unrun in this checkpoint. In addition to the historical direct, transition,
override, non-callable, abrupt-accessor, proto-index, and class-prototype
controls, it now proves:

1. an unarmed ordinary child keeps both fixed in names and ordinary string
   coercion;
2. an unarmed null-terminal child rejects both fixed names, still throws during
   OrdinaryToPrimitive, and then accepts a real inherited toString hit;
3. an approved fnctor answers true before, then false after, a no-companion
   terminal relink; and
4. cycle refusal has separate controls for the preserved TypeError behavior and
   for the fixed-name in result, so neither half can mask the other.
5. an unarmed Proxy forwards to its ordinary target, while a present fixed-name
   has trap receives the exact target and `"toString"` key exactly once and
   returns an observable false result; and
6. a distinct throwing fixed-name Proxy has trap preserves its original abrupt
   object identity and cannot reach a nested null-terminal fallback trap.

The exact four Test262 paths and SHA-256
ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50 remain the
historical conformance manifest; no Test262 file was edited.

#### Required released-worker replay

After static review, one released worker must run these serial commands from
this exact d60 worktree (or a freshly recorded newer main), recording the
actual focused denominator/result rather than reusing the historical 18 / 19:

~~~sh
node node_modules/vitest/dist/cli.js run tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot

node --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows.jsonl

node node_modules/vitest/dist/cli.js run tests/issue-5239-object-create-class-prototype.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
~~~

Before the four-row command, regenerate the sorted manifest exactly as recorded
above and verify its SHA-256. Record the 25-control focused result, zero-import
checks, all four rows, both harness controls, denominator 4, nondeterministic:
0, and the #5239 control result before clearing BLOCK.

No GitHub issue was created.

### Final b91 focused-runtime BLOCK — null-terminal `in` fold bypass (2026-08-31)

**Verdict: BLOCKED.** The exact focused standalone run on this b91 worktree
completed **15 / 19** assertions in **20.98 s**, with four failures whose
returned status codes were, in assertion order, **11 / 4 / 4 / 3**. No GitHub
issue was created.

- Code `11`: the proto-index-armed created child still reports `"toString"` or
  `"valueOf" in child` after its direct marked-null terminal.
- Code `4`: the same leakage remains after the ordinary ancestor is relinked to
  null, and again for an activated fnctor after its prototype terminal is
  relinked.
- Code `3`: a child still reports `"toString" in child` after a refused cycle
  write leaves its marked-null terminal intact.

The direct marked terminal's `get`, `has`, and coercion controls passed. Static
inspection confirms that `__extern_has` captures both its direct `$Object` root
and its real fnctor prototype root before their cursors advance, walks the
chain before the companion tail, and gates both tails with
`__object_terminal_allows_implicit_proto`. The four failing forms instead have
a preceding source-level escape: `binary-ops-in.ts` folds a fixed
`Object.prototype` name to `i32.const 1` when
`hasExplicitNullObjectPrototype` cannot prove the right operand is *directly*
`Object.create(null)`. A created descendant, later ancestor relink, fnctor
instance, and cycle-refusal child all miss that narrow syntactic proof, so they
bypass `__extern_has` and its otherwise-correct terminal gate.

#### Narrow repair plan

1. Preserve the existing `__extern_has` direct-object and fnctor root capture,
   loop ordering, companion ordering, and terminal predicate; do not weaken the
   controls or change `proto-index-store.ts`.
2. At the standalone fixed-`Object.prototype`-name `in` fold, route a mutable
   `$Object`/approved-fnctor receiver through `__extern_has` whenever the
   proto-index companion path is active instead of manufacturing an affirmative
   constant. The runtime then preserves a found own/inherited entry, returns
   true for an ordinary terminal through the companion, and returns the normal
   miss past a marked null terminal.
3. Keep the fold for modules without the companion path and for shapes outside
   this bounded `$Object`/fnctor runtime route. Re-run only the focused 19-case
   suite once a runtime lane is released, then record its denominator and the
   unchanged four-row/#5239 replay requirements separately.

No compiler, TypeScript, hook, commit, push, PR, or GitHub action has run for
this diagnosis. The next source edit requires the narrowly related
`binary-ops-in.ts` call-site correction in addition to the four existing D5
paths; it must not broaden the object representation or #5239 bridge.

Root confirmed this path expansion before implementation: the D5 slice now
also owns only `src/codegen/binary-ops-in.ts` for this static-fold bypass. The
file is the sole source of the four constant `in` answers; the runtime
predicate and proto-index ABI remain owned and unchanged. No GitHub issue was
created.

### Discovery evidence and planning base

- The isolated planning worktree is pinned to requested fetched-upstream commit
  `1c0ac753d65a939d268560776eb0591e18ceb6b9`. No compiler, Vitest, or Test262
  command was run for this planning update.
- The evidence below is copied from the #5195 recovery tracker’s serial
  per-path capture on branch `codex/5195-runtime-keys-recovery-20260831`, HEAD
  `c39de6dac8c376482b4f2cd628e445c6d8441728`. That recovery tree had
  uncommitted #5195 work; it is discovery evidence, not a validation result for
  this #2175 base or for the planned implementation.
- Its deterministic six-row harness had a passing must-pass control, a failing
  must-fail control, `pass: 2`, `fail: 4`, `total: 6`, and
  `nondeterministic: 0`. The two passing rows were separate #5195
  representatives. The four rows below all failed their first `get` accessor
  assertion with `Expected a TypeError to be thrown but no exception was thrown
  at all` (line 47 for static forms; line 45 for instance forms).
- Read-only source inspection at the planning base corroborates the recorded
  mechanism: `__object_create` in `object-runtime-prototype.ts` stores a null
  `$proto` with `flags = 0`, while `__to_primitive` in `object-runtime.ts`
  supplies `"[object Object]"` when a missing `toString` looks like the
  ordinary implicit Object.prototype case. The current representation cannot
  tell that case apart from `Object.create(null)`.

### Current-main grounding (read-only, 2026-08-31)

The live tracking ref is `upstream/main` at
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`, newer than this planning
worktree's requested historical base. The D5 ownership text is unchanged there:
it still recommends the implicit Object.prototype terminal plus
`FLAG_NULL_PROTO` for `Object.create(null)` / `setPrototypeOf(null)`. The live
source retains the same relevant anchors: `0x80+` is documented free in the
object-flag allocation, `__object_create` initializes `flags = 0`,
`__object_setPrototypeOf` has the same-value early return, and
`__to_primitive` still emits the missing-`toString` `"[object Object]"`
fallback.

An implementer must start from an updated current-main worktree, re-ground the
bit allocation and all source anchors after integration, and replay the focused
and four-row controls on that exact HEAD. The historical #5195 checkpoint and
the static manifest are discovery inputs only; neither substitutes for the
current-main replay.

### Static residual manifest

The manifest is reproducible without executing the compiler or Test262. It is
byte-sorted with `LC_ALL=C`, `test/`-relative, LF-only, and has exactly one
final LF:

```text
test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js
test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js
test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js
test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js
```

SHA-256 of those exact bytes:

```text
ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50
```

All four are the declaration/expression × instance/static variants of the same
`Object.create(null)` computed-key expectation. They are retained as conformance
evidence; do not edit their Test262 expectations or remove them from the slow
list to make this slice appear green.

### Implementation plan

1. In `src/codegen/object-runtime.ts`, reserve an object-level
   `OBJ_FLAG_NULL_PROTO` bit. At this planning base the object-flag allocation
   documents `0x80+` as free, after integrity (`0x01`/`0x02`/`0x04`), RawJSON
   (`0x08`), callable/constructor (`0x10`/`0x20`), and arguments (`0x40`)
   markers. Re-check that allocation after rebasing; do not reuse a bit claimed
   by integrated work and do not alter the `$Object` field layout.
2. Thread that flag through `ObjectPrototypeHelperState` into
   `src/codegen/object-runtime-prototype.ts`. In `__object_create`, set it only
   when the original prototype argument is JavaScript null; a failed
   `$Object` cast for some other argument must not silently become a
   null-prototype classification.
3. Preserve the distinction through `__object_setPrototypeOf`. A successful
   explicit `null` target sets the bit and a successful non-null target clears
   it while preserving every other object flag. The same-value fast path needs
   special care: an ordinary object is currently encoded as `$proto = null`, so
   `Object.setPrototypeOf(o, null)` must set the bit even when its stored proto
   field is already null. Refused non-extensible/cyclic changes must leave the
   bit unchanged; `__object_setPrototypeOf_status` remains observational.
4. In the existing `__to_primitive` `tryOrdinaryMethod("toString", true)`
   fallback, synthesize `"[object Object]"` only when the receiver is not
   marked null-prototype. For a marked object with no `toString`, continue to
   the ordinary `valueOf` probe and then use the already-emitted TypeError when
   neither method yields a primitive. Keep present data methods, accessors,
   non-callable values, abrupt completions, and primitive-return checks on their
   current paths.
5. Add a focused regression file, proposed as
   `tests/issue-2175-null-proto-toprimitive.test.ts`, using the normal
   standalone compile/validate/instantiate helper. Keep the four Test262 rows
   as the end-to-end gate rather than copying or weakening their assertions.

### Acceptance controls

- Ordinary-object control: `{}` still gets the implicit Object.prototype
  `toString` fallback, so string coercion remains `"[object Object]"`.
- Null-prototype control: `Object.create(null)` with no own coercion methods
  reaches the existing catchable TypeError path; it must not produce
  `"[object Object]"`.
- Transition control: `Object.setPrototypeOf(o, null)` flips an ordinary
  object into the null-prototype behavior even if the pre-existing encoded
  `$proto` field was null; resetting it to an accepted non-null ordinary object
  restores the ordinary fallback.
- Override control: an own callable `toString` or `valueOf` on a null-prototype
  object still runs once and supplies its primitive result; a present
  non-callable value or a throwing accessor still follows the existing
  TypeError/abrupt-completion behavior.
- End-to-end control: each manifest row passes, still expects TypeError for its
  `Object.create(null)` computed property key, and the harness reports four
  deterministic passes with both harness controls intact.

### Regression risks

- The null state cannot be inferred from `$proto === null`; doing so would turn
  all ordinary standalone objects into null-prototype objects. The flag is the
  discriminant.
- An early return in `__object_setPrototypeOf` can lose the state transition
  when both the old and requested encoded proto are null. Preserve the ordinary
  integrity and cycle checks while handling that accepted transition.
- Replacing the entire flags field would erase integrity, RawJSON, callable,
  constructor, or arguments bits. Update only `OBJ_FLAG_NULL_PROTO`.
- Do not broaden this into an `anyref` `$proto` field or a generic native-proto
  link: D5 selected the implicit terminal specifically to avoid the existing
  canonicalization and all-reader blast radius.
- The default fallback is narrow. Suppressing it for a present method, an
  accessor, an inherited non-null chain, or an unmarked ordinary object would
  create a wrong answer rather than a controlled conformance improvement.

### One-worker replay after implementation

Run this only in one clean, isolated implementation worktree after recording
its exact integrated HEAD and confirming no other compiler/test lane is active.
The repository harness is serial; `--check-determinism` repeats each selected
row rather than adding parallel workers.

```sh
mkdir -p .tmp
printf '%s\n' \
  'test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js' \
  'test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js' \
  'test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js' \
  'test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js' \
  | LC_ALL=C sort > .tmp/2175-d5-null-proto-paths.txt
shasum -a 256 .tmp/2175-d5-null-proto-paths.txt
```

The hash must be
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50` before
the manifest is consumed. Then run the focused regression and the serial
four-row evidence lane, one at a time:

```sh
node node_modules/vitest/dist/cli.js run tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot

node --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows.jsonl
```

Record the harness controls, per-row outcomes, denominator (`4`), and
`nondeterministic: 0`; do not promote the historical #5195 `2 pass / 4 fail`
checkpoint into an after-fix result. Finish with the targeted static checks
for the changed runtime files, the new focused test, and this issue file before
any broader standalone measurement.

### Handoff

One worker should own the runtime change because `object-runtime.ts` and
`object-runtime-prototype.ts` share the `$Object` flags contract. Start from
current `upstream/main` (record the exact refreshed SHA; this planning pass saw
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`), not the historical planning base.
Re-check the free bit and the `__object_setPrototypeOf` early-return ordering,
then replay every focused and four-row control on the actual integrated HEAD
before updating this record with results. Keep #5195 limited to its
computed-class-key bridge and leave its historical residual classification
intact. This documents a sub-slice of the existing #2175 issue; it neither
claims a new issue ID nor closes the broader #2175 work.

### D5 implementation checkpoint — integrated current main (2026-08-31)

The isolated implementation worktree on
`codex/2175-null-proto-residual-plan-20260831` was advanced from the historical
planning base with a non-destructive `git merge --ff-only upstream/main`. Its
implementation base is now exactly
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`. The tracked `0x80` flag range was
re-checked on that HEAD before allocation; no `$Object` field was added or
reordered.

Implementation decisions on that exact base:

- `OBJ_FLAG_NULL_PROTO = 0x80` is local to the `$Object.flags` contract and is
  threaded only through `ObjectPrototypeHelperState` into the prototype helper
  builder.
- `__object_create` marks the flag only when its original externref prototype
  input is JavaScript `null`; a failed `$Object` cast cannot classify another
  input as null-prototype.
- `__object_setPrototypeOf` preserves all unrelated flag bits, updates this bit
  only after the ordinary extensibility/cycle checks accept the write, and
  clears it for a successful non-null input. Its same-value fast path now treats
  `($proto = null, FLAG_NULL_PROTO = 0)` and
  `($proto = null, FLAG_NULL_PROTO = 1)` as distinct states. The paired status
  helper mirrors that decision without a write, so the throwing high-level
  `Object.setPrototypeOf` path cannot bypass a non-extensible transition.
- `__to_primitive` retains the missing-`toString` `"[object Object]"` result
  only for unmarked `$Object` receivers. Marked receivers continue through the
  existing `valueOf` probe and TypeError tail; present methods, non-callable
  properties, and abrupt method calls stay on their existing paths.
- `tests/issue-2175-null-proto-toprimitive.test.ts` is the focused standalone
  compile/validate/instantiate control. Its six assertions cover ordinary
  fallback, `Object.create(null)`, the same-encoded-null transition and reset,
  callable `toString`/`valueOf` overrides, a present non-callable `toString`,
  and an abrupt own `toString` completion.

#### Static evidence only

The final changed-file static gate passed on this integrated worktree:

- `git diff --check` reported no whitespace errors.
- Prettier `--check` passed for this tracker, both runtime files, and the new
  focused test.
- Biome `lint --diagnostic-level=error` passed for the three changed TypeScript
  files (`Checked 3 files`; no fixes applied).
- Focused source inspection confirmed the only `ObjectPrototypeHelperState`
  construction supplies the new bit, the writer and status helper share the
  same encoded-null predicate, and the fallback gate reads only
  `$Object.flags` after the existing `$Object` receiver test.

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
mutation has been run for this implementation checkpoint. The historical
#5195 evidence remains `2 pass / 4 fail` across its six-row harness and is not
an after-fix claim. No GitHub issue was created.

### P1 independent-review BLOCK — terminal null-prototype reachability (2026-08-31)

**Verdict: BLOCK.** The first D5 implementation only inspected the receiver's
`OBJ_FLAG_NULL_PROTO`. That is insufficient: an unmarked child such as
`Object.create(Object.create(null))`, or an existing child whose ancestor is
later changed with `Object.setPrototypeOf`, reaches an explicitly null terminal
without carrying the bit itself. It could still receive the synthetic implicit
`Object.prototype` answer. D5 is therefore not complete and must not be
claimed as complete until the dynamic terminal check and its focused replay
land.

#### Required P1 repair plan

1. Keep `OBJ_FLAG_NULL_PROTO` only on the object whose own `[[Prototype]]` was
   explicitly set to JavaScript `null`; do not copy it into children. Add one
   private, read-only `object-runtime.ts` instruction factory that starts at a
   `$Object` root, walks `$proto` links until the final reachable `null`, and
   answers whether that final terminal still permits the implicit
   Object.prototype behavior. An unmarked terminal permits it; a marked
   terminal does not. This must observe later ancestor mutation dynamically.
   Non-`$Object` callers retain their former permissive behavior.
2. Use that predicate only at the three reviewed synthetic-terminal sites:
   `__to_primitive`'s `"[object Object]"` fallback, the `$Object`
   terminal-miss tail in `__extern_get` before `protoIndexRecvGetMissInstrs`,
   and the corresponding `__extern_has` tail before
   `protoIndexRecvHasMissInstrs`. Capture each original `$Object` walk root
   before its cursor loop overwrites the cursor. If the final terminal is
   explicitly null, take the ordinary get/has miss; do not suppress a found own
   or inherited `$Object` entry.
3. Do not change `proto-index-store.ts`, its ABI, or generic prototype
   representation. The repair is a local reader predicate plus the three call
   sites above; no flag propagation and no Test262 edit are allowed.
4. Extend the focused standalone/import-free test with direct, created-child,
   and `setPrototypeOf`-child null-terminal cases; a proto-index-armed proof
   that `Object.prototype.toString`/`valueOf` do not leak; inherited explicit
   override; failed non-null cast staying ordinary; exact string/number-hint
   order and object-result behavior; non-extensible and cycle refusals; and an
   actual throwing accessor. Each remains non-vacuous.

#### Truthful handoff before P1 repair

The earlier static pass applies only to the receiver-bit implementation now
blocked by review; it is not behavioral validation of P1. No compiler, Vitest,
Test262, TypeScript, hook, commit, push, PR, or GitHub mutation has run. The
historical #5195 `2 pass / 4 fail` discovery evidence remains pre-fix only.
After this P1 repair, rerun the existing one-worker focused and four-row commands
on this same isolated worktree and record outcomes separately. No GitHub issue
was created.

### P1 repair checkpoint — static evidence only (2026-08-31)

The required P1 reader repair is staged, but **D5 remains BLOCKED pending the
released one-worker runtime replay**. This is not a completion claim.

- `object-runtime.ts` now registers the private, read-only
  `__object_terminal_allows_implicit_proto` native. Starting from a nullable
  `$Object` root, it walks each live `$proto` link and tests only the final
  `$proto === null` terminal's `OBJ_FLAG_NULL_PROTO` bit. A null root remains
  permissive for non-`$Object` callers. The bit remains local to explicit-null
  writers; no descendant propagation was added, so ancestor relinks are read
  dynamically at the eventual miss.
- The predicate is called only at the three reviewed synthetic-terminal sites:
  the missing-`toString` `"[object Object]"` fallback in `__to_primitive`, the
  terminal `$Object` miss before `protoIndexRecvGetMissInstrs`, and the matching
  terminal `$Object` miss before `protoIndexRecvHasMissInstrs`. `__extern_get`
  and `__extern_has` save their direct `$Object` root in an appended local before
  their cursor loops advance. A found own or inherited `$Object` entry still
  returns before either tail; an explicit-null terminal uses the normal get/has
  miss instead of the Object.prototype companion.
- `proto-index-store.ts` and its ABI/body were not edited. The `$proto` field
  representation remains unchanged; `Object.create` and `setPrototypeOf` retain
  the existing D5 writer/status flag contract.
- The standalone/import-free focused test now has direct, created-child,
  `setPrototypeOf`-child, and dynamically relinked-ancestor terminal cases;
  proto-index-armed `Object.prototype.toString`/`valueOf` ordinary controls and
  direct-and-child null-terminal non-leak checks; an inherited explicit
  override; a non-null class-instance prototype that fails the `$Object` cast
  and stays ordinary; exact string/number-hint ordering after object results;
  non-callable and throwing-accessor behavior; and
  non-extensible/cycle refusal controls. Its helper still asserts a valid Wasm
  module with zero imports for every snippet.

#### P1 static checks

- `git diff --check` passed after the P1 edits.
- Prettier `--check` passed for this tracker, both runtime files, and
  `tests/issue-2175-null-proto-toprimitive.test.ts`.
- Biome `check` passed for the focused test, and Biome `lint` passed for the two
  runtime files plus the focused test (`Checked 3 files`; no fixes applied).
  A full Biome `check` of the two large runtime files still reports their
  pre-existing repository-wide Biome formatter/import-order differences; this
  slice did not rewrite unrelated source formatting. The targeted Prettier
  check is clean, including both P1 insertion regions.

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
action has run after this repair. The only result evidence remains the pre-fix
#5195 discovery harness (`2 pass / 4 fail` across six rows); it must not be
reported as P1 validation. No GitHub issue was created.

#### Released-worker handoff

Keep this worktree on exact integrated `upstream/main`
`87002f1fe4dd373e8e3c791dcd964f561e02c78e` (or record the newer current-main
SHA if it changes before replay). One worker, after the runtime lane is
explicitly released, must run the focused Vitest command and the serial,
deterministic four-row command already listed above, in that order. Record the
focused assertion count, zero-import result, each manifest path, harness
controls, denominator `4`, and `nondeterministic: 0`. Only then may D5's BLOCK
verdict be revisited; do not edit Test262 or broaden into #5195.

### P1/P2 independent-review BLOCK — encoded-null transition and fnctor tails (2026-08-31)

**Verdict: still BLOCKED.** The terminal-reader repair fixed direct `$Object`
walks but left two bounded correctness holes. No GitHub issue was created.

1. **Encoded-null transition classification.** `returnIfSameEncodedPrototype`
   compares the canonicalized `$Object` references before it distinguishes the
   raw requested prototype. An explicitly null-marked object and a successful
   non-null request that fails the `$Object` cast both encode as `null`; that
   early return incorrectly retains `OBJ_FLAG_NULL_PROTO`. The writer and its
   status helper must treat raw JavaScript `null` and raw non-null failed-cast
   requests as distinct classifications whenever the encoded references are both
   null. An accepted non-null failed-cast request must continue to the normal
   write and clear only the marker; rejected non-extensible/cyclic requests and
   the status predicate remain non-mutating.
2. **Fnctor proto-index tails.** The direct `$Object` root capture intentionally
   leaves non-`$Object` callers permissive, but an activated function-constructor
   instance has a real per-fnctor `$Object` prototype walk root. When that
   prototype chain terminates explicitly at null, the fnctor branch must gate
   the same companion get/has tails using
   `__object_terminal_allows_implicit_proto`; otherwise armed
   `Object.prototype` companions leak through `in` and OrdinaryToPrimitive.

#### Narrow P2 repair plan

1. Refine only the shared same-encoded-prototype helper in
   `object-runtime-prototype.ts`: preserve a true same-state return only when
   both the canonicalized references and raw-null classifications agree. Keep
   every existing writer/status refusal path and flag ABI unchanged.
2. In `__extern_get` and `__extern_has`, capture the per-fnctor `$Object` walk
   root when that branch is activated, then apply the existing private terminal
   predicate solely to the receiver-aware companion tails. Do not widen generic
   non-`$Object` callers, alter `proto-index-store.ts`, or propagate the bit.
3. Extend the focused standalone/import-free control with an extensible
   explicit-null → non-null `new C()` failed-cast transition, its non-extensible
   refusal counterpart, a proto-index-armed ancestor-relink proof, and an
   activated fnctor whose prototype terminal is relinked to null while both
   `in` and coercion remain non-leaking.

This remains a narrow reader/writer correction within #2175 D5. No compiler,
Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub action has run
for this review response; runtime replay remains required before clearing the
BLOCK verdict.

### P2 repair checkpoint — static evidence only (2026-08-31)

The two review findings above are now repaired in the isolated D5 worktree,
but **D5 remains BLOCKED pending the released one-worker runtime replay**. This
is not a completion claim. No GitHub issue was created.

- `returnIfSameEncodedPrototype` now requires both equal encoded `$Object`
  references and matching original-input null classifications before it takes a
  no-op return. Thus a marked explicit-null object plus a non-null `new C()`
  input that cannot cast to `$Object` proceeds through the existing status,
  extensibility, cycle, and writer paths; an accepted write clears only
  `OBJ_FLAG_NULL_PROTO`. A refused status/write is still non-mutating.
- `__extern_get` saves the actual `$Object` root of an approved fnctor's
  per-constructor prototype walk before its cursor advances. `__extern_has`
  does the same for its fnctor walk. Their receiver-aware proto-index companion
  tails now use the existing terminal predicate, alongside the direct
  `$Object` tails. This is intentionally a narrow get/has fallback gate: a
  real root ending at marked null gets the normal miss; an unrooted generic
  non-`$Object` caller continues to receive its prior permissive answer.
- No descendant receives the flag, no `$proto` representation changed, and
  `proto-index-store.ts` (including its ABI/body) was not edited.
- The focused standalone/import-free control now also proves the accepted
  explicit-null → `new C()` failed-cast transition, the matching
  non-extensible refusal, a proto-index-armed ancestor relink, and an approved
  non-empty fnctor whose armed `toString`/`valueOf` companions are visible
  before its prototype terminal is relinked and cannot leak afterward through
  either `in` or coercion. Existing direct terminal, child, override, ordering,
  non-callable, abrupt-accessor, and cycle controls remain intact.

#### P2 static checks

- `git diff --check` passed.
- Prettier `--check` passed for this tracker, `object-runtime.ts`,
  `object-runtime-prototype.ts`, and the focused test.
- Biome `check` passed for the focused test, and Biome `lint
  --diagnostic-level=error` passed for the two runtime files plus the focused
  test (`Checked 3 files`; no fixes applied). No broad formatter rewrite was
  attempted.

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
action has run for P2. The historical #5195 discovery evidence remains the
pre-fix `2 pass / 4 fail` result and is not validation of this repair.

#### Released-worker handoff

On a freshly integrated current `upstream/main` worktree (re-record the SHA;
this worktree's base remains
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`), one released worker must run the
existing serial focused Vitest command and then the deterministic four-row
`harness-flip-probe.ts --check-determinism` command in the earlier D5 handoff.
Record the focused assertion count, zero-import result, exact four-path
manifest and hash, each row, denominator `4`, and `nondeterministic: 0` before
revisiting the BLOCK verdict. Do not edit Test262 or broaden #5195.

### Live-base semantic port handoff — 427900e7 (2026-08-31)

The independently PASSed D5 source slice is ported only into this exclusive live
worktree:

- worktree: `/Users/thomas/Code/js2/.codex-worktrees/recovery-2175-null-proto-live-20260831`
- branch: `codex/2175-null-proto-live-20260831`
- exact base: `427900e7cd4f40e294021d3421f7471fa49506fc`
- read-only source: `codex/2175-null-proto-residual-plan-20260831` at
  `87002f1fe4dd373e8e3c791dcd964f561e02c78e`

A path-scoped comparison of that source base with this live base produced no
changes for the four owned paths (this tracker, `object-runtime.ts`,
`object-runtime-prototype.ts`, and the focused test). Therefore the port is
semantically identical to the independently reviewed source slice; no upstream
hunk reconciliation was necessary at base `427900e7`.

The preceding P1/P2 BLOCK sections are the historical repair record, not a
claim that the independently reviewed source remains blocked. This port ran no
compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub action;
it does not manufacture a second runtime result. The historical #5195 discovery
evidence remains pre-fix only.

#### New-current-main overlap and required replay

While this 427-based port was in progress, `upstream/main` advanced to
`b91fed8a1ff949f936877b4f06bd4868b1033959`, which merges #5239's
Object.create class-prototype bridge. That is a semantic overlap at the
Object.create boundary: it can change how the D5 `new C()` failed-`$Object`
cast controls are represented. Do not merge this dirty snapshot. Root will
provide a fresh b91-based worktree for final reconciliation and replay.

On that fresh worktree, re-ground the raw-null classification in
`__object_create`, the same-encoded-null writer/status distinction, and the
class-instance `new C()` transition/refusal controls against #5239. Run the
#5239 controls together with the existing one-worker focused Vitest and
four-row deterministic replay commands above; record the fresh b91 SHA,
focused assertion result, zero-import checks, manifest/hash, all four rows,
denominator `4`, harness controls, and `nondeterministic: 0` before making
any final behavior claim.

#### 427-based static port evidence

- The two runtime files and focused test are byte-identical to the read-only
  independently reviewed source; this tracker adds only the live-base handoff
  and b91 overlap record.
- `git diff --check` passed for tracked changes, and a separate
  `git diff --no-index --check /dev/null` check passed for the new focused test.
- Targeted Prettier `--check` passed for all four owned paths. This worktree
  has no local `node_modules`, so the existing canonical repository tool
  binaries were invoked read-only against these absolute live-worktree paths.
- Biome `check` passed for the focused test; Biome `lint
  --diagnostic-level=error` passed for both runtime files plus that test
  (`Checked 3 files`; no fixes applied).
- The stable dirty snapshot contains exactly the three tracked owned files and
  the one new focused test; no `proto-index-store.ts`, Test262, or unrelated
  path changed.

No GitHub issue was created.

### Final live-base semantic port — b91fed8 (2026-08-31)

The independently PASSed 427 D5 source slice is ported into this clean exact
current-main worktree:

- worktree: `/Users/thomas/Code/js2/.codex-worktrees/recovery-2175-null-proto-final-20260831`
- branch: `codex/2175-null-proto-final-20260831`
- exact base: `b91fed8a1ff949f936877b4f06bd4868b1033959`
- read-only source: `codex/2175-null-proto-live-20260831` at
  `427900e7cd4f40e294021d3421f7471fa49506fc`

A path-scoped comparison of `427900e7` to `b91fed8` reports no upstream
change in the four D5-owned paths. The runtime files and focused test are
therefore semantically and byte-for-byte identical to the PASSed 427 port; this
tracker retains its historical record and adds only the b91 grounding and
#5239 interaction analysis. The source tracker carried one literal leading
`+` before its D5 heading; that Markdown typo is corrected here only. No
behavioral reconciliation hunk was needed.

#### #5239 Object.create class-prototype bridge interaction

#5239 adds `src/codegen/object-create-class-instance.ts` and
`tests/issue-5239-object-create-class-prototype.test.ts`; both remain
untouched by this D5 port. Its emitted class-instance export explicitly returns
without emitting under `ctx.standalone`, `ctx.wasi`, or `noJsHost(ctx)`.
D5's terminal marker is written only by the native `$Object` allocator, and
only for a raw JavaScript `null` prototype input.

Consequently, the bridge cannot bypass D5's marker: a non-null compiled class
prototype either yields a real compiled class instance (not a D5 `$Object`)
or declines to the ordinary host `Object.create` fallback; a null input
declines the bridge before the native D5 writer classifies it. The focused D5
suite uses `target: "standalone"`, where #5239 emits no bridge. Static
inspection exposes no unpinned cross-path interaction, so no additional test
was added and the #5239 control is preserved exactly.

#### Final validation plan — one released worker only

External compiler/test lanes are currently saturated. Do not treat this static
port as a behavioral replay. On this exact b91 base (or a freshly recorded
newer main), one worker must run these serial commands, in order, after
confirming the dependency provisioning:

```sh
node node_modules/vitest/dist/cli.js run tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot

node --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows.jsonl

node node_modules/vitest/dist/cli.js run tests/issue-5239-object-create-class-prototype.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

Before the four-row command, regenerate and verify the earlier exact
four-path manifest and SHA-256
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`.
Record the focused result, zero-import checks, each of the four row outcomes,
harness controls, denominator `4`, `nondeterministic: 0`, and the #5239
control result. Do not edit Test262 or broaden D5 while reconciling that
independent host-only bridge.

#### b91 static-port evidence

- A read-only comparison against the PASSed 427 port confirms both runtime
  files and the focused test are byte-identical. The tracker differs only for
  its exact b91 handoff, #5239 analysis, and the corrected literal heading
  prefix described above.
- A path-scoped `427900e7..b91fed8` source comparison is empty for the four
  D5 paths. The #5239 implementation file and its regression test also have no
  diff in this worktree, preserving that bridge exactly.
- `git diff --check` passed for tracked changes, and a separate
  `git diff --no-index --check /dev/null` check passed for the new focused
  test.
- Targeted Prettier `--check` passed for all four D5 paths. The worktree has
  no local `node_modules`, so the canonical repository tool binaries were
  used read-only against absolute paths here.
- Biome `check` passed for the focused test; Biome `lint
  --diagnostic-level=error` passed for both runtime files plus that test
  (`Checked 3 files`; no fixes applied).

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
action has run in this b91 port.

No GitHub issue was created.

### Final b91 repair checkpoint — terminal-aware `in` fold route (2026-08-31)

**Verdict: remains BLOCKED pending a released runtime rerun.** The exact
pre-repair focused result remains **15 / 19** in **20.98 s**, with failure
codes **11 / 4 / 4 / 3**; it is diagnosis evidence, not a passing result. No
GitHub issue was created.

The runtime reader was not the escaping path. `__extern_has` already captures
the direct `$Object` and approved-fnctor `$Object` roots, walks those roots
before its companion tail, and asks
`__object_terminal_allows_implicit_proto` at each tail. The four failing
descendant/relink/cycle/fnctor forms instead reached the fixed-name
`Object.prototype` `in` fold in `binary-ops-in.ts`, which emitted an affirmative
constant before `__extern_has` could inspect the marked terminal.

Root approved the sole additional D5-owned path,
`src/codegen/binary-ops-in.ts`, for this repair. Its read-only direct-statement
recognizer records static named writes to the literal `Object.prototype` through
direct or literal-element assignment, `Object`/`Reflect.defineProperty(ies)`,
and direct `__defineGetter__`/`__defineSetter__` calls. It accepts only a
preceding direct statement in the same block, rather than a merely possible
source-wide write that could be conditional or later. The static fold now defers
only when all of the following are true:

- the exact fixed key has such an already-executed direct Object-prototype
  companion write and the existing named/index proto-store reservation is
  active;
- the receiver is a mutable dynamic `$Object` representation or an approved
  fnctor instance; and
- the previous standalone Object-prototype fixed-name predicate was positive.

That path forces the former positive fold through `__extern_has`. An ordinary
terminal still gets the Object-prototype companion hit; a direct/descendant
marked-null terminal gets the normal miss after the real own/inherited walk.
Modules without an exact Object-prototype companion key, and immutable/proven
safe receiver shapes, retain their prior constant fold. The shared bare-name
pre-scan is deliberately not used as identity evidence: an
`Array.prototype.toString`-only write must not make an ordinary `$Object` miss
its valid Object-prototype answer. `proto-index-store.ts`, the terminal flag
ABI, the core get/ToPrimitive paths, and #5239 remain unchanged.

No additional compile-shape test was added. The focused 19-case control already
arms both exact Object-prototype companions, proves the ordinary positive `in`
answer, and then asserts the direct-child, ancestor-relink, fnctor-relink, and
cycle-refusal terminal answers that previously produced codes 11/4/4/3. The
new route is present in both the static `has` decision and the existing
`__extern_has` call guard; a released focused pass is therefore non-vacuous
coverage of this fold boundary.

#### Static evidence after the fold repair

- `git diff --check` passed.
- Targeted Prettier `--check` passed for this tracker, `binary-ops-in.ts`, both
  runtime files, and the focused test.
- Biome `check` passed for the focused test (`Checked 1 file`); Biome `lint
  --diagnostic-level=error` passed for `binary-ops-in.ts`, both runtime files,
  and the focused test (`Checked 4 files`; no fixes applied).
- A source inventory confirms the new route at the static fold and its existing
  `__extern_has` terminal predicate/tails. The dirty snapshot contains exactly
  this tracker, `binary-ops-in.ts`, `object-runtime.ts`,
  `object-runtime-prototype.ts`, and the new focused test.

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
action ran for this checkpoint.

#### d2c replay handoff

`upstream/main` subsequently advanced to
`d2c7305c0fdd983cc3c60c545725bd8da5043d90`. A path-scoped read-only comparison
of `b91fed8a1ff949f936877b4f06bd4868b1033959..d2c7305c0fdd983cc3c60c545725bd8da5043d90`
is empty for all five D5-owned paths above. Do **not** merge this dirty b91
worktree. A single released worker must replay the existing serial focused
D5, four-row deterministic, and #5239 regression commands from the final
validation plan on a fresh d2c-based worktree, re-record that base, and retain
the unchanged manifest/hash, zero-import controls, denominator `4`, and
`nondeterministic: 0` evidence. No GitHub issue was created.

### Root runtime checkpoint: BLOCK at 18 / 19 (2026-08-31)

Root released one compiler worker and ran the focused file from the stable b91
snapshot with one Vitest fork and no file parallelism. The result improved from
15 / 19 to **18 / 19**, but the issue remains **BLOCK** and no later validation
gate ran. The sole failure was:

```text
keeps the marked null terminal intact after a cycle refusal
expected 1, received 3
tests/issue-2175-null-proto-toprimitive.test.ts:386
```

Code `3` is returned by the fixed-name `"toString" in child` check before the
subsequent `String(child)` assertion executes. This is direct evidence that the
compiler's affirmative Object-prototype fold still escapes; it is not evidence
that the runtime cycle refusal changed the terminal bit. The first repair only
defers the fold when the same source has an exact preceding
Object.prototype-companion write. The cycle control has no such write, so
`objectPrototypeCompanionCanAnswer` leaves the affirmative fold in place.

#### Bounded residual repair plan

1. Make the focused cycle control independently prove both halves: first prove
   the refused write leaves OrdinaryToPrimitive at the marked null terminal,
   then prove the fixed-name `in` answer is false. Add matching no-companion
   direct-child and ordinary-object controls so neither outcome can pass by
   constant or unreachable code.
2. For standalone mutable `$Object` descendants and approved fnctor roots,
   replace the unsound fixed-name constant with a non-observable runtime answer
   that combines real own/prototype hits with the existing
   `__object_terminal_allows_implicit_proto` classification. It must answer
   true at an ordinary implicit Object.prototype terminal and false at an
   explicitly marked null terminal even when no proto-index companion was
   materialized. Reuse compiler/runtime metadata; do not add an observable
   property probe or weaken Proxy traps. Keep the existing constant fold for
   immutable/proven-safe shapes and preserve exact own/inherited hits.
3. Semantically replay the five-path D5 snapshot plus this residual into the
   clean current-main worktree at
   `d60aa73f9b3405dcdc1f832a511acb2366c7de00`. The
   `d2c7305c0f..d60aa73f9b` delta adds only the unrelated #5246 tracker and has
   no exact D5 path overlap; nevertheless reconcile rather than copying whole
   files.
4. Rerun static gates and obtain a fresh independent review before root repeats
   the one-worker 19-case file. Only a 19 / 19 result may unlock the exact
   four-row deterministic manifest, #5239 regression, TS7, hooks, commit, push,
   and separate non-draft PR.

No GitHub issue was created.

### d60 static handoff — pending runtime review (2026-08-31)

The exact d60 worktree has reached a stable dirty static boundary. The
historical b91 runtime result remains the only runtime evidence; the current
focused file has 25 controls and has not been executed.

- git diff --check passed, including the four tracked D5 paths.
- A separate no-index whitespace check for the new focused test passed.
- Targeted Prettier --check passed for this tracker, binary-ops-in.ts, both
  runtime files, and the focused test.
- Biome check passed for the focused test. Biome lint
  --diagnostic-level=error passed for binary-ops-in.ts, both runtime files, and
  the focused test; no fixes were applied.
- Read-only comparison confirms object-runtime-prototype.ts is byte-identical
  to the reviewed b91 slice. The #5239 class-instance bridge source is also
  byte-identical and unmodified.
- Source inventory is exactly this tracker, src/codegen/binary-ops-in.ts,
  src/codegen/object-runtime.ts, src/codegen/object-runtime-prototype.ts, and
  tests/issue-2175-null-proto-toprimitive.test.ts. No Test262 file,
  proto-index-store.ts, #5239 file, or unrelated path changed.

The next action is one released-worker runtime replay using the commands in
the d60 checkpoint above, followed by independent review. Do not infer a
runtime result from these static gates.

No GitHub issue was created.

### Independent d60 review: BLOCK on Proxy evidence (2026-08-31)

The independent reviewer found the new
`__extern_has_with_implicit_object_proto` source design coherent: real
own/inherited hits precede terminal classification, classification occurs only
after a miss, descendant/relink/fnctor roots are handled, immutable/proven-safe
folds remain, and #5239 is untouched. Acceptance is nevertheless **BLOCK** on
a P2 test-evidence gap.

The current sole Proxy control returns a fixed `false` from a present `has`
trap. It does not observe invocation count, receiver/target/key arguments, or
abrupt completion. A broken specialized helper that bypasses a present trap,
calls it twice, or swallows a thrown trap could therefore pass the claimed
then-24-control denominator.

#### Bounded evidence repair

1. Strengthen or replace the present-Proxy control so it records exactly one
   `has` invocation, proves the target and fixed key received by the trap, and
   returns an observable false result through the specialized fixed-name path.
2. Add a distinct throwing-`has` control that proves the original abrupt value
   escapes unchanged and that no terminal fallback executes afterward.
3. Update the exact focused denominator and tracker claims, then rerun targeted
   diff/format/lint gates. Do not alter the runtime helper unless the stronger
   controls expose a source defect.
4. Obtain a fresh independent review before root releases the focused runtime
   lane and later four-row/#5239 gates.

No GitHub issue was created.

### Proxy evidence repair checkpoint (2026-08-31)

The present-has control now binds one ordinary target to both the forwarding and
trapped proxies. It observes the forwarded positive result, the trapped false
result, exactly one trap invocation, and that the sole invocation received that
target plus the fixed `"toString"` key. The distinct abrupt control gives the
outer proxy a unique object sentinel and places a counted `has` trap on its
nested null-terminal target. It passes only when the original sentinel escapes,
the outer trap ran once, and the nested fallback trap never ran. This keeps a
swallowed abrupt completion, a duplicate trap call, a wrong trap argument, and
a post-trap fallback independently observable.

The focused file therefore has exactly **25** independent `it` controls: the
prior present-trap control was strengthened and one abrupt-trap control was
added. Runtime evidence remains absent. The released-worker command above must
record a fresh **25 / 25** focused result (rather than the historical b91
18 / 19 or the prior unrun 24-control denominator) before the four-row and
#5239 commands can be released. No source helper, Test262 file, or #5239 path
was changed. No GitHub issue was created.

#### Targeted static evidence

- `git diff --check` passed; the separate no-index whitespace check for the
  new focused test passed as well.
- Direct Prettier `--check` passed for this tracker and the focused test.
- Biome `check` and `lint --diagnostic-level=error` passed for the focused test
  (`Checked 1 file`; no fixes applied).

No compiler, Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub
operation ran. The P2 evidence repair is ready for a fresh independent static
review, not a runtime PASS claim.

### Released single-worker validation: Test262 setup BLOCK (2026-08-31)

The assigned one-worker runtime lane ran serially on
`codex/2175-null-proto-d60-20260831` at
`d60aa73f9b3405dcdc1f832a511acb2366c7de00`. The subsequently fetched live
`upstream/main` is `932341cc7d01547bf6b0065d766a31cdf3478d9f`; its
`207793dd..932341cc` delta contains benchmark artifacts only and has no D5
owned-path overlap. No GitHub issue was created.

- The focused command completed with one Vitest fork and no file parallelism:

  ~~~sh
  node /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
    tests/issue-2175-null-proto-toprimitive.test.ts \
    --pool=forks --poolOptions.forks.singleFork=true \
    --no-file-parallelism --reporter=dot
  ~~~

  Result: **25 / 25** tests passed in **18.49 s** (one file). This covers the
  focused suite's standalone zero-import assertions, including the strengthened
  present and abrupt Proxy controls.
- The local root corpus is pinned at
  `b363f29d3c43c626dc852744ad64a0b48a003693`; all four requested rows are
  present there. The sorted four-line path manifest was regenerated and its
  SHA-256 is
  `ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`, matching
  the recorded manifest.
- The serial `harness-flip-probe` attempt exited **3** before measuring a row or
  writing `.tmp/2175-d5-null-proto-rows.jsonl`. Its mandatory positive and
  negative controls both reported
  `ENOENT: no such file or directory, open
  '/Users/thomas/Code/js2/.codex-worktrees/final-2175-null-proto-d60-20260831/test'`,
  then refused to emit a count. The target worktree's `test262/` directory is
  empty even though the locally cached pinned corpus exists at the repository
  root. No row, determinism, or harness-control result is therefore available
  to claim.
- Per the released-lane stop-on-failure rule, the four rows were not retried and
  `tests/issue-5239-object-create-class-prototype.test.ts` was **not run**.

Handoff: provision this worktree's `test262/` root from the already available
`b363f29` local corpus (without downloading or changing Test262), then rerun
the existing serial harness command and only after its controls pass run the
#5239 Vitest regression. Preserve this focused 25 / 25 result; do not promote
it to four-row or #5239 evidence.

### Attached-corpus four-row replay: real BLOCK (2026-08-31)

The earlier exit-3 entry above was a harness **self-abort before measurement**:
the target worktree's corpus root was empty, so neither its positive nor
negative control could be read. It is distinct from this replay. The exact
local Test262 corpus is now attached in this worktree at detached
`b363f29d3c43c626dc852744ad64a0b48a003693`, with all four requested files and
the upstream harness present. No download or Test262 edit occurred.

One worker reran the serial standalone command:

~~~sh
node --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows.jsonl
~~~

The pre-run byte-sorted, LF-terminated manifest again hashed to
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`.
Both mandatory harness controls reported their intended opposite directions:
`must-pass -> pass` and `must-fail -> fail` (the latter's callback was the
expected `Test262Error` for `assert.sameValue(1, 2)`). The instrument therefore
proved it could distinguish both outcomes before processing the four rows.

**Result: BLOCKED — 0 / 4 pass, 4 / 4 fail, nondeterministic: 0.** The console
count was `{"fail":4}`, `total: 4 (counts verified to sum)`, and the preserved
JSONL has exactly four lines. A read-only JSONL reduction also reports four
standalone rows and `{"fail":4}`; its four paths exactly equal the requested
sorted manifest, so the count, callback controls, and artifact reconcile.

- `expressions/class/accessor-name-inst/...`: `get` accessor expected a
  `TypeError`, but no exception was thrown (L45).
- `expressions/class/accessor-name-static/...`: the same `get` accessor failure
  (L47).
- `statements/class/accessor-name-inst/...`: the same `get` accessor failure
  (L45).
- `statements/class/accessor-name-static/...`: the same `get` accessor failure
  (L47).

This is a real residual failure after valid controls, not a corpus setup issue.
Per the released one-worker stop-on-failure rule,
`tests/issue-5239-object-create-class-prototype.test.ts` was not run. Preserve
`.tmp/2175-d5-null-proto-rows.jsonl` for diagnosis; do not claim the historic
focused **25 / 25** result as four-row or #5239 validation. No GitHub issue was
created; no commit, push, or PR occurred.

### First computed-accessor repair replay: BLOCK at 25 / 29 (2026-08-31)

The first narrow implementation attempt is not accepted. One serial Vitest
worker ran:

~~~sh
node /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

It completed in **17.67 s** with **25 / 29** controls passing. The historical
25 D5 controls remain green. The four newly added direct class-evaluation
controls all returned `0`, so no `TypeError`/getter abrupt completion reached
their `catch` blocks:

- null-prototype computed instance accessor (`:68`);
- null-prototype computed static accessor (`:82`);
- inherited `Symbol.toPrimitive` getter through a computed instance accessor
  (`:110`); and
- the matching computed static accessor (`:138`).

No Test262 or #5239 command ran after this real failure. The prior attached
corpus artifact `.tmp/2175-d5-null-proto-rows.jsonl` remains preserved and is
still the **0 / 4** diagnostic evidence; it was not overwritten. The current
`nested-declarations.ts` conversion attempt is therefore ineffective for these
forms and must be removed or replaced rather than supplemented with a second,
stacked effect.

#### Required second-pass diagnosis before another compiler run

1. Trace the exact declaration and comma-expression class evaluation lowering,
   including the `irClassBodyRouting`/prepared-unit gate. Prove whether
   `emitPreparedAccessorComputedNameEffects` is unselected or its output is
   detached from the generated body; do not infer reachability from its source
   name alone.
2. Identify the single ClassDefinitionEvaluation emission point that owns both
   the pinned declaration and expression forms, then move the conversion there
   exactly once. Remove the ineffective hook if that point subsumes it.
3. Add a focused static non-vacuity assertion tied to the named generated
   function/body (not a global substring): it must prove the computed-name path
   contains the `__to_property_key` call for both instance and static shapes
   before the next runtime replay.
4. Preserve the full-`GetMethod` `Symbol.toPrimitive` requirement and the
   existing D5/Proxy/#5239 controls. After static proof and review, rerun the
   same serial focused file once; stop immediately on any failure.

No GitHub issue was created.

### Corrected computed-accessor root cause and replacement plan (2026-08-31)

The real **0 / 4** corpus failure and the subsequent **25 / 29** focused
replay falsify the earlier prepared-helper-only hypothesis. The D5
null-terminal classifier itself is not the escape: each row discards a dynamic
computed accessor name before it reaches `ToPropertyKey`.

Read-only route tracing identifies the actual ClassDefinitionEvaluation
owners:

- a source-file declaration accepted by
  `collectPreparedTopLevelClassComputedNameEffects` is placed in the module
  timeline, then reaches `compileModuleInitBody` → `compileStatement` →
  `compileNestedClassDeclaration`; ordinary nested declarations reach that
  same last owner directly;
- the pinned `0, class { … }` expression reaches
  `compileExpression` → `compileClassExpression` in
  `expressions/new-super.ts`, so it never selects the former prepared-only
  hook; and
- a variable-bound class expression can materialize through the singleton
  branch in `statements/variables.ts`, bypassing `compileClassExpression`.

The repair removes the ineffective prepared-only accessor-name hook rather
than layering another call beside it. Its replacement is the one shared
`emitUnresolvedComputedAccessorNameEffects` emitter in
`statements/nested-declarations.ts`. It walks only unresolved computed
get/set accessors in source order, evaluates each raw name once to
`externref`, applies `emitToPropertyKeyOnce`, then drops the converted key.
Its owners are deliberately disjoint: genuine declarations in
`compileNestedClassDeclaration`, generic expressions in
`compileClassExpression`, and only the singleton branch in
`compileVariableStatement`. Thus a class expression passed through the nested
body compiler does not receive a second effect. The singleton branch's
`classObjectGlobals`/`structMap`/`structFields` preconditions exactly cover all
`emitLazyClassObjectGet` false returns, so its generic-expression fallback is
not reachable after it has emitted the key effect.

The companion `object-runtime.ts` repair changes `@@toPrimitive` from a raw
own-entry probe to `__extern_get` followed by the existing callable/result
checks. This is the required ordinary `GetMethod` behavior: an inherited
`Symbol.toPrimitive` data method or accessor getter sees the original receiver,
and a getter's abrupt completion reaches the caller before ordinary
`valueOf`/`toString` fallback. It does not alter the D5 terminal predicate,
the fixed-name `in` helper, Proxy routing, or the #5239 class-instance bridge.

#### Static reachability proof before the next compiler replay

The focused file retains one top-level declaration control and compiles the
Test262-shaped declaration and comma-expression forms in named function
bodies—the latter matches the `assert.throws` callback lowering in the four
rows. A balanced WAT-function extractor resolves numeric direct-call indices in
each exact body: `$__module_init`, `$declarationProbe`, and
`$expressionProbe` must each own **one** `__to_property_key` call. This catches
both a dead/unselected route (zero calls) and accidental double evaluation (too
many calls), without relying on a module-wide substring.

The runtime half retains four non-vacuous controls: null-prototype instance and
static names must throw `TypeError`; instance and static inherited
`Symbol.toPrimitive` getter cases must preserve the unique abrupt identity,
run once, and make no `toString` fallback call. Together with the prior 25 D5
controls, the next focused replay has **30 controls**.

#### Acceptance sequence and risks

1. Run targeted Prettier/Biome lint and `git diff --check`, then one serial
   focused 30-control Vitest replay. Stop immediately on a real failure.
2. Only if focused green, rerun the exact four-row standalone manifest twice
   with determinism enabled, write a new JSONL artifact (preserving
   `.tmp/2175-d5-null-proto-rows.jsonl`), and reconcile row/callback/JSONL
   counts.
3. Only if all four rows are green, run the #5239 focused regression serially.

Risks are confined to ClassDefinitionEvaluation timing and cardinality:
evaluating a name twice, changing getter/setter order, or emitting the effect
after class materialization is observable. The exact named-body WAT controls
guard the retained top-level declaration and callback-equivalent declaration /
expression paths; the runtime sentinel controls guard GetMethod abrupt behavior;
and the existing D5,
ordinary-object, Proxy, proto-index, mutation, and #5239 controls guard the
unrelated routes. No prototype representation, proto-index ABI, Test262 row,
or #5239 source is broadened or changed.

No GitHub issue was created.

#### Second-pass static boundary (runtime lane held)

Before any further compiler execution, source inventory confirmed exactly four
shared-emitter call sites: the two mutually exclusive declaration outcomes in
`compileNestedClassDeclaration`, the generic expression owner, and the
variable singleton owner. No former
`emitPreparedAccessorComputedNameEffects` source symbol remains; its only
mention is the preserved first-pass diagnostic history above. The focused file
contains **30** controls, including the named module-init/declaration/expression
WAT cardinality assertion.

The following read-only static gates passed on the dirty d60 worktree:

~~~sh
prettier --check plan/issues/2175-standalone-builtin-prototype-readers.md \
  src/codegen/object-runtime.ts src/codegen/statements/nested-declarations.ts \
  src/codegen/expressions/new-super.ts src/codegen/statements/variables.ts \
  tests/issue-2175-null-proto-toprimitive.test.ts
biome lint --diagnostic-level=error src/codegen/object-runtime.ts \
  src/codegen/statements/nested-declarations.ts \
  src/codegen/expressions/new-super.ts src/codegen/statements/variables.ts \
  tests/issue-2175-null-proto-toprimitive.test.ts
biome check --formatter-enabled=false --diagnostic-level=error \
  tests/issue-2175-null-proto-toprimitive.test.ts
git diff --check
~~~

The focused-test Biome check, all targeted lint, Prettier, and whitespace diff
check passed. A wider `biome check` over the legacy source files reports only
its pre-existing full-file import-sort suggestions; no broad import reorder was
applied because it would be unrelated to this repair. The WAT assertion is
installed but deliberately unexecuted: root has held the sole #2175
compiler/Vitest/Test262 lane while the other available lanes are occupied. The
next permitted command remains the one-worker focused 30-control replay; the
historic **25 / 29** failure and `.tmp/2175-d5-null-proto-rows.jsonl` remain
preserved.

No GitHub issue was created.

### Second computed-accessor replay: BLOCK at 29 / 30 (2026-08-31)

After root released the sole #2175 validation lane, one serial Vitest fork ran:

~~~sh
node /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

It completed in **17.09 s** with **29 / 30** controls passing. The only
failure is the new structural proof at
`tests/issue-2175-null-proto-toprimitive.test.ts:111`: the balanced
`$__module_init` extractor resolved **one** direct `__to_property_key` call
where the top-level declaration-plus-bare-expression fixture expected two.
The loop stopped at that first body, so it did not report the subsequently
listed named-function WAT cardinalities.

This is not a runtime regression claim: the other 29 controls passed,
including all four new direct class-key/GetMethod controls for the declaration
and comma-expression routes, the inherited `Symbol.toPrimitive` getter's
identity/one-call/no-fallback checks, and the prior D5/Proxy controls. The
remaining question is therefore the top-level bare expression's module-init
collection/ownership versus the test's overstrong two-call expectation. It
must be diagnosed before altering the proof or stacking a source change.

Per the one-worker stop-on-failure rule, no four-row Test262 replay,
determinism/census artifact, or #5239 regression ran. The prior real-failure
artifact `.tmp/2175-d5-null-proto-rows.jsonl` remains untouched. No commit,
push, PR, or GitHub issue occurred.

#### WAT attribution diagnosis before static-control repair

A diagnostic-only standalone compile of the exact focused fixture inspected the
balanced generated WAT bodies and resolved direct numeric call indices against
the import-plus-definition function order. Its relevant calls are:

- `$declarationProbe`: `181:__object_create`, then
  `133:__to_property_key` at WAT line **6633**;
- `$expressionProbe`: `181:__object_create`, then
  `133:__to_property_key` at WAT line **6649**; and
- `$__module_init`: `181:__object_create`, then
  `133:__to_property_key` at WAT line **43961**, then a second
  `181:__object_create` with **no** following `__to_property_key` call.

There is no separate generated function containing the bare top-level
`0, class` conversion. Static tracing explains that distribution: the module
initializer collector sees the statement as a comma `BinaryExpression`, and
its `expressionRunsUserCode` predicate does not classify a dynamic
`ClassExpression` name as provably effectful. That bare expression is therefore
recorded/dropped by the top-level collection path. This is an adjacent
module-init collection exposure, but it is not the four-row Test262 route:
each expression row evaluates `0, class` inside an `assert.throws` callback,
which is represented by the proven `$expressionProbe` path. The matching
declaration callback route is likewise proven by `$declarationProbe`; all four
runtime controls already passed in the 29 / 30 replay.

Accordingly, do not broaden this D5 repair into that separate top-level
collection issue. The fixture's two-call `$__module_init` expectation is wrong
for the exact residual proof. Replace it with the observed, non-global
one-call-per-body distribution: one call in `$__module_init` for the retained
top-level declaration control, one in `$declarationProbe`, and one in
`$expressionProbe`. Remove only the unrelated bare top-level comma-expression
fixture; do not change runtime source.

### Corrected focused replay: PASS at 30 / 30 (2026-08-31)

After the evidence-only fixture correction, the same one-worker command ran:

~~~sh
node /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

**Result: 30 / 30 passed** in **16.51 s** (one file, one fork, no file
parallelism). The static control now proves the exact observed distribution:
one direct `__to_property_key` call in each of `$__module_init`,
`$declarationProbe`, and `$expressionProbe`. The remaining 29 controls include
the null-prototype declaration/comma-expression throws, both inherited
`Symbol.toPrimitive` getter abrupt-identity/one-call/no-fallback controls, and
the prior D5/Proxy/fnctor/transition controls.

This supersedes neither the preserved **25 / 29** nor **29 / 30** diagnostics;
those remain evidence of the rejected prepared-only route and the corrected
static-fixture denominator. It releases the next serial stage only: the exact
four-row standalone deterministic manifest, with a fresh output path that must
not overwrite `.tmp/2175-d5-null-proto-rows.jsonl`. No Test262 or #5239 command
has yet run in this corrected stage. No GitHub issue was created.

### Corrected four-row standalone replay: PASS at 4 / 4 (2026-08-31)

The attached local corpus remains detached at
`b363f29d3c43c626dc852744ad64a0b48a003693`. One serial harness process ran
the exact sorted four-row manifest twice per row:

~~~sh
node --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows-corrected.jsonl
~~~

The byte-sorted LF manifest SHA-256 is again
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`. Both
mandatory controls demonstrated the two required directions before measurement:
`must-pass -> pass` and `must-fail -> fail` (the latter through the expected
`Test262Error`). The harness then reported **4 / 4 pass**, total `4` with
counts summing, and **0 nondeterministic** readings.

The fresh artifact
`.tmp/2175-d5-null-proto-rows-corrected.jsonl` has exactly four standalone
`pass` rows; its target is uniformly `standalone` and its sorted paths exactly
equal the requested manifest. This supersedes neither the preserved prior
**0 / 4** diagnostic artifact
`.tmp/2175-d5-null-proto-rows.jsonl` nor its root-cause history. The sole
remaining released validation command is the serial #5239 focused regression.
No GitHub issue was created.

### #5239 bridge regression: PASS at 2 / 2 (2026-08-31)

Only after the corrected four-row replay was fully green, one serial Vitest
fork ran:

~~~sh
node /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-5239-object-create-class-prototype.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

**Result: 2 / 2 passed** in **9.09 s** (one file, one fork, no file
parallelism). This is a regression-only confirmation: neither the #5239 bridge
source nor its test changed in this D5 slice. Alongside the corrected focused
**30 / 30** and exact standalone **4 / 4** deterministic manifest, the
released #2175 validation sequence is complete. No commit, push, PR, or GitHub
issue was created.

Final targeted static gates also passed: Prettier checked the tracker, all six
changed #2175 source files, and the focused test; Biome lint checked those
seven TypeScript files; Biome check (with its formatter disabled) checked the
focused test; and `git diff --check` was clean. The dirty inventory is limited
to the tracker; `binary-ops-in.ts`; `object-runtime-prototype.ts`;
`object-runtime.ts`; `nested-declarations.ts`; `new-super.ts`; `variables.ts`;
and the new focused test. The two four-line JSONL artifacts are ignored test
evidence, not staged source changes.

### Independent P2 review BLOCK — exact WAT attribution (2026-08-31)

**Verdict: BLOCK (test-proof only).** The 30-control replay remains real
evidence for the observed d60 snapshot, and the native D5 semantics, Proxy
single-observation behavior, GetMethod path, computed-name ownership, and
#5239 boundary have no newly found source defect. However,
`extractWatFunctionBody` in
`tests/issue-2175-null-proto-toprimitive.test.ts` begins at a prefix
`indexOf("(func $${name}")`; it neither requires a complete function-name
token nor proves that exactly one definition owns that name. In particular a
missing `$__module_init` could be masked by a `$__module_init_chunk_*` body.
Its numeric call resolver also substitutes `"<missing>"` and does not reject
duplicate callable names. The tracker must not continue to call that a robust
exact named-body proof.

The bounded repair changes only the focused test's WAT utilities:

1. Discover function headers, require unique definition names, select the
   requested name by exact equality, then retain the existing balanced
   parenthesis extractor for that one body.
2. Follow the local `issue-1004` resolver posture: reject duplicate callable
   names and throw when a numeric call index has no exact target.
3. Retain the three exact `__to_property_key` cardinalities, all 30 behavioral
   controls, the corrected 4 / 4 manifest evidence, the unchanged #5239 2 / 2
   control, and the documented adjacent top-level bare comma-class collector
   gap. Do not alter compiler/runtime sources or rerun a compiler lane until
   released.

After this test-only repair, run only targeted whitespace, Prettier, Biome,
and inventory checks. No compiler, Vitest, Test262, TypeScript, hook, commit,
push, PR, or GitHub issue is authorized by this checkpoint.

#### P2 proof-repair static checkpoint

The focused test now enumerates WAT definition headers, requires a unique
exact-name match before balanced extraction, and rejects duplicate or missing
numeric call targets. Its three `__to_property_key` cardinalities and all 30
behavioral controls are unchanged.

Targeted static evidence passed after the repair: Prettier checked this tracker
and the focused test; Biome lint and Biome check with formatting disabled
checked the focused test; and `git diff --check` was clean. The inventory stays
exactly the existing eight #2175 paths: this tracker, six pre-existing source
paths, and `tests/issue-2175-null-proto-toprimitive.test.ts`. No compiler,
Vitest, Test262, TypeScript, hook, commit, push, PR, or GitHub action ran.

### Released exact-header/numeric-resolver focused replay: PASS at 30 / 30 (2026-08-31)

After the independent PASS of the test-only exact-header/numeric-resolver
repair, exactly one Vitest fork replayed the focused proof with file parallelism
disabled:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-2175-null-proto-toprimitive.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

**Result: 30 / 30 passed** in **18.52 s** (one file, one Vitest fork, no file
parallelism). An earlier unqualified `node` invocation did not launch Vitest
because the default shell path has no `node`; it is not validation evidence.

The three exact named-body `__to_property_key` cardinalities and all behavioral
controls remain green. Relative to the corrected **4 / 4** deterministic
Test262 evidence and unchanged **2 / 2** #5239 regression evidence above, the
only intervening change is this focused test's WAT-attribution utility; all
#2175 compiler/runtime source is unchanged. This replay made no source edit and
did not run Test262, #5239, TypeScript, hooks, or any Git operation. No GitHub
issue was created.

### Commit-hook provisioning retry (2026-08-31)

The first normal commit invocation stopped before `lint-staged` because the
initial worktree `PATH` exposed `node` and `pnpm` but not the hook's `npx`
launcher. No hook body, compiler, test, commit, or task-specific stash ran or
was created, and the exact eight-path staged inventory remained intact. The
retry uses the existing `/private/tmp/npx` wrapper (which delegates to
`pnpm exec`) plus the bundled Node runtime and will run the complete normal
hook chain without any skip variable.

The provisioned retry completed `lint-staged` (Prettier and Biome) and then
stopped at the unconditional LOC budget gate. It reported only the intended
runtime-site growth in `new-super.ts` (+6) and `variables.ts` (+2); the already
declared `object-runtime.ts` allowance was consumed successfully. Those two
exact paths are now documented under this issue's `loc-budget-allow` with their
route-ownership rationale. No compiler/test lane or commit ran, `lint-staged`
removed its temporary backup, and the same eight paths remain staged for a full
normal-hook retry.

That retry passed `lint-staged` and the complete LOC budget gate, consuming all
three exact path grants. It then stopped at the unconditional function budget
gate on three intended route owners: `buildObjectPrototypeHelpers` (+60),
`compileInOperator` (+19), and `compileVariableStatement` (+2). This issue now
grants only those exact function keys with their ownership rationale; no
baseline file changed. No compiler/test lane or commit ran, the temporary
`lint-staged` backup was removed, and the eight-path inventory remains staged
for another full normal-hook retry.

The following retry passed `lint-staged` and the LOC gate again, but dependency
resolution stopped the function gate before its census: while the shared root
`node_modules` links were being refreshed elsewhere, Node transiently could
not resolve `typescript`. No compiler/test lane or commit ran, the
`lint-staged` backup was removed, and the staged inventory remains unchanged.
A direct `import("typescript")` probe now resolves version 5.9.3 from the same
worktree, so the retry remains the complete normal hook chain rather than a
skipped or substituted gate.

### Integrated merge-head replay plan (2026-08-31)

The validation head is merge commit
`ef9e5e274b9c2208ea33ed01193a410eacac90be`, with upstream parent
`d1f2ed7d45b2c280cb5cea68266e73665a70f7f1`. The merged upstream delta is
documentation/artifact-only for this slice; it has no owned D5 source or test
overlap. This plan therefore replays the already reviewed D5 behavior at the
integrated head without copying, merging, or changing any implementation.

The integrated-head normal hook has already passed the focused #2175 **30 / 30**
proof, targeted lint/format, LOC/function budgets, and oracle ratchet. That is
recorded evidence and will not be rerun in this lane. The remaining commands
are strictly serial, with at most one compiler/test process:

1. Run the exact sorted four-row standalone manifest with
   `harness-flip-probe --check-determinism`, which first executes its mandatory
   must-pass and must-fail controls. Write a fresh ignored artifact at
   `.tmp/2175-d5-null-proto-rows-integrated-ef9.jsonl`, preserving both earlier
   JSONL artifacts. Reconcile the byte-sorted LF manifest SHA-256
   `ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`, two
   deterministic measurements per row, exactly four callbacks/rows, all-four
   `standalone` pass results, and the exact requested paths.
2. Only if that replay is fully green, run
   `tests/issue-5239-object-create-class-prototype.test.ts` in one Vitest fork
   with file parallelism disabled; expected result is **2 / 2**.
3. Only if #5239 is green, run the documented TS7 typecheck
   (`node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`) and
   `git diff --check` serially. The hook evidence above substitutes for another
   focused replay, Prettier/Biome, budget, or oracle invocation.

Stop at the first real failure, retain its fresh artifact/output, and record
the exact command and result here. No source/test edit, Test262 corpus update,
commit, push, PR, or GitHub issue is authorized by this replay.

No GitHub issue was created.

### Integrated four-row standalone replay: PASS at 4 / 4 (2026-08-31)

At integrated merge head `ef9e5e274b9c2208ea33ed01193a410eacac90be`, with
the local corpus still detached at
`b363f29d3c43c626dc852744ad64a0b48a003693`, exactly one harness process ran:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --import tsx scripts/harness-flip-probe.ts --target standalone \
  --check-determinism \
  --paths test/language/expressions/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/expressions/class/accessor-name-static/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-inst/computed-err-to-prop-key.js,test/language/statements/class/accessor-name-static/computed-err-to-prop-key.js \
  --out .tmp/2175-d5-null-proto-rows-integrated-ef9.jsonl
~~~

Exact harness output was: `control: must-pass -> pass`; `control: must-fail ->
fail (Test262Error: this comparison must fail Expected SameValue(«1», «2») to
be true | at L13: assert.sameValue(1, 2, "this c)`; `control: OK — instrument
reports both directions.`; `running 4 file(s) through the assembled harness...`;
`{"pass":4}`; `total: 4 (counts verified to sum)`; `nondeterministic: 0`; and
`wrote 4 rows to .tmp/2175-d5-null-proto-rows-integrated-ef9.jsonl`.

The byte-sorted LF manifest SHA-256 is
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`.
The fresh ignored JSONL has exactly four rows/results (one for each requested
callback), each with `target: standalone` and `status: pass`; its sorted paths
are exactly the requested four distinct paths, one record each. That reconciles
the four callbacks, four requested rows, four JSONL records, and harness total
without replacing either preserved historical artifact.

### Integrated #5239 bridge regression: PASS at 2 / 2 (2026-08-31)

Only after the integrated four-row manifest was fully green, exactly one Vitest
fork ran:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/thomas/Code/js2/node_modules/vitest/dist/cli.js run \
  tests/issue-5239-object-create-class-prototype.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true \
  --no-file-parallelism --reporter=dot
~~~

It exited 0: one test file passed and **2 / 2** tests passed. Vitest reported
**9.77 s** total duration (`transform 6.34 s`, `collect 8.66 s`, tests
`840 ms`, `prepare 49 ms`). This preserves the #5239 class-prototype bridge
regression boundary; neither that source nor test changed in this D5 replay.
The TS7 typecheck and `git diff --check` are now the remaining released serial
checks. No source or test changed, and no GitHub issue was created.

### Integrated TS7 typecheck: BLOCK (2026-08-31)

After the integrated four-row **4 / 4** replay and #5239 **2 / 2** regression
were both green, the next single process ran:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
~~~

It exited **1** after **13.82 s**. Exact output follows:

~~~text
src/codegen/object-runtime.ts(2298,7): error TS2322: Type '{ op: "local.get"; index: number; } | { op: "call"; funcIdx: number; } | { op: "local.tee"; index: number; } | { op: "ref.is_null"; } | { op: "i32.eqz"; } | { op: "if"; blockType: { kind: "empty"; }; then: ({ ...; } | { ...; })[]; } | ... 9 more ... | Instr' is not assignable to type 'Instr'.
  Type '{ op: string; index: number; }' is not assignable to type 'Instr'.
    Types of property 'op' are incompatible.
      Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2314,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2315,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2316,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2317,7): error TS2322: Type '{ op: "local.get"; index: number; } | { op: "call"; funcIdx: number; } | { op: "local.tee"; index: number; } | { op: "ref.is_null"; } | { op: "i32.eqz"; } | { op: "if"; blockType: { kind: "empty"; }; then: ({ ...; } | { ...; })[]; } | ... 9 more ... | Instr' is not assignable to type 'Instr'.
  Type '{ op: string; index: number; }' is not assignable to type 'Instr'.
    Types of property 'op' are incompatible.
      Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2323,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2325,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2444,9): error TS2322: Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(2588,7): error TS2322: Type '{ op: string; index: number; } | { op: string; funcIdx: number; } | { op: string; blockType: { kind: string; type: { kind: string; }; }; then: Instr[]; else: Instr[]; } | Instr' is not assignable to type 'Instr'.
  Type '{ op: string; index: number; }' is not assignable to type 'Instr'.
    Types of property 'op' are incompatible.
      Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
src/codegen/object-runtime.ts(4641,11): error TS2322: Type '({ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "local.get"; index: number; } | { op: "i32.const"; value: number; } | { op: "i32.eq"; } | { op: "return"; })[]; } | ... 7 more ... | { ...; })[]; } | { ...; } | { ...; } | { ...; } | Instr)[]' is not assignable to type 'Instr[]'.
  Type '{ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "local.get"; index: number; } | { op: "i32.const"; value: number; } | { op: "i32.eq"; } | { op: "return"; })[]; } | ... 7 more ... | { ...; })[]; } | { ...; } | { ...; } | { ...; } | Instr' is not assignable to type 'Instr'.
    Type '{ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "local.get"; index: number; } | { op: "i32.const"; value: number; } | { op: "i32.eq"; } | { op: "return"; })[]; } | { op: "ref.is_null"; } | ... 6 more ... | { ...; })[]; }' is not assignable to type 'Instr'.
      Types of property 'then' are incompatible.
        Type '({ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "local.get"; index: number; } | { op: "i32.const"; value: number; } | { op: "i32.eq"; } | { op: "return"; })[]; } | { op: "ref.is_null"; } | { op: "i32.eqz"; } | ... 5 more ... | { ...; })[]' is not assignable to type 'Instr[]'.
          Type '{ op: "if"; blockType: { kind: "empty"; }; then: ({ op: "local.get"; index: number; } | { op: "i32.const"; value: number; } | { op: "i32.eq"; } | { op: "return"; })[]; } | { op: "ref.is_null"; } | { op: "i32.eqz"; } | ... 5 more ... | { ...; }' is not assignable to type 'Instr'.
            Type '{ op: string; index: number; }' is not assignable to type 'Instr'.
              Types of property 'op' are incompatible.
                Type 'string' is not assignable to type '"any.convert_extern" | "array.copy" | "array.fill" | "array.get" | "array.get_s" | "array.get_u" | "array.len" | "array.new" | "array.new_default" | "array.new_fixed" | "array.set" | ... 235 more ... | "v128.xor"'.
~~~

This is a real static failure in existing #2175-owned
`src/codegen/object-runtime.ts` emission-array typing, concentrated at lines
2298, 2314–2317, 2323, 2325, 2444, 2588, and 4641. Per the integrated replay
plan, the sequence stops here: `git diff --check` and all remaining checks were
not run, no source/test was altered, and the fresh green Test262 JSONL remains
preserved. No GitHub issue was created.

### TS7 merge-block repair plan (2026-08-31)

This is a merge-blocking static regression, not a runtime/Test262 behavior
failure. Read-only source inspection reduces the nine TS2322 locations to two
native emission bodies: `__extern_get` at 2275 and `__extern_has` at 4641. The
new D5 receiver-aware companion tails contain exactly three conditional literal
instruction arrays that lack an `Instr[]` contextual check: the get tail at
2588 and the fnctor/direct has tails at 4777 and 4845. TS7 consequently widens
their `{ op: ... }` literals to `string`; that widened branch contaminates each
containing body, producing the apparent errors at earlier ordinary instructions
as well.

The bounded repair is type-only and preserves emitted instruction order,
branches, locals, helper calls, and runtime behavior: wrap only those three
literal tail alternatives in `satisfies Instr[]`. It uses neither `any` nor a
cast, does not change the `Instr` union, and keeps the existing explicit-null,
ordinary terminal, fnctor, Proxy, and #5239 control flow byte-for-byte at
runtime. The direct acceptance controls are the prior integrated Test262 **4 /
4**, #5239 **2 / 2**, and focused **30 / 30** evidence; after the edit, run
only targeted Prettier/Biome and `git diff --check`. An independent reviewer
must rerun TS7 before this blocker is cleared; no compiler, Vitest, Test262,
TS7 rerun, hook, or Git mutation is authorized in this repair lane.

Risks are limited to accidentally widening the annotation beyond the three D5
tail arrays or changing their evaluation order. The patch will avoid both, and
the follow-up review must verify that all three source alternatives still emit
the same direct `local.get`/predicate/call/`if` sequence.

No GitHub issue was created.

### TS7 merge-block repair: static checkpoint (2026-08-31)

The repair changed only `src/codegen/object-runtime.ts` at the three planned
D5 companion tails:

- `__extern_get` terminal get-miss alternative (2588):
  `: ([…] satisfies Instr[])`;
- `__extern_has` approved-fnctor terminal has-miss alternative (4777):
  `: ([…] satisfies Instr[])`; and
- `__extern_has` direct-$Object terminal has-miss alternative (4845):
  `: ([…] satisfies Instr[])`.

Each is a contextual type constraint on the existing literal array, not a
cast. The emitted `local.get`, terminal-predicate call, and value-producing
`if` remain in the same order with the same operands; no `any`, `Instr`-union,
control-flow, helper, local, source test, or Test262 row changed.

The only permitted post-edit static gates passed:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/prettier/bin/prettier.cjs --check \
  plan/issues/2175-standalone-builtin-prototype-readers.md \
  src/codegen/object-runtime.ts
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/@biomejs/biome/bin/biome lint --diagnostic-level=error \
  src/codegen/object-runtime.ts
git diff --check
~~~

Prettier reported `All matched files use Prettier code style!`; Biome checked
one file with no errors or fixes; and `git diff --check` exited 0. The dirty
inventory is now exactly this tracker and `src/codegen/object-runtime.ts`.
TS7, compiler, Vitest, Test262, hooks, and Git mutations remain deliberately
unrun after this repair. The next required step is independent review followed
by an authorized TS7 rerun; until then the prior TS7 BLOCK is not cleared.

No GitHub issue was created.

### Independent TS7 repair review and released replay plan (2026-08-31)

An independent read-only review accepted the bounded repair. The unstaged
source delta adds exactly three `satisfies Instr[]` contextual checks, at the
`__extern_get` terminal get-miss alternative and the approved-fnctor/direct
`__extern_has` terminal has-miss alternatives. Those are the three literal
arrays identified as the source of all nine TS2322 diagnostics. `Instr`
requires nested `if.then`/`if.else` values to be `Instr[]`, so the contextual
checks also validate the nested arrays rather than concealing a heterogeneous
instruction. The delta adds no `as`/`any`, helper, local, branch, or emitted
instruction; `satisfies` is type-only.

The index is empty. The dirty inventory remains exactly this tracker and
`src/codegen/object-runtime.ts`; staged and unstaged targeted `git diff --check`
both exit 0. The released replay is one direct TypeScript 7 process:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
~~~

Only after a clean exit may the targeted tracker/source `git diff --check`,
Prettier, and Biome checks run. No compiler, Vitest, Test262, source/test edit,
or Git mutation is part of this replay.

### TS7 replay attempt — non-authoritative wrapper loss (2026-08-31)

The released direct Node command was launched once and occupied the lane for
13.9 seconds with no TypeScript diagnostics printed. The timing wrapper then
attempted to assign zsh's read-only special parameter `status` after Node
returned, producing `zsh: read-only variable: status` before it could capture
the compiler's actual exit code. That shell failure is not evidence of a
TypeScript failure, but it also prevents claiming a clean TypeScript exit.
This attempt is therefore non-authoritative. No post-green diff, Prettier, or
Biome gate ran; the approved next action is one exact direct TS7 rerun with a
nonreserved result variable, followed by those static gates only on exit 0.

### Released TS7 replay: PASS (2026-08-31)

The authorized clean replay ran exactly:

~~~sh
/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
~~~

It exited **0** after **13 seconds** with no diagnostics. This is the
authoritative result; the preceding wrapper-loss attempt remains recorded only
as non-evidence. The released post-green checks also exited 0:

- targeted `git diff --check` on this tracker and
  `src/codegen/object-runtime.ts` produced no whitespace errors;
- Prettier reported `All matched files use Prettier code style!`; and
- Biome checked the one TypeScript source file with no errors or fixes.

No compiler, Vitest, Test262, source/test change, hook, Git add, commit, push,
or PR operation ran in this validation step.

### Integrated commit and publication handoff (2026-08-31)

The type-only repair and this issue record were committed at `73f9ac0bb3` on
top of the reviewed implementation commit `18d4d05e37` and the normal upstream
merge `ef9e5e274b` (whose upstream parent is current `d1f2ed7d45`). The normal
commit hook passed `lint-staged`, all exact LOC/function budget grants, the
focused #2175 file at **30 / 30**, and the oracle ratchet. The branch therefore
retains the integrated exact Test262 **4 / 4** deterministic evidence, #5239
**2 / 2**, and authoritative TS7 exit 0 above.

This documentation checkpoint is followed by the repository's complete
pre-push hook on its exact final head. Publication remains a separate,
non-draft PR because the fix is locally mergeable; it must target
`loopdive/js2:main`, use the fork branch only as the PR head, and cite this
repository-local issue file. No GitHub issue was created. The environment still
requires explicit user authorization before this workspace's source/history
may be pushed to `https://github.com/ttraenkler/js2`; no push or PR operation
has occurred without that authorization.

## Live-main integration plan — 2026-09-01

Fresh `git fetch upstream main` resolves `loopdive/js2:main` to
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`, one commit ahead of this branch's
integrated base `d1f2ed7d45b2c280cb5cea68266e73665a70f7f1`. The upstream delta contains
only Test262 benchmark/report mirrors plus `scripts/loc-budget-baseline.json`;
it has no direct overlap with the eight #2175-owned paths.

The normal merge hook's blanket `*.json` lint-staged rule can reformat four
generated report mirrors that upstream deliberately stores outside Prettier's
shape. Before the no-commit merge, add those four exact paths to a temporary,
worktree-only `.prettierignore` block via `apply_patch`; never stage or commit
that block. This keeps the unskipped hook from manufacturing an unrelated PR
diff while every semantic and quality gate still runs. After the attributed
normal merge commit, remove the temporary block via `apply_patch` and prove
`.prettierignore` is byte-identical to `HEAD` and the PR range still contains
exactly the eight owned paths.

Then repeat the integrated focused **30/30** controls, the #5239 bridge **2/2**,
TS7/typecheck, and the complete synthetic-ref pre-push hook on the actual final
HEAD. Stop on any regression or generated-path leak. Publication remains
blocked pending explicit authorization to push this completed branch to the
public `ttraenkler/js2` fork for a non-draft PR against `loopdive/js2:main`; no
push or GitHub mutation is part of this integration plan.

### Live-main integrated validation handoff — 2026-09-01

The plan was committed normally at `dfba027113`; its hook passed the focused
#2175 file **30 / 30**, all exact LOC/function grants, and the zero-growth
oracle ratchet. The attributed upstream merge is
`aab562d5836f9ca2ede9c01dd5b0425f053a65a7`, with second parent
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`. Its unskipped hook again passed
the exact grants, oracle ratchet, and focused **30 / 30** controls (26.26 s
total, 14.77 s test time).

The four-path worktree-only Prettier guard was never staged or committed and
was removed immediately after the merge. `.prettierignore` is byte-identical
to `HEAD`, the worktree is clean, and `git diff upstream/main...HEAD` contains
exactly the tracker, six implementation sources, and the focused test—no
benchmark, public-report, website-report, or `labs/` path.

One serial deterministic harness process then ran the four exact standalone
rows into `.tmp/2175-d5-null-proto-rows-integrated-aab.jsonl`. Its mandatory
must-pass and must-fail controls both behaved correctly; the result was **4 /
4 pass**, total `4`, `nondeterministic: 0`. The JSONL contains four distinct
requested paths, four `target: standalone` rows, and four `status: pass` rows.
The byte-sorted LF manifest SHA-256 remains
`ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`.

Only after that green result, the one-fork #5239 bridge regression passed **2 /
2** (10.35 s total, 815 ms test time). Direct TypeScript 7 then exited **0**
with no diagnostics. This handoff note must pass the normal commit hook; the
resulting actual HEAD must pass the complete synthetic-ref pre-push hook before
publication. No push or GitHub mutation has occurred, and explicit
authorization for the public fork remains the only publication-permission
blocker.

## c112 live-main integration plan — 2026-09-01

Fresh upstream fetch resolves `upstream/main` to
`c11206262088a69815d6126787b10942df148b6d`, 55 commits after the branch's
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7` merge base. A read-only three-way
`git merge-tree --trivial-merge a4d141321daf7f8874e540d7b75f58f8c3e2c2a7
upstream/main HEAD` exits zero: Git predicts no conflict. Both sides modify
`src/codegen/expressions/new-super.ts`, but #2175 owns the class-expression
computed-accessor effect near `compileClassExpression`, while upstream #5244
updates the later dynamic-`new` constructor arm and its `__argc` publication.
The normal merge must retain both regions; do not resolve it by copying or
replacing the whole file.

The integration must preserve the D5 distinction between an implicit ordinary
Object-prototype terminal and an explicit null terminal across `Object.create`,
accepted/refused `Object.setPrototypeOf`, fixed-name `in`, and
OrdinaryToPrimitive readers. It must also preserve the direct/fnctor/proxy
routes, the existing #5239 class-instance bridge boundary, and upstream #5244
dynamic-constructor default-argument behavior. No generated benchmark/report,
website, public, `labs/`, or temporary `.prettierignore` path may enter the PR
range.

### Released-lane gate sequence

Until root releases a global lane, do not stage, commit, merge, run a hook,
compiler, TypeScript, Vitest, Test262, or any publication command. On release,
fetch upstream again; if `upstream/main` is no longer c112, re-audit the exact
new head before performing the normal merge. Then run, on the exact merged
HEAD, in this order:

1. the focused serial #2175 suite
   `node node_modules/vitest/dist/cli.js run tests/issue-2175-null-proto-toprimitive.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot`, expecting **30 / 30**;
2. the exact standalone deterministic four-row manifest, with the retained
   byte-sorted LF SHA-256
   `ce4e597c4194b44490b6d076870ff13f50948d972bb22ec366c06b7143ef5d50`,
   expecting **4 / 4**, both harness controls, and `nondeterministic: 0`;
3. the serial #5239 bridge suite, expecting **2 / 2**;
4. direct TS7 `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`;
5. targeted static checks for the #2175 tracker and owned TypeScript paths,
   including `git diff --check` and the repository formatting/lint gates;
6. the complete synthetic-ref pre-push hook on that exact final head; and
7. a no-leak audit: `git diff --name-only upstream/main...HEAD` must contain
   only this tracker, the six #2175 implementation sources, and
   `tests/issue-2175-null-proto-toprimitive.test.ts`.

Stop on any failure, conflict, changed denominator, nondeterminism, or leaked
path. Publication remains blocked even after all local gates: root must release
the lane and the user must explicitly authorize a push to the public
`ttraenkler/js2` fork and creation of the non-draft PR against
`loopdive/js2:main`.

### Publication authorization cleared — 2026-09-01

The user explicitly authorized publication of completed branches to
`https://github.com/ttraenkler/js2` for pull requests against
`loopdive/js2:main`. This clears the external-destination authorization block,
but does not waive the live-main validation sequence, exact-head pre-push gate,
or no-leak audit above. After those gates succeed, publication is a separate
non-draft upstream PR from the fork branch. No GitHub issue was created.

### c112 intermediate merge / e904 follow-up handoff — 2026-09-01

This worktree is intentionally stopped at the uncommitted normal merge of
`c11206262088a69815d6126787b10942df148b6d`: `HEAD` remains
`2918a145147c0c6d9e6287efe10f12e7ebd79d9b` and `MERGE_HEAD` is `c112`. At the
read-only audit boundary there were no unmerged entries and no unstaged diff.
The prospective #2175 delta measured against `MERGE_HEAD` was exactly these
eight paths: this tracker; `binary-ops-in.ts`, `new-super.ts`,
`object-runtime-prototype.ts`, `object-runtime.ts`,
`nested-declarations.ts`, and `variables.ts`; plus
`tests/issue-2175-null-proto-toprimitive.test.ts`. It contains no benchmark,
public/website-report, or `labs/` path. The broader staged index also contains
the incoming c112 files; those are merge inputs, not #2175 PR leakage.

`upstream/main` subsequently advanced to
`e904b5f4b254dc5ab667685b8493f250d177efda`. Its post-c112 delta overlaps the
owned range only in `src/codegen/object-runtime.ts` and
`src/codegen/statements/variables.ts`. The former is mechanically disjoint:
retain e904's `fillExternSetVecArms` canonical out-of-bounds/inherited-setter
decision and retain #2175's earlier D5 terminal marker, `__extern_get`,
`__extern_has`, fixed-name `in`, and OrdinaryToPrimitive changes. Do not copy
either whole file.

`variables.ts` needs a semantic, not merely textual, resolution. Retain e904's
central `tryCompileClassExpressionBindingValue`/Promise-subclass and
proxy/RegExp helper refactor, while preserving #2175's
`emitUnresolvedComputedAccessorNameEffects` exactly once at
ClassDefinitionEvaluation. Do not call that emitter unconditionally before the
helper: a helper fallback to `compileClassExpression` would then evaluate the
same computed accessor name twice. Instead, make the selected fast path expose
an on-handled/pre-materialization hook (including the Promise-subclass path),
invoke it only after the path is known to handle the value and before its
runtime constructor/singleton materialization, and retain the generic
`new-super.ts` owner for every `undefined` fallback. This preserves effect
order, avoids duplicate keys, and keeps e904's dynamic Proxy/class-expression
representation fixes.

Next owner: first make the attributed normal c112 merge commit; then, after a
fresh read-only `upstream/main` check, perform a normal no-commit e904 merge
and apply the two narrow reconciliations above. The historical integrated
evidence remains focused #2175 **30 / 30**, standalone deterministic **4 / 4**
with both controls and `nondeterministic: 0`, #5239 **2 / 2**, and TS7 exit 0;
it is prior evidence only and must not be represented as c112/e904-head
validation. On the final e904 head, rerun the released focused, four-row,
#5239, TS7/static, full synthetic-ref pre-push, and exact no-leak gates before
publishing one mergeable non-draft PR from `ttraenkler/js2` to
`loopdive/js2:main`. User authorization for that destination is recorded
above; no GitHub issue was created.

### Local hook-runner provenance — 2026-09-01

The first normal c112 merge-commit attempt stopped at
`.husky/pre-commit: line 1: npx: command not found`; it created no commit and
left the open merge index intact. No hook was skipped, weakened, or bypassed.
For the normal retry this worktree uses the ignored, fail-closed
`.tmp/bin/npx` wrapper: it accepts only `npx lint-staged`, delegates directly to
the existing root `node_modules/.bin/lint-staged`, and exits 127 for every
other invocation. The retry PATH prefixes that local directory and the
prescribed existing runtime/root-node-modules paths; it neither downloads
dependencies nor changes repository configuration. Stage this provenance note
with the existing tracker before retrying the ordinary hook-running commit.

### c112 durable merge evidence — 2026-09-01

The normal c112 merge committed at
`36ddfd42847491f64c3c3f483362fc08e12fe341` with parents
`2918a145147c0c6d9e6287efe10f12e7ebd79d9b` and
`c11206262088a69815d6126787b10942df148b6d`. Its full, unskipped hook was run
in a durable session and passed the LOC/function budgets and oracle ratchet.
The changed-root controls were all green: #2175 **30 / 30**, fresh-cache
Temporal **11 / 11** using the unique worktree-local
`JS2WASM_TEMPORAL_CACHE=.tmp/temporal-cache-c112`, #5225 **2 / 2**, #5242
**2 / 2**, #5243 **1 / 1**, and #5244 **9 / 9**. This is c112-head evidence;
it does not replace the required current-main merge and exact-head validation
below. No hook skip, `--no-verify`, source rewrite, push, or GitHub operation
was used for this commit.

### e59 live-main execution plan — 2026-09-01

Fresh `upstream/main` is
`e59af10496753d38352fdac74059872cd6033c7e`. The complete post-c112 delta has
the same two owned-path overlaps already audited: `object-runtime.ts` and
`variables.ts`; no other #2175 path moved. Merge normally without committing.
Keep e59's vec numeric miss/inherited-setter sequence in
`fillExternSetVecArms` and retain all earlier #2175 D5 terminal-gating code;
the regions are mechanically disjoint.

For `variables.ts`, retain e59's centralized Promise/class-expression,
Proxy, and RegExp helpers. The #2175 computed-accessor effect must be emitted
only after that centralized binding helper has actually handled a class value,
but must execute at runtime before its materialization. Use a local
transactional owner wrapper: remember the `fctx.body` length, call
`tryCompileClassExpressionBindingValue`, and only for a non-`undefined`
result remove its newly appended instruction suffix; emit
`emitUnresolvedComputedAccessorNameEffects`, remove that suffix, then append
the effect suffix followed by the handled materialization suffix. An
`undefined` result leaves the generic `compileExpression`/`new-super.ts` owner
unchanged, so it emits the effect exactly once itself. This covers both
singleton and Promise fast paths without an unconditional pre-emission,
fallback duplication, or a ninth PR path.
