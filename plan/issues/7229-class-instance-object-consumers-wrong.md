---
id: 7229
title: "Class instances: `Object.values`/`entries` empty on wasi, `Object.assign({}, inst)` reads null, JSON of entries gives `[null]`"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: objects
goal: correctness
related: [7216, 7201]
---

# #7229 — object consumers on class instances

Found while implementing #7216 (PR #7051). All exist on main:

- wasi: `Object.values(inst)` / `Object.entries(inst)` return `[]` for any
  class instance, even through `any`. Opening the gate changes the bytes of
  many no-subclass wasi programs, so #7216 left it.
- `const o = Object.assign({}, inst)` reads back as `null`, even without a
  subclass.
- `JSON.stringify(Object.entries(inst))` gives `[null]` on a class nobody
  extends.

## Plan

1. Reproduce each on 3 lanes against node.
2. Fix the wasi values/entries gate together with its byte impact, and the
   assign/entries carriers.
3. Tests on 3 lanes.
