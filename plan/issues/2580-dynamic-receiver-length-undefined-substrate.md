---
id: 2580
title: "`.length` on an any/dynamically-mutated receiver returns numeric 0, not undefined (runtime property-presence)"
status: ready
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime, value-rep
language_feature: property access, length, dynamic objects
goal: test262-conformance
related: [2573, 983d]
---

# #2580 — `.length` on an `any`/dynamic receiver → runtime property-presence (substrate)

## Problem

`.length` on an **`any`-typed / dynamically-mutated** receiver returns numeric
`0` where the value is actually a plain object whose `length` is an absent
property (→ `undefined`, §10.1.8 OrdinaryGet). #2573 attempted a
**statically-typed** plain-object slice (a fail-safe static gate
`isPlainObjectWithoutLength` in `property-access.ts`) but that PR (#1868) was
**abandoned**: it moved 0 test262 rows AND ejected from the merge_group on a
hidden `.length` regression the targeted array-like pre-checks missed — the
`.length` path is too central to risk for zero conformance gain. The static gate
deliberately EXCLUDES `any`/`unknown` (at that static type a plain object and an
array are indistinguishable, and arrays dominate, so the numeric vec-field-0 /
`__extern_length` lowering is kept — excluding `any` is exactly what keeps
`any[].length` arithmetic safe), so it structurally cannot move the cluster.

The test262 `built-ins/Array/prototype/S15.4.4.*_A2_T*` cluster (the #983d
generic-Array-method-on-plain-object residual, 8 fails) is precisely the excluded
case:

```js
var obj = {};
obj.join = Array.prototype.join;
if (obj.length !== undefined) throw ...;   // obj is `any`; obj.length === 0, fails
```

## Why this is substrate, not a point-fix

Making `any`/dynamic-receiver `.length` correct requires a **runtime**
property-presence check at the read site: `ref.test $Object` → if it's a plain
`$Object`, `__extern_get(obj, "length")` (returns `undefined` when absent);
else (array / $ObjVec / string) read the numeric length. To express *both*
outcomes from one expression, `.length` on an `any` receiver must return a
**uniform externref** (the numeric array length **boxed** too). That is a
return-type change on the hot `any[].length` path — `for (;i<a.length;)` loops
and `a.length`-arithmetic are everywhere — so it carries broad regression risk
and is a value-representation decision (coordinate the value-rep lane:
`project_standalone_any_string_value_read_substrate`). #2573's #1868 ejection
already demonstrated how easily a `.length` change regresses a hidden case.

It also interacts with the #983d generic-array-method-on-plain-object machinery
(task #20, reverted as net-negative) and a standalone ToPrimitive throw, so a
correct `.length` alone would not flip the whole cluster.

## Fix direction (substrate)

- Decide the representation: either (a) `.length` on `any` returns a uniform
  boxed externref (numeric arrays boxed; plain objects `__extern_get`-undefined),
  validated against `any[].length` arithmetic across the FULL gate; OR (b)
  represent `var obj = {}` (dynamically mutated) as a dynamic `$Object` so the
  existing `$Object`-aware `.length` path applies.
- Validate via the FULL gate (merge_group / local-ci) — broad-reach, not a
  scoped sweep (the `.length` path is read everywhere; the #1868 eject is the
  cautionary example).
- Coordinate with #983d retry (task #20) for the generic-method cluster.

## Acceptance

- `var obj = {}; obj.length === undefined` (the `any`-receiver case) — typeof
  `"undefined"`.
- `S15.4.4.*_A2_T*` length-assertions flip to pass (with the #983d method-dispatch
  piece).
- ZERO regression in `any[].length` / array / string / arguments / typedarray /
  bound-fn `.length` arithmetic across the full gate.

## Cross-links

- #2573 (the static plain-object slice — PR #1868 abandoned: 0-row + hidden `.length` eject)
- #983d (generic Array method on plain object — task #20, reverted; the cluster needs both)
- value-rep / `project_standalone_any_string_value_read_substrate`
