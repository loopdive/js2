---
id: 4368
title: "Self-referential object-literal initializer writes through stale pre-capture local and emits invalid Wasm"
status: done
assignee: ttraenkler/codex
sprint: 78
created: 2026-08-11
updated: 2026-08-18
completed: 2026-08-11
priority: high
horizon: s
feasibility: medium
task_type: bugfix
area: codegen
language_feature: closures
goal: npm-library-support
related: [3128, 3534, 3715, 4369]
files:
  - src/codegen/statements/variables.ts
  - tests/issue-4368-self-referential-object-capture.test.ts
loc-budget-allow:
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/statements/variables.ts::compileVariableStatement
origin: "marked@18.0.2 pinned dogfood bundle after bypassing #3715 diagnostics"
---

# #4368 — Self-referential object-literal initializer uses a stale capture slot

## Problem

Marked's regex-builder helper initializes an object whose closures capture the
object being initialized:

```js
let n = {
  replace: () => n,
  getRegex: () => new RegExp(source),
};
```

The initializer creates a mutable capture cell for `n` and re-aims
`localMap["n"]` at that cell. The variable-declaration path, however, resolved
the local index before compiling the initializer and later used that stale raw
object slot as the receiver of `struct.set <ref-cell> 0`. The resulting Wasm is
invalid: the validator expects the ref-cell type but sees the initialized
object's struct type.

The 12 KB minimized binary and Marked's 4.1 MB binary fail with the same shape:

```text
struct.set[0] expected type (ref null <capture-cell>),
found local.get of type (ref null <object-struct>)
```

This is the declaration-initializer sibling of the assignment repair in
[#3128](https://github.com/loopdive/js2wasm/blob/main/plan/issues/3128-assignment-rhs-closure-capture-aliasing.md):
both paths must resolve live storage after compiling a RHS that can create a
capture.

## Acceptance criteria

- [x] The minimized self-referential object literal emits valid Wasm.
- [x] Calling through the captured methods returns the expected value, proving
      the initialized object and captured reference alias the same cell.
- [x] The real pinned Marked bundle advances past this validator failure.
- [x] Adjacent closure-capture and variable-initialization suites remain green.

## Implementation direction

When a declaration initializer leaves `boxedCaptures[name]` live, resolve the
current `localMap[name]` after initializer compilation and use that ref-cell
local for the null guard and `struct.set`. Keep the pre-initializer local only
as a fallback for the already-boxed-before-declaration case.

## Result

The declaration path now resolves the live local after initializer compilation
before emitting the null guard and ref-cell store. The minimized module
validates and executes to `7`, proving that the object returned through its
self-capturing closure is the initialized object.

The focused test and four adjacent capture/initialization suites pass 44/44.
With semantic diagnostics bypassed only to measure this backend stage, the
unchanged pinned Marked bundle compiles in 23.013 seconds to 4,086,843 bytes and
advances to the separate dynamic-`in` stack defect tracked by
[#4369](./4369-dynamic-in-physical-struct-field-stack-imbalance.md).
