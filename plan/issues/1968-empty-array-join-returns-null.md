---
id: 1968
title: "[].join(...) returns \"null\" instead of \"\" (resultTmp initialized to ref.null extern)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: array-methods
goal: builtin-methods
related: [1286, 1215]
origin: "2026-06-10 deep-audit sweep (objects agent, lead from closures agent): verified miscompile on main"
---

# #1968 — empty-array join yields a null externref that stringifies as "null"

## Problem

```ts
const a: number[] = []; return "<" + a.join(",") + ">";
```

wasm: `<null>` — node: `<>`. Also reachable dynamically:
`[1,2,3].filter(x=>x>10).join(",")`. Same for `string[]` receivers.

## Root cause

`src/codegen/array-methods.ts:4533-4535` (`compileArrayJoin`) — `resultTmp`
(externref) is initialized with `ref.null extern` ("result starts as null
(empty)"); the element loop only assigns it on iteration ≥ 0 elements. For
`len == 0` the function returns a null externref, which every downstream
string consumer stringifies as `"null"`.

## Fix direction

Initialize `resultTmp` from the `""` string-constant global
(`ctx.stringGlobalMap.get("")` / `addStringConstantGlobal(ctx, "")`), or add a
`len == 0 → return ""` early branch. Sibling spec rule while there:
null/undefined *elements* must also stringify to `""`
([§23.1.3.18](https://tc39.es/ecma262/#sec-array.prototype.join)); currently
the externref-element path concats raw nulls.

## Acceptance criteria

- `[].join(",") === ""`; filter-to-empty `.join` correct
- `[null, undefined, 1].join(",") === ",,1"` (element rule)
- Non-empty joins unregressed

## Dupe check

Greps `join empty`, `join null` → only #1286 (externref-receiver join routing,
done) and #1215 (number_toString registration, done). Unfiled.
