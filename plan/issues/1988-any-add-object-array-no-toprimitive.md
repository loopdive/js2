---
id: 1988
title: "__any_add on object/array operands skips ToPrimitive entirely — 1 + {} → NaN, [] + [] → 0"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-14
completed: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1938]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1988 — any + with ref-tagged operands returns NaN/0 instead of ToPrimitive result

## Problem

```ts
const o: any = {}; const a: any = []; const a12: any = [1,2];
String(1 + o) + "|" + String(a + a) + "|" + String(a12 + 1)
```

| expr | wasm | node |
|------|------|------|
| `1 + {}` | NaN | `1[object Object]` |
| `[] + []` | 0 | `""` |
| `[1,2] + 1` | NaN | `1,21` |

`"" + a12` works only because a string-literal operand routes through
`compileStringBinaryOp` instead.

## Root cause

`src/codegen/any-helpers.ts:515-560` — `__any_add` has only i32-add and
f64-add branches (comment: "Otherwise: trap (string concat via any not
supported yet)"); ref-tagged operands (tags 5/6) fall into `__any_to_f64`
(any-helpers.ts:466-505) which returns the raw `f64val` field for refs.
§13.15.3 ApplyStringOrNumericBinaryOperator requires ToPrimitive on both
operands first (valueOf/toString/Array.prototype.join via toString).

## Fix direction

Extend `__any_add` (or pre-dispatch in binary-ops) so ref-tagged operands
go through the ToPrimitive helper, then string-concat if either primitive
is a string. Sibling of #1938 which covers runtime *strings* in `__any_add`
— fix both in one pass if practical.

## Acceptance criteria

- All three repros match Node
- `{valueOf(){return 2}} + 1` → 3 (once #1989 dispatch is also correct)

## Dupe check

#1938 covers the same mechanism for runtime strings only; objects/arrays
needing ToPrimitive not mentioned there. Filed as sibling with `related`.

## Resolution — already fixed (2026-06-14)

Smoke-tested all three headline repros on current `main` (origin/main
`d1aba0601`, host/gc mode) — **all match Node**, so the `__any_add`
ToPrimitive gap was closed by the recent #1938/#1900/#2073 type-coercion wave.
No new code change needed; added a regression test to lock the behavior in.

| expr | wasm (now) | node | status |
|------|-----------|------|--------|
| `1 + {}` | `"1[object Object]"` | `"1[object Object]"` | ✓ |
| `[] + []` | `""` | `""` | ✓ |
| `[1,2] + 1` | `"1,21"` | `"1,21"` | ✓ |
| `{} + "x"` | `"[object Object]x"` | `"[object Object]x"` | ✓ |
| `[3,4] + ",5"` | `"3,4,5"` | `"3,4,5"` | ✓ |
| `{} + {}` | `"[object Object][object Object]"` | (same) | ✓ |

**Residuals (out of scope, tracked elsewhere):**
- The acceptance line `{valueOf(){return 2}} + 1 → 3` still throws "Cannot
  convert object to primitive value" — that is the user-defined-`valueOf`
  dispatch covered by **#1989** (in progress, task #9), not the object/array
  ToPrimitive this issue is about.
- Standalone (`--target standalone`) `String(...)` of the concat result returns
  `undefined` / derefs null — a separate standalone `String()` / string-result
  bug, NOT the `__any_add` defect. The `__any_add` ToPrimitive path itself is
  correct; only the standalone `String()` wrapper misbehaves (file separately if
  not already tracked).

Regression test: `tests/issue-1988.test.ts` (host/gc mode, 6 cases).
