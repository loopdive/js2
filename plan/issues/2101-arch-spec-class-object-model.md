---
id: 2101
title: "architect spec: class object model — constructor-as-value + prototype chain representation"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: codegen
language_feature: classes
goal: core-semantics
related: [2023, 2026, 2020, 1991, 2071]
origin: "2026-06-11 analysis program (report 01 CLASS family); stub 08-D16"
---

# #2101 — classes have no runtime object identity

## Problem

Classes lower to flat structs + static dispatch with no constructor
function object and no prototype object: `new.target` is a constant-1 stub
(#2023), classes aren't first-class values (`new K()` on a param throws,
`.constructor` identity broken — #2026), inherited statics unreachable
through the subclass (#2020 fixed point-wise by lookup-walk), `in` cannot
walk a chain (#1991 fixed point-wise via key lists), ctor object-override
unrepresentable (#2071). 11 June issues share this root.

## Root cause

No representation decision for "class as value" or the prototype chain;
the upstream review grades WasmGC codegen C− but proposes no class-model
work — a review gap.

## Deliverable (spec only)

`## Implementation Plan` deciding: per-class runtime descriptor struct
(class-id + ctor funcref + parent ref + method table?) vs fuller prototype
objects; what each option makes representable (#2023/#2026/#2071
feasibility verdicts); cost on the static-dispatch fast path; migration
phases. The #1965/#2082 ctor findings and #2086's consolidation feed in.

## Dupe check

Member issues filed; no model-level owner. New (analysis program).

---

## Implementation Plan (architecture spec — 2026-06-15, arch1)

> Verified against `origin/main` @ `516feec44`. Line/symbol anchors are from
> that HEAD; re-grep if drifted. This is a **representation + migration spec**,
> not a single-PR change. It feeds **#2158** (standalone class/prototype/
> descriptor residual, 1,388-test gap) and grades the feasibility of
> **#2023** (new.target), **#2026** (class-as-value), **#2071** (ctor override).

### Decision: complete the existing per-class singleton model — do NOT introduce a new descriptor struct

The compiler **already has** the constructor-object and prototype-object
representation. It is incomplete and host-dependent, not absent. Two per-class
mutable externref globals are registered for every WasmGC-backed class at
`class-bodies.ts:529-556`:

| Global | Context map | Purpose | Lazy-init |
|---|---|---|---|
| `__proto_<Name>` | `ctx.protoGlobals` | `ClassName.prototype`, `Object.getPrototypeOf(inst)` — reference identity | `emitLazyProtoGet` (`extern.ts:132`) |
| `__class_<Name>` (#1395) | `ctx.classObjectGlobals` | the class *value* `C` itself; receiver for `Object.getOwnPropertyDescriptor(C, …)`; `C === C` identity | `emitLazyClassObjectGet` (`extern.ts:229`) |

Both **reuse the `$ClassName` instance struct type** as their backing object
(not a dedicated descriptor struct) and derive identity from the *singleton
global*, not the struct shape. Both register a method-name CSV with the host
(`__register_prototype` / `__register_class_object`) so a host Proxy can present
a method-only own-key view.

**The architecture decision is therefore: do not invent a parallel
`ConstructorDescriptor` struct.** A second representation would have to be kept
coherent with `__class_`/`__proto_`, the `$ClassName` struct, `funcConstructorMap`,
`classTagMap`, and the `instanceof` tag-dispatch — five existing sources of
class truth. Instead, **make the existing `__class_<Name>` singleton the single
canonical "class value", make the existing `__proto_<Name>` singleton the single
canonical prototype, link them, and route every currently-broken site through
them.** Concretely the model becomes:

```
__class_<Name>  : externref   ← THE class value C. Carries:
   • __tag (field 0 of the backing $Name struct) = ctx.classTagMap.get(Name)
     — the globally-unique, canonicalization-immune class id (see §"#2009").
   • a link to __proto_<Name>   (Name.prototype)
   • a link to the parent's __class_<Parent>  (for super-chain new.target,
     Reflect.getPrototypeOf(C), and static inheritance #2020)
   • the ctor funcref (already reachable as funcMap.get(`${Name}_new`))
__proto_<Name>  : externref   ← Name.prototype. Carries:
   • __tag = classTagMap.get(Name)  (already set, extern.ts:159-161)
   • a .constructor link back to __class_<Name>
   • a link to the parent's __proto_<Parent>  ([[Prototype]] chain)
```

The links are stored either as extra fields on a small dedicated
**`$ClassMeta` struct** that the singletons wrap (preferred — see below), or as
side-table maps keyed by the canonicalization-immune `__tag` value. **Do not key
any cross-class link by `typeIdx` or by `ref.test $Struct`** (see #2009).

#### Recommended backing: one shared `$ClassMeta` struct, instances discriminated by `__tag`

Rather than overloading the `$ClassName` instance struct (which is shaped for
*instance fields* and is subject to iso-recursive canonicalization), register
**one** module-level struct type:

```
(type $ClassMeta (struct
  (field $tag        (mut i32))        ;; classTagMap value — unique per class
  (field $parentTag  (mut i32))        ;; parent's tag, -1 if none
  (field $ctorFunc   (mut funcref))    ;; ${Name}_new
  (field $proto      (mut externref))  ;; the __proto_<Name> object (Name.prototype)
  (field $methodCsv  (mut externref))  ;; transitive method-name CSV string
  (field $name       (mut externref))  ;; class .name string
  (field $isClass    (mut i32))))      ;; 1 = class ctor, 0 = function ctor (FunctionKind)
```

`__class_<Name>` holds (an externref view of) one `$ClassMeta` per class;
`__proto_<Name>` holds the prototype object whose `.constructor` points back to
that same `$ClassMeta`. Because there is exactly **one** `$ClassMeta` heap-type,
iso-recursive canonicalization is a non-issue *for the metadata* (there is
nothing to collide with); class identity rides the `$tag` **value**, which is
per-class data, immune to type merging — the exact discriminator
`compileInstanceOf`'s externref arm already trusts (`typeof-delete.ts:548-569`)
and the discriminator #1991-B1 and #2009 both converge on.

> **Why a struct and not just the `$ClassName` struct as today:** the current
> reuse of `$ClassName` works for *identity* (singleton global) but cannot
> carry the parent-link / ctor-funcref / method-CSV needed for `new.target`,
> dynamic `new K()`, and `.constructor` identity without colliding with real
> instance fields and without a canonicalization-safe id. `$ClassMeta` is small,
> shared, and standalone-emittable (no host import).

### What each option makes representable — feasibility verdicts

| Issue | Defect today | Verdict with `$ClassMeta` model | Phase |
|---|---|---|---|
| **#2023** new.target | `i32.const 1` truthiness stub (`expressions.ts:1251-1259`), constructor-only | **FEASIBLE.** Thread the constructing class's `$tag` as an implicit ctor param (default = own tag for direct `new Name()`, forwarded by `super()` from the derived tag). `new.target === C` lowers to `param_newTargetTag == classTagMap.get(C)`. Non-`new` invocation → undefined. No host dependency → works standalone. | P2 |
| **#2026** class-as-value / dynamic `new K()` | dynamic constructee falls to extern-class import intent, `runtime.ts` rejects → "No dependency provided for extern class" | **FEASIBLE for known closed class sets.** When `K` is a *parameter/variable* whose static type is a union of known classes (or `typeof C`), dispatch `new K()` on `K`'s `$ClassMeta.$tag` through a generated `br_table`/if-chain calling the right `${Name}_new`. For fully-open `any` with no class hint, fall back to the host extern-class path in JS-host mode and a **loud compile diagnostic** in standalone mode (do not silently miscompile). `.constructor === A` becomes true because both sides resolve to the same `__class_<A>` singleton. | P3 |
| **#2071** ctor returns foreign object | ctor Wasm return type is `(ref $Struct)`; foreign `return {x:99}` falls back to `this` | **PARTIALLY FEASIBLE; recommend option (c)+ for now.** True foreign override needs the ctor return ABI to be `externref` (option (b) in #2071) — a pervasive ABI change touching every `new` site. **Recommend: keep the `(ref $Struct)` ABI on the static fast path; widen to an externref ctor-return ABI only for classes whose ctor body contains a `return <expression>` of non-self type** (detectable at compile time). Classes with no object-returning `return` keep today's zero-cost path. Until that lands, emit the documented compile-time diagnostic from #2071 option (c). Schedule after the P1/P2 core lands. | P4 |
| #2020 inherited statics | point-fixed by lookup-walk | subsumed: `$ClassMeta.$parentTag` chain gives a uniform static-inheritance walk; keep the existing point-fix until P3 unifies it | P3 |
| #1991 `in` proto-walk | Stage-C registry (spec in #1991) | composes: the `$ClassMeta.$methodCsv` (transitive) is the same CSV #1991 Stage C needs; share one CSV builder | P1 |

### The #2009 constraint (MUST READ — governs every cross-class link)

WasmGC types are canonicalized **iso-recursively**: two classes with identical
field *layouts* (`class A { m() {} }` and `class B { n() {} }`, both lowering to
`(struct (field $__tag i32))`) **share one heap type**. Therefore:

- **`ref.test $ClassNameStruct` cannot identify a class** — it returns true for
  every structurally-identical class. This is the live #2009 bug and #1991-B1's
  correction. Any dispatch that picks a class by `ref.test` on the instance
  struct type is **wrong by construction**.
- **The only sound per-class discriminator is the `__tag` field *value***
  (`classTagMap`), which is instance data, not type identity. Every cross-class
  link in this model (`$parentTag`, the `new.target` tag param, dynamic-`new`
  dispatch, `.constructor` identity) keys on the **tag value**, read via
  `struct.get … 0` after a single `ref.cast` to the *root* hierarchy struct
  (the cast is only a safe-access guard; the tag if-chain/`br_table` spans all
  classes and disambiguates — mirror `compileInstanceOf` at
  `typeof-delete.ts:531-585`).

### Standalone driver (#2158) — the representation MUST be host-free

The 1,388-test #2158 gap is concentrated in `built-ins/Object` compile errors
and class language tests **in standalone mode**. The existing model leaks to the
host in three places that standalone cannot satisfy:

1. `__register_prototype` / `__register_class_object` (`extern.ts:197-201,
   240-250`) present the method-only own-key view via a host Proxy — **skipped
   in `nativeStrings` mode**, so standalone `Object.getOwnPropertyNames(C)` /
   `Object.keys(proto)` / descriptor enumeration return the wrong key set.
2. `.constructor` returns a bare `ref.func` wrapped via `extern.convert_any`
   (`property-access.ts:3068-3085`) — identity-unstable, and the funcref-as-
   externref is opaque to standalone descriptor ops.
3. dynamic `new K()` → host extern-class intent (`runtime.ts` rejection).

**Standalone fix:** the `$ClassMeta` model carries `$methodCsv` and `$name` as
WasmGC strings, so a **standalone presence/enumeration predicate** can read
own-keys, method names, and `.constructor`/`.prototype` links directly from the
`$ClassMeta`/`$proto` structs with **no host import**. #2158 implements the
standalone readers (`Object.getOwnPropertyNames`, `getOwnPropertyDescriptor`,
`Object.keys`, `in`, `instanceof` on `any`) against these structs. JS-host mode
keeps the Proxy fast path; standalone uses the struct readers. This is the
dual-mode pattern CLAUDE.md mandates (host optional).

### Migration phases (independently mergeable; land in order)

- **P0 — `$ClassMeta` registration (no behavior change).** Register the
  `$ClassMeta` struct type; at the existing `class-bodies.ts:529-556` site,
  allocate one `$ClassMeta` per class, populate `$tag`/`$parentTag`/`$ctorFunc`/
  `$name`/`$methodCsv`/`$isClass`, link `__class_<Name>` ↔ `$ClassMeta` ↔
  `__proto_<Name>`. Keep all existing lowering; nothing reads the new links yet.
  Build the transitive `$methodCsv` once (own `classMethodNames` ∪ ancestors via
  `classParentMap`) and **reuse it for #1991 Stage C** (single CSV builder).
  *Acceptance: byte-identical output except the new struct/globals; existing
  class tests green.*
- **P1 — `.constructor` / `.prototype` identity through the singletons.**
  Re-point `property-access.ts:3068-3099` (`.constructor`, `.prototype` on
  instances) and `2138-2139` (`ClassName.constructor`) at `__class_<Name>` /
  `__proto_<Name>`. `new A().constructor === A` and
  `Object.getPrototypeOf(new A()) === A.prototype` become true. Standalone
  readers for these links. *Acceptance: #2026's `.constructor === A` half; the
  identity test262 in `language/statements/class/*` constructor-property tests.*
- **P2 — `new.target` (#2023).** Thread the new-target tag param through
  `${Name}_new` and `super()`; lower `new.target` to the tag param (==compare
  for `=== C`, truthiness unchanged for the `if (new.target)` use). Default the
  param to the own tag at direct `new` sites. *Acceptance: #2023 repro
  `"direct|sub"` through super chains, both modes.*
- **P3 — dynamic `new K()` (#2026 core) + static inheritance unify (#2020).**
  Closed-class-union dispatch on `$ClassMeta.$tag`; host fallback (JS) / loud
  diagnostic (standalone) for open `any`. *Acceptance: #2026 repro returns 6 in
  JS-host mode; standalone emits the documented diagnostic, not a miscompile.*
- **P4 — ctor foreign-object override (#2071).** Scoped externref ctor-return
  ABI for classes whose ctor returns a non-self object; static fast path
  otherwise. *Acceptance: #2071 repro → 99 (or documented diagnostic), #2018
  tests green, common-path `new` perf unchanged.*

### Cost on the static-dispatch fast path (REQUIRED — no regression)

- `new Name()` where `Name` is statically known stays a direct
  `call ${Name}_new` returning `(ref $Name)` — **unchanged** through P0–P3
  except P2 adds one `i32` (tag) param, which is a constant at direct `new`
  sites and folds. No `$ClassMeta` is touched on the instance-construction hot
  path; `$ClassMeta` is materialized lazily only when `C` / `C.prototype` /
  `new.target ===` / dynamic-`new` / a descriptor op actually demands it (same
  lazy-init guard as `emitLazyProtoGet` today).
- Property/method access on a statically-typed instance (`o.m()`,
  `o.field`) is **untouched** — still `struct.get` / direct `call`. The model
  adds reflective identity, it does not route normal access through the proto.
- `instanceof` keeps its existing tag if-chain (`typeof-delete.ts:531-585`); P0
  makes `$parentTag` available so the `compatibleTags` set can be derived from
  the `$ClassMeta` chain instead of recomputed, but that is an internal cleanup,
  not a perf change.

### Inputs folded in

- **#1965** (base-ctor body execution via `super(args)`) — **done** (task #8).
  P0 assumes `super()` runs the parent ctor body; the new-target tag forwarding
  in P2 piggybacks on the same `super()` call site #1965 fixed.
- **#2082 / #2086** (implicit derived ctor arg-forwarding / single synthesis) —
  the synthesized implicit ctor must forward the new-target tag (P2) and
  populate `$ClassMeta` (P0) like an explicit one. Note in the #2086 task.
- **#1983** (class-method funcMap name collision) — orthogonal but adjacent; the
  `$ctorFunc`/method-funcref population in P0 must read the **post-#1983**
  collision-free funcMap names. Land #1983 first or coordinate.
- **#1395** (static class-object singleton) — this model *is* the completion of
  #1395; `__class_<Name>` is reused, not replaced.

### Edge cases

- **Class expression `const C = class {…}`** — has a synthetic name
  (`anonClassExprNames` / `classExprNameMap`); `$ClassMeta` keys on the
  synthetic name like the existing `__class_`/`__proto_` globals. `new C()` on
  the variable resolves via `classExprNameMap` (already done,
  `new-super.ts:2607-2610`).
- **Externref-backed builtin subclass** (`class E extends Error {}`,
  `classBuiltinParentMap` / `classExternrefBackedSet`) — no `$ClassName` WasmGC
  struct, no `__class_` global today (`class-bodies.ts:547`). `$ClassMeta` for
  these carries `$ctorFunc` = the externref forwarder and `$parentTag` = a
  reserved builtin tag; `instanceof`/`.constructor` route through the existing
  externref path. Do **not** force a struct for these.
- **Function-style constructor** (`function F(){this.x=1}; new F()`) —
  `funcConstructorMap` already builds a `$F` struct + ctor; give it a
  `$ClassMeta` with `$isClass = 0` so `typeof F === "function"` and
  `F.prototype.constructor === F` hold. `new.target` inside `F` works the same
  way (tag param).
- **`Symbol.hasInstance` override / `instanceof` on a class with custom
  `[Symbol.hasInstance]`** — out of scope here; the tag if-chain assumes the
  default `OrdinaryHasInstance`. Flag if a test262 cluster needs it.
- **Deleting `instance.constructor`** — own-tombstone (per #1991/#2130 predicate)
  shadows the inherited `.constructor`; `$ClassMeta` link is the *inherited*
  tier, consulted after the own tombstone.

### Test gates (for the implementing PRs, per phase)

- P1: `language/statements/class/*constructor*`, `built-ins/Object/getPrototypeOf`,
  `new A().constructor === A`, `A.prototype.constructor === A`.
- P2: `language/expressions/new.target/*`, #2023 repro through 2- and 3-level
  super chains; `if (new.target)` truthiness unchanged.
- P3: #2026 repro (`make(C).m()` → 6), closed-union `new K()`, standalone
  diagnostic on open `any`-`new`.
- P4: #2071 repro, #2018 regression suite.
- **Standalone shard (the #2158 driver):** `built-ins/Object` compile-error
  count drops; `Object.getOwnPropertyNames(C)` / `getOwnPropertyDescriptor`
  / `Object.keys(proto)` return host-equal key sets in standalone mode.
- No regression: instance method/field access perf, `instanceof` typed path.

### What #2158 implements against this spec

#2158 is the standalone conformance implementation. It consumes **P0–P1** (the
`$ClassMeta` + singleton links) and adds the **standalone struct readers** for
`Object.getOwnPropertyNames` / `getOwnPropertyDescriptor` / `Object.keys` /
`.constructor` / `.prototype` / `in` / `instanceof`-on-`any`, replacing the
`__register_*` host-Proxy presentation that standalone skips. Gap-diff repros
from the host-vs-standalone baseline become standalone equivalence tests.
