---
id: 7456
title: "Ordinary pipeline: wrong values for a script var written only through shorthand destructuring"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: high
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7456 — Ordinary pipeline: wrong values for a script var written only through shorthand destructuring

## Problem

A script-level `var` that a function writes only through a shorthand destructuring assignment (`({ g } = o)`, `[{ g }] = a`, nested forms) is treated as never written, and later reads give a stale value. Found on main on 2026-11-22 while reviewing #7354 H2 (which made the shared writes query see these targets; the ordinary output did not change in 34 programs x 2 targets, so the wrong values come from another analysis). Failing probe shapes: a string var in a nested pattern, a string var read in a function, a number array, a class instance, a function-expression var, a function declaration, a nested shorthand.

## Acceptance criteria

- Each probe shape gives node's answer on the default and standalone targets.
- One analysis decides "is this binding written"; it resolves shorthand targets with `getShorthandAssignmentValueSymbol`.
