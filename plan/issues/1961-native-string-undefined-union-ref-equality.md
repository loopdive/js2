---
id: 1961
title: "nativeStrings: === on a string|undefined value compares by reference, not content (\"hello\".at(1) === \"e\" → false)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: equality
goal: standalone-mode
related: [1352, 2051]
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main, native backend"
---

# #1961 — union-typed native strings fall through to ref equality

## Problem

Any API producing `string | undefined` (`.at()`, optional chains, optional
params) yields values whose `===` against a string literal is compiled as
struct identity comparison — always false for equal content.

## Repro (verified on main, `{ nativeStrings: true }`)

```ts
export function test(): boolean { return "hello".at(1) === "e"; }
```

wasm native: `false` — node / jsHost: `true`.
Controls: `"hello".charAt(1) === "e"` (plain `string` type) → `true`;
`.at(1)` value itself correct (charCode 101); `at(99) === undefined` → `true`.

## Root cause

`src/codegen/binary-ops.ts:943-948` — routing into `compileStringBinaryOp`
(content comparison via `__str_equals`) requires `isStringType()` on both
sides; `src/checker/type-mapper.ts:292-302` `isStringType` returns false for
the union `string | undefined` (no Union handling). The expression falls
through to generic ref-equality on distinct `$NativeString` structs.

## Fix direction

Teach the dispatch (or a union-aware `isStringType` variant) to treat
`string | undefined` / `string | null` operands as string comparisons with a
null-guard (null ref ↔ undefined ≠ any string), mirroring the existing
`isNullableNativeString` special case at binary-ops.ts:464-465.

## Acceptance criteria

- Repro true in native mode
- `x === undefined` for `x: string | undefined` still correct both ways
- `!==`, `==`, `!=` variants covered

## Dupe check

#2051 (today) is optional-chain default-value fabrication — different root
cause. #1352 is exec-result externref equality in JS-host mode. Union-typed
native-string `===` untracked.
