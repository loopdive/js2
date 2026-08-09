---
id: 3714
title: "Private brand check (#x in obj) on a null receiver does not throw a catchable TypeError"
status: done
sprint: 77
created: 2026-07-27
updated: 2026-07-30
completed: 2026-07-27
priority: low
horizon: s
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: n/a
goal: property-model
origin: "#3690 — new tests/differential/corpus/private-fields/05-brand-checks.js surfaced this on first run"
related: [3690]
# The +8 lines are the new `__extern_is_object` host import (implementation
# + the comment explaining why it's not just `typeof v === "object"`, per
# #3714's Root cause section below). Genuinely new runtime surface, not
# god-file drift.
loc-budget-allow:
  - src/runtime.ts
# compileInOperator grew because the new not-an-object throw check is
# inlined at its one call site rather than factored out (it needs fctx/ctx
# plus the already-computed externCopy/brandLocal, so extracting a helper
# would mean threading 4-5 params for a single-caller function). resolveImport
# is the same shared big-dispatch-table pattern __extern_is_undefined and
# every other single-arg host import already lives in.
func-budget-allow:
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/runtime.ts::resolveImport
---

# #3714 — `#field in obj` with `obj === null` should throw a catchable TypeError

## Repro

```js
class Box {
  #v;
  constructor(v) { this.#v = v; }
  static isBox(obj) { return #v in obj; }
}
const b = new Box(1);
console.log(Box.isBox(b));   // true
console.log(Box.isBox({}));  // false
try {
  Box.isBox(null);
} catch (e) {
  console.log(e instanceof TypeError); // true
}
```

## Symptom (before fix)

- V8: `true\nfalse\ntrue`
- js2wasm: `true\nfalse` (third line never printed)

## Root cause

ECMA-262 §13.10.1 step 5 (`RelationalExpression : PrivateIdentifier in
ShiftExpression`): *"If `rval` is not an Object, throw a TypeError
exception."* — verified empirically against real Node 22 that this applies
to `null`, `undefined`, and every primitive, not just `null`.
`src/codegen/binary-ops-in.ts` carried a comment claiming the opposite
("no throw, even when obj isn't an object"), which was itself wrong.

`emitPrivateBrandPredicate` (`src/codegen/expressions/helpers.ts`)
implements the check as a single `ref.test $declaringClassStruct`, which is
correct for "does obj have this brand" but `ref.test` evaluates to `0` for
ANY non-matching anyref (including `null` and boxed primitives) — every
non-instance receiver, object or not, silently became `false` with no
distinction and no throw.

## Fix

`ref.test` alone can't distinguish "a real object of the wrong class" from
"not an object at all" — Wasm has no visibility into what an opaque
externref (the receiver's static type for an untyped/`any` parameter, the
common case here) actually wraps once it crosses the JS-host boundary.
Added a new JS-host import, `__extern_is_object` (`src/runtime.ts`),
implementing ECMA-262's `Type(x) is Object` directly (`v !== null &&
(typeof v === "object" || typeof v === "function")` — deliberately NOT
`typeof v === "object"` alone, which is `true` for `null` too).

`src/codegen/binary-ops-in.ts`'s private-identifier branch now: stashes a
raw copy of the externref receiver before `any.convert_extern`, and if the
`ref.test`-based brand predicate comes back `false`, calls
`__extern_is_object` on that raw copy. If it says "not an object," emits a
catchable `TypeError` throw (via the existing `emitThrowTypeError` /
`pushBody`/`popBody` nesting pattern); otherwise falls through to the
existing `false` result (correct object, just the wrong class).

Scoped to the JS-host fast path only (guarded by `!ctx.standalone &&
!ctx.wasi`), per the dual-mode architecture principle — standalone has no
host to delegate to, so it keeps its pre-existing (still spec-incomplete,
but not regressed) false-no-throw behavior for the non-object case. A
Wasm-native standalone fix is a separate, deferred follow-up.

## Verification

- New repro (own instance / wrong-class object / null / undefined / number
  / string, all six cases): matches V8 exactly.
- `private-fields/05-brand-checks.js` in the #3690 differential corpus: now
  matches (private-fields category 5/5, up from 4/5).
- Zero regressions across ~380 tests spanning private fields, brand checks,
  the `in` operator, and class-value tests (`tests/private-class-members.test.ts`,
  `tests/class-static-private-this.test.ts`,
  `tests/issue-2563-privatefield-global-shift.test.ts`,
  `tests/in-operator-edge-cases.test.ts`, plus 20+ other `issue-*.test.ts`
  files) — every failure encountered was independently confirmed
  pre-existing on `main` (unrelated to this change) by re-running the same
  suites with the fix stashed out.
- One test needed correcting, not preserving: `tests/issue-1348.test.ts`'s
  "private in is a brand check and does not throw on wrong receiver" test
  asserted `Box.isBox(null)` returns falsy — the exact same spec
  misunderstanding this issue fixes in the compiler. Updated to assert the
  correct behavior (own instance → `true`, wrong-class object → `false`,
  `null` → catchable `TypeError`).
