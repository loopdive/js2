---
id: 6700
title: "standalone: Object.defineProperty(date, \"valueOf\", {value: Number.prototype.valueOf}); date.valueOf() no longer throws TypeError (#4482 F2 row regressed on main)"
status: ready
sprint: current
created: 2026-09-26
updated: 2026-09-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: builtins
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [4482, 6692]
---

# #6700 — #4482 F2 "Number.prototype.valueOf on a Date" row fails on main

## What you will see

`tests/issue-4482.test.ts` > `#4482 F2 — an own slot written by
Object.defineProperty` > `Number.prototype.valueOf on a Date` fails on
`upstream/main` (measured 2026-09-26 at 36f92e8917, before and independent of
#6692's change):

```js
var d = new Date(0);
Object.defineProperty(d, "valueOf", { value: Number.prototype.valueOf });
d.valueOf(); // must throw TypeError (§21.1.3.7 thisNumberValue); standalone: no throw
```

The test answers `100` ("did not throw") where `1` (TypeError) is expected.
The `toString` twin of the same row still passes, so the regression is
specific to the `valueOf` call on a Date carrier. Unverified hypothesis: a
static Date-`valueOf` arm answers `[[DateValue]]` again without consulting the
own slot (`sourceOverridesMethodOnReceiver`).

This test262 row is `built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T03.js`.

## Pin

#6692 had to edit `tests/issue-4482.test.ts` (it closed that file's
"dot and bracket in one module" residual). The `changed root test files must
pass` gate then required the file to be green, so this row is pinned there as
`it.fails` pointing here. Flip it back to a plain row when fixed.

## Acceptance

- The row answers `1` standalone; `it.fails` pin removed.
- Bisect the regressing commit and name it in `## Resolution`.
