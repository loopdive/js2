---
id: 4622
title: "standalone: `delete arguments.length` crashes the COMPILER — arguments-object descriptor surface prerequisite"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: arguments-object
goal: standalone-gap
related: [4620, 3251]
origin: "dev-4620 family-B triage (2026-08-22): the crash blocks the whole arguments-object descriptor family from even being measured."
---

# #4622 — `delete arguments.length` compiler crash

## Problem (measured by dev-4620, 2026-08-22)

Compiling a function containing `delete arguments.length` (or `delete
arguments[<k>]` shapes reached by the #4620 family-B rows) crashes the
compiler itself — not a wrong answer, not a runtime trap: compilation
throws. This is a crash-class defect (highest tier per the campaign brief)
and it walls off the arguments-object descriptor rows behind it, because a
test that deletes then re-reads can't even be bucketed.

Context from #4620's family-B record (see that issue's Results): the
arguments object is an opaque `$Vec` copy of the parameters
(`arguments-object-mop.ts` header), so member-delete lowering on it has no
descriptor store to hit; the crash is in the lowering path, before any
runtime semantics question arises.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Reproduce
   first with a minimal `.tmp/` probe: `function f(){ delete
   arguments.length; return 1; }` — record the exact throw site and stack.
2. Bisect the lowering: member-delete on an `arguments` receiver — find
   where the delete path assumes a `$Object`/struct receiver and meets the
   `$Vec` copy. Likely `property-access.ts` delete arm or
   `arguments-object-mop.ts` interplay.
3. Minimum correct fix: `delete arguments.length` must compile and answer
   per §10.4.4 ordinary-object semantics for the copy we have (own
   `length` is deletable → `true`, subsequent `arguments.length` reads
   fall through per the current representation). Do NOT attempt the full
   `[[ParameterMap]]` write-through here (that is #3251-class,
   representation work) — the deliverable is: no compiler crash, spec-true
   where the representation permits, honest `it.fails` pins where it does
   not.
4. Sweep the `built-ins/Function/arguments*` + `language/arguments-object`
   ES≤5 rows before/after (own runs, serial for timing-adjacent rows).
5. Pins: tests/issue-4622.test.ts — crash-gone positives + residual pins
   with owners (#3251 for write-through).
