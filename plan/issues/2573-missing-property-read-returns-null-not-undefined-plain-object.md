---
id: 2573
title: "Reading a missing property on a plain `{}` object returns null, not undefined"
status: ready
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: medium
goal: test262-conformance
parent: 983d
test262_fail: 8
---
# #2573 — Missing-property read on a plain object yields `null` not `undefined`

## Problem

Reading an own property that does not exist on a plain object literal
(`var obj = {}; obj.length`) returns JS `null` (`typeof === "object"`) where the
spec requires `undefined` (§10.1.8 OrdinaryGet → returns `undefined` for a
missing property).

```js
var obj = {};
obj.length;   // expected: undefined ; actual: null
```

## How it surfaced (#983d residual)

After #983d landed the dual-path dispatch for `obj.<field>()` host-method calls
(`var o = {}; o.pop = Array.prototype.pop; o.pop()` now actually runs), the
generic-Array-method-on-plain-object test262 cluster went 0 → 11/19. The
remaining 8 fail at a **later** assertion — `obj.length === undefined` — because
the missing-`length` read returns `null`:

```
S15.4.4.5_A2_T1.js  #2: ... obj.join(); obj.length === undefined.  Actual: null
S15.4.4.7_A2_T1.js  #4: ... obj.push(...); ...
S15.4.4.8_A2_T{1,2,3}.js, S15.4.4.13_A{2_T1,3_T2}.js, S15.4.4.7_A4_T3.js
```

Probe (`var obj={}; var b=obj.length; ... b===null, typeof==="object"`) confirms
the read is `null`, independent of any method call — it is a **property-read**
bug, not a method-dispatch or write-back bug.

## Root cause (to confirm)

`obj.length` on a `{}` struct lowers to a `struct.get` against a struct shape
that has no `length` field (or reads field 0 of the wrong shape), and the
missing-field path coerces to `ref.null.extern` (→ JS `null`) instead of the
host `undefined`. The fix is to make the missing-own-property read on a
plain-object struct yield `undefined` (e.g. `__get_undefined` / the
externref-undefined representation), not a null externref. Audit the
property-access codegen for plain-object structs (`src/codegen/property-access.ts`
/ the member-read path in `expressions`) and the `__sget_`/`__extern_get`
missing-field return.

## Acceptance

- `var obj = {}; obj.missing === undefined` (typeof `"undefined"`).
- The 8 residual `…/S15.4.4.*` generic-method-on-plain-object fails flip to pass.
- No regression in property reads that legitimately return `null`.

## Notes

Carved from #983d by sd-4 on 2026-06-21. Orthogonal to the dual-path dispatch
fix that #983d delivered (the method now runs correctly; this is the missing
sibling property read returning the wrong nullish value).
