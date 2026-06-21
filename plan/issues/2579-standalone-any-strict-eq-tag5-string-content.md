---
id: 2579
title: "standalone: __any_strict_eq / __any_eq tag-5 string arm returns always-false (boxed string === and Array.prototype.indexOf/includes.call on string array-likes)"
status: done
sprint: 64
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: sdev-strdispatch
priority: low
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: strings
goal: standalone-mode
related: [2036, 1461, 1360, 296]
origin: "2026-06-21 — pinpointed by sdev-reflect while closing #2036 array-search"
---

# #2579 — `__any_strict_eq` / `__any_eq` tag-5 string arm is always-false in standalone

## Problem

The `$AnyValue`-boxed equality helpers `__any_strict_eq` (`===`) and `__any_eq`
(`==`) compare same-tag string operands (tag 5) by content via the
`wasm:js-string` `equals` builtin. In standalone/WASI there is no
`wasm:js-string` host, so `strEqualsIdx = ctx.jsStringImports.get("equals") ?? -1`
is `-1`, and the tag-5 arm emitted `i32.const 0` (**always false**) — two equal
strings boxed in `$AnyValue` never matched.

The headline standalone repro (still failed on `origin/main` `93e53919f`):

```ts
const al: any = { 0: "x", 1: "y", length: 2 };
Array.prototype.indexOf.call(al, "y"); // -1   expected 1
Array.prototype.includes.call(al, "y"); // false expected true
```

`Array.prototype.{indexOf,lastIndexOf,includes}.call(arrayLike, str)` routes
through `compileArrayLikePrototypeSearch` → `__extern_strict_eq` /
`__extern_same_value_zero` (composed from `__any_from_extern` + `__any_strict_eq`),
so the always-false tag-5 arm made every string-element search miss.

## Root cause

`any-helpers.ts` — the tag-5 (string) arm in both `__any_strict_eq` and
`__any_eq`: `then: strEqualsIdx >= 0 ? [...wasm:js-string equals...] : [i32.const 0]`.
Standalone takes the `i32.const 0` stub. The `$AnyValue` field 4 (externval)
holds the native string as `extern.convert_any($AnyString)`, so the value is
recoverable — only the comparison was stubbed out.

## Fix

Route the standalone tag-5 arm to the native `__str_equals` (the same helper
`binary-ops.ts` uses for a static string `===`), recovering each operand from
field 4: `any.convert_extern` → `ref.test $AnyString` guard → `ref.cast` →
`__str_flatten` (cons-string safe) → `__str_equals`. Applied to BOTH helpers
(`==` on same-type strings is content equality too, §7.2.15 → §7.2.16). The
`ref.test` guard keeps a non-string-rep field-4 carrier on `0` rather than
trapping. Host/gc mode keeps the `wasm:js-string equals` path unchanged. Two new
anyref temp locals (`seA`/`seB`) per helper.

## Acceptance criteria

- `Array.prototype.indexOf.call({0:"x",1:"y",length:2}, "y")` → 1;
  `…includes.call(…, "y")` → true.
- cons-string element (`"x"+"y"` vs `"xy"`) matches; different-length strings
  early-out correctly; a miss returns -1/false.
- No regression: numeric/null array-like `.call` search unchanged; static string
  `===` unchanged; host/gc mode unchanged.

## Out of scope (verified, pre-existing on main — separate gaps)

- Plain `const a:any=[...]; a.indexOf("y")` (NOT the `.call` form) still returns
  0 — it routes through `__extern_method_call`, whose non-`$Object` ($Vec) brand
  arm is the #1888 "Slice 4" deferral (returns undefined), and never reaches
  `__any_strict_eq`. Separate, larger gap.
- Boolean-element array-like `.call` search (`includes.call([true,false],
false)`) returns 0 on main too (search-value boolean boxing, tag-4) — unrelated
  to the string arm.
- The #2036 S6 "refuse loud" + #1360 null-field array-like tests fail identically
  on main (pre-existing, independent).

## Implementation (sdev-strdispatch, 2026-06-21)

`src/codegen/any-helpers.ts` only: capture `__str_equals`/`__str_flatten`
indices in the standalone native-string block; replace the tag-5 `i32.const 0`
stub in `__any_strict_eq` and `__any_eq` with the guarded native comparison; add
`seA`/`seB` anyref locals to both helpers. Tests:
`tests/issue-2579.test.ts`.
