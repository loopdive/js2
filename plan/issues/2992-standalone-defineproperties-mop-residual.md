---
id: 2992
title: "Standalone defineProperties MOP residual (~250: array/arguments own-prop MOP + accessor-attribute fidelity + destructive verifyProperty/tombstone survival)"
status: ready
sprint: Backlog
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2985, 2667]
origin: "#2985 sizing-pass split — the substrate-scale MOP remainder after the illegal-cast slice shipped in #2985"
---

# #2992 — standalone defineProperties MOP residual (~250)

## Problem

Split out of #2985. #2985 was the whole `defineProperties` 5-b/6-a slab residual
(~250, mixed bucket). The bounded, discrete sub-bug (the `__obj_find`
illegal-cast on non-string computed keys) shipped in #2985. This issue carries
the **remaining ~250 substrate-scale MOP work**, which is genuinely
large/hard and wants further slicing:

- **array / arguments own-property MOP** — `defineProperty`/`defineProperties`
  on array indices and `length` with full attribute semantics.
- **accessor-attribute fidelity** — get/set descriptor round-trips through
  define → gOPD must preserve accessor identity and attribute flags.
- **destructive `verifyProperty` survival** — test262's `verifyProperty`
  mutates then restores the property; the standalone MOP must survive the
  define→delete→redefine cycle.

## Concrete evidence (measured 2026-07-02, standalone)

The destructive-`verifyProperty` sub-class has a reproducible root cause that is
**not key-type-specific** — a plain string-keyed delete→re-read already fails:

```ts
const o: any = {};
o["k"] = 1;
delete o["k"];
o["k"] === undefined; // FALSE in standalone (returns the stale value)
```

i.e. after `__delete_property` tombstones an entry, a subsequent read on the
same key does not consistently observe the tombstone. This is the mechanism
behind verifyProperty's define→delete→redefine failures and should be the first
slice (it is bounded and high-leverage). Suspect area: the tombstone-skip /
open-addressing read path in `__obj_find` / `__extern_get`
(`src/codegen/object-runtime.ts`).

## Acceptance

- Measured flip count on the `built-ins/Object/defineProperties` (and
  `defineProperty`) standalone subset, per sub-class, with zero regressions on a
  passing-test sweep.
- gc/host lane byte-inert (standalone-gated).

## Notes

Wants slicing into separate PRs:

1. delete-tombstone-read survival (bounded — start here).
2. array/arguments index + `length` own-prop MOP.
3. accessor-attribute (get/set) define→gOPD fidelity.
