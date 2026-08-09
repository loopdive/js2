---
name: reference_f1_honest_floor_deinflation_landing_recipe
description: "The concrete recipe that LANDED #3468 F1 honest standalone floor de-inflation (2026-07-23→24, PR #3523): how to land an intentional, measured, stakeholder-authorized negative baseline through the merge_group without masking anything."
metadata: 
  node_type: memory
  type: reference
  originSessionId: a3d6eeff-28b8-4096-ad2f-4e98df2f82bf
  modified: 2026-07-23T22:03:07.942Z
---

**#3468 F1 LANDED** (PR #3523, merged 2026-07-24 21:59): standalone de-inflated from the
**inflated 31,188 → honest 27,557** host-free passes at **oracle v10**. 3,545 vacuous passes
(assert methods never fired because standalone closures couldn't carry own properties) now fire
and honestly fail, cohort-routed to trackers. Public host conformance (~70.4%) UNCHANGED —
host byte-identical, corpus-confirmed. This is the working recipe for landing an intentional,
measured negative baseline. See [[reference_standalone_floor_inflated_by_exception_swallow]],
[[reference_baseline_promote_trap_gate_two_failure_modes]].

## The recipe (each step was load-bearing)
1. **Stakeholder ruling FIRST, recorded in the issue** before building — the floor-rebaseline
   gate defers to the stakeholder; a PR-shepherd "do not rebaseline" note is NOT a veto once the
   stakeholder rules. Put the ruling in the issue `## STAKEHOLDER RULING` section AND the PR body.
2. **The park IS the measurement.** The standalone floor/#1897 guard is **merge_group-only** —
   the PR goes green at PR-level, then auto-parks (`hold` + `auto-park-bot`) on "merge shard
   reports". Do NOT treat the park as failure; pull the merge_group `test262-merged-report` delta
   — THAT is the honest number. Never use a stale pre-measured figure (the 07-20 "3,608" was
   stale by F3; the real measured delta was 3,637 against the fresh 20:20Z baseline).
3. **Discriminate honest-flips vs invalid-Wasm.** 3,545/3,637 were assertion-time Test262Error
   throws (the designed de-inflation). 4 were compile_errors = a REAL pre-existing latent bug
   (cross-fctx `local.get cap.outerLocalIdx` in call-identifier.ts, the #1177-revert minefield)
   that F1 merely exposes → FIXED-or-tracked, never absorbed silently. Filed #3559; stakeholder
   signed off to carry 4 (0.11%) inside the allowance with the tracker.
4. **Cluster-route ALL exposed fails to trackers, cohort-level** (#2860 census ~3,454, #3442/#2865
   async 137, #2903/#3390 promise 31, #3443 illegal_cast 4, #1781 null_deref 7). This is the
   condition that makes it honest de-inflation, not banking.
5. **Landing-kit mechanics (measured, not round):**
   - The high-water JSON (`benchmarks/results/test262-standalone-highwater.json`, mark 25,453) did
     NOT need editing — the honest 27,557 sits +2,104 ABOVE the floor. Only the rolling **#1897**
     guard trips.
   - Clear #1897 via **rebase mode**: `regressions-allow` frontmatter in the issue is read by
     diff-test262.ts ONLY inside `if (rebaseMode)` → requires **`ORACLE_VERSION` bump 9→10**
     (tests/test262-oracle-version.ts + history entry). No bump ⇒ allowance ignored ⇒ #1897 fails
     forever. Precedent: v4/#3285.
   - **Tighten the allowance to measured + documented margin** — 3,675 = 3,637 measured + 13
     (timeout-flake conversion bound) + 25 (codified `ORACLE_REBASE_DRIFT_TOLERANCE`). A round
     ceiling (the proposed 3,700) is the mode-B "banks future regressions" failure. No free slack.
   - **FOLD the oracle-classifier fix, don't allow around it.** The trap-ratchet oob trip was 100%
     an oracle misclassification (classifyError matched "out of bounds" inside newly-firing
     assertion TEXT); F1 AGGRAVATES it. Hoisting the `^Test262Error`→assertion_fail rule above the
     trap regexes ELIMINATED the trap-growth-allow entirely and made all 4 trap categories shrink.
     A bounded allowance around a defect your own change worsens is a smell — fold if small.
6. **Land against a QUIET queue, single re-enqueue.** Drain other in-flight PRs first (oracle bump
   + de-inflation can wedge concurrent PRs). Remove `hold` by **REST** (`gh api -X DELETE
   .../labels/hold` — gh 2.23 `pr edit` silently no-ops), enqueue ONCE via GraphQL. The
   re-enqueue's merge_group is the drift re-confirm; if it parks again, re-measure — NOT a loop.
   F1 passed within 3,675 on the first re-enqueue (no drift park).

## Meta-lesson banked this session
**MEASURE-NOT-EXTRAPOLATE validated 3× in one day**: acorn (#3520), wasi-leak, promise-import — all
three bisects REFUTED the lead's/dev's "landed today" hypotheses; culprits were 5, 19, 10 days old.
And **4 instances of the "vacuous/stale/invisible test outside required checks" disease** (acorn
regression, the #2847 boolean-quirk mislabel, the two stale guard tests #3558) — systematically
closed by folding into the required guard suite (#3552/#3514, now 5 files). F1 is the largest
instance of the same disease. See [[feedback_measure_never_extrapolate]].
