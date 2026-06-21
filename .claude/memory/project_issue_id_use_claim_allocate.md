---
name: project_issue_id_use_claim_allocate
description: "Allocate new issue IDs with claim-issue.mjs --allocate (atomic), never next-issue-id.mjs (races → dup-ID)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

When creating a new `plan/issues/<id>-<slug>.md`, get the ID from
`node scripts/claim-issue.mjs --allocate` (atomic: reserves on the
`issue-assignments` ref vs origin/main ∪ open-PR added files ∪ already-reserved
IDs, first-push-wins). Do NOT use `next-issue-id.mjs` — it only prints `max+1`
from a scan and does NOT reserve, so two concurrent branches pick the same
number. The dup is green at PR time and only fails in the `merge_group`
`quality` gate ("N duplicate IDs"), wedging the queue.

**Why:** 2026-06-20 I renumbered PR #1711 off the reused #2026 using
`next-issue-id.mjs` → got #2550, which raced and collided with the trust-gate
PR's #2550 that landed first; another agent had to re-renumber #1711 to #2551.
Separately, #1769's Phase-2 deferral target was hand-drafted as #2514 which was
already on main (runtime-helpers) — `check:issues` caught it; fixed via
`--allocate` → #2552.

**How to apply:** `NEW=$(node scripts/claim-issue.mjs --allocate)` then create
`plan/issues/$NEW-<slug>.md` with `id: $NEW`. Always run
`node scripts/update-issues.mjs --check` (check:issues) before pushing — it hard-
fails on duplicate IDs. Related: [[project_merge_queue_dup_issue_id_churn.md]].
