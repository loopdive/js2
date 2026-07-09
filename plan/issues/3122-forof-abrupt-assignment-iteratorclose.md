---
id: 3122
title: "for-of: abrupt LHS assignment (accessor setter throw) must raise and IteratorClose — never-done iterators spin (body-put-error.js)"
status: backlog
sprint: Backlog
created: 2026-07-09
priority: low
horizon: s
feasibility: medium
task_type: bug
area: codegen, standalone
language_feature: for-of, iterators, accessors
goal: standalone-mode
related: [3119, 1888, 2602]
origin: "2026-07-09 fable-3119 — surfaced by the #3119 OBJ iterator arm: language/statements/for-of/body-put-error.js flipped fail('illegal cast') → run_timeout because the iterator now genuinely drives."
---

# #3122 — for-of abrupt-assignment IteratorClose (§13.7.5.13)

## Problem

`test/language/statements/for-of/body-put-error.js` (standalone lane):

```js
var x = { set attr(_) { throw new Test262Error(); } };
iterable[Symbol.iterator] = function () {
  return { next: () => ({ done: false, value: 0 }), return: ... };
};
assert.throws(Test262Error, function () {
  for (x.attr of iterable) { ... }   // never-done iterator
});
```

Spec (§13.7.5.13 ForIn/OfBodyEvaluation step 6.f): `PutValue(lhsRef,
nextValue)` is abrupt (the setter throws) → `IteratorClose(iteratorRecord,
status)` → the error is forwarded. The loop must exit on the FIRST step.

Our compilation: the `x.attr = v` store inside the for-of does NOT raise (the
`{ set attr(_) {…} }` literal's accessor store doesn't throw on this path),
so nothing stops a never-done iterator — before #3119 the ladder trapped
"illegal cast" (fail, fast); with the #3119 OBJ arm the iterator genuinely
drives and the loop spins to the runner timeout.

Two sub-parts:

1. The accessor-setter throw must actually raise on the for-of LHS
   assignment path (pre-shaped struct literal accessor store).
2. The for-of lowering must wrap the LHS assignment so an abrupt completion
   triggers `__iterator_return` (IteratorClose) before rethrowing.

## Mitigation in place

The file is in `HANGING_TESTS` (tests/test262-runner.ts) since #3119 —
status `skip` on both lanes (it was `compile_timeout` on the host lane and
`fail` on standalone before, so no pass is lost; the skip saves the shard
the timeout cost). Remove the entry when fixing this issue.

**Side-finding (path-shape bug in HANGING_TESTS matching):** the lookups
strip `.*test262\/` from absolute paths like `<root>/test262/test/...`,
leaving keys shaped `test/<category>/...` — but the pre-#3119 entries are
prefix-less (`language/comments/S7.4_A6.js` etc.), so they NEVER match and
are dead. Verified 2026-07-09: S7.4_A6.js runs (and now passes, so its entry
should simply be deleted); the #1589A indexOf/lastIndexOf trio should be
re-probed — if they still spin they need the `test/` prefix, if fixed they
should be deleted. The #3119 entry uses the matching `test/` shape.

## Acceptance

1. body-put-error.js passes standalone (throw forwarded, `callCount === 1`).
2. Remove the `HANGING_TESTS` entry.
3. Sibling shapes (`body-dstr-assign-error.js`, put-error variants across
   for-of/for-await) re-checked.
