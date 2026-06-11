---
id: 1962
title: "nativeStrings: spreading a string ([...\"ab\"]) silently produces an empty array"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: spread
goal: standalone-mode
related: [1514, 1964]
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main, native backend"
---

# #1962 — array-literal spread has no native-string source branch

## Problem

`[..."ab"]` compiles cleanly and yields `[]` in native/standalone mode. Spec
([§13.2.5.5](https://tc39.es/ecma262/#sec-runtime-semantics-arrayaccumulation)):
spread iterates the string's code points.

## Repro (verified on main, `{ nativeStrings: true }` or standalone)

```ts
export function test(): number { const a = [..."ab"]; return a.length; }
```

wasm native/standalone: `0` — node / jsHost: `2`.
Control: `"ab".split("").length` → native `2` (correct) — only the spread
path is broken.

## Root cause

`src/codegen/literals.ts` array-literal spread path (~2501-2690): a
native-string spread source compiles to a `ref $AnyString`/`$NativeString`
struct, which is neither the externref branch (2519, host-iterable
materialization) nor a registered vec type —
`getArrTypeIdxFromVec(ctx, spreadInfo.srcVecTypeIdx)` returns <0 and the fill
loop is silently `continue`d (~2709); the length contribution reads a non-vec
struct field. No string-spread case exists.

## Fix direction

Add an explicit native-string branch in the spread source handling: flatten,
iterate code points (surrogate-pair aware — coordinate with #1964), push
1-code-point native strings into the result vec; check whether
destructuring/`Array.from` share this path and cover them too. Also: a
silently-`continue`d unknown spread source should be a compile error, not an
empty fill (same hazard class as #2054).

## Acceptance criteria

- `[..."ab"].length === 2` native; elements `"a"`, `"b"`
- Non-BMP: `[..."a😀"].length === 2` (code points)
- Unknown spread-source types produce a diagnostic, not silent empty

## Dupe check

#1514 fixed externref-iterable spread (same symptom, host mode); native-string
source not covered. No other hit.
