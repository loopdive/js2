---
id: 2102
title: "shared throwJsError(kind, msg) lowering + trap-site audit — runtime checks must throw catchable JS errors, not Wasm traps"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: exceptions
goal: core-semantics
related: [2003, 2017, 2012, 2000, 2025, 581]
origin: "2026-06-11 analysis program (report 01 ERR family — the review's blind spot); stub 08-D17"
---

# #2102 — the error-model family needs one helper

## Problem

Runtime checks lower to uncatchable Wasm traps (or to nothing) where the
spec requires catchable TypeError/RangeError/ReferenceError — 10+ June
issues: charCodeAt OOB traps (#2003), getter-only assignment traps
(#2017), freeze writes silent (#2012), TDZ unenforced (#2121), Array
RangeError missing (#2000), extracted-method null-this trap (#2025).
Invisible to test262 until the #1945 oracle upgrade lands — which is this
issue's detector.

## Root cause

No shared "throw a JS error" lowering that bounds/integrity/callable
checks route through. Standalone: the exception tag; host: `__throw_*`
imports.

## Fix direction

`emitThrowJsError(ctx, kind, messageConst)` helper + an audit converting
the 10 known trap sites; new checks must use it (fail-loud ratchet class).
Sequence after the exception-handler reachability fixes (#1972 family)
per the sprint proposal.

## Acceptance criteria

- The 6 cited issues' repros throw catchable errors of the right
  constructor in both modes
- `e instanceof TypeError` etc. true; oracle step-1 negatives pass

## Dupe check

Member issues filed individually; #581 is the old catchability family
anchor; no shared-helper issue exists. New (analysis program).
