---
id: 2007
title: "array operand in string concatenation traps 'illegal cast' — '+' never routes vecs through ToPrimitive/join"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1969, 1997, 1988]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2007 — struct-ref concat path can't handle WasmGC vec refs

## Problem

```ts
const arr = [1, 2];
"a=" + arr   // wasm: RuntimeError: illegal cast   node: "a=1,2"
```

## Root cause

`src/codegen/string-ops.ts:1503-1508` — struct-ref operands route through
`coerceType(..., externref, "string")`, but the ToPrimitive dispatch path
doesn't handle WasmGC array/$Vec refs (unguarded `ref.cast` in
`src/codegen/type-coercion.ts`), so arrays never reach
Array.prototype.toString/join.

## Fix direction

Detect vec refs in the concat coercion and emit the join path (ties into
#1997 array toString and #1996 host bridge vec recognition).

## Acceptance criteria

- Repro returns "a=1,2"; nested arrays follow join semantics

## Dupe check

#1090/#1806 cover "cannot convert object to primitive" for plain structs;
#1969 is concat-the-method, not `+`. New.

## Status check (2026-06-13, dev-a)

**js-host mode: already FIXED** (likely by #2022 `+` ToPrimitive ordering +
#1997 Array.join element coercion). The issue's repro and acceptance criteria
(`"a=" + [1,2]` → `"a=1,2"`) now pass under js-host — verified via
`assertEquivalent` across: `string + number[]`, `number[] + string`, nested
arrays, string arrays, empty array, and array-in-template-literal. No
`illegal cast`; all match Node.

**standalone mode: STILL WRONG** — `"" + [1,2]` returns `"[object Object]"`
(length 15) instead of `"1,2"`. Root cause precisely located:
`src/codegen/native-strings.ts` `ensureAnyToStringHelper` (the standalone
`$__any_to_string` walker). Its `body` dispatch (~L5639-5654) does
`ref.test $AnyString` → `ref.test $AnyValue` (tag dispatch) → **else
`"[object Object]"`**. A **vec ref (array)** is neither an `$AnyString` nor an
`$AnyValue`, so it falls into the final `"[object Object]"` branch (see the
explicit comment at ~L5652: "else (null ref, plain object, **vec**, …) →
'[object Object]'"). So in standalone, an array stringified via `+`/template
never reaches Array.prototype.toString/join.

### Remaining fix (standalone only)

In `ensureAnyToStringHelper`'s `body`, before the final `"[object Object]"`
else, add a `ref.test` against the registered vec struct type(s) and route to
a **native array-join** that:
1. iterates the vec's elements,
2. recursively calls `$__any_to_string` on each (so nested arrays/objects
   stringify correctly — `[[1,2],[3]]` → `"1,2,3"`),
3. joins with `","` (empty array → `""`, single → that element, JS
   Array.prototype.join semantics; `null`/`undefined` elements → `""`).
This ties into #1997 (array toString) and #1996 (host bridge vec recognition);
a shared native join helper would serve both. The vec type registry to test
against is the set of `__vec_*` struct types (f64/i32/externref/ref variants).

Non-trivial (recursive native-string join in the deepest standalone layer) —
larger than the js-host portion that's already done.
