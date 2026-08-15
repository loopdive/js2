---
id: 3914
title: "CI throughput: why speculative batching failed, and making per-run PR batching safe"
status: in-progress
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, merge-queue
goal: dev-velocity
sprint: current
related: [1956, 2519, 2522, 2674, 3431, 3438, 3448, 3456, 3470]
created: 2026-07-31
---

# #3914 — CI throughput: the batching post-mortem, and what to do instead

## TL;DR

Speculative batching (`max_entries_to_build > 1`) did not fail because of a bug.
It failed because **it is arithmetically incapable of helping a runner-saturated
queue**, and every attempt to run it anyway produced oversubscription and
cancellation churn. Three of its four historical failure modes have since been
fixed; the fourth — the runner-capacity one — is _structural_ and has gotten
**worse**, not better, because the shard matrix was deliberately resized upward
(53 → 106 jobs) to exploit a serial queue.

The form of batching that _does_ pay here is many PRs in **one** group, validated
by **one** 102-job run — amortising the fixed per-run overhead instead of
competing for runners. Because the queue is already serial, arrivals accumulate
while a group is in flight **for free**, and batching them costs those PRs no
latency: they were waiting for that run anyway. The policy is therefore "take
what accumulated", and the setting that matters is the **cap**
(`max_entries_to_merge ≈ 4`) — the throughput curve is a bowl that turns back up,
so unbounded accumulation is worse than a small batch.

**Measured**: 0 of 26 successful groups on 2026-07-31 held more than one PR —
while the **median PR waited 23.6 min** in the queue for a 13.3 min run, and
**13 of 20 groups had another PR already waiting when they were dispatched**.
The queue is backed up most of the day and still validates one PR at a time.
Whether the binding constraint is the floor (`min_entries_to_merge: 1` forming
eagerly) or the cap (`max_entries_to_merge` effectively 1) cannot be determined
from here, so the rollout tests the **cap first** — that path costs no latency at
all. This is a repo-ruleset change, not a code change, and its one real objection
(intra-group masking) is narrower than the policy doc claimed.

Auditing for that turned up **three places that silently assume one PR per
group** — the #1956 predecessor-baseline lookup, `auto-park`, and the #2975
park-race guard. Each degrades into a queue pathology under batching rather than
failing loudly. All three are fixed here, and all three are verified no-ops at
batch size 1. After that the only remaining step is a repo-ruleset flip.

Independently of any queue-config change, this issue also lands three measured
wall-clock wins on the merge_group critical path (≈ **−130 s / −17 %** per
src-touching run).

---

## Part 1 — Why batching failed

"Batching" in this repo has meant `max_entries_to_build: 5`: the queue builds up
to five _speculative_ groups concurrently (`main+A`, `main+A+B`, …), each with its
own full CI run. It was enabled by #1956 and turned off during the 2026-06-20
merge-queue wedge (#2519 / #2522). Four distinct things went wrong.

### 1. ALLGREEN masking — the _attribution_ failure (FIXED by #1956)

The regression gate diffed each group against the **main** baseline. In a
multi-entry window the group for B contains A+B, so A's +5 improvement cancels
B's −3 regression and the gate sees net +2. #1956 fixed this: every `merge_group`
run publishes its merged JSONLs keyed by the group head SHA, and the next group
diffs against its **exact predecessor group**. Per-PR attribution is restored.
**This one is genuinely solved** — though its implementation resolved the
predecessor as `HEAD^1`, which is the predecessor **group** only for a
single-entry group; see P1 in Part 2.

### 2. Runner oversubscription — the _structural_ failure (NOT fixed; worse)

This is the real cause of death, and it is pure arithmetic.

- 5 speculative groups × 114 jobs = **570 jobs** against a **~120-runner** pool
  = 4.75× oversubscription.
- Measured consequence (#3431, runs 29631214965 / 29632953272): an _uncontended_
  114-job run finished in 15–19 min; a _contended_ one took **38.5 min**, with
  job starts trickling over ~20 minutes, and 60+ min during queue waves.

The mechanism is worse than "everything is slower". The **head** group is the
only one whose result can actually merge. Its descendants — whose work is
discarded the moment anything upstream changes — compete with it for runners on
equal terms. Speculation therefore **starves the one run that matters** in order
to pre-compute results that are usually thrown away. Throughput went _down_.

**Why this cannot be fixed by tuning:** under a fixed runner pool `R`, if one
group already saturates the fleet (`J = R` shards, wall `W`), then splitting the
fleet `k` ways gives each group `R/k` shards, so each shard does `k×` the work and
each group's wall grows to ≈ `k·W_shard + overhead`. The `k` groups finish
"concurrently" but each took `k×` longer:

```
serial throughput   = 1 / (W_shard + overhead)
k-deep speculation  = k / (k·W_shard + overhead) = 1 / (W_shard + overhead/k)
```

Speculation's **entire** win is amortising the _fixed_ overhead — nothing else.
Here that fixed overhead is ~170 s (41 s pre-shard prefix + 39 s per-job setup +
90 s post-shard tail) out of a 799 s run: a ceiling of **~1.25×** even at
infinite depth, before paying any of the costs below.

And the situation is now _less_ favourable than in 2026-06, not more: #3431/#3470
deliberately grew the `merge_group` matrix from 53 → 106 jobs **precisely
because** the queue is serial and a lone group should use the whole fleet. Re-enabling
5-deep speculation today would mean 530 jobs on 120 runners.

### 3. Cancellation churn — the _amplifier_ (mitigated, hazard remains)

Any enqueue, dequeue, or ejection invalidates **all descendant** speculative
groups and restarts their full matrices. Three separate high-frequency actors
were poking the queue: the undebounced `auto-enqueue` sweep (#1758, #2560), the
`queue-unstick` cron's dequeue+re-enqueue loop (#3456), and manual re-enqueues.
Each re-add rebuilds the group and **cancels the in-flight `merge_group` run**
(memory `project_merge_queue_requeue_cancels_run`). Churn rate exceeded
completion rate; the queue could not make forward progress.

Mitigations landed: `auto-enqueue` debounced to latest-wins (#2519 part 1),
`queue-unstick.yml` deleted outright (#3456, Option A), agents forbidden from
self-enqueuing (#2548/#2786). But the _structural_ hazard is untouched — with
`k`-deep speculation and a per-PR failure rate `e`, a head ejection discards all
`k−1` descendants' work. Today's observed `e` is ~10 % (3 failing merge_group
runs out of 30 on 2026-07-31), so ~10 % of all speculative work is dead on
arrival.

### 4. Cross-PR interaction false positives — the _diagnostic tax_ (#2674)

A batched speculative tree merged #2075 and #2063 into one SHA (`562d2cde`) and
reported a net −2 regression. Neither PR reproduced it alone — on clean main, on
#2075-on-main, or on the exact merge tree. The real cause was a #2043
late-import-index-shift collision that only appears when two import-adding PRs
combine.

Honest reading: this is batching **working** — it found a genuine latent bug that
serial validation would have missed. But the cost was hours of triage on a PR
that was individually correct, and the failure surfaces on a synthetic tree that
no developer can check out and reproduce against. Any batching scheme must budget
for this class, and must make the batch trivially splittable when it hits.

### Summary table

| #   | failure mode                                 | status today                                        | blocks re-enabling? |
| --- | -------------------------------------------- | --------------------------------------------------- | ------------------- |
| 1   | ALLGREEN masking (attribution)               | **fixed** (#1956 predecessor-group diff)            | no                  |
| 2   | runner oversubscription                      | **worse** (matrix grew 53 → 106 for a serial queue) | **yes — fatal**     |
| 3   | cancellation churn                           | mitigated (#2519, #3456, #2786); hazard structural  | yes, at depth       |
| 4   | cross-PR interaction false positives (#2674) | unchanged                                           | tax, not a blocker  |

**Verdict: do not re-enable `max_entries_to_build > 1`.** It was not a
mis-configuration and it does not deserve another attempt at these fleet sizes.

---

## Part 2 — The batching that would actually pay

The queue exposes a second knob that is not speculation:
**`min_entries_to_merge`** — how many PRs go into **one** group. One group means
**one** 102-job run for N PRs. Runner pressure is unchanged; the fixed overhead
is divided by N. That is the amortisation speculation was reaching for, without
the contention that killed it.

### The right policy is "take everything that accumulated", with a cap

The natural formulation is not a fixed N at all: **while a group is in flight the
queue is serial, so arrivals pile up for free — the next group should simply take
everything that accumulated.** That is self-tuning (batch size tracks the arrival
rate) and, critically, it is **latency-free**: a PR that arrives mid-run was
going to wait for that run to finish regardless, so batching it costs it nothing.
A fixed `min_entries_to_merge: N` with a wait timer can add latency on a quiet
queue; accumulate-while-busy cannot.

**But it must be capped, and the cap is the load-bearing number.** With per-PR
merge_group failure rate `e`, a batch of N is all-green with probability
`(1−e)^N`; a red batch costs one wasted run plus serial re-validation. Expected
run-time per merged PR, in units of one run `W`:

| N   | e=0.05     | e=0.10     | e=0.15     |
| --- | ---------- | ---------- | ---------- |
| 1   | 1.050W     | 1.100W     | 1.150W     |
| 2   | 0.598W     | 0.690W     | 0.778W     |
| 3   | 0.476W     | 0.604W     | **0.719W** |
| 4   | 0.435W     | **0.594W** | 0.728W     |
| 5   | **0.426W** | 0.610W     | 0.756W     |
| 8   | 0.462W     | 0.695W     | 0.853W     |
| 12  | 0.543W     | 0.801W     | 0.941W     |

The curve is a shallow bowl that **turns back up**: unbounded accumulation is
actively worse than a small batch, because batch failure probability compounds
faster than the overhead amortises. At the observed `e ≈ 0.05–0.10` (2 distinct
PRs failed merge_group re-validation on 2026-07-31) the optimum is **N ≈ 4–5**,
worth **~1.85×**, and by N=12 you are back near the N=2 result. Hence
`max_entries_to_merge: 4` — not "as many as possible".

Batching also helps _disproportionately_ here because doc-only groups cost 2 min,
not 13 — and roughly half of 2026-07-31's 28 merges were doc-only. A doc PR
batched with a src PR is free.

### Measured: group formation is EAGER — it takes 1 even when more are waiting

Checked against every successful merge_group run of 2026-07-31 by counting
`Merge pull request #N` commits in each group's `base..head` range:

**0 of 26 groups contained more than one PR.**

That is not because the queue was never backed up — it was backed up **most of
the day**. A group's head commit is created when the entry is prepared, well
before its run is dispatched, so `run_start − commit_date` measures how long that
PR sat in the queue:

| enqueued | dispatched | waited     | PR    |
| -------- | ---------- | ---------- | ----- |
| 10:42:56 | 11:14:04   | 31.1 min   | #3884 |
| 11:24:56 | 11:51:12   | 26.3 min   | #3889 |
| 11:28:42 | 12:15:03   | 46.4 min   | #3887 |
| 11:35:52 | 12:28:21   | **52.5** m | #3890 |
| 11:54:27 | 12:33:44   | 39.3 min   | #3891 |
| 12:18:21 | 12:59:04   | 40.7 min   | #3892 |
| 12:49:50 | 13:33:18   | 43.5 min   | #3895 |

Across 20 resolvable groups: **median queue wait 23.6 min** against a 13.3 min
run — PRs spend longer waiting than being validated — and 12/20 waited >10 min.

The decisive statistic: **13 of 20 groups had at least one _other_ PR already
waiting at the moment they were dispatched** (median 1, max 3). Every one of
those still went out as a size-1 group. Between 11:28 and 12:28, four PRs
(#3887, #3890, #3891, #3893) were all queued simultaneously and each got its own
full run — ~52 min of validation that one group would have done in ~13.

So the queue **already accumulates**; the group simply refuses to take more than
one PR off the pile.

**Which knob is binding — settle this before touching `min`.** Two hypotheses fit
the data equally well, and they imply different fixes:

- **(a) eager-with-minimum**: a group takes exactly `min_entries_to_merge`
  entries. Then `min: 1` can never batch, and the floor must be raised.
- **(b) the cap is already 1**: a group takes `min(available, max_entries_to_merge)`
  and the live `max_entries_to_merge` is effectively 1. Then raising the **cap**
  is sufficient and `min` should stay at 1.

The live ruleset is not readable from the repo (merge-queue settings are not in
`scripts/enable-branch-protection.sh`, and `docs/ci-policy.md`'s record of them
was stale — it had `max_entries_to_build: 5` long after the wedge reverted it),
so this cannot be resolved from here.

**Test (b) first, because it is free.** Raise `max_entries_to_merge` to 4 and
leave `min_entries_to_merge: 1`. Given 13/20 dispatches had a peer waiting, one
backed-up afternoon is a decisive sample. If groups start containing 2+ PRs, the
work is done at **zero latency cost** — nothing ever waits for a quorum. Only if
groups stay size-1 is (a) confirmed, and only then raise `min` to 2.

### The one real objection, and why it is narrower than the policy doc says

`docs/ci-policy.md:113` states: _"`min_entries_to_merge` stays 1 — single
multi-PR groups would collapse per-PR runs and reintroduce intra-group masking."_

That is correct but over-broad. Intra-group masking applies **only** to the
test262 _delta_ gate. It does not apply to:

- `quality`, `cheap gate`, `linear-tests`, `equivalence-*` — pass/fail, not
  deltas; a batch that breaks any of them fails, period;
- the catastrophic guard (#1668) and the standalone floor (#1897/#2097) —
  **absolute** thresholds, immune to intra-group cancellation.

And for the delta gate itself, masking is an artefact of comparing **aggregate
counts**. The merged JSONL is per-test: a group of A+B that regresses 3 tests
still names those 3 test ids in the predecessor diff. What batching costs is
**attribution** (which of A or B did it), not **detection**.

So the design is _optimistic batching with split-on-failure_: batch merges when
green; on a red group, fall back to serial re-validation to attribute. Cost of a
red batch = one wasted 13-min run, which is exactly the `e`-weighted term already
priced into the table above.

### Three code prerequisites — all silent, all landed here

Auditing the pipeline for multi-entry-group safety turned up **three places that
silently assume one PR per group**. None of them fails loudly under batching;
each one degrades into a queue pathology. All three are fixed in this issue, and
because a serial queue produces single-member groups, **every fix is a verified
no-op today**.

The shared root cause is the queue ref, `gh-readonly-queue/main/pr-<N>-<sha>`.
Two facts about it were mis-recorded in the codebase:

- the trailing SHA is the group's **base**, not its head (verified: run
  30631849709 had ref `pr-3892-a19c4abe…` while its own `head_sha` was
  `4aa1162c…`, and `a19c4abe` was the main tip). A comment in
  `auto-park-merge-group-failure.mjs` called it `<headSha>`;
- `pr-<N>` names only the **last** entry in the group, not the only one.

Together those give the fix: parse the base SHA out of the ref, compare
`base…head`, and read every member PR off the commit subjects.

| #   | site                                                                 | assumption                                 | consequence under batching                                                                                                                                                                                                                                                                                                                | fix                                                                                                                         |
| --- | -------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P1  | `test262-sharded.yml` → "Resolve predecessor-group baseline (#1956)" | `HEAD^1` is the predecessor **group** head | For a 3-PR group `HEAD^1` is the _second PR's merge commit inside the same group_ — which never published a `test262-group-<sha>` artifact, since only the group head does. The lookup misses **every time** and silently drops to the latest-main baseline: exactly the cross-PR drift path (a)-resolution exists to prevent.            | use `github.event.merge_group.base_sha` (== `HEAD^1` for a 1-entry group), `HEAD^1` retained as fallback                    |
| P2  | `auto-park-merge-group-failure.mjs`                                  | the ref-named PR is the whole group        | On a red batch, only the **last** PR is parked. The actual regressor — any other member — stays un-held, `auto-enqueue` re-adds it, and it burns a full merge_group run every lap. That is precisely the forever-cycle #2547 was built to break, reintroduced through the batch. Meanwhile an innocent group-mate sits held in its place. | park **every** member; the comment names the co-members and says to re-enqueue singly to attribute                          |
| P3  | `enqueue-green-prs.mjs` → #2975 park-race guard                      | ditto                                      | The guard suppresses re-enqueue of PRs with a recent genuine merge_group failure. Under batching it only recognises 1 of N, so the other N−1 look un-failed and get re-added straight into the ~5–16 s park race — the guard's own failure mode, multiplied by batch size.                                                                | map the failure onto every member; compare call only fires for already-confirmed-failed runs, fail-safe to the ref-named PR |

P2 and P3 share the parsing helpers (`baseShaFrom…QueueBranch`,
`prNumbersFrom…Subjects`), both pure and unit-covered — `--self-check` in
auto-park, `tests/issue-2975-park-race-guard.test.ts` for the sweep. Both
recognise the squash-commit subject shape as well as the merge-commit one, so
they will not silently under-park if the repo's merge method ever changes.

Every live path is fail-safe **towards today's behaviour**: a compare-API error
returns `[refNamedPr]`, so the worst case is the pre-#3914 outcome, never worse.

### Remaining step: the ruleset — now scripted (`scripts/set-merge-queue-config.sh`)

The merge-queue settings are **not** in `scripts/enable-branch-protection.sh`
(it manages required checks and reviewers only, and deliberately *preserves*
whatever merge-queue parameters it finds live). They lived solely in
Settings → Rules → Rulesets, which is why this issue could not even determine
which knob was binding.

**That gap is now closed.** `scripts/set-merge-queue-config.sh` reads and writes
exactly the merge-queue slice of the ruleset, preserving everything else:

```bash
./scripts/set-merge-queue-config.sh --show    # read live params (was impossible before)
./scripts/set-merge-queue-config.sh --check   # diff live vs canonical
./scripts/set-merge-queue-config.sh           # apply (needs repo-admin gh)
```

Canonical values are the script's defaults: `max_entries_to_merge: 5`,
`min_entries_to_merge: 1`, `max_entries_to_build: 1`. The cap is 5 per the
project lead; the model above puts 4 and 5 within noise of each other
(N=5 wins at e=0.05, N=4 at e=0.10) and both ≈1.85× serial — what matters is
that the curve is a bowl, so 5 is a **cap to hold**, not a floor to raise.
The script hard-refuses `max_entries_to_build > 1` without
`--allow-speculative-build`, with the Part 1 arithmetic in the refusal message,
so the reverted setting cannot be re-enabled by accident a third time.
Covered by `tests/issue-3914-merge-queue-config.test.ts`, which runs the script
against a stubbed `gh` and pins both invariants: unrelated ruleset fields
(required checks, bypass actors, conditions) survive the replace-style PUT
verbatim, and speculation is refused.

Applying it still needs an admin-scoped `gh`; the values themselves are now a
reviewed artifact rather than a click. Original step list, unchanged:

**Step 1 — raise the cap only. This is the free experiment; do it first.**

```
max_entries_to_build: 1          # unchanged — see Part 1, do NOT raise this
min_entries_to_merge: 1          # UNCHANGED for now — see below
max_entries_to_merge: 4          # THE CAP — bigger is worse, see the bowl above
```

Then watch one backed-up window (13/20 dispatches had a peer waiting, so an
afternoon is decisive). If groups start containing 2+ PRs, **stop here** — you
have batching at zero latency cost, because nothing ever waits for a quorum.

**Step 2 — only if Step 1 leaves groups at size 1** (i.e. formation is
eager-with-minimum, hypothesis (a)):

```
min_entries_to_merge: 2
min_entries_to_merge_wait_minutes: 2     # keep SHORT — see the tax below
```

Raising `min` is **not free**, which is why it is second and not first: a group
now waits for a quorum, so a genuinely solo PR pays up to the wait timer. Sizing
that tax from the same data — 7 of 20 dispatches had **no** peer waiting, and
those PRs waited only 0.3–6.5 min — so roughly a third of the time the queue is
genuinely idle and would eat the timer as pure added latency. The other ~two
thirds it costs nothing, because the queue is serial: while a run is in flight
the next group could not start anyway, so the wait overlaps work already
happening. Hence **2 minutes, not 5** — bound the idle-case tax, since the
busy-case benefit does not need a long timer to materialise.

`max_entries_to_merge` remains the setting that bounds the downside: the serial
queue accumulates arrivals for free, and this decides how many a group swallows.
4 is the optimum at the observed failure rate; much higher hands the gain back to
compounding batch-failure probability.

Pre-conditions, all now satisfied:

1. ✅ The delta gate reports **per-test** regressions (#1956 predecessor diff +
   bucket-by-path), so a red batch is diagnosable even without attribution.
2. ✅ The absolute guards (#1668, #1897, #2097) run on the merge_group path via
   `merge shard reports` — immune to intra-group masking by construction.
3. ✅ P1/P2/P3 above.
4. ✅ `docs/ci-policy.md` §3 corrected — it both forbade this _and_ recorded
   `max_entries_to_build: 5`, which has not been the live ruleset since the
   2026-06-20 wedge.

Roll out at `min_entries_to_merge: 2`, watch the red-batch rate for a day, then
go to 3. Rollback is setting it back to 1 — no code revert needed, since every
code change here is a no-op at batch size 1.

---

## Part 3 — Measured critical path, and the three wins landed here

Ground truth: merge_group run **30631849709** (PR #3892, 2026-07-31, 799 s /
13.3 min, 114 jobs). Per-job and per-step timings pulled from the Actions API.

| phase                                                   | t (s)        | cost                      | note                                                     |
| ------------------------------------------------------- | ------------ | ------------------------- | -------------------------------------------------------- |
| `detect test262-relevant changes`                       | 0 → 41       | **41 s**                  | 33 s of it is a `fetch-depth: 0` checkout                |
| shard jobs start                                        | 44 → 52      | —                         | …for 101 of 106                                          |
| **starved shard starts**                                | 90 → **184** | **~89 s**                 | 5 jobs; the last-finishing job of the run is one of them |
| per-shard fixed overhead                                | —            | 39 s                      | setup + checkout + install + bundle + upload (median)    |
| `Run shard`, js-host (72)                               | —            | mean 408 s, max 468 s     | 29,353 runner-s total                                    |
| `Run shard`, standalone (34)                            | —            | mean 471 s, max **542 s** | 16,000 runner-s total — **long pole**                    |
| last shard ends                                         | → 709        |                           | standalone 2/34: started t+134, ran 575 s                |
| `merge shard reports` ∥ `check for test262 regressions` | 712 → 798    | **90 s**                  | tail                                                     |

Two defects fall straight out:

### Win A — the lane split is stale (again)

The 72/34 matrix was scaled from a **2.13:1** host:standalone work ratio measured
at run 29807524490. The measured ratio is now **1.835:1**. At 72/34 the lanes are
inverted and standalone is the long pole by ~74 s.

Fixed: **66 / 36** (= 1.833). Both lanes land on ~444 s mean shard work, ~510 s at
the observed per-lane max/mean skew — within ~2 s of each other.

> This constant has now drifted **twice**. `gen-test262-mg-matrix.mjs` gains a
> "re-deriving this" note making it a recurring check rather than a constant.

### Win B — the matrix is 4 jobs over the ceiling, and pays ~89 s for them

Concurrent demand at t+45 s is 106 shards + 13 `ci.yml` merge_group jobs
(`changes`, `quality`, `cancel-test262-on-quality-failure`, `linear-tests`,
`equivalence-shard` ×8, `equivalence-gate`) + this workflow's `cheap gate` and
`changes` ≈ **121** — just over 120. The 14-runner reserve bought 4 extra shards
and paid ~89 s of start skew on the critical path for them.

Fixed: reserve **18** → **102** shards.

### Win C — 33 s of full-history checkout as a serial prefix

Every shard `needs:` the `changes` job, so nothing starts until it finishes. It
spent 33 s of its 38 s on `fetch-depth: 0` — solely to run one
`git diff base head`. That is a two-dot **tree** comparison and needs no merge
base, so depth-1 objects for the two SHAs suffice (a shard's own default-depth
checkout is 9–10 s).

Fixed: `fetch-depth: 1` + explicit `--depth=1` fetch of both SHAs, with an
`--unshallow` retry **before** the fail-safe — so the answer is identical to the
old behaviour and full history is only paid for when the cheap path fails.

### Combined expected effect

```
critical path  = 41 (prefix) + 4 + 134 (starved start) + 575 (longest shard) + 90 (tail)  = 799 s
               →  17 (prefix) + 4 +  45 (no starvation) + ~511 (rebalanced)  + 90 (tail)  ≈ 667 s
```

≈ **−132 s / −17 %** on every src-touching merge_group run. Under a serial queue
that converts directly into queue throughput.

---

## Acceptance criteria

- [x] `JS_HOST_CHUNKS` / `STANDALONE_CHUNKS` re-derived from a completed
      merge_group run; both lanes' projected max within ~1 min of each other.
- [x] `MERGE_GROUP_RESERVED_RUNNERS` raised to cover measured concurrent demand;
      no shard job should start >60 s after the first.
- [x] `changes` job no longer does a full-history checkout on the critical path,
      with a deepen-and-retry fallback so the emitted `run_shards` answer is
      unchanged in every case.
- [x] `tests/issue-3431-mg-matrix.test.ts` updated to the new constants and
      asserting lane-ratio consistency rather than a frozen number.
- [x] Batching post-mortem written down with the arithmetic, so
      `max_entries_to_build > 1` is not attempted a third time without new
      runner capacity.
- [x] Every pipeline site that assumes one PR per merge group identified and
      fixed (P1 predecessor baseline, P2 auto-park, P3 park-race guard), each a
      verified no-op at batch size 1 and fail-safe towards today's behaviour.
- [x] Queue config is readable and appliable from the repo —
      `scripts/set-merge-queue-config.sh` (`--show` / `--check` / apply), with
      the speculation guard and `tests/issue-3914-merge-queue-config.test.ts`.
      `docs/ci-policy.md` §3 records the canonical values, why the two knobs
      differ, and why a tail append never ejects a running group.
- [x] **Follow-up — DONE, with a negative result (see "Step 1+2 result"
      below):** Step 1 (cap 5) applied, groups stayed size 1; Step 2 (floor 2,
      5-min timer) applied 2026-08-14T18:16Z, groups **still** stayed size 1
      (29/29 on 2026-08-15). Root cause: GitHub merge limits do not combine
      `merge_group` builds at all — the premise of Part 2 was wrong.
- [ ] **Revert the floor to 1** (`MIN_ENTRIES_TO_MERGE=1
      ./scripts/set-merge-queue-config.sh`, needs repo-admin `gh`/PAT — the
      script's default is 1 again, so a bare run applies it). The floor-2
      config batches nothing and taxes quiet-queue docs-only merges with up
      to ~3 min of wait-timer latency.
- [ ] **Verify after merge:** on the first post-merge `merge_group` run, confirm
      (a) max shard start < 60 s, (b) both lanes' max job within ~1 min,
      (c) `changes` job < 20 s, (d) total run wall ≈ 11 min.

## Step 1+2 result (2026-08-15) — the floor is a no-op; Part 2's premise was wrong

Step 2 went live 2026-08-14T18:16Z (ruleset 16700772: `min_entries_to_merge: 2`,
`min_entries_to_merge_wait_minutes: 5`, cap 5, build 1, HEADGREEN). Measured the
next day, 03:23–13:34Z: **29/29 successful `merge_group` runs carried exactly
one PR** (counted as merge commits in each queue ref's `base..head`), one full
shard-matrix run each, PRs merging one at a time ~15 min apart. Decisive
counterexample: entries for #4557/#4558/#4559 were all stacked in the queue by
12:44Z (their queue merge commits are dated 12:39:40/12:44:21/12:44:42Z) and
still consumed three separate full runs, merging at 13:18/13:34/13:49Z.

Why, in two layers:

1. **The wait timer can never survive a busy queue.** It counts from queue
   entry, and GitHub's documented behavior is that after it elapses the queue
   "stop[s] waiting for more entries and merge[s] with fewer than the minimum".
   The head's queue wait under load is ≥ one ~15-min run, so a 5-min timer is
   always expired by merge-decision time and the floor is permanently waived.
2. **The deeper one: GitHub merge limits do not combine `merge_group` builds —
   period.** Every queued PR always gets its own temporary branch and its own
   full CI run; `min`/`max_entries_to_merge` only group the final fast-forward
   of entries that have each already passed their own run (GitHub community
   discussion #58523 confirms; today's runs demonstrate). "N PRs validated by
   one 102-job run" — the whole Part 2 design goal — **does not exist as a mode
   of GitHub's native merge queue.** Even with a timer long enough to bind, a
   ≥2 merge needs ≥2 simultaneously-green entries, which `max_entries_to_build:
   1` precludes: the next entry's run is dispatched ~2 s *after* the head
   merges (observed on every pair today).

Consequences:

- Floor reverted to 1 (it batches nothing and adds up to timer-minutes of
  latency to quiet-queue docs-only merges, which go green inside the timer).
  Cap 5 / build 1 unchanged. `docs/ci-policy.md` §3 and
  `set-merge-queue-config.sh` corrected — the script's refusal message itself
  repeated the "one group, one run" claim.
- The P1/P2/P3 multi-member-group hardening stays: multi-PR groups can still
  occur as merged *prefixes* (e.g. if speculation were ever re-enabled) and the
  fixes are no-ops at size 1.
- Real per-run amortisation, if ever wanted, means leaving the native queue:
  a batch-building queue product (Mergify-style) or a bot-maintained train PR
  (combine N green PRs into one PR, enqueue that). Both are project-lead
  decisions with their own failure modes; neither is a ruleset flip. The
  cheaper lever that remains inside this repo is cutting per-run cost (Part 3
  landed −17 %; L3/L4 in `plan/ci-acceleration-review.md` remain the big one).

## Notes / non-goals

- The 4 % of the run spent in the post-shard tail is dominated by the regression
  gate's own `fetch-depth: 0` checkout (34 s), which **does** need full history
  for #1081 merge-base resolution. Left alone deliberately.
- The structural ~146k redundant harness compiles per run (L3/L4 in
  `plan/ci-acceleration-review.md`) remain the largest theoretical win and remain
  out of scope: L3 is an oracle-policy change (v9 + rebase), L4 needs the
  #1046/#33/#34 linker.
