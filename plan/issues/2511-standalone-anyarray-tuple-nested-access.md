---
id: 2511
title: "standalone: any[] of heterogeneous tuples — nested access e[0][1] traps null-deref (#2190 residual)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, array-literal, element-representation
goal: standalone-mode
related: [2190, 2106, 2042]
origin: "TaskList #86; surfaced from #85 Object.fromEntries blocker"
---

# #2511 — standalone `any[]` of heterogeneous tuples: nested access traps

## Problem (file-verified, current main, `--target standalone`)

```ts
const e: any[] = [["a", 1], ["b", 2]];
e[0][1];   // TRAP: "dereferencing a null pointer"
```

Reading a nested element of an `any[]` whose elements are **heterogeneous tuples**
(`[string, number]`) traps. Discriminator:
- `number[][]` → `e[0][1]` WORKS
- `[string,number][]` (typed) → CE
- `any[] = [["a",1]]` → `e[0][1]` TRAPS

This is the canonical `Object.fromEntries([["a",1]])` entries shape — and a user
hand-rolled `for (const p of e) { o[p[0]] = p[1]; }` over the same `any[]` also
trapped, so it's upstream of `fromEntries` (which it was blocking, #85).

## Root cause (WAT-pinned)

`compileArrayLiteral` (`src/codegen/literals.ts`) infers the inner array's element
type from the FIRST element. For `["a", 1]` element 0 is `"a"` → the heuristic
picks `$AnyString` for the whole inner vec. The number `1` then can't be stored
in a `$AnyString[]`, so codegen emits `f64.const 1; drop` and substitutes
`ref.null $AnyString; ref.as_non_null` — a guaranteed null-deref when `e[i][1]`
is later read.

The existing heterogeneity widening only handled a NUMERIC first element with a
later object/null element (`[0, 1, obj]` → externref via `hasObjectElem`). A
STRING first element with a later non-string element (`["a", 1]`) fell through and
stayed `$AnyString[]`.

## Fix

In `compileArrayLiteral`, add a mirror of the `hasObjectElem` widening: when the
first-element heuristic picked a native-string element type (`$AnyString` /
`$NativeString`) but the literal contains a NON-string element, widen the vec to
`externref` so each element is boxed by its own static type at construction
(`__box_number` / `__box_boolean` / native-string). Scoped to native-strings
mode; `number[]` / `string[]` / homogeneous literals are byte-identical.

## Acceptance criteria

1. `any[] = [["a",1]]` → `e[0][1]` reads the number; `e[0][0]` reads the string.
2. A hand-rolled `for`-loop fromEntries over the `any[]` tuples works end-to-end.
3. No regression: `number[]`, `string[]`, `number[][]`, all-string `any[]`,
   flat mixed-scalar `any[]` unchanged.

## Resolution (sdev-arrayrep, 2026-06-19)

One-arm widening per above. MEASURED: `[["a",1],["b",2]]` → `e[1][1]`=2, e[0][1]=1,
e[0][0].length=1; hand-rolled fromEntries → correct; flat mixed-scalar any[]
unchanged; number[]/string[]/number[][]/all-string-any[] regressions clean.
`tests/issue-2190b-anytuple-nested.test.ts` (7) green; #2106/#2190/#786/#2014/#2505
suites unchanged; `tsc` + coercion gate clean.

**Unblocks #85** — with nested any[]-tuple access fixed, `Object.fromEntries([…])`
over a literal-array entries arg now iterates correctly (the native helper from
#85 can land on top).

**Out of scope (separate residual):** a HOMOGENEOUS string sub-array
(`[["a","b"]]`, a `$AnyString[]` stored into an `any[]`) still traps `e[0][0]` —
broken on main without this change too; a distinct `$AnyString[]`-in-`any[]`
read-back layer, not the heterogeneous-tuple fix.
