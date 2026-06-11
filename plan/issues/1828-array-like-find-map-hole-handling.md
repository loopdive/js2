---
id: 1828
title: "Array-like find/findIndex skip holes; map compacts holes (sparse .call receivers)"
status: in-review
pr: 1271
created: 2026-06-04
updated: 2026-06-07
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
goal: correctness
sprint: 61
needs: architect-or-senior-dev
claimed_by: codex-developer
claimed_at: 2026-06-07T10:27:48.839Z
---

# #1828 — array-like find/findIndex/map hole handling

## Symptom

With an array-like `.call` receiver `{length:3, 0:1, 2:3}` (index 1 a hole):

- `Array.prototype.findIndex.call(o, x=>x===undefined)` → `-1` (spec `1`).
- `Array.prototype.map.call(o, x=>x*2).length` → `2` (spec `3`, holes preserved).

## Location

`src/codegen/array-methods.ts:824-895` wraps find/findIndex bodies in `gatedBody`
(HasProperty) — but spec visits holes as `undefined`. `:937-987` map builds the
result via `__js_array_push`, compacting holes and shifting indices.

## Spec

ECMAScript §23.1.3.9/.10 via §23.1.3.12.1 `FindViaPredicate`
(find/findIndex visit every index), and current draft §23.1.3.21 (map preserves
length / holes). Dense arrays are unaffected.

## Fix

Drop `gatedBody` for find/findIndex; write mapped values by index into a length-`len`
result (leave holes) instead of push.

## Investigation (2026-06-04, dev-w1) — NOT a localized fix; reclassified `hard`

The hole-handling corrections this issue describes are **necessary but not
sufficient**. The array-like `Array.prototype.<m>.call(receiver, cb)` path in
`src/codegen/array-methods.ts` is broken one layer deeper: it **never reads any
element correctly** for the receivers in scope, so fixing the hole gates alone
changes nothing observable.

### Root cause found

- `__extern_get_idx(obj, i)` (`src/runtime.ts:5190`) does `obj[i]`. The
  externref passed as the `.call` receiver for a compiled array/object is a
  **WasmGC `$Vec` / open-object struct**, not a JS-indexable value, so `obj[i]`
  is always `undefined`.
- Confirmed end-to-end (all on current main, JS-host `gc` target):
  - `({length:3,0:1,2:3})[2]` read back via the receiver → **NaN** (the numeric
    index isn't even retrievable — a separate object-literal numeric-key storage
    gap).
  - `Array.prototype.findIndex.call([10,20,30], x=>x===20)` → **-1** (spec 1),
    i.e. a **dense** real-array receiver also fails. So the defect is upstream of
    holes entirely: the receiver's elements are unreadable through
    `__extern_get_idx`.

### What I implemented and then reverted (kept the branch clean)

The localized parts described above DO compile and DON'T regress dense
_non-.call_ arrays (`[1,2,3].findIndex(...)`, `[1,2,3].map(...)` stay correct):

- find/findIndex: drop `gatedBody`, decrement the inner `if`'s `br` depth 3→2.
- map: add `__js_array_new_len(len)` + `__js_array_set_idx(arr,i,val)` host
  helpers (`src/runtime.ts`), pre-size the result to `len`, keep the
  HasProperty gate, set present indices by index.

But because no element is readable on the `.call` receiver, every
behavioral case still returns `-1` / `0` / `NaN`, so there is no test that can
prove the fix. Reverted rather than ship an unverifiable PR.

### Reroute

Before #1828 can land, the array-like `.call` **receiver-retrieval** path must
be fixed so `__extern_get_idx` / `__extern_length` read compiled `$Vec` /
open-object struct receivers (convert the receiver to a JS-accessible
array/object at the `.call` boundary, or route index reads through the WasmGC
element accessor). That is an architect/senior-dev sized change spanning the
receiver-conversion at the `.call` site plus the runtime accessors — not a
localized array-methods edit. Recommend architect spec; the hole-logic patch
above can land as a follow-up slice once receiver reads work.

## Implementation (2026-06-07, codex-developer)

The receiver-retrieval blocker described above has since been addressed on main:
`__extern_get_idx` / `__extern_has_idx` now consult sidecars and generated
struct getters for open-object numeric fields. With receiver reads working, the
localized hole-handling fix is now verifiable.

Changes:

- `Array.prototype.find.call` / `findIndex.call` on array-like receivers now
  load and visit every index instead of wrapping the predicate body in
  `HasProperty`, matching `FindViaPredicate` (`Get` per index, holes become
  `undefined`).
- `Array.prototype.map.call` still gates callback execution with
  `HasProperty`, but now sets the result length up front and writes mapped
  values by index via `__extern_set` instead of compacting through
  `__js_array_push`.
- Added `tests/issue-1828.test.ts` covering `find`, `findIndex`, interior holes,
  and trailing holes.

Validation:

- PASS: `pnpm vitest run tests/issue-1828.test.ts`
- PASS: `pnpm vitest run tests/issue-1828.test.ts tests/issue-array-call-arraylike.test.ts tests/issue-1358.test.ts tests/issue-1461.test.ts tests/equivalence/issue-6407.test.ts` (5 files, 59 tests)
- PASS after merging `origin/main` (attempt 30): `pnpm vitest run tests/issue-1828.test.ts tests/issue-array-call-arraylike.test.ts tests/issue-1358.test.ts tests/issue-1461.test.ts tests/equivalence/issue-6407.test.ts` (5 files, 59 tests)

Notes from expanded-but-out-of-scope validation:

- `tests/issue-1030.test.ts` fails across existing filter/reduce/map top-level
  `.call` cases, including methods not touched here.
- `tests/issue-342.test.ts` has existing TypeScript lib errors for dense
  `.call` typings (`unknown[]`, `number | undefined`, `unknown`).
