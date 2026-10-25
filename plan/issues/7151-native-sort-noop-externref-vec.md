---
id: 7151
title: "Native-first: comparator-less Array.prototype.sort() is a no-op on module-level externref-element arrays"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7146, 2502, 3579]
---

# #7151 — comparator-less `sort()` is a no-op on module-level externref vecs

Found during the review of PR #6905 (#7146). On gc native-first and
standalone, `sort()` without a comparator on a module-level array whose
storage is the externref-element vec (`$__vec_externref`, e.g. a `const keys =
[]` filled by `for…in` or `push`) lowers to `__arr_sort_noop` (the #2502
fallback; #3579 fixed only the host lane) and returns the array unchanged.
Inside a function the same code sorts correctly; the host-assisted lane sorts.

Before #7146 these programs failed wasm validation at the following `join`; now
they compile and print the unsorted order — a compile error became a silent
wrong result, which is why this issue is filed with that PR.

## Observed (gc native-first and standalone, module level)

```js
const keys = [];
for (const k in { b: 1, a: 2 }) keys.push(k);
console.log(keys.sort().join(","));   // "b,a"   (node: "a,b")
const s = []; s.push("c"); s.push("a"); console.log(s.sort().join()); // "c,a"
const n = []; n.push(3); n.push(1);   console.log(n.sort().join());   // "3,1"
```

One more shape (review of #6905 round 2): `let keys = []` filled by `for…in`,
then reassigned to a literal (`keys = ["z","y"]`) — the literal lands in the
externref global, so `keys.sort().join(",")` prints `"z,y"` (node `"y,z"`).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs above on gc native-first and standalone and
   inside a function (sorts correctly) — the difference is the receiver's
   storage type (externref vec at module level vs the typed vec the checker
   assigns in a function), not the comparator.
2. Find the `__arr_sort_noop` selection in `src/codegen/expressions/array-methods.ts`
   (≈9113) and the #3579 host-lane fix; the native lanes need the default
   comparator (SortCompare: `undefined` last, then ToString order, spec
   23.1.3.30) over externref elements — reuse the existing native string
   comparison (`__str_cmp` or the native-strings compare helper) with a
   ToString of each element through the shared dispatch, and the existing
   in-place sort routine used for the typed vecs.
3. Keep host-assisted gc bytes identical; native-first/standalone bytes change
   only for programs that reach a comparator-less `sort()` on an externref
   vec — state the delta in the PR body.
4. Tests: `tests/equivalence/issue-7151-*.test.ts` with the three programs
   plus mixed `undefined`/number/string elements, both lanes vs node; extend
   `tests/issue-7146-array-join-vec-type.test.ts`'s rows to use **unordered**
   keys once this lands (they use ordered keys by design today so they cannot
   mask it).
