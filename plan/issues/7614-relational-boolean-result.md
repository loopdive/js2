---
id: 7614
title: "Preserve the JavaScript boolean type of relational results"
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
related: [4503, 3167, 2949]
---

# Relational result type

## Problem and plan

The scalar comparison path preserves the JavaScript boolean type. The string comparison and dynamic paths produce a plain i32. A consumer such as String therefore refuses a mixed comparison even when numeric conversion and the comparison itself work.

## Implementation and validation

Use the existing IR boolean type for the final comparison result in all three paths. Keep the string comparison helper's intermediate sign as an integer. The regression compares all four operators with Node and checks the number of observable valueOf calls.

On main at 7698b13c1b and with the change, the same 4 of 16 ES5 Test262 operand evaluation order cases (A2.4, all four operators) pass on standalone WasmGC IR with strict reruns. The remaining cases require unresolved identifier handling or comparison of two dynamic operands.
