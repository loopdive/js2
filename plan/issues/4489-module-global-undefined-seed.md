---
id: 4489
title: "standalone: module-scope `var x;` reads before declaration are `ref.null.extern`, indistinguishable from the closure ABI's absent-arg pad — seed with the undefined singleton (full-corpus A/B required)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: hoisting
goal: standalone-gap
related: [4465, 737]
origin: "2026-08-15 #4465 R1 finding — 5 measured rows in built-ins/String/prototype alone; the root is module-wide."
---

# #4489 — module globals seed null, not undefined

## Problem

`registerModuleGlobal` seeds externref module globals with `ref.null.extern`.
A hoisted-but-unassigned `var x;` read therefore yields the same value the
closure ABI uses as its "absent argument" pad, so downstream arms
(String.prototype methods among them, #4465 G1b/G3, 5 measured rows) cannot
distinguish `undefined` from "no argument", and `String(x)`-class coercions
answer wrong. The function-local hoister already seeds `undefined` (#737) —
module scope diverges.

## Why this is NOT a one-line ship despite a one-line fix

The candidate fix is one line (seed with the undefined singleton), but its
blast radius is EVERY module global in the corpus: any arm that currently
`ref.is_null`-tests a module global to mean "unset" changes behavior. #4465's
agent measured only a 630-file String-scoped sweep and correctly declined to
ship blind.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md`.
2. Find every consumer that null-tests module globals (grep the emission
   sites reading `moduleGlobal`/`registerModuleGlobal` slots; catalogue
   `ref.is_null` uses on those values).
3. Apply the seed change; fix consumers that meant "unset" rather than
   "undefined" (they must test against the undefined singleton or a
   separate flag).
4. **Full-corpus A/B is the acceptance instrument**: a broad standalone
   sweep (at minimum: `built-ins/String`, `language/statements`,
   `language/expressions`, `built-ins/Object`, ~2k files) before/after from
   your own runs, zero regressions; plus the 5 #4465 R1 rows flipping.
5. Pins: extend tests/issue-4465.test.ts's residual pins (R1 has no pin —
   the harness's exported-function shape masks it; write a
   module-init-shape pin that actually exercises the module-global path,
   documented in #4465's report).

## Acceptance criteria

- The 5 R1 rows flip; broad-sweep zero regressions; consumers catalogued in
  the issue file.
