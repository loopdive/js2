---
id: 6423
title: "An ABSENT number-typed property stringifies as `\"NaN\"` instead of `\"undefined\"` — the f64 absence sentinel leaks through `String()`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
// untyped .js half
export function readProp(o) {
  return String(o.maxAge);
}
export function readPropWithField(o) {
  return String(o.path) + "/" + String(o.maxAge);
}
```

| call                                | node                    | compiled                |
| ----------------------------------- | ----------------------- | ----------------------- |
| `readProp({})`                      | `"undefined"`           | **`"NaN"`**             |
| `readProp({ path: "/" })`           | `"undefined"`           | **`"NaN"`**             |
| `readPropWithField({})`             | `"undefined/undefined"` | **`"undefined/NaN"`**   |
| `readProp(Object.assign({}))`       | `"undefined"`           | **`"NaN"`**             |

The third row is the diagnosis in one line: the same absent-property read gives
the right answer for a **string**-shaped slot and the wrong one for a
**number**-shaped slot. So the absent numeric slot is carrying the f64 absence
sentinel (`UNDEF_F64`) and `String()` stringifies the sentinel as `NaN` instead
of mapping it back to `undefined`.

Measured on `cf82f78d6d` (2026-09-12) through an untyped two-file fixture, the
dogfood `compileAndRunUpstreamModule` lane.

## What is NOT broken (measured in the same run — do not re-derive)

These all answer correctly for an absent numeric property, so the fix belongs
at the value→string boundary, not in the property read or the type predicates:

* `typeof o.maxAge === "undefined"` ✓
* `o.maxAge === undefined` ✓
* `"maxAge" in o` ✓ (false)
* a `typeof o.maxAge === "number" && o.maxAge >= 0` guard is NOT taken ✓
* anti-vacuity: a PRESENT `maxAge: 0` answers `"number"`, is `>= 0`, and the
  guard IS taken ✓

## Acceptance criteria

1. `String(o.p)` / `` `${o.p}` `` / `o.p + ""` answer `"undefined"` for an
   absent number-typed property, on an empty and a non-empty object literal and
   on an object that reached the reader through an `any` parameter.
2. Anti-vacuity, and this is the whole risk: a PRESENT `p: 0` still stringifies
   as `"0"`, and a genuine `NaN` still stringifies as `"NaN"`. The sentinel and
   a real NaN are the same f64 bit pattern family — a fix that maps all NaN to
   `undefined` is worse than the bug.
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD.
5. Standalone lane status recorded.

## Two adjacent measurements, NOT claimed as this defect

Both came out of the same probe. Each needs its own bisect; neither is
explained by the diagnosis above, and attributing them here would be a guess:

1. **hono serializes a spurious `Max-Age=0`.** `src/utils/cookie.ts:196` guards
   with `typeof opt.maxAge === "number" && opt.maxAge >= 0` and compiled hono
   takes that branch for an options object with no `maxAge`, emitting
   `; Max-Age=0`. It costs `Should serialize cookie` outright and is the second
   of the two defects in `Should serialize a signed cookie` (the first being
   [#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments)).
   **Two hypotheses were tested and BOTH refuted**: it is not `typeof` on an
   absent property (works, above) and it is not the guard shape (works, above).
   So the trigger involves hono's real `CookieOptions`-typed parameter rather
   than the `any`-typed literal a minimal fixture produces — bisect from the
   real module, not from a reconstruction.
2. **An empty object literal `{}` passed as an argument then read** throws
   `TypeError: Cannot access property on null or undefined` — the no-field
   literal appears to lower to a null struct. `readProp({})` above does NOT
   throw, so the trigger is narrower than "`{}` argument"; it showed up only in
   the longer `serializeLike(name, value, {})` form.

## Dispatch

Model: **opus**. The defect itself is one boundary; criterion 2 is the reason
this is not an easy ticket.
