---
id: 6471
title: "JS-host: authenticating the host bridge for a Date instance leaks an internal field into Object.keys/for-in"
status: ready
sprint: current
created: 2026-09-13
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
goal: correctness
---

## Problem

Found while sweeping the `setExports` → `setInstance` collateral for
[#6451](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6451-jshost-struct-enumeration-returns-empty-in-2131-harness).
`tests/issue-2746.test.ts` "M2: Object.keys and for-in list ordinary dynamic
writes" builds:

```ts
var obj = new Date(0);
(obj as any).p1 = 1;
(obj as any).p2 = 2;
var forin = 0;
for (var p in obj) { if (obj.hasOwnProperty(p)) forin++; }
var keys = Object.keys(obj).length;
return keys === 2 && forin === 2 ? 1 : 100 + keys * 10 + forin;
```

With the harness on `setExports` (the current, un-authenticated host bridge
state), `keys === 2 && forin === 2` and the test returns `1` — correct: only
`p1`/`p2` should be own-enumerable.

Switching the same harness's post-instantiate call from
`imports.setExports?.(instance.exports)` to `imports.setInstance?.(instance)`
(the fix #6451 applies everywhere else, which authenticates the struct's host
bridge via `_dataStructHostBridgeMetadata`) makes `Object.keys(obj).length`
become `3` and the test return `133` — a third, internal Date-struct field is
now being reported as an own enumerable key.

## Why this matters

`setInstance` is the *correct*, production-shaped wiring (see #6451) — it is
what `compile()`'s own `result.importObject.__setInstance` and every shared
test helper already do. `setExports`'s fail-closed masking was accidentally
hiding this leak by returning `[]`/`undefined` for every struct, Date
included. #6451 intentionally does not touch `issue-2746.test.ts` (reverted
back to `setExports`) specifically to avoid trading a real reported bug for a
green checkmark — but that leaves the underlying leak live for any real
JS-host caller that reaches struct enumeration through the authenticated
`setInstance` path (i.e. every production Wasm module).

## Acceptance criteria

1. Reproduce with the snippet above through `compile()` + `r.importObject.__setInstance`
   (the production path, not a hand-rolled harness) and confirm `Object.keys`
   returns 3 entries including a non-`p1`/`p2` name.
2. Identify which internal Date field (`_getStructFieldNames` /
   `__struct_field_names` metadata, `src/runtime.ts` ~L1280/1573, or wherever
   Date's struct-field enumeration metadata is populated) is leaking and why
   it is not marked non-enumerable / excluded from the host bridge's own-key
   view, unlike a plain compiled class instance.
3. Fix so `Object.keys`/`for-in`/`Object.values`/`Object.entries` on a `Date`
   instance with dynamically-added own properties reports only the
   dynamically-added properties, under the authenticated `setInstance` path.
4. Flip `tests/issue-2746.test.ts`'s harness to `setInstance` (matching #6451's
   sweep) once fixed, and confirm the full file is green.
5. Dogfood A/B over the 17 upstream suites (`Date` is used broadly; this is a
   `src/` change).

## Notes

- `tests/issue-2746.test.ts`'s other subtests (M1, M-C) are unaffected by this
  and unrelated (M1's `arr.hasOwnProperty` failure is a separate, pre-existing
  bug — do not conflate).
- Not this file's harness quirk: the leak is a real host-bridge metadata gap,
  reproducible via the production `importObject.__setInstance` entry point.
