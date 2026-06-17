---
id: 2107
title: "value-rep P4: standalone any-helper conformance on canonical tags (__any_strict_eq, __any_unbox_bool, $__any_to_string, __any_typeof)"
status: done
completed: 2026-06-16
assignee: ttraenkler/d3
sprint: 62
created: 2026-06-11
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [2104, 2080]
origin: "2026-06-11 analysis program (report 02 phase P4); stub 08-E22"
---

# #2107 — consumer-side fixes deferred from P0

## Problem

The standalone any-helpers dispatch on stale tag assumptions even after
type-aware boxing (P0): `__any_strict_eq` bails on tagA≠tagB so `0 === -0`
fails across the i32/f64 tag pair (#1987 residue), `__any_unbox_bool` has
no tag-5 string-length arm, `$__any_to_string` lacks the refval string
branch, `__any_typeof` lacks tag-5/6/7 arms.

## Root cause

src/codegen/any-helpers.ts:384-443 / 887-1000 / 1076-1163 and
native-strings.ts:5480-5586 — helper bodies written against the old tag
world.

## Fix direction

Per the value-rep spec P4: rewrite the four helper bodies against the
canonical JsTag module (#2104). Coordinates with coercion-engine Step 3
(the engine owns operator ENTRY points; P4 owns the helper BODIES).

## Acceptance criteria

- Standalone: 0===-0 true across tags, any-boxed "" falsy, typeof correct
  for all 8 tags, String(any) correct for every tag
- Host mode unchanged; the 8 probe tables from the spec's guardrail
  section pass in the standalone lane

## Dupe check

P0 issues (#2072/#2080) cover boxing only; helper conformance is the
deferred consumer half. New (analysis program).

## Resolution (2026-06-16, d3)

The issue's premise was partly stale after #2104 landed:

- **`__any_strict_eq` `0 === -0`** — already correct. #2104 added a
  numeric-class arm that compares tags {2,3} via `__any_to_f64` + `f64.eq`,
  and `f64.eq(0.0, -0.0)` is `true` (the right answer for `===`). No change
  needed; verified by probe.
- **`__any_unbox_bool` / `$__any_to_string`** — the string and box-recovery
  arms were already present and correct after #2104/#2072 (empty-string
  truthiness and the tag-5 externval / residual primitive-box arms verified
  by probe). No change needed.

The real, observable standalone defect was the **`typeof` operator over
canonical tags**, which is what P4's "typeof correct for all 8 tags"
acceptance criterion exercises:

1. **`__typeof_object` (native, `src/codegen/index.ts`)** returned `1`
   (object) for any non-null, non-boxed-primitive externref — *including a
   native `$AnyString`*. So a string-typed `any` reported BOTH
   `typeof === "string"` AND `typeof === "object"` as true. Added a
   `ref.test $AnyString` guard (gated on `ctx.anyStrTypeIdx >= 0`) that
   returns 0 (not object) for a native string, mirroring the #1896
   closure-wrapper guard.
2. **`compileTypeofComparison` `$AnyValue` fast-path
   (`src/codegen/typeof-delete.ts`)** used pre-canonical tag maps
   (`string -> [5,6]`, `object -> [0]`, no `function`). Corrected to canonical
   JsTag: `string -> [5]`, `object -> [0,6]`, `function -> [7]`.
3. **`__any_typeof` helper (`src/codegen/any-helpers.ts`)** collapsed tags
   5/6/7 to `"object"`. Now emits `"string"` for tag 5, `"function"` for
   tag 7, `"object"` for tag 6/other.
4. **`compileTypeofExpression`** consulted `__any_typeof` only under
   `ctx.fast`; the standalone path fell through to the `__typeof` native
   *stub* (`ref.null.extern`), so bare `typeof v` returned null and every
   `typeof v === "…"` compare failed. Re-gated on
   `isAnyValue && nativeStrings && anyStrTypeIdx >= 0` so standalone uses the
   real helper.

Boolean (tag 4) producer routing is owned by #2105 (value-rep P2 boolean
brand) and intentionally untouched here; the boolean typeof arm is correct
at the helper level given a tag-4 input.

## Test Results

`tests/issue-2107.test.ts` — 10/10 pass (standalone + wasi), each via a
runtime-selected union branch so the value flows through the runtime helper
(not statically folded):

| value (dynamic `any`) | `typeof ===` expected | result |
|-----------------------|-----------------------|--------|
| string                | "string" (not object) | pass   |
| number                | "number"              | pass   |
| object                | "object" (not string) | pass   |
| function              | "function" (not obj)  | pass   |
| undefined             | "undefined"           | pass   |

Regression guards: `typeof-comparison`, `typeof-expression`,
`issue-1896-typeof-closure`, `issue-1470-string-coercion-standalone`,
`issue-1917-coercion-plan` all pass; host/GC typeof verified unchanged by
probe (new helper path is no-op outside native-strings). Pre-existing
`tests/typeof-member-expression.test.ts` / `comparison-coercion.test.ts`
fail to load on a missing `./helpers.js` import — unrelated to this change.
`tsc --noEmit` clean.
