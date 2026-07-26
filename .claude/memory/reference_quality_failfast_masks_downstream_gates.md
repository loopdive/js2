---
name: reference_quality_failfast_masks_downstream_gates
description: "A failing early step in the `quality` job aborts it under bash -e, so all later gates never run — 'fixed the failure' does NOT mean quality will pass"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T23:30:25.477Z
---

The `quality` CI job runs its gates as sequential steps under `bash -e`. A failure
in an early step **aborts the whole job**, so every later step never executes.

Measured 2026-07-26 on PR #3619: step 13 ("Per-function LOC-ceiling ratchet,
#3400 / R-FUNC") failed, so **steps 14–38 never ran — 25 gates, including all
four issue-ID / integrity gates**.

**Two consequences that cost real CI cycles:**

1. **Fixing the reported gate does NOT imply `quality` will pass.** Everything
   behind the abort has never been evaluated even once, so failures are
   discovered strictly ONE PER CI ROUND-TRIP. This is a major contributor to the
   multi-round-trip pattern on this queue.
2. **Never claim a PR "passed the integrity gates" if `quality` aborted earlier.**
   Those gates produced no verdict at all. Absence of a failure is not a pass.

**Mitigation while the ordering stands:** after fixing an early-step failure, run
the cheap downstream gates LOCALLY before pushing, so the next CI cycle isn't
spent rediscovering them one at a time:
`check:issues`, `check:issue-ids:against-main`, `check:loc-budget`,
`check:issue-spec-coverage`, `check:codegen-fallbacks`, `check:oracle-ratchet`.

**Related trap — the LOC ratchet has TWO levels.** Declaring the file-level
`loc-budget-allow` does NOT satisfy the function-level ratchet; that needs
`func-budget-allow: - path::functionName` in the issue frontmatter. A function
already at its ceiling on the merge base faults on ANY growth. #3619 declared
only the file-level twin and stalled on exactly this.

See [[reference_ci_gate_change_scoped_not_wholetree_absolute]] and
[[reference_merge_queue_park_triage_four_causes]].
