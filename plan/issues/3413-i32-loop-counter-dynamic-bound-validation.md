---
id: 3413
title: "Redeclared var loop counters change Wasm local types after emission"
status: done
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler, codegen
language_feature: for-loops, relational-operators
goal: test262-conformance
assignee: codex/root
related: [3372, 2055, 3412]
files:
  - src/codegen/statements/loop-analysis.ts
  - src/codegen/statements/loops.ts
  - tests/issue-3413.test.ts
---

# #3413 — keep redeclared var loop bindings on one stable Wasm type

## Problem

The integer-loop optimization stores canonical `for` counters in an `i32`
local. JavaScript `var` declarations are function-scoped, so several
`for (var i = ...)` declarations in one function all denote the same binding
and must use one stable Wasm local type. The loop initializer currently retypes
that reused local for each declaration. A later canonical loop can therefore
change the final local type to `i32` after an earlier dynamic/reverse loop was
already emitted as `f64`, leaving instructions such as `local.get i; f64.ge`
and producing an invalid Wasm module.

The oracle-v8 literal Test262 harness exposes this in
`testWithAllTypedArrayConstructors`, where both `k` and `i` are optimized loop
counters compared with dynamic array lengths. Once #3412 removes the preceding
duplicate-`isPrimitive` early error, representative TypedArray tests reach this
shared invalid-binary failure.

## Acceptance criteria

- Repeated `var` declarations of one loop binding use a stable Wasm local type
  across all loops and produce a valid module.
- A fractional initializer in one redeclaration retains its JavaScript number
  value rather than being truncated through an earlier i32 specialization.
- The fix preserves the i32 fast path for an unambiguous single loop binding.
- A harness-shaped `testWithAllTypedArrayConstructors` source validates as
  Wasm with `allowJs` and semantic diagnostics skipped.
- Representative strict-harness TypedArray tests advance past this compiler
  validation error through the authoritative project runner.

## Resolution

The loop optimizer now detects repeated `var` declarations of one
function-scoped binding and leaves that binding on the stable JavaScript number
representation. Unambiguous single-loop counters retain the i32 fast path.

Verified by three focused tests, including Wasm validation and a fractional
redeclaration case, plus the literal-harness TypedArray batch.
