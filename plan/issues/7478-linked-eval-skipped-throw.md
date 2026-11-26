---
id: 7478
title: "Standalone link + eval mention: a throw inside a call with a `false` argument is skipped (unearned Temporal passes)"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, link, runtime-eval
goal: core-semantics
related: [7376, 7479, 5383, 4242]
---

# #7478 — linked standalone unit that mentions `eval` skips a throw

## Problem

In a standalone compile that links a provider (`compileWithTemporalGlobal`)
and whose source mentions `eval` anywhere, even a dead `globalThis.eval;`:

```js
function g(m) { throw "in"; }
g(false);
throw "after";
```

- **Measured, 2026-11-26, main `6694a8b8`:** the unit throws `"after"`. It
  throws `"in"` in three other cases: when it is not linked, when it has no
  eval mention, and with `g("x")` or `g()`. The `false` argument matters.
- **Effect:** every harness `assert(false, msg)` is skipped in such a unit.
  The test262 runtime shim's `$262` mentions `eval`, so standalone Temporal
  rows on main can score passes they did not earn:
  - `verifyProperty(Temporal.PlainTime, "name", { value: "Nope" })` passes.
  - The real verdict of `Temporal/PlainTime/name.js` is
    `Test262Error: name should be an own property`.
- **Found while** root-causing the #7376 revert.

## Implementation Plan

To be filled in from the root-cause trace. Requirements:

- one fix at the mechanism, no special case;
- gc output stays byte-identical;
- a pin test that fails on main.

## Acceptance

1. The repro throws `"in"` in every variant.
2. A pin test fails on main and passes with the fix.
3. Before the PR opens: the standalone rows that flip pass→fail are counted
   per edition, with a sample list. ES5 rows are called out explicitly.
