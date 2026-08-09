---
id: 3884
title: "The test262 regression gate is blind to ~20 genuine regressions: phantom compile_timeout credits inflate every diff"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: current
horizon: m
es_edition: n/a
related: [3883, 3457, 1943, 2562, 3467, 3468]
---

# #3884 — The regression gate is blind to ~20 genuine regressions

## The defect, stated as a consequence

**A PR that introduces up to ~20 genuine semantic regressions and zero genuine
improvements passes the test262 regression gate.**

This is not a cosmetic inflation of a reported number. The gate systematically
**under-detects**, and the size of the blind spot is set by a property of the
promoted baseline rather than by anything about the PR under test.

Measured on the **host** lane (see Scope). Whether the standalone baseline
carries the same artifact is **unknown and unmeasured**.

## Mechanism

### 1. The baseline hands every candidate ~20 free "improvements"

The promoted baseline contains ~120 rows recorded as `compile_timeout`. About 20
of those are **load artifacts** — tests that reliably pass, recorded as timing
out because the run that produced the baseline was under load. Every candidate
therefore "improves" them, whatever its own diff does.

Holding the baseline **fixed** and varying the candidate across four independent
merge_group runs of PR #3871:

| run | baseline `compile_timeout` rows | of which **pass** in candidate | genuine `other`→pass |
| --- | ---: | ---: | ---: |
| 1 | 120 | 21 | **0** |
| 2 | 120 | 21 | **0** |
| 3 | 120 | 19 | **0** |
| 4 | 120 | 21 | **0** |

**19 of those paths are identical in all four runs** (set intersection). Not one
run produced a single genuine `other`→pass improvement. Every "improvement" the
gate reported was a timeout/absent recovery.

Method was validated before being trusted: this reconstruction reproduces the
gate's own `Raw host improvements before canary quarantine` line exactly
(23 / 23 / 21) and its regression categories to the row.

### 2. The phantom credit defeats BOTH hard gates, not just one

From `plan/issues/3457-regression-ratio-gate-flap-tolerant.md`, the
`Fail on regressions` step has two independent hard-fail conditions:

1. **Net gate** — `netPerTest = stableImprovements − regressionsWasmChange < 0`.
2. **Ratio gate** (`evaluateRegressionThresholds`) — fires when
   `regressionsWasmChange > 0` AND `regressions/improvements ≥ 10%`, classified
   by net:
   - **`net ≥ 0`** → the ratio breach is a **WARNING, not a failure**
   - `net < 0` AND `regressions ≥ 10` → hard FAILURE
   - `net < 0` AND `regressions < 10` → WARNING

Now substitute a PR with `R` genuine regressions and **zero** genuine
improvements. The phantom credit makes `improvements ≈ 20`, so:

- `net = 20 − R ≥ 0` whenever `R ≤ 20` ⇒ **net gate passes**.
- Because `net ≥ 0`, the ratio breach is **downgraded to a warning** ⇒ **ratio
  gate passes**.

So the phantom credits do not merely mask the net gate — **by keeping `net ≥ 0`
they simultaneously disarm the ratio gate**, which is the mechanism specifically
designed to catch one-directional regression. Both hard gates are defeated by
the same artifact. The only surviving hard check is the per-bucket >50
concentration limit, which `R ≤ 20` cannot trip.

**Blind spot: `R ≤ 20`.**

### 3. Observed consequence

PR #3871 was caught **only because it carried 27** — it exceeded the blind spot
by seven. A sibling defect with 15 genuine regressions and no improvements would
have merged silently. Separately, the passing control #3867 reported fine-gate
net `+47`; after removing ~20 phantom credits its earned figure is nearer `+28`.
Its verdict stands, but `+47` was never real.

## Scope and limits (stated so the finding isn't over-read)

- **Host lane only.** This is the gate's own arithmetic (`Host stable-path
  fine-gate net`), so it is the right lane for the verdict — but the standalone
  baseline has **not** been analysed and may or may not share the artifact.
- **Not audited historically.** See below — past verdicts cannot be re-checked.

## Structural aggravator: past verdicts are unauditable

`promote-baseline` **overwrites** the baseline on every push to main. The
control experiment originally planned for this investigation — re-running
#3867's diff — was **impossible** because its baseline (47,815 rows, pass
30,384) no longer exists. A gate whose baseline is destroyed on every promote
**cannot have its past verdicts audited**, so the historical extent of this
blind spot is unrecoverable. That is a third integrity problem in the same
system, alongside this issue and #3883.

The fixed-baseline / varying-candidate design above was substituted precisely
because the control route was closed, and it is stronger evidence for this
particular claim than the control would have been.

## Sibling defect

**#3883** — the same baseline is *configuration*-stale: ~1,200 rows it records
as `skip` are attempted and fail as `compile_error` in every candidate, while
the freshness check reports `CONTENT-CURRENT` because it counts commits, not
configuration. Two independent staleness defects in one baseline; this one is
load-recorded status, that one is configuration.

## Leads investigated and RULED OUT (recorded so they aren't re-raised)

- **"The baseline claims `pass` on rows main actually fails."** Raised from a
  local A/B showing `compound-assignment/11.13.2-25-s.js` and
  `assignment/11.13.1-1-s.js` failing on stock main while the baseline says
  `pass`. **RULED OUT — root cause confirmed: a stale local `origin/main`.** The
  A/B ran against a local ref pinned at `a1f72e93` while main was `0694da8f`.
  Re-run against current main, host **passes** both rows, agreeing with the CI
  baseline and with the CI candidate merged reports for runs 1 and 4. Baseline,
  CI candidate and current main all agree on host. No pipeline fault.

  Note the local harness had already been **validated** — it reproduced a known
  CI host failure (`6-a-161` on `2654bc0c`) with the exact assertion and values
  — so "permissive local harness" was never the explanation. The input commit
  was simply wrong. Both rows are also **standalone-only** failures, invisible
  to a host-lane gate by design.

  **This stale-ref trap fired five separate times in one session** and produced
  a confident wrong answer every time. `git fetch origin main` does **not**
  reliably advance `refs/remotes/origin/main`. Before any A/B against "main":

  ```bash
  git fetch origin '+refs/heads/main:refs/remotes/origin/main'
  git rev-parse origin/main
  gh api repos/loopdive/js2/commits/main --jq .sha   # must match
  ```

  **A baseline-vs-main disagreement should prompt a ref check before the
  baseline is suspected.**
- **`Object/defineProperties/15.2.3.7-6-a-161.js` as a mis-attributed row.**
  **Ruled out**: the file fails in *both* lanes for *different* reasons — host
  `arr.length` (SameValue 1 vs 10), standalone `hasOwnProperty`. Host and
  standalone are separate artifacts; the host report contains exactly one row
  for it, and the host baseline says `pass`. It is a genuine host regression.

Both leads arose from comparing across a **lane** or a **harness** boundary. The
rule that emerged: **every A/B on these paths must state its lane AND its
harness.** Host-vs-standalone and local-vs-CI each produced a confident wrong
conclusion within one hour, and from the inside they look identical. The local
harness has been demonstrated to diverge in the **permissive** direction (it
reports `pass` where CI reports `fail`), which is the direction that
manufactures false confidence.

## Proposed fix

1. **Stop counting recoveries from load-sensitive baseline statuses as
   improvements.** `compile_timeout`→`pass` and `absent`→`pass` should be
   excluded from the improvement numerator exactly as `→compile_timeout` is
   already excluded from the regression numerator (`noiseFiltered`,
   `r.to !== "compile_timeout"`). The asymmetry is the whole bug: the filter
   exists on one side only.
2. **Re-record baseline `compile_timeout` rows before promotion** — a row that
   passes on re-run should not be banked as a timeout.
3. **Surface the phantom credit** — report `improvements` split by source
   status, so a diff whose entire credit is timeout recovery is visible.

## Acceptance criteria

- [ ] **A PR carrying N genuine regressions and zero genuine improvements fails
      the gate for all N ≥ 1.** (Primary — the blind spot, not the reported
      number.)
- [ ] The improvement numerator excludes `compile_timeout`→`pass` and
      `absent`→`pass`, symmetric with the existing regression-side filter.
- [ ] The reported `Improvements` figure is decomposed by baseline source status
      in the diff output.
- [ ] Consider retaining prior baselines (or their digests) so gate verdicts
      remain auditable after promotion.

## Notes

Filed 2026-07-31 by the PR shepherd. All figures measured from CI merge_group
report artifacts against a fixed baseline jsonl; no local-harness measurement
contributes to any claim in this issue. Id reserved via
`scripts/claim-issue.mjs --allocate`.
