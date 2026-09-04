---
id: 5312
title: "A declared-but-never-initialised class field (`m!: T`) holds a null ref, not `undefined` — `this.m === undefined` does not fold and a guarded call traps"
status: ready
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5309, 3522]
requested_by: ttraenkler/orchestrator
---

# A guarded call on an uninitialised declared field traps where node returns 0

Found by the [#5309](5309-legacy-private-name-shadow-resolves-parent-method.md)
implementer (PR #5565) while pinning the `declare` narrowing. It is
**independent of #5309**: the control below has no parent method at all and
traps identically on base and on the #5309 branch.

```ts
class A { p() { return 9; } }
class B extends A {
  m!: () => number;
  f() { return this.m === undefined ? 0 : this.m(); }
}
new B().f();
```

| | result |
| --- | --- |
| node (`useDefineForClassFields`: the field is defined as `undefined`) | `0` |
| js2, gc and standalone | **traps** |

The field-collection loop in `collectClassDeclaration`
(`src/codegen/class-bodies.ts` ~L1186) gives `m!: T` a struct slot like any
other field, and nothing initialises it, so the slot holds a null ref. The
`this.m === undefined` comparison does not fold to true for a null callable
slot, the else arm runs, and the `call_ref` on the null slot traps.

What #5309 changed is only that the *shadowing* variant of this shape
(`class A { m() {…} }` + `class B extends A { m!: () => number }`) stops being
masked by the inherited-method alias — on base it silently returned the
parent's answer, now it reaches the same trap the control already hits. The
`typeof this.m` and non-callable read forms do not move.

## Acceptance criteria

1. The program above returns `0` on gc and standalone, with a test red on
   base for both lanes.
2. State which of the two is the fix and why: (a) an uninitialised
   declared field reads as `undefined` (the null slot is mapped to
   `undefined` at the read site), or (b) `=== undefined` / `== null` /
   `typeof` on a nullable callable slot fold correctly. Measure `typeof this.m`
   (`"undefined"` in node), `this.m == null` (`true`), and `this.m?.()`
   (`undefined`) alongside; all four must agree with node after the fix.
3. A field WITH an initialiser, a field assigned in the constructor, and a
   `declare m: T` field (no property installed, inherited callable stays
   visible) are pinned unchanged.
4. Byte identity on the emit corpus (`scripts/prove-emit-identity.mjs`,
   all targets); any moved row named.

## Out of scope

- `[[Define]]` vs `[[Set]]` semantics for fields with initialisers
  (`useDefineForClassFields` off) — a different shape.
- The #5309 row 14 base-typed receiver dispatch.
