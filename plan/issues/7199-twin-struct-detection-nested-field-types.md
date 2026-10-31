---
id: 7199
title: "Twin-layout guard misses classes whose fields point to different but structurally identical structs"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7158]
---

# #7199 — twin detection compares field type indices, not field structure

Found by the review of PR #6996 (#7158), finding 1. The PR adds a `__tag` guard to
closed-struct enumeration arms, but only for class arms that "share a layout" with
another struct. The layout comparison uses field type *indices*, so two classes whose
fields point to different yet structurally identical structs are not seen as twins,
even though WasmGC canonicalises them to one type.

```js
class P { p = 1 }
class Q { q = 1 }
class A { a: P = new P() }
class B { b: Q = new Q() }
console.log(JSON.stringify(new B()));
// node: {"b":{"q":1}}
// gc native-first, standalone, wasi (base and #6996): {"a":{"q":1}}
```

The same happens with `P[]` vs `Q[]` fields.

## Plan

1. In `src/codegen/class-arm-tag-guard.ts`, compare field types recursively
   (canonical structural equality), or drop the type index from the comparison
   and always guard arms whose field *shapes* match (safe; more guards).
2. Tests: extend `tests/equivalence/issue-7158-twin-struct-layouts.test.ts` with
   nested-struct and array-field twins on all 3 lanes against node.
3. Programs without twins must stay byte-identical.
