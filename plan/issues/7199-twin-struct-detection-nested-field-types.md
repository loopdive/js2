---
id: 7199
title: "Twin-layout guard misses classes whose fields point to different but structurally identical structs"
status: done
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
completed: 2026-10-31
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

## Resolution (2026-10-31)

`src/codegen/class-arm-tag-guard.ts` now decides "layout twin" with
`mayShareCanonicalLayout`: field kinds must match, and a referenced type is
compared by SHAPE (struct fields, array element, func params/results),
recursively and coinductively (a pair already being compared is assumed equal,
which accepts self- and mutually-recursive types). Both consumers of the twin
decision use it: the #7158 enumeration arms (JSON.stringify, Object.keys,
for…in, getOwnPropertyNames, Object.assign, spread) and the #4618/#6608
per-name method ladders, which had the same bug (`b.name()` ran `A`'s body).

Why an over-approximation and not exact isorecursive equality: rec groups are
planned at EMIT time (`planPhysicalTypeSection`, from forward references, after
DCE), so the exact canonical identity is not known when the arms are built. The
walk therefore ignores what can only SEPARATE two types (mutability,
supertype/finality, the later rec-group split) and answers "maybe" for an index
it cannot resolve. A false "maybe" costs one redundant, still-correct `__tag`
test; equal indices still answer "equal", so the guarded set only grows.

Evidence: 29 programs (the #7158 rows, its sweep bodies, 8 class-heavy programs
without twins) x 3 lanes = 87 binaries are byte-identical to base.
`tests/equivalence/issue-7199-twin-nested-field-types.test.ts` (45 rows) fails
37 rows on base and passes on head.

Not in scope: `hasOwnProperty` / `in` on twins (#7200); wasi enumeration of a
class instance answering `null` / empty (#7201).
