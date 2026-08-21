---
id: 4510
title: "#4605 baseline traded a pre-claim rejection for 2 post-claim resolve-stage demotes — the drift #4462's design notes set out to avoid"
status: done
sprint: current
created: 2026-08-16
updated: 2026-08-21
completed: 2026-08-21
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

## Resolution (2026-08-21) — re-measured, residue gone

AC 1 re-measurement on current main (branch `claude/ir-migration-completion-lf3fz0`,
base `bc588f2f3`): `pnpm run check:ir-only` reports the standalone lane at
**38/38 terminal units emitted as IR bodies, 0 unsupported, 0 invariants, 0
legacy bodies**, `unsupported codes {}` — there is no `resolve/`-stage
post-claim demote left in the reference corpus at all, so no unit exists whose
verdict could be moved pre-claim (AC 2 is vacuous). `check:ir-fallbacks`
concurs: every post-claim bucket (build/verify/lower/backend-legality) is
empty.

The specific traded pair this issue recorded — `select/primitive-method-unsupported: 1`
→ `resolve/late-preparation-unsupported: 2` — was unwound by the chain the
baseline notes document: #4611 (#4508) recovered both
`late-preparation-unsupported` units via module-binding storage edges, #4514
made the reverse-callers withdrawal directional, and #4573/#4574/#4576/#4577
drove the lane's remaining unsupported set to zero and promoted it to strict
IR-only policy. No code change needed here; this issue closes as a
measurement record.
