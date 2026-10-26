---
id: 7154
title: "Native-first and host lanes: an any[] literal that later receives an array via push loses its earlier elements"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7147, 7146, 7152]
---

# #7154 — `any[]` literal + `push(array)` drops earlier elements

Found during #7147 (PR #6908). On **every** lane, host-assisted included, on
`origin/main` before and after #7147:

```js
const a: any[] = [1];
a.push([2]);
console.log(a.join());        // ",2"   (node: "1,2")

let cur: any[] = [1];
for (let i = 0; i < 100; i++) { const b: any[] = [i]; cur.push(b); cur = b; }
// the chain prints "1" at depth 100 instead of the nested join
```

The literal-initialised vec carries a numeric element storage; pushing an
array element migrates the storage (externref / boxed) and the migration does
not carry the existing elements across — the earlier numbers come back as
holes. This is a silent wrong result, not a compile error, and it also
limits what #7147's tests can exercise (they build cycles with `push` on
empty arrays for this reason).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the two programs on gc host-assisted, gc native-first and
   standalone; dump WAT around the `push` and find the storage-migration
   site (`array-element-inference.ts` evolving-array evidence and the `push`
   lowering in `array-methods.ts`; the same storage-vs-checker source as
   #7146).
2. When a push changes the element representation of an existing vec, copy
   the existing elements through the element coercion (number → boxed/extern)
   into the new storage before appending; if the migration is instead decided
   statically (the literal is lowered as a numeric vec although the
   declaration is `any[]`), lower an `any[]`-declared literal with the dynamic
   element storage from the start and state the byte delta.
3. Audit the siblings that append (`unshift`, `splice`, index store past
   length, `concat` into an `any[]`) for the same migration path.
4. Tests: `tests/equivalence/issue-7154-*.test.ts` with the two programs plus
   mixed pushes (number, string, object, array) into `any[]`, `unknown[]` and
   untyped `const a = [1]` literals, all three lanes vs node; afterwards
   change #7147's cyclic test rows to build the cycle on a literal-initialised
   array.
