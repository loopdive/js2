---
name: reference-untested-recovery-paths-rot-silently
description: "An untested recovery path is indistinguishable from a working one until you need it — disabling a workflow silently invalidates every runbook line naming it, and nothing links the two"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T09:16:07.734Z
---

**An untested recovery path is indistinguishable from a working one until you
need it.** Verify a lever can actually fire *before* the incident, not during it.

**Confirmed 2026-07-25.** The documented recovery lever for a queue wedged on
#1897 was `refresh-baseline.yml` **EMERGENCY** mode
(see [[reference_intentional_standalone_rebaseline_fast_path]]). That workflow is
`state=disabled_manually`: `gh workflow run` cannot see it and a REST dispatch
returns **HTTP 422 "Cannot trigger a 'workflow_dispatch' on a disabled
workflow"** — it fails before doing anything. It would have been discovered
*during* a wedge, when there is no time and when the obvious improvisation
(re-enable a workflow mid-incident to run an unconditional, guard-ignoring
promote) is the most dangerous possible version of that action.

**The structural bug: disabling a workflow silently invalidates every runbook /
memory / doc line that names it, and NOTHING links the two.** GitHub does not
warn you; the docs keep confidently describing a lever that cannot move.

**How to apply:**
- Before relying on any documented lever, check it exists AND is enabled:
  `gh api repos/<owner>/<repo>/actions/workflows --jq '.workflows[]|"\(.path) \(.state)"'`.
  Note `gh workflow list` simply omits disabled workflows — absence there is not
  evidence of non-existence (cf. [[reference_label_evidence_by_source_before_reasoning]]).
- When disabling a workflow, grep the runbooks/memories for its name in the same
  change, or you have created a latent incident.
- Prefer repairing the PRIMARY mechanism over re-enabling a backstop: on
  2026-07-25 promote-on-merge (the primary #2097 mark-raise) was ALSO broken —
  it skips on queue-merge pushes via the per-SHA-reuse HIT path (#3611). Both
  paths dead at once, and the symptom is a floor that only ever falls behind,
  silently, because **a floor that is too low never complains**.
- Re-enabling a manually-disabled workflow is a repo-config change with standing
  effect (it restarts the cron) and usually undoes a deliberate decision whose
  rationale may be unrecorded — escalate, don't infer permission.

**Same family as the constant-vs-measurement failures** (a parser returning a
constant, `grep` silently binary-classifying a file, a poll on a CLI-unsupported
field): all present as a benign-looking normal state. This one is about a
**capability** that has quietly gone missing rather than **evidence** that is
quietly empty.
