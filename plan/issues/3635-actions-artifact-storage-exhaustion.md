---
id: 3635
title: "~985k Actions artifacts accumulated — storage exhaustion, likely cause of the artifact 403s"
status: done
sprint: 78
created: 2026-07-25
updated: 2026-08-18
completed: 2026-07-31
assignee: ttraenkler/dev-ci-3584
priority: high
horizon: s
feasibility: easy
# Infra/operations, not behavioural — the deliverable is a workflow retention
# setting plus a measurement write-up, and there is no compiler behaviour to
# pin with a repro. `task_type` was simply absent before, which made
# check-issue-spec-coverage (#2093) treat this as a gated behavioural issue and
# demand a probe that cannot meaningfully exist. `ci` is the accurate label
# (matches `area: ci` / `goal: ci-hardening`, and #3584/#3906 alongside it).
task_type: ci
area: ci
goal: ci-hardening
related: [3634, 2547, 2519, 3915]
---

# #3635 — ~985k Actions artifacts; storage exhaustion

> **RESOLVED 2026-07-31 — the premise did not survive measurement.** The count is
> real (now higher than reported), but it is **not a storage figure**, storage is
> **not** exhausted, the 403s are **not** recurring, and the retention fix this
> issue proposes was **already implemented**. **Do not run the bulk delete** — it
> would reclaim approximately zero bytes. Full measurement below; read it before
> re-opening.
>
> **⚠ ACTION REQUIRED ELSEWHERE — #3634 must NOT be treated as a symptom of this.**
> This issue asserted that #3634's six consecutive baseline-promote failures were
> knock-on damage from storage exhaustion, and therefore that #3634's
> retry/alerting was "treating a symptom". **That assertion is now falsified**
> (§4 below): storage is not exhausted, it has only *grown* since those failures,
> and the failures stopped anyway. **#3634 is an independent, unexplained bug and
> must be judged on its own merits.** This is called out here, at the top, on
> purpose: a wrongly *suppressed* issue is far harder to notice than a wrongly
> *filed* one — nothing re-surfaces it, because the reason it was parked is
> recorded as settled fact in an issue nobody re-reads.

## The original measurement

`GET repos/loopdive/js2/actions/artifacts` reports **`total_count = 984,897`**, with **0
expired** on the sampled page. The most recent 100 artifacts total **120 MB** (~1.2 MB
average).

**DO NOT QUOTE A TOTAL SIZE FROM THAT AVERAGE.** The sampled page is biased — those names
are small `issue-tests-partial-*` files at ~0 MB each, whereas the test262 report/group
artifacts are 15-30 MB. A naive scale gives ~1.2 TB but the true figure could be well
either side. Read the real number from **Settings → Billing → Actions/Packages storage**;
the REST billing endpoints need `admin:org` (the container token has only `gist, read:org,
repo, workflow`).

That warning was right to be there, and it was right in the direction it worried about:
the true figure is **~4.9 GB**, roughly **250× smaller** than the naive scale.

## Why this is the explanation for the "used up minutes" report

Public repos get **unlimited standard-runner minutes**, and this repo uses only standard
runners — verified: **61× `ubuntu-latest`, 2× `ubuntu-24.04`, zero larger-runner labels**.
All three relevant repos are public (`loopdive/js2`, `ttraenkler/js2`,
`loopdive/js2wasm-baselines`). So it was never minutes.

**Actions artifact STORAGE is billed and enforced regardless of repo visibility.**

## Why it accumulated

The sharded test262 matrix produces **114 jobs per merge_group run**, most uploading
artifacts, and the queue runs many times a day. With default 90-day retention and nothing
pruning, this compounds continuously.

---

# MEASURED 2026-07-31 — what is actually true

## 1. The count is real, and larger. It is also not a storage figure.

`total_count = 1,017,559` (up from 984,897 on 2026-07-25).

**But `total_count` counts metadata rows, including artifacts GitHub has already
expired and whose CONTENT is deleted.** An expired artifact keeps a row — with
`size_in_bytes` still populated, which is precisely how a naive sum manufactures a
fake terabyte — and occupies **zero storage**.

Binary search for the expired/live boundary (artifacts are ordered newest-first, so
expiry is a suffix):

| page | expired / sampled | oldest on page |
| --- | --- | --- |
| 1 | 0 / 100 | 2026-07-31 |
| 159 | 99 / 100 | 2026-07-29 |
| 288 | 98 / 100 | 2026-07-26 |
| 289 | **100 / 100** | 2026-07-26 |
| 636 | 100 / 100 | 2026-07-18 |
| 5088 | 100 / 100 | 2026-06-19 |

**Everything created before ~2026-07-26 is already expired — a ~5-day horizon, not 90.**

- **LIVE: ~8,800 artifacts (0.9 %)**
- **EXPIRED: ~1,008,000 (99.1 %)** — content already deleted, zero storage

## 2. Live storage is ~4.9 GB, not ~1.2 TB

Sampling 11 pages across the live region: mean live artifact **0.58 MB**, live fraction
in-region **30.5 %** ⇒ **~4.9 GB**.

Where it sits — and note the top entry is already at 1-day retention:

| live MB (sample) | retention | family |
| --- | --- | --- |
| 311.6 | 1 d | `github-pages` |
| 59.5 | **7 d** | `benchmark-candidate` |
| 40.7 | 1 d | `test262-merged-report` |
| 25.1 | 1 d | `test262-js-host-shard-*` (551 artifacts) |
| 24.6 | **14 d** | `landing-four-lane-pr` |
| 14.2 | 1 d | `test262-standalone-shard-*` |
| 12.5 | **14 d** | `porffor-direct-ab-sanitizers` |

## 3. Storage is NOT exhausted — uploads are working right now

At 14:42:23Z, the newest artifact was created at **14:41:52Z — 31 seconds earlier**.
Uploads succeed. A quota-exhausted repo cannot upload.

## 4. The 403s are NOT recurring

14 of the last 15 `test262-sharded` runs are `success` (the 15th `cancelled`, none
failed), **including every `merge_group` run** — the ones that download and upload
artifacts heavily. Whatever caused the 2026-07-24/25 403s, it is not happening now, and
the suspected causal link to storage is unsupported: storage has only grown since.

## 5. The proposed fix was ALREADY IMPLEMENTED

> 1. **Set a short artifact retention** … 2. Add explicit **`retention-days:`** to the
> heavy upload steps in `test262-sharded.yml`

**26 of 27 `upload-artifact` steps already declare `retention-days`**, and
`test262-sharded.yml` — the 114-per-run matrix this issue blames — has all 7 uploads at
**1–3 days**. That is why the observed expiry horizon is ~5 days rather than 90. The
repo default is still 90, but it is only a *ceiling*; the per-upload value wins.

**The one real gap:** `vacuity-canary.yml:89` was the single upload with no
`retention-days`, inheriting the 90-day default — on a *scheduled* workflow, the shape
that accumulates. Now set to 7.

**Honest sizing of that gap: it leaks nothing today.** `vacuity-canary.yml` has run
**once** (2026-07-27) and produced **zero** `vacuity-*` artifacts. Closing it is hygiene
against a future leak, not a storage win. Stating otherwise would repeat this issue's
original error at smaller scale.

## 6. DO NOT run the bulk delete

> 3. **Bulk-delete the backlog** (`DELETE …/artifacts/{id}`) — needs care and
> rate-limiting at ~985k objects.

**This would reclaim ~0 bytes.** 99.1 % of those objects are already expired; deleting
them removes a metadata row whose content GitHub has already reclaimed. The cost is
~1M authenticated DELETEs against a rate-limited API, on a destructive, outward-facing
operation, for no storage benefit.

If the ~1M metadata rows ever need trimming it is an **API/UI ergonomics** concern
(pagination depth), not storage, and it should be argued on those terms.

## What was actually done

1. `vacuity-canary.yml` — added `retention-days: 7`, closing the last policy gap.
2. This write-up, so the destructive step is not run on a premise that has been falsified.

## Recommended, NOT done here (needs org admin, and is a settings change)

**Lower the repo-level default from 90 days** (Settings → Actions → Artifact and log
retention; `maximum_allowed_days: 90`). Every upload already overrides it, so this
changes nothing today — its value is that the *next* upload someone forgets to annotate
fails safe. A repo setting is not a code change and is outside a dev's remit; flagged
for the maintainer.

## Still unverified from here

The **actual billing/storage figure**. `orgs/loopdive/settings/billing/shared-storage`
now returns **410 "endpoint has been moved"** *and* requires `admin:org`, which this
token lacks. The ~4.9 GB above is a measurement of live artifacts on this repo, not a
reading of the bill, and the org has 41 other private repos sharing the account quota.
If a bill needs quoting, read Settings → Billing.

## Ruled out (probably) but worth confirming

The org has **41 private repos** sharing the account quota. Nearly all are dormant (last
pushed 2020-2025); the only recent ones are `company-website` (2026-05-20),
`html-device-mockup` (2026-02-25), `cloudflare-worker-openai` (2025-07-26). Private-repo
Actions **do** consume minutes, so glance at their recent run activity before concluding
this is entirely artifacts.

## #3634 — un-suppressed. Judge it on its own merits.

The original text above says, of #3634's six consecutive baseline-promote failures:

> If storage exhaustion is the cause, those are **not independent bugs** and #3634's
> retry/alerting is treating a symptom.

**The antecedent is false, so the conclusion does not hold.** Three independent
measurements each defeat it:

1. **Storage is not exhausted** — an artifact uploaded 31 s before the check (§3).
2. **Storage has only grown since** those failures — 984,897 → 1,017,559 rows, and the
   live set is bounded by ~5-day retention, so conditions today are no *better* than
   on 2026-07-24/25.
3. **The failures stopped anyway**, with no storage reclaimed by anyone.

If exhaustion had caused them, (2) says they should have got worse, not stopped. So
**#3634 describes a real, still-unexplained bug**, and its retry/alerting is not
"treating a symptom" — there is no established underlying cause for it to be a symptom
*of*.

**Why this warrants its own section rather than a footnote:** the failure mode of a
wrong suppression is silence. A wrongly-filed issue gets closed by the next person who
reads it; a wrongly-suppressed one is never re-read, because the reason it was parked
sits in a *different* issue that now reads as settled. #3635 was that different issue.
