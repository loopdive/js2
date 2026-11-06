---
id: 7174
title: "Native-first: reading a property after delete o.a prints NaN instead of undefined (diff-test object/06-delete)"
status: ready
sprint: current
created: 2026-10-26
updated: 2026-10-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: objects
goal: correctness
parent: 6979
related: [6899, 2796, 2787, 7170]
---

# #7174 — `delete o.a; o.a` reads NaN on the native-first lane

The differential corpus row `object/06-delete` mismatches on the default native-first gc lane (the lane CI's diff-test measures since PR #6899 / S7-a). Its earlier trackers #2787 and #2796 are `done`; this row has no open tracker. Shape:

```js
const o = { a: 1, b: 2 };
delete o.a;
console.log(o.a);          // js2 native-first: NaN   (node: undefined)
console.log("a" in o);     // check
```

## Cause (as diagnosed; verify before fixing)

The object literal `{a: 1, b: 2}` lowers to a closed struct with an f64 field for `a`. `delete` cannot remove a struct field, so it writes a deletion marker or the f64 sentinel; the later typed read of `o.a` returns the f64 field and boxes NaN instead of consulting the deletion state and returning `undefined`. Compare #7170 (native-lane array holes) — same class: a typed slot has no "absent" state.

## Implementation Plan (2026-10-26; implement on Opus)

1. Reproduce with the corpus program (`scripts/diff-test.ts` corpus `object/06-delete`) and the snippet above, plus `Object.keys(o)`, `JSON.stringify(o)`, `o.hasOwnProperty("a")` after the delete, on gc native-first and standalone.
2. Find how `delete` on a closed-struct property is lowered and which read paths ignore the result. Fix so that a deleted property reads `undefined` (typed reads of a possibly-deleted field must go through the presence check, or a `delete` on a closed struct must demote that object to the dynamic `$Object` representation at the allocation site). Pick the option that keeps programs without `delete` byte-identical.
3. Tests: `tests/issue-7174-delete-property-read.test.ts` with the snippets on gc native-first and standalone vs node; the diff-test row must become `match`, then re-bank the diff-test baseline in the same PR with `scripts/diff-test-gate.ts --update` (improvement only).

Acceptance: node output on both lanes; diff-test `object/06-delete` matches; host-assisted gc bytes unchanged; equivalence gate no new regressions.
