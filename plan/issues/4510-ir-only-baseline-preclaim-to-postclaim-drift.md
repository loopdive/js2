---
id: 4510
title: "#4605 baseline traded a pre-claim rejection for 2 post-claim resolve-stage demotes — the drift #4462's design notes set out to avoid"
status: ready
sprint: current
created: 2026-08-16
priority: medium
horizon: s
feasibility: medium
task_type: hardening
area: ir
goal: ir-full-coverage
related: [4462, 4605, 4494]
origin: "dev-4605-park diagnosis 2026-08-16"
---

# #4510 — pre-claim → post-claim demote drift in the standalone reference corpus

## Finding (measured 2026-08-16)

The #4605 (`#4462`) branch's `scripts/ir-only-baseline.json` trades
`select/primitive-method-unsupported: 1` for
`resolve/late-preparation-unsupported: 2` in the standalone corpus — i.e. two
reference-corpus units moved from a **pre-claim** rejection (selector says no
before committing) to a **post-claim resolve-stage** demote (selector claims,
then the build backs out). This is exactly the selector↔capability-table
drift #4462's own design notes set out to make structurally impossible, now
merged. It is NOT a regression (both are demotes, the units still compile via
legacy) but it weakens the claim ⇔ preparability parity story #4494
established, and post-claim demotes are the bucket `check:ir-fallbacks`
watches most closely.

Note: #4611 (#4508) landed immediately after and reworked the same baseline
region (`late-preparation-unsupported` → 0 in standalone) — re-measure on
current main before doing anything; the residue may already be gone.

## Acceptance criteria

1. Re-measure on current main: `pnpm run check:ir-only` standalone lane —
   list any unit whose rejection is post-claim (`resolve/`-stage) where a
   pre-claim (`select/`-stage) verdict is derivable from the same facts.
2. For each, either move the verdict pre-claim (selector consults the same
   predicate the resolver uses) or record in this issue why the facts are
   genuinely only known at resolve time.
