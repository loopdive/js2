---
id: 2101a
slug: externref-subclass-ownfield
title: "standalone: own fields on externref-backed Error subclass TRAP construction (this.code=42 casts $Error to $A)"
status: done
completed: 2026-06-19
assignee: sdev-boxrep
sprint: Backlog
parent: 2101
created: 2026-06-19
priority: low
feasibility: hard
reasoning_effort: max
area: codegen
language_feature: classes, error-subclass, standalone
goal: standalone-mode
related: [1472, 2188, 1536c, 1366a]
origin: "2026-06-19 — #1472 R5 delta (arch-dynshape). Measure-first found the gap is a CONSTRUCTION TRAP, not silent-0; message/instanceof ALSO break when an own field is declared."
---

## Problem (measure-first — sharper than the original spec)

`class A extends Error { code = 0; constructor(m){ super(m); this.code = 42 } }`
in `--target standalone`:

- `new A("z").code` → **TRAPS** (not silent 0 as the spec assumed).
- `new A("z") instanceof Error` → **TRAPS**.
- `new A("z").message` → **TRAPS**.

i.e. declaring ANY own field on an externref-backed Error subclass corrupts
*construction itself*, so message/name/stack + instanceof (which the spec
claimed were unaffected) ALSO break. The instance is never validly produced.

A subclass with NO own fields works fine (message + instanceof OK) — confirming
the trigger is the own-field read/write codegen, not the Error-backing.

## Root cause (from WAT)

An Error subclass instance IS a `$Error_struct` (built by `__new_<Error>` via
the `super()` chain; branded with `userClassId` field 4 — #2188). It has NO
general property storage.

The class ALSO gets a vestigial user struct `$A (struct $__tag i32, $code f64)`
(struct registration bookkeeping, #1366a keeps `parentStructTypeIdx` undefined).
The own-field assignment `this.code = 42` in the ctor body lowers through the
ordinary member-assignment path (`assignment.ts`), which does:

```
local.get self            ;; the $Error_struct externref
any.convert_extern
ref.test  $A              ;; false — self is $Error_struct, not $A
(if (result (ref null $A)) (then ref.cast $A) (else ref.null $A))
... struct.set $A $code   ;; receiver is null → ref.is_null → throw TypeError
```

The `ref.test $A` is false, the else-branch yields `ref.null $A`, and the
null-receiver guard throws. Construction aborts → the instance is never
returned → every downstream read traps. The own-field READ path
(`property-access.ts`) has the same `ref.cast $A` hazard.

`emitOwnInstanceFieldInitializers` (class-bodies.ts ~L1674) DOES bail for
externref-backed classes, but the ctor-BODY assignment `this.code = …` is a
separate path that does not.

## Fix (rep signed off — $Object-promotion via one trailing field on $Error_struct)

Add ONE trailing `props: ref null $Object` field to `$Error_struct`
(error-types.ts). Only ONE `struct.new $Error_struct` site exists
(`emitWasiErrorConstructor`, error-types.ts ~L171) — it supplies `ref.null`.
The brand/instanceof sites (class-bodies.ts ~L448, identifiers.ts ~L1178) only
`struct.get/set` existing fields 0/4, untouched.

Route own-field read/write on an externref-backed Error subclass through the
LANDED open-`$Object` runtime instead of `$A`:
- WRITE (`this.f = v`): `__obj_set(self.props ??= new $Object(), "f", box(v))`.
- READ (`this.f` / `inst.f`): the message/name/stack struct fast-path stays
  FIRST (zero-cost); an unknown own field routes through
  `__obj_get(self.props)` (null/undefined when props is null).

Scope R5 v1 to `$Error_struct` only (Error family). Map/Set/Promise/WeakMap
follow-up.

## Hazard

Adding `props` shifts NO funcidx (struct fields positional), but the `struct.new`
site must supply `ref.null` and the field must be registered with the type from
the start — never push a field mid-class-collection (type-index-shift /
dead-elim remap hazard, [[project_type_index_shift_and_deadelim]]).

## Acceptance (R5 v1 — all passing)

- `new A("z").code === 42` (own field on the instantiated Error subclass)
- multiple own fields independent (`a.x`, `a.y`)
- a subclass that declares its OWN field + ctor stores it (`class D extends A {
  code }`)
- inherited `.message` + `instanceof Error` survive when an own field is
  declared — these were REGRESSED (construction trapped); this fix restores them.

## Out of scope (deferred — #2188-family construction threading)

`class D extends A {}` where the own field is declared on the ANCESTOR `A`
(not on D) and D has only an IMPLICIT derived ctor: `new D("z").code` is still 0.
Root cause is orthogonal to the R5 storage rep — the implicit `D_new` threads
super() straight through the builtin ancestor's `__new_<Error>` and never runs
A's constructor body (where `this.code = 42` lives), so the write never executes.
That is the #2188 multi-level ctor-body-threading problem (see TaskList #48), not
the own-field representation. The storage rep is correct: once A's body runs,
the field lands. Filed as a follow-up.
