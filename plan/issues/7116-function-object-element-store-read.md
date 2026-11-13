---
id: 7116
title: "Function-object element store `F[\"k\"] = fn` reads back wrong through `F.k` (standalone, all-legacy)"
status: ready
sprint: Backlog
created: 2026-10-22
updated: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
parent: 7106
---

## Problem

After a legacy **element** store of a function value onto a function object,
reading the same property back through a **named** access is wrong. Every unit
compiles on the legacy path, so this is not an IR boundary issue. Found by the
#7106 census arm 3 work and confirmed on origin/main (2026-10-22): standalone,
script goal, `deferTopLevelInit`. Node does not throw.

```js
function fmt(v) { return "<" + String(v) + ">"; }
function holder(x) { return x; }
holder["el"] = fmt;
if (holder.el(5) !== "<5>") throw new Error("el wrong"); // throws on js2 standalone
```

The property-access store `holder.el = fmt` reads back correctly. Once #6831
lands, an IR caller of `holder.el(…)` throws instead of returning a wrong
value.

## Acceptance

- The repro returns `"<5>"` on standalone and gc, matching node.
- Element and named stores and reads of the same key on a function object
  share one property, including computed string keys equal to an identifier.
- A test in `tests/` compares results with node.
