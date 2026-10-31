---
id: 7214
title: "`this.field += s` on a string class field traps"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7199]
---

# #7214 — compound string append on a class field traps

Found by the PR #7017 (#7199) review. Reproduces on main (9e82d60c42) on gc,
standalone and wasi:

```js
class Acc { total = ''; add(s) { this.total += s; return this; } }
console.log(new Acc().add('a').add('b').total);
// node: ab — we: trap ("dereferencing a null pointer"; with a non-empty
// initial value and chained calls: "illegal cast")
```

`this.total = this.total + s` works, so the bug is in the compound-assignment
lowering for a string-typed class field (`src/codegen/expressions/operator-assignment.ts`).

## Plan

1. Compare the lowering of `this.f += s` and `this.f = this.f + s` for a
   string field; find where the read or the store gets the wrong type or a
   null receiver.
2. Fix it, and cover `+=` on string fields of `this`, of another instance,
   of a static field, and with a number right operand.
3. Tests on 3 lanes against node.
