---
id: 7618
title: "Preserve operand values across short-circuit expressions"
status: done
created: 2026-11-28
completed: 2026-11-28
priority: high
feasibility: medium
task_type: implementation
goal: ir-full-coverage
es_edition: ES5
related: [1820, 7354]
---

Lower logical AND and OR with the existing condition conversion and branch selection. Retain matching operand types, box mixed values when necessary and lower a literal-selected arm directly. This preserves the value in module initializers and the conditional execution of right-hand effects.

On the 54 ES5-tagged logical AND, OR, NOT and comma originals, 20 pass on standalone WasmGC IR compared with 11 on main. All nine gains execute the original harness in both modes. A Node agreement test checks typed storage, null, signed zero and side effects.
