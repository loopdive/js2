---
id: 4521
title: "demoteOnLegacyCaller mode policy is duplicated in select.ts and select-identity.ts — hoist to one shared module"
status: ready
sprint: current
created: 2026-08-16
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
language_feature: compiler-internals
goal: ir-full-coverage
parent: 3518
related: [3518, 4514]
origin: "tech-lead IR design review 2026-08-16"
files:
  - src/ir/select.ts
  - src/ir/select-identity.ts
---

# #4521 — one definition for the caller-direction demotion policy

## Problem

`const demoteOnLegacyCaller = options.jsHostExterns !== true;` is computed
independently in `src/ir/select.ts` (~line 1014) and
`src/ir/select-identity.ts` (~line 982), with mirrored consult sites in each.
The predicate machinery is properly shared (select-identity imports
`configureIrStructuralSelectorPredicates` etc. from select.ts), but the
mode-keyed POLICY line and its guard sites are copy-pairs. #3518's 2026-08-15
work had to patch both files in lockstep, and its notes call them out as "two
mirrored places". A future edit that touches only one silently forks
selection behavior between the structural and identity paths — a class of
drift no current gate detects (the two paths are never diffed against each
other).

## Acceptance criteria

- [ ] The policy (`jsHostExterns !== true`, plus the
      `legacyCallerAbiIsProjected` consult contract around it) lives in ONE
      exported helper; both select.ts and select-identity.ts call it. Grep
      for `jsHostExterns !== true` finds exactly one hit under `src/ir/`.
- [ ] Pure refactor: `check:ir-only` (both lanes), `check:ir-fallbacks`, and
      the equivalence gate are byte-for-byte unchanged.
- [ ] Bonus if cheap: a comment or micro-test asserting the structural and
      identity paths consult the same policy object, so the next mirrored
      policy addition has an obvious home.
