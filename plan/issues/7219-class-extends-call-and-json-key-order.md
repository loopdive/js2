---
id: 7219
title: "`class S extends mk()` traps on inherited calls; JSON key order wrong with constructor-assigned fields"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
---

# #7219 — two small class bugs from the #7199 review

Both found by the PR #7017 review, both on main.

1. **A class extending a call expression** traps when an inherited method
   is called:
   ```js
   function mk() { return class { m() { return 1; } }; }
   class S extends mk() {}
   console.log(new S().m());   // node: 1 — we: trap
   ```
2. **JSON key order** is wrong when one field is assigned in the
   constructor and another has an initializer:
   ```js
   class K { a; b = 2; constructor() { this.a = 1; } }
   console.log(JSON.stringify(new K()));   // node: {"a":1,"b":2}
   ```
   The review reports our order differs; record the exact output when
   reproducing. Spec order is field declaration order, set by the field
   initializers before the constructor body runs.

## Plan

1. Reproduce both on 3 lanes and split into separate issues if the causes
   are unrelated.
2. Fix and test against node.
