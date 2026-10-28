---
id: 7165
title: "Native-first and standalone: comparator-less sort() of a typed string vec holding undefined traps with a null dereference"
sprint: current
created: 2026-10-25
updated: 2026-10-27
completed: 2026-10-27
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: done
reasoning_effort: high
priority: medium
horizon: s
feasibility: medium
language_feature: arrays
related: [7151, 7164]
---

# #7165 — `["c", undefined, "a"].sort()` traps on a `(string | undefined)[]` vec

Found while implementing #7151 (PR #6918). Pre-existing on `origin/main`, gc
native-first and standalone (host-assisted correct):

```js
const a: (string | undefined)[] = ["c", undefined, "a"];
a.sort(); console.log(a.join("|"));   // trap (null dereference)   (node: "a|c|undefined")
```

## Cause (as diagnosed; verify before fixing)

`compileArrayDefaultToStringSort` (`src/codegen/array-methods.ts`) string-element branch `ref.as_non_null`s each element before `__str_compare`; a nullable string vec stores `undefined` as null and the cast traps. #7151 added the undefined-last rule only for the externref vec (`prepareExternVecDefaultSortCompare`, `src/codegen/array/array-sort-value.ts`).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `(string | undefined)[]`, `(string | null)[]` (node sorts `"null"` as text, not last) and a `string[]` that received `undefined` through an `any` write, on gc native-first and standalone.
2. In the string-element branch, reuse `undefinedLastGreater` (#7151) before the non-null cast: nullable-undefined elements compare greater than any string; a null that represents JS `null` must compare as the text `"null"` — check how the vec distinguishes the two (if it cannot, say so in the Resolution and sort both last, documenting the deviation). Keep non-nullable `string[]` byte-identical.
3. Tests: `tests/issue-7165-string-vec-sort-undefined.test.ts` with the three programs on gc native-first and standalone vs node.

Acceptance: no trap; node's order for `undefined`; non-nullable string vec programs byte-identical; host-assisted gc bytes unchanged; equivalence gate no new regressions.

## Resolution (2026-10-27)

**Diagnosis confirmed, plus one sibling.** `(string | undefined)[]` lowers to a
nullable `$AnyString`-ref vec (`$__vec_ref_6`) that stores `undefined` as null.
The comparator-less sort's string branch `ref.as_non_null`'d each element
before `__str_compare`, and the native `join` string arm did the same — so the
issue program trapped twice (`a.join("|")` alone trapped too). `(string |
null)[]` and `(string | null | undefined)[]` lower to an externref vec and were
already correct (#7151 path).

**Fix.** Both gated on the receiver's element type via `ctx.oracle.elementFactOf`
(a union that admits undefined or null) and a `ref_null` element ValType, so a
non-nullable `string[]` keeps its bytes:

- sort: `stringVecSortCompare` (`src/codegen/array/array-sort-value.ts`)
  wraps the existing compare in #7151's `undefinedLastGreater` with a
  `ref.is_null` test — null sorts last, before the non-null cast.
- join: `stringJoinElement` (`src/codegen/array-join-element.ts`) joins
  a null element as "" (§23.1.3.18 step 4.b).

**null vs undefined.** In this storage a null element is `undefined` or a hole;
a JS `null` can only get in through a type lie (`null as any`), and would also
sort last (node sorts it as the text "null"). Holes and undefined are both null
and both trail, so element order matches node.

**Test:** `tests/equivalence/issue-7165-string-vec-sort-undefined.test.ts` —
gc (native-first), standalone and wasi vs node: the issue program, several
undefined, for-of read-back, all-undefined, `sort()` chains, `toString`/`String`,
pushed undefined, code-unit order, `sort(undefined)`, module-level vec, holes
(`length` growth, sparse writes), `(string | null)[]` ("null" as text),
`(string | null | undefined)[]`, and a `string[]` control.

**Left out (pre-existing, separate paths):**

- A `string[]` that receives undefined through an `any` alias
  (`const b: any = a; b[1] = undefined`) does not trap: the write is silently
  dropped (`a[1]` still reads `"b"`) — a dynamic-store bug, not a sort one.
  `undefined as any` / `null as any` stored into a plain `string[]`, and a
  sparse `string[]` (`a[4] = "b"`), still trap in sort: the gate keeps
  non-nullable `string[]` byte-identical by design.
- `toSorted()` returns an empty result for every string vec on these lanes
  (`["c","b","a"].toSorted().join()` → ""), with or without undefined.
- A comparator sort of `(string | undefined)[]` passes undefined to the
  comparator (`a.sort((x, y) => …x!…)` traps); §23.1.3.30.2 sorts undefined
  last without calling it. That is `tryCompileComparatorSort`, not this path.
- `a.map((x) => String(x))` on a `(string | undefined)[]` stringifies an
  undefined element as "null" (a direct `String(a[i])` is correct) — the map
  callback path.
