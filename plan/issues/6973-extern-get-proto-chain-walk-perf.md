---
id: 6973
title: "standalone perf: generic property lookup on fnctor instances walks the prototype chain recursively in `__extern_get` (deltablue ~1000× node; needs ~2× to fit the Octane run cap)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
language_feature: prototype, property-access, constructor-functions
goal: standalone-gap
related: [6971, 6966, 6951, 6949]
---

# Deltablue: prototype-method reads go through a recursive generic `__extern_get` walk

After #6971 (closure-bag slot on on-demand fnctor structs), deltablue on standalone runs at about
**77 ms per rep** against node's 75 µs. Measured on main + #6949/#6951/#6966/#6967/#6968/#6971.

The Octane harness makes 6 calls of `octane_run(703)`, because reps are calibrated on node. That is
about 325 s, against a 180 s run cap. **Deltablue needs about 2× (≤ ~40 ms per rep) to pass with
default settings.**

## Profile after #6971

| Function | Share | What it does |
|---|---|---|
| `__extern_get` | ~27 % self | recursive `[[Prototype]]` chain walk for inherited methods |
| `__obj_find` / `__obj_hash` | | per-level own-property hash lookups |
| `ref.test` chains | | struct-type dispatch per receiver |

Deltablue is method-heavy: `c.output()`, `this.strength.stronger(...)`, `v.addConstraint(...)`, all
inherited through `Constraint.prototype` / `BinaryConstraint.prototype` chains built with
`Object.inherits` (child `.prototype = Object.create(parent.prototype)` style).

## Plan (measure first)

1. Profile deltablue on integ plus #6971 and list which call sites reach `__extern_get` with a
   method name, and at what chain depth.
2. Pick the cheapest of the following that gives ≥ 2× on deltablue without an object-model
   rewrite:
   - **(a)** Make the walk iterative instead of recursive, and short-circuit levels whose `$Object`
     has no own entries.
   - **(b)** A per-call-site monomorphic inline cache for `obj.name(...)` calls, keyed on the
     receiver's struct type plus the shape of the proto object, holding the resolved closure. It
     must be invalidated on any prototype write; reuse the #6951 prototype-write routing hooks.
   - **(c)** Intern the property-name strings, so `__obj_hash` / `__obj_find` compare by identity.
3. **Acceptance:**
   - `--only deltablue --lanes node,standalone` passes with the default 180 s run timeout;
   - no change in the equivalence gate or the related tests;
   - host (gc) output is byte-identical, or any change is justified.
