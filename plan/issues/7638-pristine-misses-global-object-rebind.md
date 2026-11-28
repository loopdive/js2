---
id: 7638
title: "`pristine` misses a realm global rebound through the global object"
status: backlog
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
depends_on: []
related: [7350, 7628, 7503, 7609]
---

# #7638 — `pristine` misses a realm global rebound through the global object

## Problem

`pristineBuiltinGlobal` (`src/ir/builtin-global-binding.ts`, #7350 slice 1) decides that a name such as `Number`
still reads the realm's built-in. It sees declarations, assignments, `++`/`--`, `delete`, destructuring targets
and the global-object alias store `globalThis.Number = …`.

It does not see a rebinding through the global object by a key writer or a computed key. On main after #7549, each
of these leaves `Number` pristine, so `Number.isNaN(1)` still folds to the native:

```js
Object.defineProperty(this, "Number", {value: {isNaN: function () { return 7; }}});
Object.assign(globalThis, {Number: {isNaN: function () { return 7; }}});
this["Num" + "ber"] = {isNaN: function () { return 7; }};
```

Repro: `plan/samples/7628/probe-global.mts` on the #7628 branch. Found while planning #7628.

**Blocks B3b-1 (#7561, PR #7535).** B3b-1 does not have an issue file on main yet, so there is no frontmatter link.
Today a folded member and the native are the same algorithm on the Prepared path, so nothing observable goes wrong.
Once B3b-1 holds the realm's members as objects, a fold under a rebound name answers wrongly.

## Direction (to plan)

A realm name is not pristine when a write that may reach the global object names it as a key. The writes that
count:

- a store or key-writer call on `this` / a global alias;
- a computed key whose values (#7628's `keyValues`) may include the name.

This reuses #7628's member-write scan and key domain, so there is no second walk.

Measure the census cost on carriers and o411 (`plan/samples/7350-b3bc/README.md`) before choosing. Coordinate with
#7609 (script `this` is the sealed global object): a sealed global object may make some of these writes throw
instead.
