---
id: 7165
title: "Native-first and standalone: comparator-less sort() of a typed string vec holding undefined traps with a null dereference"
sprint: current
created: 2026-10-25
updated: 2026-10-25
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: ready
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
