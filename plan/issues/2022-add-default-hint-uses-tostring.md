---
id: 2022
title: "obj + '' applies string-hint ToPrimitive (toString) instead of default hint (valueOf first) when one operand is string-typed"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1989, 1900, 1988]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2022 — `+` pre-commits to string concat before ToPrimitive

## Problem

```ts
class P { toString(): string { return "P!"; } valueOf(): number { return 7; } }
(new P() as any) + ""
// wasm: "P!"   node: "7"
```

§13.15.3: `+` applies ToPrimitive with *default* hint to both operands
first (OrdinaryToPrimitive tries valueOf before toString), THEN decides
concat vs add. Template `` `${p}` `` correctly gives "P!" (string hint);
relational `p > 5` correctly uses valueOf.

## Root cause

`src/codegen/binary-ops.ts:950` — `+` with a string-typed operand routes
straight to `compileStringBinaryOp` (string-hint stringification of the
ref operand) instead of applying ToPrimitive(default) to the object
operand before the concat/add decision.

## Fix direction

For ref operands in `+`, emit ToPrimitive(default) (valueOf→toString),
then branch on the primitive's type. Coordinate with #1989 (dispatch
correctness) and #1988 (any path).

## Acceptance criteria

- Repro returns "7"; objects with only toString still concat correctly
- Template literals (string hint) unchanged

## Dupe check

#1253/#1090 done; #1900 is standalone-native ToPrimitive phase 1 —
host-mode `+` hint routing not covered. New.

## Resolution (2026-06-12)

`+` stringified object/`any` operands via the STRING hint
(`__extern_toString` / `coerceType(..., "string")`, both toString-first).
§13.15.3 requires the DEFAULT hint (valueOf-first) even when the other operand
is a string.

Fix kept entirely in `src/runtime.ts` + `src/codegen/string-ops.ts` (no
`type-coercion.ts` edit — that region is #1989's; coordinated with dev-c):

1. **`src/runtime.ts`** — new `__extern_to_string_default` host helper: mirrors
   `__extern_toString` but calls `_toPrimitive(v, "default", …)` (valueOf before
   toString), then `String(...)`. Throws on Symbol per spec.
2. **`src/codegen/string-ops.ts`** — every `+`-concat object/`any`/struct
   operand path now routes through `__extern_to_string_default` instead of the
   string-hint helpers: the left/right externref + ref/struct branches in
   `compileStringBinaryOp`, and the ref/struct branch of
   `compileAndCoerceConcatOperand` (the batched `__concat_N` path; `__concat_N`
   already used the default hint for raw structs, so its plain-externref operand
   stays correct). Template literals / `String()` keep the string hint;
   relational / `-` / `*` keep the number hint — all untouched.

### Test Results

New `tests/issue-2022.test.ts` — 7 cases, all match Node:
`objWithValueOf + "" → "7"` (was "P!"), `"x" + obj → "x7"`, 3-op chain
`"a"+obj+"b" → "a7b"`, only-toString obj still concats (`"Q!"`), template
`${p}` keeps string hint (`"P!"`), `p > 5` keeps number hint (valueOf),
`[Symbol.toPrimitive]` override honoured.

Existing string/concat tests unregressed (`#1525` string-hint cases, `#2005`,
`#2006`, `#1342` all pass). The two `#1525` *arithmetic* failures
(`valueOf in arithmetic`, `hint number prefers valueOf`) pre-exist on clean
`main` — that's the separate #1989 ref→f64 valueOf-collision bug, not this
change. `tsc --noEmit`, `biome lint`, `prettier --check` clean;
`check:ir-fallbacks` OK.
