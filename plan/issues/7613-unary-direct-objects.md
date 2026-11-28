---
id: 7613
title: "Use realm ToNumber for direct object and function operands of unary signs"
status: done
created: 2026-11-27
updated: 2026-11-27
completed: 2026-11-27
assignee: codex
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: ir
goal: core-semantics
sprint: current
horizon: s
es_edition: ES5
related: [7354, 7525]
---

# Unary numeric conversion of direct objects

## Problem and plan

Unary plus rejects a direct object literal or function expression during lowering. Assigning the same value to a script variable first allows the expression to reach realm ToNumber. Use the existing realm conversion for the direct representations on the Prepared path. Keep the BigInt refusal and evaluate the operand once for both unary signs.

## Result

Both signs now select their numeric conversion in one place. Unary minus applies Wasm floating-point negation to the converted number. A regression compares execution with Node for a direct function operand and an object whose conversion method counts calls.

On main at `d985b87266`, 7 of the 16 ES5-tagged originals under `language/expressions/unary-plus` pass. With this change, 8 pass. The only transition is `S11.4.6_A3_T5.js`, which now passes in both strict and non-strict mode with the original harness on standalone WasmGC IR. The object-conversion suite passes all 16 tests and the BigInt numeric-operand suite passes all 51.
