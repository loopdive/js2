---
id: 4043
title: "'__get_builtin' (dynamic-shape object/property operation) refused in standalone — 11 gap files, 121 all-official"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [1781, 4040]
---

# '__get_builtin' (dynamic-shape object/property operation) refused in standalone — 11 gap files, 121 all-official

## Problem

```
L#:# Codegen error: '__get_builtin' (dynamic-shape object/property operation) is …
```

**11 goal-scope host-pass ∧ standalone-fail files** (part of #4040);
**121 all-official** — so most of its mass is outside the ES5+untagged goal, and
the goal-scope payoff is small. Filed for completeness and because the mechanism
is narrow and named.

## Why it may be cheaper than its count suggests

It is a **single named codegen refusal**, i.e. Tier-1 conclusive: membership needs
no body-reading, and the compiler itself states the missing capability. The same
shape (`__get_builtin`, dynamic-shape property access) is adjacent to the
receiver-representation work in **#4010** (two disjoint identity-keyed side tables,
`vec-props.ts` #3537 and `vec-overlay.ts` #3251) — **check whether #4010 subsumes
it before starting**, because a dynamic-shape property operation is exactly what
that substrate is supposed to answer.

## ⚠ Do not size off the all-official 121

The goal is ES5+untagged. This sprint, ranking by all-official count nearly
mis-dispatched a dev onto `#680` generators — **320 all-official, 1 in goal
scope**. Measure in goal scope first; if the goal-scope share stays ~11, this is a
low-priority tail item, not a lever.
