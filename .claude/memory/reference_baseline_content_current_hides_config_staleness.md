---
name: reference_baseline_content_current_hides_config_staleness
description: "`CONTENT-CURRENT` from the regression gate does NOT mean the baseline matches the candidate's config — ~1,200 baseline `skip` rows become `compile_error` in every candidate, inflating every diff"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T04:55:11.281Z
---

# `CONTENT-CURRENT` is a commit-lineage check, not a config-equivalence check

Measured 2026-07-31 across **every** merge_group run that night, **passing and
failing alike**:

| | baseline `skip` → candidate | baseline `compile_error` → candidate |
|---|---|---|
| #3871 (parked ×3) | 1312 → 108 (**−1204**) | 661 → 1856 (**+1195**) |
| **#3867 (control, PASSED)** | 1295 → 108 (**−1187**) | 660 → 1865 (**+1205**) |

**~1,200 tests the promoted baseline recorded as `skip` are attempted — and fail as
`compile_error` — in every candidate.** The baseline is **configuration-stale**
relative to every candidate.

Meanwhile the gate reports the baseline **`CONTENT-CURRENT`**, because that
freshness check counts **test262-relevant commits**, not config equivalence. **It
cannot see this class of staleness by construction.**

## Why it is dangerous rather than merely wrong

- It **inflates `compile_error` by ~1,200 in every diff**, so any `compile_error`
  delta read off these reports is meaningless without subtracting it.
- It appears in **passing** runs too, so it is not verdict-driving — which is
  exactly why it looks like a real finding when you first meet it. One shepherd
  nearly handed it to a dev as the lead for a live regression; that would have been
  a wasted investigation.
- `CONTENT-CURRENT` *reads* as "baseline is fine". It means only "no
  test262-relevant commits separate baseline from HEAD".

## Rule

**Never read `compile_error` deltas from a merge_group report without checking the
`skip` delta first.** A large negative `skip` swing paired with a matching positive
`compile_error` swing is this artifact, not a regression.

When triaging a park, the **semantic (`other`) bucket** is the one that carries
signal; `compile_error`, `compile_timeout` and `absent` were all shown to be noisy
or artifact-driven that night.

## Suggested fix (unfiled — `claim-issue.mjs --allocate` wedged 3× that session)

Either make the freshness check compare **effective skip-configuration** rather than
commit lineage, or surface **`skip`-delta as a first-class warning** so a ~1,200-row
swing cannot hide inside `compile_error`.

## Family

Seventh member of the "reports itself as authoritative and isn't" family — with a
green job that committed nothing, `prunable`, `$?` through a pipe, `granted by
<another issue>`, a short-sha `actions/runs` query, and an unstable bucket
signature. See [[reference_budget_grant_from_another_issue_fails_in_ci]],
[[feedback_baseline_drift_cross_check]],
[[reference_baseline_promote_trap_gate_two_failure_modes]].
