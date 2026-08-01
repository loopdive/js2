---
horizon: m
id: 4033
title: "ESLint frontier: two entry-source support drafts collide on one structural order"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 3520, 4001, 4018, 4019, 4027, 4028]
---

# #4033 — `intrinsic-provider` and `legacy-module-init-pass` share a structural order

## Problem

The current single hard error on the ESLint `linter.js` graph, reachable only
after #4001, #4018, #4019, #4027 and #4028:

```text
Codegen error: ABI drafts
  ir-binding:v1:callable:ir-source:v1:0000000000000118:entry:linter.js:intrinsic-provider:0000000000000000
and
  ir-binding:v1:support:ir-source:v1:0000000000000118:entry:linter.js:legacy-module-init-pass:0000000000000000
share structural order 118:0:0:5:0
```

Thrown as `duplicate-draft-order` from `ProgramAbiSession` (see
`src/codegen/program-abi-session.ts`, the `draftOrderOwners` collision check).

## Analysis

Two structurally distinct support drafts on the **entry source** —
`intrinsic-provider` and `legacy-module-init-pass` — are assigned the identical
structural order tuple `118:0:0:5:0`:

- `118` — the entry source's order
- `0` — declaration ordinal
- `0` — domain ordinal
- `5` — role ordinal
- `0` — derived ordinal

Both carry `derivedOrdinal: 0` and the same role ordinal, so the tuple cannot
distinguish them. The collision is in how these two support kinds derive their
ordinals, not (apparently) in the drafts themselves being duplicates: their ids
differ and their `intent.kind` differs (`callable` vs `support`).

Worth checking first, and **not yet ruled out**: whether #4001 (which changed
the accumulated `__module_init` from being compiled and injected once per source
to once per graph) altered the ordinal that `legacy-module-init-pass` derives.
The name appears directly in the colliding id. Against that reading, #4001
strictly *reduces* the number of module-init passes, and the equivalence suite
plus the multi-source behavioural A/B showed no change — but the interaction has
not been directly tested, and the ESLint graph never reached this code on any
earlier state, so there is no before/after comparison available.

## Acceptance criteria

- A reduced fixture reproduces the collision without ESLint.
- The #4001 interaction above is explicitly confirmed or ruled out, with
  evidence, before any ordinal-assignment change is designed.
- Distinct support kinds on one source get distinct structural orders.
- ESLint `linter.js` advances past this diagnostic.
