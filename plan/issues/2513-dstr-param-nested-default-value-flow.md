---
id: 2513
title: "nested destructuring-param default: outer-default object fires → inner fields read 0/undefined instead of the default object's values"
status: ready
sprint: 64
created: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [2512, 2158, 1224, 1225, 1451]
test262_bucket: dstr-param-default-value
origin: "2026-06-19 — separated from #2512 (the arity half) by sen-1: once the invalid-Wasm CE clears, the destructured VALUES are still wrong."
---

# #2513 — nested destructuring-param default: value flow lost when the outer default fires

## Problem

After #2512 clears the invalid-Wasm CE, the `meth-…-dflt-obj-ptrn-prop-obj`
test262 family runs but FAILS its value assertions. When the OUTER parameter
default object fires (the method is called with no argument), the destructured
bindings read `0`/`undefined` instead of the default object's field values.

```ts
class C {
  method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 6 } }) {
    return z;   // expect 6; wasm returns 0
  }
}
new C().method();   // expected z = 6, got 0
```

Reproduced even for a FULL inner default object (all three fields present, in
declared order) — so it is NOT the #2512 field-pad arity hazard and NOT a
partial-literal/slot-order issue. The whole nested-pattern destructuring of the
outer-default object value yields sentinels.

Contrast: the `…-value-undef` variant (`{ w: undefined }` → the INNER pattern
default `{x:4,y:5,z:6}` fires) returns correct values on main — that is a
different code path. The broken path is specifically destructuring the
OUTER-default object's nested object property into the inner pattern.

## Acceptance criteria

- `new C().method()` with the outer object default firing yields the default
  object's field values (not 0/undefined).
- The `meth-…-dflt-obj-ptrn-prop-obj` test262 family passes its `assert.sameValue`
  checks (x/y/z + the `w` ReferenceError-after-block).
- No regression in the `…-value-undef` / `…-value-null` variants that already
  pass.

## Notes

Deeper than #2512 — touches the value-flow of how a destructuring-param outer
default object is destructured by a nested object pattern. Tracked separately so
#2512 can land the contained invalid-Wasm fix first. Senior-dev / focused fix.
