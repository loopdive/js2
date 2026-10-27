---
id: 7176
title: "WASI: `.length` of a `$AnyValue`-typed string reads `undefined`"
status: ready
sprint: Backlog
created: 2026-10-26
updated: 2026-10-26
task_type: bugfix
area: codegen
goal: correctness
priority: medium
horizon: s
feasibility: medium
language_feature: strings
related: [7152]
---

# #7176 — `.length` of a `$AnyValue` string is `undefined` on wasi

Found while reviewing PR #6932 (#7152). Not introduced by it: base wasi
already returns `undefined` for the first program below.

```js
export function test() {
  const keys = [];
  for (const k in { c: 1, a: 2 }) keys.push(k);
  keys.push(3); keys.push(1);
  return keys.reduce((acc, k) => acc + "", "").length; // node 0; wasi undefined
}
```

With #7152 applied, `keys.reduce((acc, k) => acc + k, "").length` (node 4)
also reads `undefined` on wasi while gc native-first and standalone give 4;
comparing the string itself (`=== "ca31"`) is correct on all three lanes. A
pass-through accumulator (`keys.reduce((acc, k) => acc, "q").length`, node 1)
reads `undefined` on gc, standalone and wasi alike, on base and head.

## Implementation Plan

Find the wasi lowering of `.length` on a receiver whose wasm type is
`$AnyValue` (the reduce result is typed `string | number`, so the property
read goes through the `$AnyValue`/externref member path, not the native-string
`length` fast path). Dump WAT for the first program on wasi and standalone and
diff the `.length` read: standalone reaches the native-string length, wasi
falls to a dynamic property get that misses strings. Route the `$AnyValue`
string case (tag 5) to the native string length on wasi as on standalone, then
check the pass-through form on all three lanes. Test:
`tests/equivalence/issue-7176-*.test.ts` with the three programs above, gc
native-first / standalone / wasi vs node.
