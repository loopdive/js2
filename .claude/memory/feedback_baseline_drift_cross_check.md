---
name: Cross-check regression clusters against other open PRs before treating as real
description: When sampling CI regressions, compare against other unrelated open PRs from the same baseline — identical clusters are drift artifacts, not real regressions
type: feedback
originSessionId: fad84284-8590-4992-b3a1-47149eeef103
modified: 2026-07-31T10:36:07.476Z
---
When a PR's CI reports regressions, before assuming they're caused by the PR:

1. Check other recent PR CI feeds in `.claude/ci-status/pr-*.json` and the
   merged-report artifacts from other open branches that built against the
   same baseline.
2. If the same test names appear as regressions in **unrelated** PRs whose
   diffs don't touch that area (e.g. DataView detached-buffer regressions
   showing up in a PR that only edits eval codegen), those are almost
   certainly **baseline drift**, not real regressions.
3. Real regressions cluster by diff area: a DataView PR causes DataView
   regressions; an eval PR causes eval regressions. Cross-domain ghost
   clusters are noise from when baseline was captured vs when PR branches
   re-ran.
4. Before self-merge, run a local scoped compile+run on the regressed tests
   from your worktree. If they pass locally, the "regression" is drift and
   can be discounted from the self-merge gate.

**Why:** 2026-04-11 PR #107 (#1064 DataView) showed 4 DataView detached-buffer
tests as regressions in CI, but all 4 passed when compiled+run locally from
the same worktree. Same tests have been flipping on other unrelated PRs
(#100, #103, #104) — it's stale baseline noise. Team-lead called out the
pattern explicitly after dev-1047 saw the same DataView cluster on PR #100.

**How to apply:** when self-merge gate shows regressions, don't just count
them blindly against the ratio. Sample them locally; if they pass, they're
drift and the PR is safe to merge. Mention the cross-check in the self-merge
report so the team-lead can audit the reasoning.

**Fast drift signal (2026-06-03):** the `test262-regressions.txt` artifact
now prints its own age warning, e.g. "⚠️ baseline is 125h 44m old (commit
9ee8e92) — consider force-refresh before trusting these numbers." A
baseline more than a day or two old + a cross-domain cluster (e.g. 78x `oob`
on a String.prototype.concat/at PR) is drift; the gate is non-required so
the merge queue lands the PR regardless. Confirmed on PR #1058 — team-lead
agreed it was stale-baseline drift, not the change. Download the artifact
(`gh run download <run> -n test262-regressions-report`) to read the age line
and category breakdown.

---

## ⚠️ 2026-07-31 — bucket-SIGNATURE equality is NOT a reliable drift oracle right now

**Measured:** PR #3871 was re-validated on **two independent merge groups** with
**byte-identical compiler source**, and produced **different bucket signatures**:

> ⚠️ *Precision, so this isn't dismissed on audit:* the two groups did **not** share a
> base commit — the merge-group ref suffix is the **base**, not the merge SHA
> (`9d888281` = `Merge pull request #3872`; `d9b02d86` = `chore(ci): refresh landing
> benchmark artifacts [skip ci]`). But `git diff --stat` between those bases is
> **exclusively benchmark artifacts** — 9 files, all `benchmarks/results/*.json|.md`,
> **zero `src/`**. So no source change can account for the divergence.
>
> This makes the evidence **stronger**, not weaker: the two runs were independently
> scheduled on different runner allocations rather than being a literal re-run, so
> `compile_timeout` 47→25 and `absent` 16→6 across independent scheduling is exactly
> the signature of runner-load sensitivity.

| | group `9d888281` (03:50) | group `d9b02d86` (03:55) |
|---|---|---|
| bucket signature | `7f6c4012102d6f84` | `0db68fb596139630` |
| non-CT regressions | 43 | 35 |
| `other` (semantic) | 27 | 29 |
| `absent` | 16 | 6 |
| `compile_timeout` | 47 | 25 |
| net | −67 | −37 |
| fine-gate net | −21 | −15 |

**The signature is not stable across re-runs of one PR**, so "the same signature
appears on an unrelated PR ⇒ drift" will produce **false negatives**. Comparing
*test names* (the original form of this rule) still works; comparing *signatures*
does not, at least while the box is noisy.

### What IS stable, and what to bisect against

`compile_timeout` swung 47→25 and `absent` 16→6 on identical code — both are
**load-sensitive** categories, and this box ran load 11–13 all night. The stable
core was **`other` ≈ 27–29 against 20 improvements**.

**Quote the stable semantic core, not the headline net.** The −67 headline was
inflated; the honest figure was nearer **−15**. A net that moves by 30 between two
runs of the same code is measuring the box, not the change.

### Corollary — a docs-only PR is NOT a usable drift control

#3873 (docs-only) was proposed as a control and came back **green**, but the log
showed `SHARDS_RAN: false` with both shard-matrix jobs **skipped**. A green tick
there is **no evidence at all**, not evidence of a clean baseline. Any control PR
must be checked for `SHARDS_RAN` before its result is read either way.

See [[reference_ci_status_feed_retired_use_required_checks]] — the
`.claude/ci-status/pr-*.json` feed referenced above is retired; use the checks API
and the merge_group job logs.

### The signature's SCOPE, not just its stability (2026-07-31, same PR)

The instability above is only half the hazard. The other half:

> **The bucket signature hashes the WHOLE non-CT set, so it can never answer a
> question about ONE bucket's membership.**

A changing signature was read as "`other`'s membership churns" — supporting a
"marginal population near a threshold" story that would have excused a bad result.
Decomposing the same three runs killed it:

| run | non-CT | `other` | residue | `absent` |
|---|---:|---:|---:|---:|
| 1 | 43 | 27 | **16** | **16** |
| 2 | 35 | 29 | **6** | **6** |
| 3 | 37 | 28 | **9** | **9** |

**Residue equals `absent` exactly, all three runs.** The entire non-CT movement
lives in `absent`; `other` has spread **2**. So the signatures diverged without
`other` churning at all — and `other` at 27/29/28 on byte-identical source reads as
a **near-stable set of ~28 genuinely broken files**, which is the *worse* reading
for the change under test.

**Rule: an aggregate moved is not evidence that YOUR bucket moved.** Subtract the
other buckets before naming a cause. Two lines of arithmetic settled what three CI
runs could not.

**Only per-path rows can answer a per-bucket membership question** — pull the
merged-report jsonl paths, not bucket counts, whenever the two candidate readings
("stable set" vs "churning marginal pool") carry opposite verdicts.

Family: eighth member of "reports itself as authoritative and isn't", and the
first where the instrument was *fine* — it was simply asked a question outside its
scope. See [[reference_baseline_content_current_hides_config_staleness]],
[[reference_budget_grant_from_another_issue_fails_in_ci]],
[[feedback_measure_never_extrapolate]].

### DE-NOISE BOTH SIDES OR NEITHER — the noise is SIGNED

Same PR, and this is the load-bearing rule of the whole episode.

The regression column was de-noised to a verified 27-path core; the improvement
column was left as the gate's raw number (~20). That produced a plausible −7. Then
the **same** path-level treatment was applied to the improvements:

| run | `other`→pass (**genuine**) | `compile_timeout`→pass | `absent`→pass | gate's raw total |
|---|---:|---:|---:|---:|
| 1 | **0** | 21 | 2 | 23 |
| 2 | **0** | 21 | 2 | 23 |
| 3 | **0** | 19 | 2 | 21 |

**Not one improvement in any run was a genuine semantic flip.** Every one was a
baseline `compile_timeout`/`absent` row that merely *completed* in the candidate —
the exact load noise already excluded from the regression side, re-entering as a
**credit**.

Honest host-lane ledger: **27 real regressions vs 0 real improvements (−27)**, not
−7 and not the −67 headline.

> **The noise is signed.** Load inflates the improvement column and the regression
> column *simultaneously*. De-noising one side does not merely lose precision — it
> **biases the verdict in a predictable direction**, and always in favour of
> whichever side you cleaned. One-sided rigour is worse than none, because it
> looks like rigour.

**Rule: any net figure must have both columns given identical treatment**, and say
which treatment. Quote the method with the number or don't quote the number.

**CONFIRMED systemic, and it is a REGRESSION BLIND SPOT, not just a flattering
number.** Measured by holding the baseline **fixed** and varying the candidate
across all four #3871 runs (the control-PR route was unavailable — #3867's baseline
had already been overwritten by `promote-baseline`, so its diff is not
reproducible; this test is stronger anyway):

| run | baseline `compile_timeout` rows | of which **pass** in candidate | genuine `other`→pass |
|---|---:|---:|---:|
| 1 | 120 | 21 | **0** |
| 2 | 120 | 21 | **0** |
| 3 | 120 | 19 | **0** |
| 4 | 120 | 21 | **0** |

**19 are the identical paths in all four runs.** The promoted baseline carries ~120
`compile_timeout` rows, ~19–21 of which are **load-recorded artifacts for tests that
reliably pass** — collected as free "improvements" by *every* candidate regardless
of its diff.

> **The fine gate computes `improvements − regressions`. With ~20 phantom
> improvements in every diff, a PR carrying up to ~20 GENUINE regressions scores
> net ≥ 0 and passes.** The gate systematically **under-detects regressions by
> about twenty**. #3871 was caught only because it carried 27 — it exceeded the
> blind spot. A sibling defect of 15 real regressions merges silently.

Corollary: headline improvement figures are unearned by ~20 (#3867's `+47` was
really ~+28; still positive, verdict stands, but nobody should quote `+47`).

Second independent config/load-staleness defect in the **same** baseline as the
`skip`→`compile_error` artifact — so treat "this baseline has exactly one problem"
as false. See [[reference_baseline_content_current_hides_config_staleness]].

**Pass condition read from source (#3884 / PR #3875) — the blind spot is worse than
inferred, via TWO mechanisms:** the `Fail on regressions` step has two independent
hard-fail conditions, the **net gate** (`stableImprovements − regressionsWasmChange
< 0`) and the **ratio gate** — and a ratio breach is classified *by net*, so
**`net ≥ 0` downgrades it to a WARNING**. With ~20 phantom credits, `R ≤ 20`
regressions give `net ≥ 0`, which passes the net gate *and simultaneously disarms
the ratio gate* — the very check built to catch one-directional regression. Only the
per-bucket >50 concentration check survives, and `R ≤ 20` cannot trip it.

**Root cause in one line: the noise filter exists on ONE SIDE ONLY.** The regression
numerator filters `compile_timeout` (`noiseFiltered`, `r.to !== "compile_timeout"`);
the improvement numerator does not.

**Always read the literal pass condition from source before quoting a blind-spot
size** — inferring it understated this one.

**Observed in the wild on the very next run (#3871 run 5, the PASSING one).** Real
semantic ledger: **0 regressions, 0 improvements — net 0**. What the gate computed:
~21 phantom `compile_timeout` credits − 3 `absent` = **net ≈ +18**. The verdict was
correct and *the entire margin was phantom*. `compile_timeout` was **48**, the
highest of any run that night, and changed nothing — because timeouts are filtered
out of the regression numerator while their recoveries are counted into the
improvement numerator.

> A genuinely net-zero change passed with an apparent **+18 cushion**. That cushion
> is the blind spot, seen rather than argued for.

**So a green gate verdict tells you nothing about the size of the margin.** Never
read a positive net as headroom.

**Scope your lane.** The above is the **host** lane (the gate's own arithmetic,
"Host stable-path fine-gate net"). Standalone has its own baseline and needs its
own analysis; "no host improvement" is not "no improvement anywhere".

## A RECORD COUNT IS A CEILING. The yield discriminator is the OTHER lane.

**Never claim leverage from a record/citation count.** One shared compile-error
string blocking a family early produces a huge count with almost no recoverable
work behind it. The one-command check, run **before** the leverage claim:

> **Of the standalone rows carrying this signature, how many `pass` on HOST?**
> Only those have a first-party demonstration that the semantics are achievable.
> Rows that are host-`skip` or host-`fail` cannot be shown to flip — moving them
> from `compile_error` to `fail` is **not** a conformance gain.

Measured 2026-07-31, same harvest, and it separates real prizes from phantoms:

| slice | standalone rows | host=`pass` | verdict |
|---|---:|---:|---|
| generator family (`iterator_protocol`) | 1,907 | **1,094** | real |
| the `-dflt` sub-slice | 497 | **425** | real |
| `host_import` bucket | 1,656 | 539 | real |
| **#2046 Reflect receiver** | **1,484** | **2** | **phantom** |

#2046 was dispatched as "2nd-largest cited issue" and survives measurement at
**two** achievable rows — one of which is collateral from another feature.

**Three-for-three that session**: every large citation count checked this way
concealed a far smaller yield (#3877 ~51 ceiling, #3876 14/866, #2046 1,484→2).
The count answers *how many rows mention this*; it never answers *how many can
be made to pass*. Also note the corollary: this check is what **validated** the
generator dispatch, so it is a discriminator, not a debunking tool.
