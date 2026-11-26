---
id: 7448
title: "Ordinary pipeline: a JSDoc `@param {number}` makes `x + 1` numeric for a string argument"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: high
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7448 — Ordinary pipeline: a JSDoc `@param {number}` makes `x + 1` numeric for a string argument

## Problem

`/** @param {number} x */ export function h(x){ return x + 1 }` called as `h("a")` returns `NaN`; node returns `"a1"`. A JSDoc type in a `.js` file is a hint, not a guarantee, so the addition must stay dynamic unless every caller is proven numeric.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- `h("a")` returns `"a1"` on the default and standalone targets.
- A function whose callers are all provably numeric keeps its numeric addition (no size regression on the playground corpus).
