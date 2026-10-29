---
id: 7159
title: "Native-first and standalone: JSON.stringify(C) of a class constructor prints {} / null instead of undefined"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7149, 7158]
---

# #7159 — `JSON.stringify(C)` where `C` is a class

Found by the fresh-context review of PR #6912 (#7149, finding 4). Pre-existing
on `origin/main`; #7149 changed the no-host output from `null` to `{}`:

```js
class C { #x = 1 }
console.log(JSON.stringify(C));          // "{}" after #7149, "null" before   (node: undefined → prints "undefined")
console.log(JSON.stringify({ a: C }));   // {"a":{}} on every lane incl. host-assisted   (node: {})
```

## Cause (as diagnosed; verify before fixing)

A class constructor value shares (or is represented by) its instance struct on
the no-host lanes, so the closed-struct classifier treats it as an instance.
Per spec a function is skipped by `SerializeJSONProperty` (`undefined` at top
level, omitted as a property value). The host-assisted lane gets the
top-level case right but still prints `{"a":{}}` for the property case, so the
function check is missing in the property path on every lane.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce both programs on gc host-assisted, gc native-first and standalone;
   also `JSON.stringify([C])` (node: `[null]`) and `JSON.stringify(function
   f(){})` / an arrow.
2. In the JSON value-kind dispatch, test "is callable" (the same predicate
   `typeof v === "function"` lowers to) BEFORE the closed-struct classifier
   and before the object arm, returning the undefined sentinel for top-level /
   property positions and `null` inside arrays. Do not add host imports; keep
   the host-assisted gc bytes identical unless the property-path fix requires a
   change there — then state it in the PR body with the byte delta.
3. Tests: `tests/issue-7159-json-stringify-function-values.test.ts` with the
   four programs on all three lanes vs node.

Acceptance: node's output on gc native-first and standalone for all four
programs; equivalence gate reports no new regressions.
