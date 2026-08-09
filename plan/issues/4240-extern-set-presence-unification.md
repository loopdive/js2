---
id: 4240
title: "Unify the write-side presence-storage resolution onto findPresenceStorage (read side's single source of truth)"
status: ready
created: 2026-08-08
updated: 2026-08-08
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: objects
goal: core-semantics
related: [3920, 3927, 4194, 4237]
origin: "Noted in PR #4231 (which made findPresenceStorage the union-aware read-side source) and PR #4232 (whose write arms still resolve storage via presenceSlotOf/findColdStructsForField); deferred out of both change-sets deliberately"
---

# #4240 — one presence-storage oracle, not two

## Problem

After the 2026-08-08 reflection chain landed, presence storage (base
`$presence_<w>` bit word | `$cold` hop | layout family side-table | nothing)
is resolved by TWO parallel mechanisms:

- READ side: `findPresenceStorage` (`src/codegen/closed-struct-presence.ts`)
  — union-aware, extended with the layout arm in PR #4241, explicitly
  designed as the single source of truth (PR #4231's design note).
- WRITE side: the `__extern_set` closed-struct arms
  (`src/codegen/closed-struct-extern-set.ts`, PR #4232) — resolve the same
  storage through `presenceSlotOf`/`findColdStructsForField` directly.

The two agree today because they consume the same underlying sources, but
nothing enforces it: the next storage class (this session alone added one —
layout families) must be taught in two places, and a divergence would be the
worst kind of bug — presence bits SET through one resolution and READ
through another, i.e. reflective operations lying in whichever direction the
divergence points.

## Fix

Route the write arms' storage resolution through `findPresenceStorage`
(read-only query + a set-bit emitter on its returned storage descriptor).
PR #4232's own report calls this "a clean refactor" and left it out only to
keep that change-set reviewable. Behavior-preserving: pin with the existing
suites (issue-3920, issue-4225 kill-switch A/B, issue-3927 layout-emit,
issue-4194 computed-write, the copy-mode differential 58/64 with the same 6
documented residuals).

## Acceptance

- [ ] `closed-struct-extern-set.ts` contains no direct
      `presenceSlotOf`/`findColdStructsForField` storage resolution; all
      presence placement flows through `findPresenceStorage`.
- [ ] All five suites above green, byte-diff of the standalone acorn binary
      empty or explained.
