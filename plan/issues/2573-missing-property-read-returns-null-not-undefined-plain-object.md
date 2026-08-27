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

## 2026-08-27 ES2015 standalone revalidation plan

This old residual must be re-proven on current `upstream/main` `f5420ef1b`
before any source change; recent standalone undefined-singleton work may have
changed its disposition.

1. Add direct controls for a missing property on a plain open object, an
   explicitly `null` property, an inherited property, and a getter returning
   `undefined`, all in standalone with zero imports.
2. Locate the eight historical generic-Array-method paths in the pinned
   Test262 checkout and run the exact surviving ES2015 rows through the
   maintained official-scope runner. Record the actual denominator rather than
   assuming all historical names remain.
3. If still failing, fix the shared missing-property producer so it returns the
   canonical JavaScript undefined representation without conflating explicit
   null or bypassing prototype lookup/accessors.
4. Run focused controls and the exact maintained slice. A completed fix must
   have every owned row passing with zero failures, compile errors, timeouts,
   or skips; otherwise commit an issue-backed draft handoff.

## 2026-08-27 bounded revalidation evidence

The checkout was revalidated at compiler `f5420ef1be0c81f171009d0355228b22e56c0eec`
with Test262 revision `b363f29d3c43c626dc852744ad64a0b48a003693`. The focused
standalone controls are committed in `tests/issue-2573-missing-property.test.ts`:
missing, explicit `null`, an
inherited value, and a getter returning `undefined` all pass (4/4 assertions),
with zero `env` imports and a valid module.

All eight historical names still exist in the pinned checkout and classify as
official standard-scope rows (`strict: both`):

* `built-ins/Array/prototype/join/S15.4.4.5_A2_T1.js`
* `built-ins/Array/prototype/push/S15.4.4.7_A2_T1.js`
* `built-ins/Array/prototype/reverse/S15.4.4.8_A2_T1.js`
* `built-ins/Array/prototype/reverse/S15.4.4.8_A2_T2.js`
* `built-ins/Array/prototype/reverse/S15.4.4.8_A2_T3.js`
* `built-ins/Array/prototype/unshift/S15.4.4.13_A2_T1.js`
* `built-ins/Array/prototype/unshift/S15.4.4.13_A3_T2.js`
* `built-ins/Array/prototype/push/S15.4.4.7_A4_T3.js`

Using the maintained `tests/test262-runner.ts` official-scope runner with the
requested fixed Node/LLVM/artifact paths and `COMPILER_POOL_SIZE=2` produced:

* Standalone: denominator 8, pass 0, fail 8, skip 0. The join row still fails
  its missing-length assertion with `Actual: 0`; the other seven stop earlier
  because `Array.prototype.push/reverse/unshift` are not callable as standalone
  values. These are independent method-value limitations.
* Host: denominator 8, pass 3, fail 5, skip 0. The join row still fails the
  missing-length assertion with `Actual: 0`; the three reverse rows fail their
  existing reversal assertion and `push/S15.4.4.7_A4_T3.js` fails its existing
  length/coercion assertion. There were no compile-error or timeout statuses.

Disposition: this is an unfinished draft handoff, not a completed fix. The
direct generic missing-property seam is green, but the exact host residual still
reproduces after later `undefined`/`null` writes widen the plain-object shape.
No source change was made without a bounded proof that it preserves explicit
`null`, prototype lookup, and accessors; the next implementation slice must
address that widened `length` representation and separately account for the
standalone method-value prerequisite.
