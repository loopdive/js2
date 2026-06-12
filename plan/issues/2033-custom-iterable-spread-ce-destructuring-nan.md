---
id: 2033
title: "custom iterables ([Symbol.iterator]): spread emits invalid wasm (CE), destructuring reads NaN — only for-of consults the protocol"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterators
goal: core-semantics
related: [1320, 1052]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2033 — spread/destructuring assume vec-shaped structs

## Problem

```ts
const obj = {
  [Symbol.iterator]() {
    let i = 0; const data = [10, 20, 30];
    return { next: () => i < data.length
      ? { value: data[i++], done: false }
      : { value: 0, done: true } };
  }
};
// for-of: works ("10,20,30")
[...obj]                      // wasm: CompileError: i32.add[1] expected type
                              //   i32, found struct.get of type externref
const [first, second] = obj;  // wasm: "NaN,NaN"   node: 10,20
```

## Root cause

Spread: `src/codegen/literals.ts:~2507-2571` assumes a vec-shaped struct
(struct.get field 0 = i32 length) for ref-typed spread operands — the
iterable's struct field is the externref iterator closure. Destructuring:
`src/codegen/statements/destructuring.ts:949ff` struct path never consults
`[Symbol.iterator]`, reads non-existent numeric fields → NaN. Spec
§13.2.4.1/§8.6.2: both constructs must use the iterator protocol; for-of
already does.

## Fix direction

When a ref-typed spread/destructuring source isn't a known vec, route
through the same iterator-protocol lowering for-of uses (GetIterator +
step loop).

## Acceptance criteria

- Both repros match Node; vec fast paths unchanged
- Invalid-wasm CE eliminated

## Dupe check

#1320 (in-progress) covers only the Array.from/Iterator.from externref
bridge; #1052 (in-review) is overridden Array.prototype[Symbol.iterator].
New.
