---
name: feedback-check-declared-rebaseline-before-crying-corruption
description: "Before declaring a baseline/metric collapse 'corrupt/poisoned', check for a DECLARED oracle rebaseline spec and reconcile the arithmetic; also: merge groups are cumulative, so identical failures on unrelated PRs can be an in-queue verdict-changing PR, not infra."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-18T11:10:04.773Z
---

On 2026-07-18 the standalone test262 baseline "collapsed" 24,840 → 4,312
(fail:0, 38,771 host-import CEs). I declared it cache poisoning (#3411),
restored old baselines 3×, disabled a workflow, and fought a parallel lead
session that kept republishing it — but the collapse was the **intentional
oracle-v8 rebaseline declared in plan/issues/3370** (~20,561 host-import-
leaking passes reclassified by the #2961/#3288 compile-time leak scan under
the authoritative upstream harness; 24,840 − 20,561 ≈ 4,312 reconciles
exactly). The user caught it: "see if the numbers are actually correct with
the removed modifications of the test262 harness."

**Why:** an "impossible-looking" verdict shape (fail:0 + mass CE) can be the
expected shape of a new verdict CLASS. Declared rebaselines carry a
`bounded regressions / count:` block in their issue file — reconcile the
arithmetic against it FIRST.

**How to apply:**
- Before any baseline restore / "corruption" claim: grep plan/issues/ for a
  rebaseline/oracle-bump declaration covering the delta, and reconcile
  old − declared ≈ new.
- "Identical failure cluster on unrelated PRs while a fresh-based PR passes"
  does NOT prove infra: merge groups are CUMULATIVE — an in-queue
  verdict-changing PR (here #3288) contaminates every group it rides in.
- Never enter a republish war with a parallel session; escalate with evidence
  and wait (the other side may hold the missing spec context).
Related: [[reference_verdict_logic_change_must_bump_oracle_version]],
[[feedback_verify_fix_in_git_not_narrative]].
