---
id: 5346
title: "prettier residual (101/151): `print-doc-to-string` illegal cast, `doc-builders`' last 6, `is-empty-doc` 7/16 — and which four files are deliberate refusals"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

prettier is **101/151** on clean main `c9a8b48616` (51 at the start; #5321
resolution of package.json `imports`, #5327 array element carrier, #5332
census). The 50 remaining split into three kinds, and only two are ours:

```
get-parser-plugin-by-parser-name.js   0/11 ┐ deliberate refusal — #3587
get-printer-plugin-by-ast-format.js   0/11 │ `async shape not supported … inside
massage-ast.js                        0/1  │  a try`, and the `--allow-fs` gate
resolve-parser.js                     0/1  ┘ (24 tests — NOT this issue)
doc-builders.js                      40/46   6 left after #5327
is-empty-doc.js                       7/16   9
print-doc-to-string.js                0/3    `illegal cast` in printDocToString
errors.js                             0/3
traverse-doc.js                       1/2  · get-descendants.js 1/2 · doc-printer.js 0/1
ast-path.js                           3/4  · whitespace-utilities.js 45/46
```

The four refusal files were **confirmed** as intentional by two independent
agents (#5321, #5327). Do not force them; they need the #3587 lane.

The `print-doc-to-string` `illegal cast` was localised by #5321 to
`printDocToString` and confirmed by #5327 as a **`ref.cast`** (not the
`ref.test`→null shape #5327 fixed) — a genuinely different defect at a known
location.

Also **known, deliberately not fixed in #5327, still observable**: when a
later array element's field names are a *superset* of element zero's
(`{type, contents}` then `{type, n, contents}`), the **binding slot**
re-narrows on store and silently drops `n`
(`Object.keys(docs[1]).length` → 2). That is a binding-slot defect with a
large blast radius (widening the declared vec carrier for every array-literal
global/local); it is pinned as a failing anchor in the #5327 test. It may be
behind some of `doc-builders`' last 6 and `is-empty-doc`'s 9 — **measure
before assuming**.

## Acceptance criteria

1. prettier ≥ 110/151 with the four refusal files untouched.
2. `print-doc-to-string.js` ≥ 2/3.
3. Regression test per fixed cause, failing on parent, passing with fix,
   untyped `.js` two-file fixtures, anti-vacuity control. If the superset
   binding-slot defect is fixed, the pinned anchor in
   `tests/issue-5327-call-produced-array-element-carrier.test.ts` flips to
   its correct expectation in the same PR.
4. A/B at one HEAD, 17 suites, per test file — prettier improves, nothing
   else moves (anchors in #5338).
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. `print-doc-to-string` first (0/3, located). Reproduce via the generated
   entry; get the exact `illegal cast` frame from `wasmError`; dump WAT
   around the `ref.cast` in `printDocToString`'s lowering. The doc printer
   walks a heterogeneous union of doc node shapes (`{type:"group"…}`,
   `{type:"indent"…}`, strings) — the cast is almost certainly a **union
   member** being cast to the *first* member's struct. Check the struct
   carrier decision in `src/codegen/struct-carrier-inhabits.ts` (#5327's new
   module) — this may be the same predicate needing to admit a union, not a
   new mechanism.
2. `doc-builders` last 6 and `is-empty-doc` 9: pull each failing assertion's
   `actual`/`expected`. If they read like a dropped field, that is the
   superset binding-slot defect; decide then whether to take it on (widen the
   declared carrier only for bindings whose initializer is an array literal
   with heterogeneous object elements — the narrowest sound scope) or record
   it and stop.
3. `errors.js` 0/3: custom `Error` subclass identity across the host boundary
   (`instanceof`/`.name`). Probe the eight basic shapes first — they all pass
   on main — then find what prettier does differently (likely the error
   crossing a *linked-module* boundary).
4. One PR per independent cause; regression tests; A/B.

## Dispatch

Model: **opus**. One located defect, one known large-blast-radius decision,
and one open question; needs judgement about scope.
