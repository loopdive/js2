---
id: 2188
title: "standalone: sibling Error subclasses share the parent $tag — instanceof can't distinguish them (per-user-class brand)"
status: in-progress
assignee: ttraenkler/sdev-proxy3
sprint: Backlog
created: 2026-06-17
updated: 2026-06-18
priority: low
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: errors, classes
goal: standalone-mode
related: [1536c, 1536, 1455, 2101]
origin: "2026-06-17 — precision residual found while closing #1536c (standalone user Error subclass)"
---

# #2188 — standalone Error-subclass instanceof precision

## Problem

`#1536c` made `class MyError extends Error {}` instantiate and resolve
`instanceof` natively in standalone (zero host imports). The instance is the
parent's `$Error_struct`, discriminated by the parent's `$tag`. That is exact
for a single subclass, but **two distinct `extends Error` siblings share the
same parent `$tag`**, so `instanceof` cannot tell them apart:

```ts
class A extends Error {}
class B extends Error {}
export function test(): number {
  return (new A("x")) instanceof B ? 1 : 0;  // standalone wasm: 1   node: 0
}
```

(`#1536c`'s acceptance — single subclass, `instanceof Self`/`instanceof Parent`
— is correct; this is the sibling-disambiguation residual.)

## Root cause

`emitWasiErrorConstructor`'s `$Error_struct` carries the **builtin** type tag
(`Error` / `TypeError` / …), not a per-user-class brand. The standalone
instanceof path (identifiers.ts, `userErrorParent`, #1536c) compares against the
parent's `collectErrorInstanceOfTags` set, which is identical for every direct
subclass of the same builtin error.

## Fix direction

Give externref-backed user Error subclasses a **per-class brand** on the
instance (or a `$ClassMeta`/`$parentTag` slot) so `instanceof Sub` checks the
brand chain, not only the builtin parent tag. This is the `$ClassMeta` /
`$parentTag` externref-backed-subclass discrimination work tracked under #2101;
#1536c deliberately used the coarser parent-tag check to ship the
single-subclass case host-free. Coordinate with #2101 and the host-mode
`__tag_user_class` chain (#1455) so JS-host and standalone agree.

## Acceptance criteria

- `class A extends Error {}; class B extends Error {}; (new A()) instanceof B`
  → `false` (standalone), `(new A()) instanceof A` → `true`,
  `(new A()) instanceof Error` → `true`.
- Multi-level user chains (`class C extends A {}`) resolve correctly.
- #1536c single-subclass tests stay green; JS-host mode unaffected.

## Notes

Split from #1536c (single-subclass standalone Error subclass — `done`). See
#1536c's `## Resolution` and #2101 for the brand machinery.

## Resolution (2026-06-18, sdev-proxy3 — PR on `issue-2188-sibling-error-brand`)

**Scope shipped:** sibling discrimination for *direct* builtin-Error subclasses
(`class A extends Error {}`, `class C extends TypeError {}`), the issue's primary
repro + root cause. Implemented a minimal **additive per-class brand** instead of
the full `$ClassMeta` migration (#2101) — that migration stays future work.

**Why the brand, and why a new field (not field 0):** `$Error_struct.$tag`
(field 0) is the *builtin* type tag — shared by every direct subclass of the same
builtin Error, and immutable. Reusing it cannot separate siblings. So I appended a
**mutable** `$userClassId` (fieldIdx 4, after `stack`) carrying the subclass's
unique `classTagMap` id. Kept LAST so the existing positional field indices
(0=tag, 1=message, 2=name, 3=stack) used across property-access.ts / identifiers.ts
stay stable.

**Three touch points (registry/error-types.ts, class-bodies.ts, identifiers.ts):**
1. `$Error_struct` gains `$userClassId` (field 4); `__new_<Parent>` writes the
   `-1` sentinel (a plain builtin Error / the shared parent ctor has no brand —
   it cannot, because `__new_<Parent>` is shared by name across all siblings).
2. `emitSetSubclassUserBrand` writes the subclass's id into field 4 **after**
   construction at BOTH externref-backed-subclass sites (implicit derived ctor +
   explicit `super()`), `ref.test`-guarded, standalone/WASI only. The brand can't
   live in the shared parent ctor, so it's a post-`struct.new` `struct.set` at the
   per-subclass site — no funcIdx-shift hazard (no body rebuild, no late import).
3. The standalone `instanceof <UserSubclass>` path reads field 4 against the id
   set {ctorName} ∪ {descendant subclasses} (`collectUserErrorSubclassBrandIds`,
   walks `classParentMap`). Builtin RHS (`Error`/`TypeError`) keeps the field-0
   tag check unchanged. A `-1`-branded plain Error never matches a subclass set
   (ids ≥ 0), so `(new Error) instanceof MySubclass` is correctly false.

**Verified:** `(new A) instanceof B` → false; self / parent / cross-family
(`C extends TypeError instanceof TypeError|Error`, not `A`); three siblings
mutually disjoint. 10/10 `tests/issue-2188.test.ts`; 25/25 existing exception
suites (issue-2077/1536/1536c/2192); coercion-drift gate OK; tsc + prettier clean.

**Pre-existing gap NOT addressed here (orthogonal, not a regression):** a
*multi-level user chain* `class D extends A {}` where `A extends Error` does not
construct `D` as a proper `$Error_struct` — D's direct parent A is a user class,
so D's `super()` chains through A's `_init`, not `__new_Error`. On **both
upstream/main and this branch**, `(new D) instanceof A` and `instanceof Error`
return false (`(new D) instanceof D` works — D is branded). The acceptance
criterion "multi-level user chains resolve correctly" therefore needs a separate
construction-routing fix (transitively-derived Error subclasses must thread
through `__new_<builtinAncestor>`); filing as a follow-up. The brand machinery
here already supports the chain on the *read* side (descendant ids are collected)
— only the *construction* side is missing for the >1-level case.

## Resolution of the multi-level follow-up (2026-06-18, sendev-prb — `issue-2188-multilevel`)

The construction-routing gap above is FIXED. `class D extends A {}` /
`A extends Error` now constructs `D` as a real `$Error_struct`.

**Root cause (located):** `compileSuperCall` (class-bodies.ts) gated the native
`__new_<builtin>` super-routing on `classBuiltinParentMap.get(child)`, which the
collection phase (class-bodies.ts ~545) only populated when the **direct** parent
is a host-constructible builtin (`isHostConstructibleBuiltin(directParent)`). For
`class D extends A` the direct parent A is a user class → no entry → D's `super()`
chained through A's user `_init`, never threading to `__new_Error`, so D was
un-tagged (`instanceof Error` false, `.message` unset, uncatchable as Error).

**Fix (class-bodies.ts, additive):** make the resolution **transitive** — when
the direct parent is itself an externref-backed user Error subclass
(`classExternrefBackedSet.has(parent) && classBuiltinParentMap.has(parent)`),
propagate the **builtin ANCESTOR** name (`classBuiltinParentMap.get(parent)`,
not the immediate parent) into the child's `classBuiltinParentMap` and add the
child to `classExternrefBackedSet`. We deliberately do NOT gate on
`parentStructTypeIdx === undefined` here (the parent carries a vestigial struct
slot; the discriminator is the parent's externref-backing, not struct presence).
Parents are collected before children in source order, so the ancestor mapping is
already present. Everything downstream (implicit forwarder, `super()` routing,
`instanceof` brand reads) then fires through the existing externref-backed path.

**Verified:** `.message` field, catchability (try/throw/catch instanceof Error),
and #2188 sibling-disjointness all pass standalone; `tests/issue-2188-multilevel-error-chain.test.ts`
(7 tests). tsc clean.

**Dependency — #2029/#1702:** the implicit derived-ctor forwarder pads missing
`super()` args via `pushDefaultValue`→`emitUndefinedValue` (type-coercion.ts),
which leaks `env.__get_undefined` in standalone until #1702's `nativeStrings`
guard lands (a PRE-EXISTING 1-level leak too, not introduced here). The 4
no-arg-construction tests' `imports === []` assertion passes once #1702 merges;
this PR is rebased on #1702.

## Re-validation of the #48 follow-up (2026-06-19, sdev-protoglue)

Re-measured the task #48 scope against current upstream/main (`129df118f`).
**The scoped acceptance is already satisfied** — the construction-routing fix
(PR #1713) is in place. Verified standalone, all green:

- 3-level `D extends A extends Error`: `instanceof Error` / `instanceof A` /
  `instanceof D` all `true`; `.message` carries the constructor arg (real
  `$Error_struct`); a thrown `D` is catchable as `Error`.
- 4-level `D extends B extends A extends Error`: `instanceof Error` and
  `instanceof B` both `true`.
- Explicit-`super(msg)` chains at every level: `.message` correct.
- `tests/issue-2188-multilevel-error-chain.test.ts` (+ `issue-2188.test.ts`):
  **17 tests pass.**

**No code change needed.** The sole remaining gap is a *user-field* set in an
intermediate ctor (`class A extends Error { code:number; constructor(m){
super(m); this.code=42; } }; class D extends A {}` → `new D().code` is `0`).
That is the **documented out-of-scope externref-backed own-field limitation**
(`class-bodies.ts` ~1674: "user `prop = ...` declarations inside `class Sub
extends Error` would need to be installed via host setters, which is out of
scope") — the instance IS a `$Error_struct`, which has no slot for arbitrary
user fields. This is the #2101 brand/representation lane, NOT the #48 scoped
instanceof+message bug. Flagged, not fixed here.
