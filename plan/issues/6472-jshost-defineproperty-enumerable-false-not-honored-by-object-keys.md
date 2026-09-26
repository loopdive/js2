---
id: 6472
title: "JS-host: Object.keys/values/entries and propertyIsEnumerable ignore a compile-time-known enumerable:false flag"
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
`tests/issue-797-batch1.test.ts` (`#797 WI2/WI4`) is pre-existingly red — same
failures before and after #6451's harness fix, so this is not the #6451
mechanism, but a distinct real bug uncovered by re-running the file:

```ts
export function test(): number {
  const obj = { a: 1, b: 2, c: 3 };
  Object.defineProperty(obj, "b", { enumerable: false });
  return Object.keys(obj).length; // expected 2, actual 3
}
```

`Object.keys`/`Object.values`/`Object.entries` still list the
`enumerable: false` field, and `propertyIsEnumerable` returns the wrong
boolean after a `defineProperty(..., {enumerable: false})` call — 5 of the
file's assertions fail this way (WI2's three enumeration-surface checks, WI4's
two `propertyIsEnumerable` checks). WI1's `__getOwnPropertyDescriptor` runtime
check is unaffected and (per #6451) now passes once the harness uses
`setInstance`.

## Acceptance criteria

1. Reproduce standalone via `compile()` + `r.importObject.__setInstance` (the
   production path).
2. Trace where a struct field's enumerable flag is (or should be) tracked at
   compile time / in the runtime descriptor metadata, and why the
   `Object.keys`/`Object.values`/`Object.entries`/`propertyIsEnumerable`
   surfaces don't consult it (likely the same struct-field-name enumeration
   path `#6451` touches, `_getStructFieldNames` / `__struct_field_names` in
   `src/runtime.ts`, vs. the separate descriptor-flags storage used by
   `__getOwnPropertyDescriptor`).
3. Fix so a `defineProperty(..., {enumerable:false})`'d field is excluded from
   `Object.keys`/`values`/`entries`/`for-in`, and `propertyIsEnumerable`
   answers correctly, without breaking WI1's descriptor read-back or WI3
   (untouched, presumably passing — verify).
4. `tests/issue-797-batch1.test.ts` fully green.
5. Dogfood A/B over the 17 upstream suites (this touches the general
   enumeration path; `src/` change).

## Notes

- Do not conflate with #6471 (Date-struct field leak) — different root cause
  (a class of struct generally, not specifically `Date`), same symptom class
  (enumeration surfaces disagreeing with the property's real enumerable
  status).
