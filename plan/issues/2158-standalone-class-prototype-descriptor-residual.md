---
id: 2158
title: "Standalone class/prototype/private-name/descriptor conformance residual (~1,388 tests)"
status: suspended
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: classes
goal: standalone-mode
parent: 1591
depends_on: [2101, 1965]
---

# Standalone class/prototype/descriptor conformance residual

## Problem

Class elements, private fields, brand checks, and descriptor fidelity landed
in #1591, #1365, #1364 (all `done`, sprints 51–61). The host-vs-standalone
baseline diff (sha `31fa7e099`, 2026-06-15) shows **1,388 tests pass in host
mode but fail standalone**, attributed to the class/prototype/private-name/
descriptor object model — the second-largest catch-up bucket.

## Evidence

- Concentrated in `built-ins/Object` (compile-error heavy) and class
  language tests; `dynamic_object_property` leaks plus `(none)`-leak compile
  errors in the object model.
- Implementation should consume the #2101 class object-model architecture
  spec and the #1965 base-constructor execution fix.

## Acceptance criteria

- Standalone pass count for `built-ins/Object` + class language tests rises
  toward host parity.
- Descriptor/private-name/brand-check semantics match host mode standalone.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1591. Implements against spec #2101; depends on #1965.
Part of sprint-62 standalone catch-up (rank 2 by gap impact).

## Suspended Work / handoff (2026-06-16, sdev5)

Branch `issue-2158-classmeta` (from origin/main `1bd19e72a`), commit `2c5bb9fef`
— **inert P0 scaffolding only** (no behavior change, typechecks clean):

- `src/codegen/context/types.ts`: added `classMetaTypeIdx?: number` (the single
  shared `$ClassMeta` heap-type idx) + `classMetaGlobals: Map<string, number>`
  (per-class meta-singleton globals).
- `src/codegen/context/create-context.ts`: `classMetaGlobals: new Map()`.

Nothing registers or reads them yet — the next agent picks up here.

### Resume steps (read the #2101 spec FIRST — it is authoritative)

1. **Read** `plan/issues/2101-arch-spec-class-object-model.md` in full, esp.:
   - §"Recommended backing: one shared `$ClassMeta` struct" — the exact field
     layout (`$tag` i32, `$parentTag` i32, `$ctorFunc` funcref, `$proto`
     externref, `$methodCsv` externref, `$name` externref, `$isClass` i32).
   - §"The #2009 constraint (MUST READ)" — **class identity rides the `$tag`
     field VALUE, never `ref.test` on the `$ClassMeta`/instance type.** Every
     cross-class link keys on the tag value, read via `struct.get … 0` after a
     `ref.cast` to the root hierarchy struct (mirror `compileInstanceOf`,
     `typeof-delete.ts:531-585`).
   - §"Migration phases" P0→P4 (independently mergeable, land in order).
   - §"What #2158 implements" + §"Standalone driver" — #2158 = P0-P1 + the
     standalone struct readers replacing the host-Proxy `__register_*`.
2. **P0 (byte-identical):** register the `$ClassMeta` struct type once (set
   `ctx.classMetaTypeIdx`); at `class-bodies.ts:546-573` (where `__proto_<Name>`
   + `__class_<Name>` externref globals register today) allocate one
   meta-singleton global per class into `classMetaGlobals`, and add a **lazy**
   populator (mirror `emitLazyProtoGet`, `expressions/extern.ts:132`) that
   `struct.new $ClassMeta`s the fields: `$tag`=classTagMap, `$parentTag`=parent
   via classParentMap→tag (-1 if none), `$ctorFunc`=`ref.func` of
   `classMemberFuncKey(ctx, "${Name}_new")` (#1983 helper, `class-member-keys.ts`
   — use it; #1983 is merged), `$name`/`$methodCsv` strings, `$isClass`=1.
   Build the transitive `$methodCsv` once (own `classMethodNames` ∪ ancestors via
   `classParentMap`) and reuse the existing `classMethodsCsvGlobal`. Lazy ⇒
   byte-identical (no instructions on the hot path until a reader demands it).
   **Acceptance: existing class tests green; only the new type+globals appear.**
3. **P1:** re-point `.constructor`/`.prototype` (`property-access.ts:3068-3099`,
   `2138-2139`) at `__class_<Name>`/`__proto_<Name>`; add standalone struct
   readers for these links.
4. **Standalone readers (#2158 core):** `Object.getOwnPropertyNames`/
   `getOwnPropertyDescriptor`/`Object.keys`/`in`/`instanceof`-on-`any` read
   own-keys/method-names from `$ClassMeta.$methodCsv`/`$proto` directly (no host
   import), replacing the `__register_prototype`/`__register_class_object`
   host-Proxy presentation that `nativeStrings` mode skips (`extern.ts:197-250`).

### Constraints (do not violate)

- Static-dispatch fast path **byte-identical** through P0-P3 (§"Cost on the
  static-dispatch fast path"): `new Name()` stays a direct `call ${Name}_new`
  returning `(ref $Name)`; instance `o.m()`/`o.field` untouched; `$ClassMeta`
  materialized lazily only on reflective demand.
- Externref-backed builtin subclasses (`class E extends Error {}`) have no
  `$ClassName` struct — `$ClassMeta` carries the externref forwarder, do NOT
  force a struct (§"Edge cases").
- #1983 collision-free funcMap names are merged — `$ctorFunc`/method-funcref
  reads MUST go through `classMemberFuncKey` (`class-member-keys.ts`).

Why suspended: P0-P4 is a multi-PR class-object-model lane whose consequential
phases (P3 dynamic-`new` tag dispatch, P4 ctor foreign-object externref ABI,
standalone readers) are frontier-reasoning work best done with fresh context;
sdev5 flagged at the P0 boundary rather than splitting mid-lane.
