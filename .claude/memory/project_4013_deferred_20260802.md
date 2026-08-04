---
name: project_4013_deferred_20260802
description: "PR #4013: the deferred close-vs-revive decision is MOOT — its lane revived it AND un-drafted it (2026-08-03). Now an ordinary open PR inside auto-refresh/auto-enqueue. Do NOT raise it with the stakeholder unless it goes ownerless with a red required check."
metadata:
  node_type: memory
  type: project
---

## Decision closed by events — do not re-raise

History: 2026-08-02 the stakeholder deferred close-vs-revive on PR #4013
(`codex/2929-direct-eval-capture`) when it was a DIRTY draft, 177 behind, 12h
untouched. 2026-08-03 its Codex lane revived it (conflicts resolved, actively
pushing) and then **marked it ready for review** (`isDraft: false`).

That removes the entire structural argument the decision rested on: as a
non-draft it is inside both `auto-refresh-prs` and `auto-enqueue` — nothing
needs a human to shepherd it. Current state at last check: behind 15, actively
worked, required checks red (`quality`, `equivalence-gate`) — ordinary
in-progress work, its lane fixing failures as they arise (5/5 that day).

**Treat it as any open PR.** Surface to the stakeholder only on the standard
bar: ownerless with a red required check.

The premise changed three times under the deferred decision
(DIRTY-and-rotting → revived → ready-for-review) — the standing lesson is
flag-once-then-recount, never escalate each move, and never present a stale
premise when asking for a decision.

Interpreter-tier mapping stands (stakeholder directive 2026-08-03): dynamic-code
refusals (#2928's 559 SA rows, #2527 packaging) are OWNED by this lane/PR. Our
lanes stay off interpreter territory; reground against this branch if near it.

## UPDATE 2026-08-03 ~05:40Z — stakeholder chose STACK-FLATTEN via #4077

#4013 parked (3 burned cycles, 5 baseline-pass annexB traps, no valve). Its fix
lived in #4077, stacked two PRs downstream (deadlock). Stakeholder decision:
retarget #4077 to main — its diff is now the WHOLE stack (#4013+#4068+fix,
75 files +10875/−790), full CI firing for the first time.

**OUTCOME 2026-08-03 ~06:1xZ: #4077 PARKED — flatten hypothesis REFUTED.** The
five baseline-pass annexB files trap IDENTICALLY under the flattened stack
(run 30789483199; floor −225, host net −146, fine −104, ratio 195.4%,
signature 8b3faf7347ca0a44 — worse than #4013 alone by ~27 files, no
offsetting fix). `fix(eval): preserve Annex B binding lifecycles` does not
touch these five. **Supersede-close is OFF** — #4013/#4068/#4077 are all
parked/stranded on the same defect.

The isolated blocker: five `annexB/language/function-code/
if-*-func-existing-var-update.js` (baseline pass → null_deref), ONE semantic
case — B.3.3 function-in-block updating an EXISTING var binding. No valve
applies (baseline-pass). Code fix required, reproducible locally against the
stack head. Likely interaction surface: the stack's declaration-environment
changes vs `src/codegen/annexb-cancel.ts` (ours, landed 2026-08-02).
Stacked-PR lessons: task #84.
