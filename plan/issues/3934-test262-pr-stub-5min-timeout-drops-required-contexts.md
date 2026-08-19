---
id: 3934
title: "`test262 PR stub` times out at 5 min and silently strands the PR — the `cancelled` detect check makes it UNSTABLE, which auto-enqueue skips"
status: done
completed: 2026-08-01
assignee: ttraenkler/dev-ci-3934
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: s
feasibility: easy
task_type: ci
area: ci, merge-queue
goal: ci-hardening
related: [3878, 3908, 3880, 3584]
origin: "Cluster spotted by shepherd-2 across four PRs on 2026-07-31; mechanism pinned while unparking #3907. The logs name no cause because GitHub reports a job timeout as `cancelled`."
---

# #3934 — the test262 PR stub times out at 5 min, and silently strands the PR

## CORRECTION (2026-08-01) — the stranding mechanism is NOT the one below

**Everything in this issue about the timeout is right. The consequence is
wrong**, and the wrong version pointed the fix in the wrong direction. Read the
record, not the report — here is the record.

`check-runs` for PR #3919 at sha `76ec23dc` (the 5m01s timeout, run
`30645425429`), every entry:

```
cancelled  test262 PR stub — detect relevance
skipped    cheap gate (main-ancestor + lint)
skipped    check for test262 regressions
skipped    merge shard reports
skipped    equivalence-gate · equivalence-shard · linear-tests · promote-benchmarks
success    quality · cla-check · changes · CodeQL · Analyze (actions) · measure-and-gate
```

Two things follow, both contradicting the "## THE PART THAT MAKES THIS URGENT"
section below:

1. **The three required contexts were NOT missing.** They published as
   `skipped`. A job skipped by its `if:` DOES publish a check run, and a
   `skipped` required check **satisfies** branch protection. The claim that a
   skipped job publishes nothing came from the stub workflow's own header
   comment and was simply false — on `61d58e077c94` both producers published all
   three names (stub `skipped` in run `30677373432`, real `success` in run
   `30677373444`).
2. **What stranded the PR was `detect`'s OWN conclusion.** `detect` is a
   *non-required* check; a non-green non-required check drives
   `mergeStateStatus` to `UNSTABLE`; `scripts/enqueue-green-prs.mjs` has
   `ENQUEUEABLE = {CLEAN, HAS_HOOKS}` and deliberately excludes `UNSTABLE`. So
   the PR was green on the merits, blocked by nothing, and skipped by
   auto-enqueue forever — the same class as #3878 and #3904.

The practical difference: "the PR is waiting on contexts that never report"
suggests raising the budget so the contexts get produced. But the contexts were
always produced. **A bigger budget just makes the same silent `UNSTABLE`
rarer** — which is why the fix below is structural instead.

## The mechanism

`.github/workflows/test262-pr-stub.yml`:

```yaml
  detect:
    name: test262 PR stub — detect relevance
    timeout-minutes: 5
```

When the job exceeds that budget GitHub **kills it and reports the conclusion as
`cancelled`** — not `failure`, and not `timed_out` in the check-run surface. The job log
contains exactly one line of explanation:

```
##[error]The operation was canceled.
```

**That is why no log names a cause and why this reads as a concurrency cancellation.** It
is not one. It is the 5-minute budget being hit.

## THE PART THAT MAKES THIS URGENT — required contexts go MISSING, not red

This is the consequence that is not recorded anywhere else, and it is strictly worse than
a red check.

The stub is not cosmetic. For a PR with no test262-relevant changes it **supplies** the
required contexts as stub-passes:

| context | required? | supplied by |
| --- | --- | --- |
| `cheap gate (main-ancestor + lint)` | **yes** | `test262-pr-stub.yml` (stub-pass job) |
| `merge shard reports` | **yes** | `test262-pr-stub.yml` (stub-pass job) |
| `check for test262 regressions` | **yes** | `test262-pr-stub.yml` (stub-pass job) |

Those jobs are gated on `detect`'s output. When `detect` times out they never run, so the
required contexts are **absent** rather than non-green.

**A missing required context never resolves.** A red check can be re-run or fixed and the
PR moves; an absent one leaves the PR waiting on something that will never report, with
nothing in the UI naming what is missing. `auto-enqueue` also accepts only
`{CLEAN, HAS_HOOKS}`, so the PR is skipped indefinitely.

## The cluster

Four occurrences on four different PRs, all on 2026-07-31 — reported by `shepherd-2`,
who read the clustering of durations as "a hard timeout, not a slow fetch":

| PR | duration |
| --- | --- |
| #3904 | 4m55s |
| #3900 | 4m58s |
| #3901 | 5m0s |
| #3907 | 5m1s |

**Verified independently, with a caveat that matters for anyone re-checking this.** A
census of `check-runs` on 2026-07-31T16:5xZ reproduced **#3900 `cancelled` at 5m3s** and
**#3907 `cancelled` at 5m1s** (observed live before remediation), but showed #3901 and
#3904 as `success`.

**That is not a contradiction — it is the instrument.** Re-running a job **overwrites**
its check-run record, so a census taken *after* anyone has remediated under-counts the
cluster. Both PRs had been re-run by then. **Do not use a post-hoc `check-runs` census to
size this defect**; it can only ever show the occurrences nobody has fixed yet.

## It is a FLAKE, not a systematically slow job — the sharpest evidence

On #3907, commit `02d2b5d4`:

| run | duration | conclusion |
| --- | --- | --- |
| original | **5m1s** | `cancelled` (timeout) |
| re-run, **identical SHA** | **0m40s** | `success` |

Same commit, same tree, same fetch — 7.5× difference and opposite outcomes. Typical
duration across the sampled runs is **36s–50s**, so the timeout case is ~7–8× normal
rather than a gradual creep.

**Operational consequence:** a re-run is a valid remediation for an occurrence (it is
remediating a flake, not changing the change). It is not a fix.

## Likely cause — ref count

Measured 2026-07-31: `git ls-remote origin` returns **6,145 refs** (1,985 heads, 235 tags,
the remainder `refs/pull/*`). During the #3880 work a full-ref fetch was measured with a
**47.8 s connectivity check** on this repo.

A 5-minute budget for checkout-plus-path-match is tight against that ref count, and it
explains the flakiness: the job is normally ~40 s, but a fetch that has to walk every ref
can blow past 5 minutes when the runner or the connectivity check is slow.

**So the fix is plausibly both halves:**

1. **Raise the budget** — `timeout-minutes: 5` has no headroom over a known 47.8 s
   connectivity check plus checkout. This is the one-line mitigation.
2. **Narrow the fetch** — the `detect` job only needs the changed-path list. A shallow,
   single-ref, blob-filtered checkout (`fetch-depth`, `filter=blob:none`, and *not* a
   full-ref/full-tag fetch) removes the cost centre rather than budgeting around it.

Raising the budget alone leaves a job that occasionally takes minutes for a path match.

## Third arrival route into the #3878 / #3908 stranding class

The same end state — **a PR that is green on the merits and never enqueues** — has now
been reached three different ways:

| # | route | mechanism |
| --- | --- | --- |
| 1 | **#3878** | a helper (`release-pending`) wrong for every fork head ⇒ red non-required ⇒ `UNSTABLE` |
| 2 | **#3889** | a non-required check finishing *last* with no `workflow_run` trigger ⇒ `CLEAN` but unswept |
| 3 | **this** | a flaky timeout on a **context-supplying** check ⇒ required contexts **missing** |

Route 3 is the worst of the three, because the other two leave a signal — a red check, or
a `CLEAN` PR a sweep can pick up. This one leaves a PR whose required contexts simply
never arrive.

**#3908's protocol fix (stand down only on `CLEAN`, not on "required checks green") is
necessary and does not cover this.** It stops a dev *standing down* onto the stranding
condition; it does not stop the stranding. Both are needed.

## Acceptance

1. A test262-irrelevant PR reliably gets all three stub-supplied required contexts
   reported — no run of `detect` is `cancelled` by timeout across a sustained window.
2. `detect`'s normal duration stays in the tens of seconds, and the budget has clear
   headroom above the worst observed fetch.
3. If the fetch is narrowed, `detect` still produces the same relevance verdict — the
   `&test262-paths` allowlist mirroring must not regress, or the stub and the real
   `test262-sharded.yml` could both claim, or both drop, a required context.

## Notes

- **Do not "fix" this by making the stub jobs unconditional.** They must stay mutually
  exclusive with `test262-sharded.yml`'s real jobs — the header comment in
  `test262-pr-stub.yml` is explicit that the two workflows can never both own a required
  context on the same PR.
- The `concurrency` group (`test262-pr-stub-<pr>`, `cancel-in-progress: true`) is a
  *different* source of `cancelled` on this same job. When triaging, separate the two by
  **duration**: a concurrency cancel happens whenever a newer push lands; a timeout sits
  at ~5m00s. Both surface identically in the check-run conclusion.

## Resolution (2026-08-01)

Fixed in `.github/workflows/test262-pr-stub.yml` in two independent layers,
because "raise the budget" alone leaves the failure mode intact (see the
CORRECTION at the top).

**Layer 1 — the job can no longer be killed by ordinary slowness.**

- `fetch-depth: 0` → **`fetch-depth: 2`**. The old full-ref fetch pulled all
  6,145 refs (1,985 heads, 235 tags, the rest `refs/pull/*`; measured 47.8 s
  connectivity check) to answer a two-commit question. At depth 2 the merge ref
  carries both parents: `HEAD^1` = base tip, `HEAD^2` = PR head — **the same two
  commits** the old `git diff BASE_SHA HEAD_SHA` compared, so the relevance
  verdict is unchanged (acceptance #3). The step also verifies `HEAD^2` equals
  the event's head SHA and degrades if not, rather than diffing a pair it cannot
  vouch for.
- Every fallible step is individually bounded **and** `continue-on-error`, and
  the verdict step runs under `if: always()` and always exits 0. A slow checkout
  now fails a *step*, and the job still publishes a verdict and concludes
  `success`. The script drops `set -e` (which would have aborted before the
  `$GITHUB_OUTPUT` write) for `set -uo pipefail` plus explicit degrade paths.
- The job budget is 15 min — deliberately **unreachable**: the step budgets sum
  to 8. It is now a runner-hung backstop, not a work budget.

**Layer 2 — if the job dies anyway, it is loud.** New `stub-guard` job
(`test262 PR stub — verdict published`) fails with a named annotation stating
the consequence ("this PR is UNSTABLE and auto-enqueue takes only
CLEAN/HAS_HOOKS") and the one-line remediation (`gh run rerun <id> --failed`).
It is gated on `!cancelled()`, **not** `always()`, so it fires on a job-level
timeout (which cancels the JOB, not the run) and stays quiet on a concurrency
cancel (which cancels the RUN, and where the SHA is superseded anyway).
Evidence the two are distinguishable: in run `30645425429` the three downstream
jobs still had their `if:` evaluated after `detect` was killed, concluding
`skipped` with later timestamps — a cancelling run would have cancelled them.

A new `degraded` output distinguishes "measured" from "fell back to the
fail-safe". Degradation is safe (the contexts publish `skipped`, and the merge
queue re-validates on the merged state) so it warns rather than fails — but it
is recorded, so a repeated degrade cannot look like a normal run.

**Acceptance evidence.** `tests/issue-3934.test.ts` (41 assertions) is the
observable check, and each one was verified to FAIL when the property is broken
(mutation control: reverting `fetch-depth: 2` → `0` and `!cancelled()` →
`always()` fails exactly the two corresponding tests). It asserts:

- `detect` carries no `fetch-depth: 0`; the checkout step is bounded and
  `continue-on-error`; the verdict step is `if: always()`;
- **the sum of step budgets is strictly less than the job budget** — the
  invariant that makes a `cancelled` conclusion unreachable by slowness;
- `stub-guard` exists, depends on all four jobs, is gated on exactly
  `${{ !cancelled() }}`, and actually `exit 1`s while naming the remediation;
- the three stub job names still equal the context names `test262-sharded.yml`
  publishes (drift on either side would let both, or neither, own a context);
- **acceptance #3, the mirroring ratchet**: every pattern in the
  `&test262-paths` anchor is parsed out of `test262-sharded.yml` (count floored,
  so a silent parse failure cannot pass) and each must be `true` per
  `scripts/test262-paths-match.sh`, while a set of excluded paths must be
  `false` on *both* sides;
- the documented required-check list equals the six in the live ruleset.

This PR's own CI run is the live demonstration: its file set is path-excluded
per the matcher (asserted in the test), so it takes the stub's green arm and
exercises the rewritten `detect` end to end.

**Left open, deliberately** — whether a `skipped` run of a context name
satisfies branch protection while a *same-named* run is RED. Both producers do
publish the same three names on a src PR (measured above), so the question is
real, but nothing here depends on the answer and nobody has measured it. It
wants its own issue before anyone leans on either answer.
