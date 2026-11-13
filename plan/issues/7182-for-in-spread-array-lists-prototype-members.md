---
id: 7182
title: "Static for-in unroll over `{...arr, z}` lists Array.prototype members"
status: ready
sprint: Backlog
created: 2026-10-27
updated: 2026-10-27
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: statements
goal: correctness
related: [7156, 7155]
---

# #7182 — `for (k in {...arr, z})` lists Array.prototype members

Found in the round-1 review of PR #6940 (#7156). The bug is already on main and happens on gc native-first, standalone and wasi.

```ts
const arr = [1, 2];
const keys: string[] = [];
for (const k in { ...arr, z: 1 }) keys.push(k);
console.log(keys.join());
// node:  0,1,z
// all 3 lanes: length,toString,toLocaleString,…,z
```

## Cause (verify before fixing)

The static for-in unroll (`src/codegen/statements/for-in-static-unroll.ts`, keys from `forInStaticKeysOf` in `src/checker/oracle.ts` after #7156) lists the properties of the spread source's checker type. That type is `number[]`, so its properties are the `Array.prototype` members, not the index keys.

## Implementation Plan

1. An array spread source adds only its index keys `"0".."n-1"`. Take `n` from a tuple type or from the array literal's static length.
2. When `n` is not static, do not unroll; fall back to the dynamic for-in over the materialized `$Object`. #7155 made `{...arr}` materialize index keys.
3. Tests: `tests/equivalence/issue-7182-for-in-spread-array.test.ts` on gc native-first, standalone and wasi vs node, covering:
   - `{...[1,2], z}`;
   - `{z, ...arr}`;
   - a tuple;
   - a non-literal `number[]` source (dynamic fallback);
   - an empty array.
4. Bytes: only programs that spread an array inside a for-in receiver change.

Acceptance: `0,1,z` on all three lanes.
