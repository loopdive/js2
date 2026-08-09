---
name: feedback_opus5_is_frontier_tier_claims_fable_tasks
description: "Opus 5 is frontier-tier — it may claim `model: fable` (frontier) issues, not just `model: opus`. Do NOT invent a `model: frontier` tag or mass-retag."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-24T18:28:17.841Z
---

**Opus 5 is a frontier-tier model and may claim `model: fable` issues.** Established
2026-07-24 at the start of sprint 77 ("start sprint 77 with the new Opus 5 model that
can work on model: fable or model: frontier tasks").

**Why:** the `model: fable` tag never meant "the Fable product" — it meant *frontier
tier required*. When Fable 5 hit its account-wide rate limit (2026-07-23), the entire
fable-tier substrate backlog stranded, even though the work was model-class-gated, not
Fable-specific. Opus 5 satisfies that tier, so the gate lifts. This also collapses the
`fable_role: spec` split (Fable specs → Opus implements): Opus 5 does both.

**How to apply:**
- Treat "frontier" as a **capability tier**, not a tag. There is no `model: frontier`
  value on disk (survey at the time: 79 `fable`, 20 `opus`, 3 `gpt-5.6-sol`, zero
  `frontier` anywhere in SCHEMA.md / agent defs / lane-partition.md). **Do NOT create
  one and do NOT mass-retag 79 issues** — that is churn the change does not require.
- Dispatch Opus 5 onto `model: fable` issues directly. Say "frontier-tier, now
  Opus-5-claimable" in the spawn prompt so the agent knows why it is allowed.
- The **lane partition still applies** for claim collisions ([[feedback_mandatory_predispatch_gate_and_lane_partition]]).
  Collapsing the *model* gate does not collapse the *claim* gate — `symphony/` and
  `codex/` lanes still hold live branches. Run the pre-dispatch grep-gate per issue.
- Budget still binds independently of capability: `horizon: xl` epics do not fit a
  drained window regardless of model. Ship **slices**. See
  [[feedback_token_budget_guardrails]].

Related: [[reference_fable5_is_frontier_claude_not_codex]] (tier ordering),
[[feedback_devs_default_opus]] (fallback rule this supersedes for fable-tier work),
[[project_next_session]] (the stranded fable-tier backlog this unblocks).
