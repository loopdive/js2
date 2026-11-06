---
id: 7278
title: "IR: harness-defined bindings referenced from harness functions and test bodies (`expr-ident-not-in-scope`)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7267, 7275, 7251, 7252, 7266]
assignee: "ttraenkler/c-lane-opus"
---

# #7278 — IR: harness-defined bindings referenced from harness functions and test bodies

## Problem

`expr-ident-not-in-scope` is the second-largest refusal family on the wrapped
stride-40 standalone census (main d28280a0: 687 parts — `assert` 183,
`Function` 129, `Array` 59, `Float16Array` / `Int32Array` 52 each,
`nonAtomicsFriendlyTypedArrayConstructors` 50, `Object` 45, …). Many are
references to **harness-defined** top-level bindings (the `assert` object
literal, harness arrays) from inside harness functions.

(Measurements, plan and acceptance criteria follow.)
