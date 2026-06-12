---
id: 2117
renumbered_from: 1958
title: "nativeStrings split() ignores the limit argument; split(undefined) emits an invalid Wasm module"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: standalone-mode
related: [1369, 1913]
origin: "2026-06-10 deep-audit sweep (strings agent): verified on main, native backend"
---

# #2117 — native `__str_split` has no limit param

## Problem

Per [§22.1.3.23](https://tc39.es/ecma262/#sec-string.prototype.split), `limit`
caps the result (ToUint32; `0` → `[]`). The native backend never compiles the
second argument; `split(undefined)` additionally produces a module that fails
to parse.

## Repro (verified on main, `{ nativeStrings: true }`)

| case | wasm native | node / jsHost |
|------|------|------|
| `"a,b,c".split(",", 2).length` | `3` | `2` |
| `"a,b".split(",", 0).length` | `2` | `0` |
| `"a,b".split(undefined as any).length` | **broken binary** ("call function index 1 has 2 arguments, but the expression stack currently holds 1 values") | `1` |

## Root cause

`src/codegen/string-ops.ts:2292-2315` — native split branch compiles receiver
+ separator and calls `__str_split(s, sep)` (`native-strings.ts:3837`, two
params, no limit); `expr.arguments[1]` is never compiled (not even for side
effects). Invalid-wasm case: `compileExpression(arguments[0])` for `undefined`
yields a non-string value but `emitFlatten()` is emitted unconditionally
(2297-2298), leaving a stack-shape mismatch for `__str_flatten`.

## Fix direction

Add a limit i32 param to `__str_split` (count check inside both push loops,
`limit===0 → []`, default 0xFFFFFFFF); guard the separator-arg compile on a
string-typed result (fall back to undefined-separator semantics → 1-element
array containing the whole string).

## Acceptance criteria

- All three repro rows match Node
- Limit arg side effects evaluated once
- Host path (#1369) unregressed

## Dupe check

#1369 (done) fixed limit on the **host** path; #1913 (ready) covers
**RegExp**-separator split limit in standalone. The native string-separator
helper untracked; no hit for the invalid-wasm shape.

## Closed as duplicate (2026-06-12)

Duplicate of #2125 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2125.
