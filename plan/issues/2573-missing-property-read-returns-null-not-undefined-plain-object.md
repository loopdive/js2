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
coercion-sites-allow:
  # Generic Array.join's element ToString path intentionally reuses the
  # established standalone __extern_toString provider.
  - src/codegen/array-like-native.ts
loc-budget-allow:
  # The generic-method implementation lives in array-like-native.ts. These
  # existing dispatch and widening seams only wire that subsystem into calls,
  # declarations, open-object tracking, and transferred prototype values.
  - src/codegen/array-object-proto.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/statements/variables.ts
  - src/codegen/typeof-delete.ts
func-budget-allow:
  # These small additions are the corresponding subsystem dispatch hooks; the
  # generic Array method bodies remain outside these driver functions.
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations/object-shape-widening.ts::collectEmptyObjectWidening
  - src/codegen/declarations/object-shape-widening.ts::scanStatements
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/typeof-delete.ts::compileTypeofExpression
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

## 2026-08-27 resumed implementation plan — widened `length` first

1. Reduce the single `join/S15.4.4.5_A2_T1.js` row to the exact write/read
   sequence that changes missing `length` from canonical undefined to numeric
   zero. Preserve the four direct controls already committed.
2. Fix only the shared widened-property carrier/read seam proven by that
   reduction; explicit null must remain null and missing/inherited/accessor
   values must remain distinct.
3. Rerun the join row in standalone and host. Only after it passes, reduce the
   seven push/reverse/unshift rows as the independently documented first-class
   Array-method-value prerequisite.
4. Keep PR #5033 draft until all eight exact rows pass with zero non-passes;
   push each verified checkpoint to the same issue branch.

## 2026-08-27 widened `length` checkpoint

The first resumed slice is now implemented and bounded. Empty-object receivers
with a direct `length = undefined`/`length = null` write stay on the open
presence-aware object carrier; the dynamic read result remains `externref`, and
`typeof obj.length` stays on the runtime read. This keeps missing, explicit
null, and accessor results distinct while leaving ordinary primitive-only
widening unchanged.

Focused controls pass: `tests/issue-2573.test.ts` and
`tests/issue-2573-missing-property.test.ts` report 3/3 tests (4/4 direct
missing/null/inherited/getter assertions). A reduced `join` sequence passes in
both host and standalone for the missing/typeof/undefined/null checks; the
method-value call remains a standalone prerequisite limitation and passes in
host.

The exact surviving join row was rerun through the maintained official-scope
runner at the pinned revision with the fixed Node/LLVM/artifact paths and
`COMPILER_POOL_SIZE=2`:

* Host: 1/1 pass.
* Standalone: 0/1 pass; it stops at the pre-existing `Array.prototype.join is
  not yet callable as a value in --target standalone` limitation, before the
  missing-length assertion.

This is a verified partial checkpoint only. PR #5033 remains draft because the
standalone join row and the seven independent push/reverse/unshift method-value
rows are not yet zero-nonpass. The source checkpoint preserves the four direct
controls and is not an issue closure.

## 2026-08-27 first-class Array method-value checkpoint

The transferred first-class `Array.prototype.push`, `reverse`, and `unshift`
closures now use a receiver-aware variadic ABI and the host-free dynamic
array-like substrate. The mutator bodies preserve present-but-`undefined`
properties, holes, and the original receiver for `reverse`; the proof accepts
the numeric element writes used by these historical rows while remaining
conservative for dynamic method-slot writes. A narrow declaration-carrier
proof keeps `var result = obj.reverse()` on the open externref carrier, because
the borrowed TypeScript return type otherwise materializes a fresh typed array
and loses object identity.

The exact seven non-`join` surviving rows were rerun once through the
maintained official-scope runner at the pinned revision with the fixed
Node/LLVM/artifact paths and `COMPILER_POOL_SIZE=2`:

* Standalone: denominator 7, pass 7, fail 0, compile errors 0, timeouts 0,
  skips 0.

The focused direct controls remain green (4/4 missing, explicit `null`,
inherited, and getter cases), and TypeScript typechecking passes. The exact
`join` row is still the only owned non-pass: its standalone method-value call
requires the next shared join closure implementation. PR #5033 remains draft
and this checkpoint is not an issue closure until the exact eight-row slice is
8/8 with zero non-passes.

## 2026-08-27 exact eight-row standalone acceptance

The transferred `Array.prototype.join` value now uses the same receiver-aware
variadic ABI as the other three generic methods. Its native body reads
`length` and indexed values through the dynamic object substrate, converts
non-nullish values with the native ToString helper, and renders missing,
`undefined`, and `null` elements as empty strings. The optional separator is
kept as a vector so omitted/`undefined` select the comma default while an
explicit `null` remains distinguishable under the canonical undefined
singleton.

The maintained official-scope runner was run once over the exact eight
surviving rows at the pinned Test262 revision with the fixed Node/LLVM/artifact
paths and `COMPILER_POOL_SIZE=2`:

* Standalone: denominator 8, pass 8, fail 0, compile errors 0, timeouts 0,
  skips 0.

The standalone harness controls also reported both directions as expected,
and the focused issue tests remain green: 3/3 tests, including 4/4 direct
missing, explicit-`null`, inherited, and getter assertions. TypeScript
typechecking and `git diff --check` pass. The earlier host rerun of the exact
slice remains 3/8 because five unrelated host-lane assertions fail (three
reverse behavior rows and one push length/coercion row, plus the pre-fix join
row); the owned standalone acceptance slice is now 8/8. This closes the
resumed implementation scope; PR #5033 may leave draft status only at the
parent agent's discretion after reviewing the host-lane residuals.

## 2026-08-27 upstream quality follow-up

The first refreshed PR quality run failed the LOC-regrowth ratchet after the
branch was tested as a merge result against a newer `main`. The implementation
already keeps the generic method bodies in the dedicated
`array-like-native.ts` subsystem; the remaining growth is the intentional
wiring across existing call, declaration, open-object widening, property
dispatch, and transferred-prototype seams. This issue now grants those exact
paths a change-set-local LOC allowance rather than changing the shared budget
baseline. The branch was merged with current upstream `main`; focused and
exact semantic evidence above remains the acceptance proof, and PR #5033 stays
draft until the refreshed quality and regression jobs pass.
