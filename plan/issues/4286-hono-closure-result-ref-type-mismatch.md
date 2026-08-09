---
id: 4286
title: "codegen: Hono emits a closure result with the wrong concrete ref type"
status: ready
sprint: Backlog
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures, classes
goal: dogfood
related: [1244, 3993]
---

# codegen: Hono emits a closure result with the wrong concrete ref type

## Problem

After #3993 removes the inherited-class callable abort, the pinned Hono 4.12.16
entry compiles in about 5.9 s to a 360,309-byte module but fails Wasm validation:

```text
WebAssembly.Module(): Compiling function #519:"__closure_156" failed:
type error in fallthru[0] (expected (ref null 2), got (ref 300))
```

The mismatch is a compiler-emitted closure result ABI defect, not a Hono source
diagnostic. Identify `__closure_156`'s exact source unit, compare the inferred
result contract with the body fallthrough value, and correct the generic
closure/result representation path without package-name special casing.

## Acceptance criteria

- A reduced regression fails validation before the fix and runs with its native
  JavaScript result afterward.
- `node --import tsx tests/dogfood/npm-compat-catalog-harness.mjs --package hono --json`
  emits a valid module or advances to a separately documented runtime blocker.
- Existing closure-result and class inheritance suites remain green.

