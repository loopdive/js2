---
id: 5240
title: "Object.getOwnPropertyNames(C.prototype) omits 'constructor' on compiled classes — both single-module and linked lanes"
status: ready
sprint: current
priority: low
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5240 — compiled class prototypes lack an own `constructor` property

## Problem

`Object.getOwnPropertyNames(C.prototype)` on a compiled class omits
`"constructor"` in BOTH the single-module and linked lanes (measured by
dev-5237; the issue-5237 reduction pins the shared wrong answer as a control).
Spec: every class prototype has an own non-enumerable `constructor` property
referencing the constructor. test262 asserts this per class
(`prototype/constructor` rows exist for every Temporal class).

## Direction

The prototype surface (#5237's `ownKeys` trap on the ctor-mirror facade, and
the single-module `__struct_field_names`/member-kind enumeration) should
include `constructor`, with `get` answering the class constructor mirror and
the descriptor non-enumerable. Check `inst.constructor === C` too.

## Acceptance criteria

1. `getOwnPropertyNames(C.prototype)` includes `constructor`;
   `C.prototype.constructor === C`; `inst.constructor === C`; flip the pinned
   control rows in `tests/issue-5237-cross-module-class-members.test.ts`
   rather than deleting them.
2. Both lanes covered; no regressions in issue-5237/5223/4628 + linker
   family. Gates green.

## Notes

- Found by dev-5237 (PR #5343 "Reported, NOT fixed"). Related: #5238
  (reflective surface gaps — descriptors, toStringTag, proto identity).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
