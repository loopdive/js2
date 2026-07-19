---
id: 3465
title: "ci(test262): fast-baseline seed / migration (one-shot native-harness full-corpus rebase for the fast lane)"
status: ready
sprint: Backlog
priority: high
horizon: s
task_type: ci
area: ci
goal: maintainability
parent: 3450
depends_on: [3461, 3462]
---

# ci(test262): fast-baseline seed / migration

Child (e) of the #3450 HYBRID two-oracle pipeline. Full spec:
`plan/design/3450-hybrid-two-oracle-plan.md` §7.

## Problem

The fast merge_group gate can only diff fast-vs-fast once an initial
native-harness host baseline exists. This is an `ORACLE_REBASE`-equivalent for
the FAST lane only; honest v8 is untouched. Must be seeded BEFORE the #3463
merge_group flip or the first fast run false-fails against a missing/empty
baseline.

## Scope

- One-shot `workflow_dispatch` (manual arm of the daily honest workflow, or a
  dedicated dispatch): run the full corpus in `TEST262_ORACLE_MODE=fast` (host
  lane) → produce `test262-fast-current.jsonl` stamped `fast-nativeharness`
  rev 1 → commit to `loopdive/js2wasm-baselines`.
- Bakes in the ~9,244 native-harness boundary flips ONCE.
- Sequenced: #3461 + #3462 land first; this seed runs; THEN #3463 flips CI.

## Acceptance criteria

1. A one-shot fast-mode full-corpus run produces `test262-fast-current.jsonl`
   committed to `js2wasm-baselines`, stamped `fast-nativeharness` rev 1.
2. Seed runs BEFORE #3463's merge_group flip (documented ordering dependency).
3. Post-seed, the first merge_group fast run shows ~zero regression delta
   (fast-vs-fast self-consistency), no false failures.
4. Honest v8 baseline + published number unchanged across the rollout.
