---
id: 7152
title: "Native-first: Array.prototype.filter with a narrowing predicate on a mixed externref-element array dereferences null in the predicate"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7146, 7151]
---

# #7152 — `filter` with a narrowing predicate on a mixed externref vec traps

Found during the round-2 review of PR #6905 (#7146). On gc native-first and
standalone, at module level and inside a function:

```js
const keys = [];
for (const k in { c: 1, a: 2 }) keys.push(k);
keys.push(3); keys.push(1);
console.log(keys.filter(k => typeof k === "number").length); // RuntimeError: dereferencing a null pointer
console.log(keys.filter(k => k !== "a").length);              // same trap
console.log(keys.filter(k => true).length);                   // works
console.log(keys.map(k => k).length);                         // works
```

Pre-existing on `origin/main` (not introduced by #6905; that PR only makes
`…filter(narrowing).sort(cmp).join()` reach this trap instead of failing wasm
validation). The predicate's parameter is read from the externref-element vec
and dereferenced as a concrete struct in the `typeof` / `!==` lowering.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the four lines above on both no-host lanes; dump WAT for the
   predicate closure and find the `ref.as_non_null` / struct read that
   precedes the trap (it is in the predicate body, not in `filter`'s loop).
2. The closure-literal planning for an array callback (`select-closure-literal.ts`
   / the legacy `compileArrayMethodCall` callback path) assumes the element
   type the checker gives (`any[]` → f64/number element) while the storage is
   externref; make the callback's parameter carry the receiver's **storage**
   element type (the same source #7146 now uses in `nativeJoinProbeExpr`), so
   `typeof k` and `k !== "a"` lower through the dynamic/externref arms.
3. Keep host-assisted gc bytes identical; native-first / standalone bytes
   change only for callbacks over externref vecs — state the delta.
4. Tests: `tests/equivalence/issue-7152-*.test.ts` with the four lines plus
   `find`, `some`, `every`, `forEach` with the same narrowing predicates (same
   callback path), both lanes vs node.
