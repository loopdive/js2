---
name: reference-verdict-logic-change-must-bump-oracle-version
description: A test262 scorer/verdict-logic change must bump
metadata: 
  node_type: memory
  type: reference
  originSessionId: 1ef96580-7db6-4559-9e05-7f637b7f44c5
  modified: 2026-07-24T23:23:09.396Z
---

Root cause of BOTH intentional-reclassification queue wedges in 2026-07 (the −439 strict-negative-verdict and the #2463 vacuity-scorer). When a PR changes VERDICT LOGIC (how a test262 result is scored: test262-worker.mjs / test262-shared.ts / a scorer like the vacuity reclassifier), the new-policy results diff against the OLD-policy baseline as a mass pass→fail cluster. If the change does NOT bump the #2096 `oracle_version`:

- the push-to-main run's Catastrophic regression guard (#1668) sees the huge delta and FAILS → `promote-baseline` never runs → baselines stay old-policy → every merge_group since diffs new-vs-old → identical cluster signature → auto-park → the whole queue wedges against a baseline that can only be fixed by the promote the guard is blocking.

**THE GATE HAS A BLIND SPOT — do NOT rely on it to catch a missing bump (measured 2026-07-25).**
`scripts/check-verdict-oracle-bump.mjs` reported **"no verdict-logic files changed"** for a PR
that changed the #3189 trap-ratchet exclusion policy in `scripts/diff-test262.ts` — a genuine
verdict-logic change. Its `VERDICT_SIGNAL_RE` only matches `status:` **verdict-literal
assignments**, so **ratchet/gate-policy changes are invisible to it**. The `ORACLE_VERSION`
10→11 bump on that PR was made deliberately by the author, NOT forced by the gate; had the
author not known the rule, the gate would have waved it through and the queue would have
wedged. This is the same false-negative class already noted in the v4 oracle history.
**So: decide the bump from what the change DOES, never from whether the gate complains.**

**Prevention (the durable fix, reserved as #3003):** a CI check that flags any change to scorer/verdict-logic files that does NOT also bump `oracle_version`. When the oracle IS bumped, the guards correctly refuse the cross-oracle diff (or require `ORACLE_REBASE=1`) instead of catastrophic-blocking the promote.

**How to apply:** landing an intentional honesty reclassification (verdict-logic change) requires EITHER (a) bump `oracle_version` so the guards treat it as a re-baseline not a regression, OR (b) the coordinated temporary-lever dance (raise the guard + regression-budget, land, promote, revert — see the −439 landing). (a) is cleaner. Also note there are THREE required checks that diff vs baseline on merge_group — the two guards PLUS `check for test262 regressions` (test262-sharded.yml regression-gate job) — a lever/excusal must reach all three. Related: [[feedback_baseline_gates_need_postmerge_autorefresh]], [[reference_baseline_gates_need_postmerge_autorefresh]].

**Correction (2026-07-15, #3285/#3104):** (a) is NOT always sufficient on its own — bumping `oracle_version` only activates "rebase mode" in `scripts/diff-test262.ts`, and rebase mode only EXCUSES flips carrying a `vacuous`/`vacuousReclassification` marker (this is what let the #3086 v2 precedent land 1438 flips on a bare bump — they were all vacuity-tagged). A reclassification whose flips are plain non-vacuous fails (e.g. #3285's `assert_throws` error-type tightening: 2668 flips, all `assertion_fail`/`type_error`, zero `vacuous`) still hits `regressionsWasmChange > ORACLE_REBASE_DRIFT_TOLERANCE` (25, `diff-test262.ts:1040`) even with the bump in place, plus the per-bucket-50 concentration check and the #1668 catastrophic guard (200) — all three read the same non-excused delta. For this shape, (a) alone is necessary but not sufficient; only the full (b) lever dance lands it. Before telling anyone "just bump the oracle version" for a specific PR, check whether that PR's flips are vacuity-tagged (a) or plain assertion/type-error flips at a scale >25 (needs b) — don't assume every verdict-logic change is the cheap case. Given (b) is a shared-system risk (temporarily weakens the merge queue's regression guard for every other in-flight PR) and needs end-to-end babysitting to safely revert, treat it as a deliberate big-rock for a well-budgeted window, not a same-day fix on a thin budget.
