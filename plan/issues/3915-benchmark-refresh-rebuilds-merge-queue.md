---
id: 3915
title: "benchmark-refresh pushes to main discard in-flight merge_group validations"
status: done
completed: 2026-08-01
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: release-pipeline
---

# benchmark-refresh pushes to main discard in-flight merge_group validations

## Summary

`benchmark-refresh.yml` pushes a `chore(ci): refresh landing benchmark artifacts [skip ci]`
commit **directly to `main`** after every merge. Any push to `main` forces the merge queue to
**rebuild its group on the new base**, which **discards the in-flight `merge_group` validation**
— including validations that had already gone **fully green**.

Because the bot push is _triggered by_ each merge and lands **7–12 min later**, while the next
PR's group is built within seconds of that merge and takes **11–13 min** to validate, **every
merge schedules a bot push timed to land inside the next merge's validation window.**

This is not a bot that occasionally collides with the queue. It is a **feedback loop**, and its
corollary is the alarming part:

> **The tax scales with merge throughput — the busier the queue, the more validation is discarded.**

That is backwards for a pipeline whose job is to land work.

## Measured impact

**Window:** 2026-07-31 09:23:28Z–14:03:44Z = **280 min (4.7 h)**.
**Denominators:** 25 `Test262 Sharded` `merge_group` runs across **17 distinct PRs**.

- **6 of 17 PRs (35%) needed more than one merge group.**
- **8 rebuilds total. 7 rooted at a `benchmark-refresh` commit; exactly 1 at a genuine PR
  landing ahead** (the only kind a serial queue must pay for).
- **129 min of `merge_group` validation discarded**, of which **93 min is
  `benchmark-refresh`-attributable** — **33% of the window**.

> **Two caveats, stated deliberately.**
>
> 1. This is **one API page, one 4.7 h window** — an observed rate for that window, **not a
>    long-run rate**.
> 2. `actions/runs?event=merge_group&per_page=100` is a **sliding page**: older runs fall off as
>    new ones land, so the window bounds and therefore the _absolute_ totals depend on when you
>    sample. An earlier sample of the same day covered 05:54Z–13:11Z and produced different
>    window bounds and different absolute minutes, but the **same 7:1 attribution ratio**.
>    Treat the **ratios** as the finding and the absolute minutes as illustrative of magnitude.

**The 7:1 ratio is the argument**, and it is the part that survives resampling: this is **not**
the unavoidable cost of a serial queue. Only **1 of 8** rebuilds was one the queue had to pay.

### Per-PR detail

Every group except each PR's last is a discarded validation; attribution is by the commit the
_superseding_ group was based on.

| PR    | groups | discarded                | superseded by                                                |
| ----- | ------ | ------------------------ | ------------------------------------------------------------ |
| #3886 | **4**  | 12.0 m + 36.3 m + 15.4 m | bench-refresh · **#3884 merge (legitimate)** · bench-refresh |
| #3887 | 2      | 11.8 m                   | benchmark-refresh                                            |
| #3889 | 2      | 14.4 m                   | benchmark-refresh                                            |
| #3892 | 2      | 13.3 m                   | benchmark-refresh                                            |
| #3894 | 2      | 14.7 m                   | benchmark-refresh                                            |
| #3898 | 2      | 11.1 m                   | benchmark-refresh                                            |

### The incident shape

**#3886 burned 63 minutes across 3 discarded groups before its 4th landed.** That is what a
human reports as _"the queue is stuck"_ — and nothing surfaces it. There is **no failure, no
park, no label**. A green run simply vanishes and a new one starts. An earlier diagnosis this
session attributed a ~1 h stall to head-of-line blocking on a workflow-touching PR; that was
**wrong** (the PR had been enqueued and merged normally). This mechanism is the better
explanation. Recording the wrong diagnosis next to the right one so the next person does not
re-derive it.

### Two consecutive fully-green validations discarded

- **#3892** group 1 (base `e0dfd0d2`) went green on all four `merge_group` workflows and was
  superseded **40 seconds before it would have merged**, by a bot push at 12:58:44Z.
- **#3894** group 1 (base `4aa1162c`) `completed success` and was superseded at 13:19:56Z by a
  bot push at 13:19:42Z.

### The timing is near-deterministic

| merge           | → bot push | lag       |
| --------------- | ---------- | --------- |
| #3886 11:43:44Z | 11:51:02Z  | 7 m 18 s  |
| #3889 12:06:41Z | 12:14:44Z  | 8 m 03 s  |
| #3893 12:46:23Z | 12:58:44Z  | 12 m 21 s |
| #3892 13:10:20Z | 13:19:42Z  | 9 m 22 s  |

Validation takes ~11–13 min and starts within seconds of the preceding merge. A push at +7 to
+12 min lands inside that window **almost every time**. This explains a 35% multi-group rate
rather than the occasional collision an unrelated bot would cause.

**Compute cost, not just latency.** Per #3914 the `merge_group` matrix uses **102 of 120
runners**. A discarded validation is not merely ~12 min of wall time — it is ~102 runners'
worth of compute thrown away, on a queue #3914 documents as **runner-saturated**.

## Five traps worth recording independently of the fix

Traps 1-4 mislead triage regardless of how this issue is resolved; the fifth is a documentation failure mode. They share one shape: **a
signal that looks complete or self-explanatory, and isn't.** Traps 1–2 are this issue's;
traps 3–4 were hit during the #3888 park triage in the same session and each cost real time,
so they are recorded here rather than lost.

1. **`[skip ci]` does not make a push inert to the merge queue.** It suppresses _workflows on
   that commit_. It does **not** stop the queue rebuilding its group. The marker reads as "this
   push is harmless", and that reading is wrong.

2. **The SHA in `gh-readonly-queue/main/pr-N-<sha>` is the BASE commit, not the group head.**
   Two distinct groups for the same PR therefore look like one run set unless you compare the
   embedded SHA. This cost a full sweep during triage and produced an incorrect "all green"
   report on a superseded group.

3. **The regressions artifact names almost no regressed path.** It enumerates the _quarantine_
   list in full, but the only regressed file it names is whichever one the trap gate happens to
   print. On #3888 the 11 non-CT regressions existed **only as a bucket-signature hash**. Anyone
   triaging a park whose failing arm is _not_ the trap ratchet gets **a count and no paths** —
   and cannot apply auto-park rule (c) (distinguish real regression from flake/collateral) at
   all. That park was tractable only by luck, because the failing arm happened to be the one
   that prints a filename.

   Related, and independent: the **headline count is dominated by noise**. #3888's "33
   regressions" decomposed to **22 compile_timeout (flake) + 10 `absent` (missing rows) + 1
   substantive**. The first number a human sees overstated the real finding by ~33×.

4. **`Newly trapping: <file>` does NOT mean the file used to pass.** The #3189 ratchet reports
   _trap-category growth_. A file going `fail` → `trap` prints **identically** to one going
   `pass` → `trap`. On #3888 this was misread as a `pass` → trap regression, which led to the
   wrong conclusion that #3596's `fail` → `fail` valve did not apply — when in fact it is the
   matching category. The baseline had the file at `status: fail`; the PR fixed the _first_
   assert, so execution reached a later line and hit a trap **already present on `main`**.

   **Read the prior state from the baseline JSONL, never from the gate's phrasing.**

### A fifth, different in kind: prose written to compensate for broken tooling outlives the breakage

Traps 1–4 are signals that mislead. This one is a **documentation** failure mode, and it is
worth naming separately because the fix is behavioural, not technical:

> **When tooling cannot fix a record, agents write prose explaining that the record is wrong —
> and the prose then outlives the problem.**

Observed the same day on #2916. An agent's claim-release appeared to fail three times, so it
wrote a 24-line warning into the issue file saying the `issue-assignments` record was stuck at
`in-progress` and the issue was effectively blocked. In fact **one of those "failed" attempts
had written the record**: it read `status: released` at 08:55:03Z. The tool reported failure
while having succeeded, the agent trusted its own error output instead of reading the record
back, and the note then explained a problem that no longer existed. Compounding it,
`pre-dispatch-gate.mjs` tested `assignee` alone and ignored `status`, so a **released** record
still printed `CLAIMED by …` (fixed in #3901) — which independently corroborated the wrong
story. **Three separate readers were misled for ~6 h**, and the note was nearly propagated
verbatim into a second PR, which would have preserved the false claim indefinitely.

Mitigations, in order of value:

1. **Read the record back after any write, and cite the record — not the tool's exit output —
   in any prose about its state.** A tool that can report failure after succeeding makes its
   own output inadmissible as evidence.
2. **Date-stamp any prose asserting a mutable external state**, so a reader can tell whether it
   is still current rather than assuming it is.
3. Prefer fixing the record over documenting that it is broken; when that is impossible, say
   explicitly what would make the note obsolete.

## Fix options (trade-offs, not a recommendation)

1. **Gate `benchmark-refresh` on an empty merge queue** — simplest; delays artifact freshness
   while the queue is busy, i.e. exactly when refreshes are most frequent.
2. **Batch / debounce its pushes** (e.g. coalesce to a schedule) — fewer rebuilds; same failure
   mode at a lower rate, and still throughput-coupled.
3. **Move the artifacts off `main` entirely** — largest change, **eliminates the class**.
   `loopdive/js2wasm-baselines` is the existing precedent for exactly this: #1528 moved the
   test262 baseline JSONL out of the main repo for unrelated reasons and it is fetched on
   demand.

Option 3 is the only one that removes the coupling rather than reducing its rate. Note also
that #3914's proposed `min_entries_to_merge > 1` would **reduce** exposure (fewer, longer
groups ⇒ fewer collision windows per PR) without removing the mechanism.

## Related

- **#3914** — merge*group critical-path latency and speculative batching. **Adjacent, not
  overlapping**: #3914 makes each validation \_faster*; this issue stops validations being
  _thrown away_. #3914's "invalidates all descendant work" concerns speculative batching, and
  its "each re-add rebuilds the group and cancels the in-flight run" concerns re-enqueue loops
  — a **third**, distinct cause. This one is an _external push to `main`_.
- **#2547** `auto-park` — parks PRs failing `merge_group` re-validation. Unrelated failure
  class; a discarded group is not a park and produces no label.
- **#1216** — the `benchmark-refresh` auto-commit-to-main behaviour.

## Acceptance criteria

- [x] A `benchmark-refresh` push can no longer discard an in-flight `merge_group` validation
      (by any of the three options). — **option 1**, see Resolution below.
- [ ] Re-measure the rebuild rate over a comparable window; benchmark-refresh-attributable
      rebuilds reach **0**, with legitimate PR-merge rebuilds unaffected.
      **Deliberately left unchecked** — this cannot be measured until the fix has been on
      `main` for a full comparable window. The pre-fix resample below is the baseline to
      diff against; sample a ≥5 h window with ≥15 distinct PRs and repeat the attribution
      in "Reproduction / evidence". Do not check this box off the strength of the argument.
- [x] `docs/ci-policy.md` records traps 1–2: `[skip ci]` does not prevent a queue rebuild, and
      the `gh-readonly-queue/main/pr-N-<sha>` SHA is the base, not the head. — new section
      _"Pushing to `main` from a workflow — the rebuild tax (#3915)"_.
- [ ] Traps 3–4 are routed to the regression-gate owner (separate change): the regressions
      report should enumerate every regressed path, not just the trap-gate one, and
      `Newly trapping:` should state the baseline status (`pass → trap` vs `fail → trap`) so the
      applicable valve is unambiguous.

## Resolution (2026-08-01) — option 1, gated at the class

### The loop still holds; verified on data disjoint from the filing sample

Independent resample, **2026-07-31 17:55Z–23:11Z** (25 `Test262 Sharded` `merge_group` runs,
**20 distinct PRs**):

| PR    | groups | superseded by                              |
| ----- | ------ | ------------------------------------------ |
| #3913 | 2      | `12add728` benchmark-refresh               |
| #3915 | 2      | `9eef01c1` benchmark-refresh               |
| #3918 | 2      | `782c805c` benchmark-refresh               |
| #3920 | 2      | `f47c3864` benchmark-refresh               |
| #3929 | 2      | `ee3b3f36` benchmark-refresh               |
| #3924 | 2      | `def6d524` **Merge PR #3920 — legitimate** |

**6 of 20 PRs (30%) needed more than one merge group. 5 of 6 rebuilds bot-caused, 1
legitimate.** Same shape as the filed 7:1, on a different window. Over the two days to
2026-07-31 `main` took **48** `chore(ci): refresh landing benchmark artifacts` commits.

### The decisive evidence was already in the repo: a natural experiment

**#1951 had already solved this class — for two of the four bots that push `main`.** Its
header comment in `baseline-summary-sync.yml` states this exact mechanism verbatim
("any push to main (even `[skip ci]`) makes GitHub rebuild every queued merge group"), and
`test262-sharded.yml`'s `promote-baseline` carries the matching inline deferral.

So the repo was already running the experiment:

| pusher                                              | gated?      | pushes / 2 days | rebuilds attributed (5.3 h window) |
| --------------------------------------------------- | ----------- | --------------- | ---------------------------------- |
| `benchmark-refresh.yml`                             | **no**      | **48**          | **5**                              |
| `test262-sharded.yml` + `baseline-summary-sync.yml` | yes (#1951) | 7               | **0**                              |
| `refresh-baseline.yml`                              | **no**      | 0 (8 h cron)    | 0                                  |

That is a measurement of **the fix**, not of the problem, on the same repo and the same
mechanism — stronger than any further measurement of the bug. Hence option 1.

### Why NOT option 3 (move the artifacts off `main`)

Two independent reasons, either sufficient:

1. **It does not cover the class.** `refresh-baseline.yml` also pushes `main` un-gated
   (its audit commit). Moving the _benchmark_ artifacts to another repo leaves that push,
   and any future one, doing exactly the same damage. The reported instance is not the class.
2. **It reworks a provenance chain two consumers depend on.** `benchmark-manifest.json`'s
   `sourceSha` is validated by `benchmark-lifecycle.mjs validate` before write credentials
   are configured, and the PR gate's `inherit` auxiliary path copies
   `wasm-host-wasmtime-*.json` out of the _checked-out base tree_. Both would need a fetch
   seam and a new trust story. Larger change, strictly less coverage.

Option 2 (batching) is dominated by option 1: same failure mode at a lower rate.

### What shipped

- **`scripts/main-push-queue-gate.mjs`** — one shared gate.
  **defer ⟸ queue _positively_ busy AND artifact _positively_ fresh**; everything else
  proceeds. `--stale-after-hours` (6 h) bounds how long a never-draining queue can hold an
  artifact back, at ≤4 rebuilds/day instead of ~24. `--fallback` lets a pusher whose file set
  is re-landed by another _already-gated_ path skip the floor instead of inventing one.
- **`benchmark-refresh.yml`** `promote-benchmarks` — gated, freshness from
  `benchmark-manifest.json.generatedAt`.
- **`refresh-baseline.yml`** — gated too, closing the class. Its main-repo commit is an
  _audit copy_; the authoritative baselines-repo push is untouched, and the hourly gated
  `baseline-summary-sync.yml` re-lands the same file set, so `--fallback` applies. An
  EMERGENCY (forced) run never defers.
- `test262-sharded.yml`'s inline #1951 gate is **deliberately left alone** — it works, and
  `promote-baseline` is the most load-bearing promote path in the repo.

> **Correction, verified 2026-08-01 while starting #3611 — do not read this as "two live
> holes closed".** `refresh-baseline.yml` is **`disabled_manually`**
> (`gh api repos/loopdive/js2/actions/workflows/265204741` → `state=disabled_manually`;
> it is the only non-active workflow in the repo). It has landed **nothing** since at
> least 2026-07-20 — `git log origin/main --grep="scheduled baseline refresh"` is empty.
>
> So the **only live un-gated pusher was `benchmark-refresh`**, and the gate added to
> `refresh-baseline` is **pre-emptive: correct once that workflow is re-enabled, inert
> until then.** Two things follow, and both are worth more than the tidier claim:
>
> 1. **It explains the 0 in the evidence table** rather than leaving it as luck. That row
>    read "gated pushers caused 0, and so did `refresh-baseline`" — the honest reason for
>    the third 0 is that the workflow never ran. The `benchmark-refresh`-vs-#1951
>    comparison is untouched by this; that is where all the signal was.
> 2. **#3611 owns the disposition** (its acceptance criterion 5: re-enable, or record why
>    the repo runs without that backstop). Whichever it decides, the gate is already in
>    place, so re-enabling cannot silently re-introduce the rebuild tax. That is the
>    right order — but it means this issue did not, by itself, remove a second live
>    source of discarded validations, and should not be cited as having done so.

### What this costs, stated plainly

Deferral is not free, and the costs are all in artifact **freshness**, never in correctness:

- **Landing-page benchmark numbers can lag by up to ~6 h during a continuously busy
  queue** (the floor), versus minutes today. On an idle or intermittently-draining queue
  nothing changes — the very next push promotes.
- **`history.json` gains fewer data points.** ~24 samples/day was over-sampling a
  measurement whose run-to-run noise exceeds most real deltas; this is arguably an
  improvement, but it is a change and it is not free.
- **A deferred run's measurement is discarded**, exactly as it already is when
  `main` advances mid-measure (the existing `remote_sha != SOURCE_SHA` no-op).
- The **PR benchmark gate is unaffected**: since the base and candidate are measured on
  the same runner in one job, it never reads the committed artifact for its verdict. Only
  the `bootstrap` path and the `inherit` auxiliary carry-forward read committed files, and
  both are provenance-stamped with the SHA they came from.

Set against ~24 discarded `merge_group` validations/day, each ~12 min of wall time and
~102 runners of compute on a queue #3914 documents as runner-saturated.

### Three traps caught while building the fix

1. **`git log -1 --format=%ct -- <path>` returns EMPTY, not an error, under
   `fetch-depth: 1`** — and every promote job here is shallow. Empty parses as "unknown
   age" ⇒ fail-open ⇒ **the staleness floor silently disables itself forever while the gate
   still reports success**. Freshness is therefore read from a timestamp carried _inside_
   the artifact, which a shallow checkout cannot launder into "fresh".
2. **The step shell is `bash -e {0}`.** A bare `node gate.mjs` followed by `RC=$?` **aborts
   the step** on the DEFER exit code, before `RC` is ever read — the deferral would surface
   as a red run instead of a skipped push. Only `... || RC=$?` survives; verified by running
   both idioms under `bash -e`.
3. **Fail-open here is correct and looks like a rule violation.** The standing rule
   ("a detector must be able to say I don't know") exists because a _verifier_ that cannot
   see must not fall to the reassuring side. This is a _deferral_ and the asymmetry is
   reversed: unknown ⇒ push costs at most one discarded validation, once; unknown ⇒ defer
   can freeze the artifact **indefinitely** on a flaky API, silently, because a skipped push
   is indistinguishable from a no-op one. The rule's intent is kept where it matters — the
   gate still _reports_ blindness (`::warning::` + `queue=UNKNOWN` in the verdict).

### Testing

`tests/issue-3915-main-push-queue-gate.test.ts` (35 assertions), in three layers:

- the pure decision table, every branch including both "cannot see" ones;
- the silent-empty readers (`""`/`"null"`/blank `gh` output ⇒ UNKNOWN, never `0`);
- **the wiring** — the gate step's `run:` body is executed **verbatim** under `bash -e` with a
  stub `node` supplying the exit code, asserting the `$GITHUB_OUTPUT` value; plus that the
  `if:` guard sits on the step that actually contains `git push deploykey HEAD:main`.

Each layer was **positive-controlled by breaking it**: removing the `if:` guard, flipping
queue-UNKNOWN to `defer`, and reverting to the unsafe `RC=$?` idiom each fail the exact
corresponding test and nothing else.

### Follow-up

**#3950** — nothing prevents the _next_ workflow from pushing `main` un-gated. The rule is
prose plus a hardcoded four-workflow list. Filed separately rather than bundled: a textual
workflow scanner has to accept two gate shapes and classify every `git push` in the tree,
which is its own design problem. (Detecting by _capability_ — a job referencing
`MAIN_DEPLOY_KEY`, the only credential that can push `main` past ruleset GH013 — looks
better than detecting by syntax.)

## Reproduction / evidence

```bash
# Group by (PR, base SHA); any PR with >1 distinct base had a validation discarded.
# NB: the SHA embedded in gh-readonly-queue/main/pr-N-<sha> is the BASE, not the group head.
gh api 'repos/loopdive/js2/actions/runs?event=merge_group&per_page=100' \
  --jq '.workflow_runs[] | select(.name=="Test262 Sharded") | "\(.head_branch)\t\(.created_at)\t\(.updated_at)\t\(.conclusion)"'

# Attribute each rebuild by the commit the SUPERSEDING group was based on.
# Look it up — do not hardcode a list of known benchmark-refresh SHAs; doing that
# during this investigation under-counted attribution by one (7 -> 6).
gh api 'repos/loopdive/js2/commits/<base-sha>' --jq '.commit.message'
```

---

# Addendum — two findings from the same session, deliberately NOT the same class

Both were nearly filed as further instances of the rebuild tax above. Neither is. Recording the
mis-classification because "same symptom, unrelated mechanism" is how a wrong fix gets shipped.

## A. A gate whose error message names a cause that does not exist

**The failure that cost ~50 minutes across two agents was not the mechanism — it was the
wording.** `quality` fails with:

```
node scripts/sync-conformance-numbers.mjs --check
[sync-conformance] --check failed: 1 file(s) would change.
[sync-conformance] DRIFT  CLAUDE.md
```

Under a script named \*sync-conformance-**numbers\***, `DRIFT` reads as _"your conformance figure
is stale."_ So triage goes looking for a stale number — and on a fast-moving queue there is
always a plausible story ready to hand ("`promote-baseline` rewrites it on every push to
`main`, main advanced, your copy is old"). That story is coherent, fits the evidence, and is
**wrong**.

**The number never drifted.** Measured on #3901, byte-identical in all three places:

| where                             | conformance line           |
| --------------------------------- | -------------------------- |
| the failing branch                | `29,846 / 43,099 (69.2 %)` |
| `origin/main`                     | `29,846 / 43,099 (69.2 %)` |
| after `pnpm run sync:conformance` | `29,846 / 43,099 (69.2 %)` |

The entire diff is **two blank lines inside the generated block**:

```diff
 <!-- AUTO:conformance-start -->
-
 **test262 conformance**: 29,846 / 43,099 (69.2 %)
-
 <!-- AUTO:conformance-end -->
```

**Mechanism: two gates disagree about one file.** `sync-conformance-numbers.mjs` regenerates the
block _without_ blank lines; **prettier adds them back** (verified in both directions). So
prettier and `sync:conformance` are mutually undoing on `CLAUDE.md`, and `sync:conformance` must
run **last**. Anyone who edits `CLAUDE.md` and then formats it — an entirely reasonable thing to
do — re-breaks the gate.

**It is not a deadlock, and checking that mattered.** `origin/main`'s own `CLAUDE.md` is
prettier-dirty by exactly those two lines **and main is green**, which proves prettier does not
gate that file. So the post-sync form is correct and safe to commit.

**Why this is NOT the rebuild tax.** That one is throughput-driven — it needs a busy queue.
**This one would happen on a completely idle repo.** Filing them together under "merge
throughput creates work for open PRs" would have been a real mis-attribution and would have
pointed the fix at the wrong subsystem.

**Fix at source**, so the gates stop disagreeing: make `sync-conformance-numbers.mjs` emit
prettier-stable output, or have prettier ignore the block. Secondarily, make the message say
_"generated block differs"_ and print the diff, rather than implying the number. Same family as
the `Newly trapping:` fix (#3902/#3915 trap 4): **a message that names a plausible-but-wrong
cause is worse than one that names nothing**, because it manufactures a confident wrong lead.

## B. A detector must be able to say "I don't know"

Trap 5 above says a control that cannot fail is worse than none. This is the same class caught
**inside this session's own watcher**, after the other half of that watcher had already been
positive-controlled — which is why it is worth recording separately.

The watcher polled `gh pr view <N> --json state --jq .state` and treated anything `!= "OPEN"` as
settled. On a transient API blip the call returned **empty**. Empty is not `"OPEN"`, so:

```
16:23:19Z 3900=//[]/red=0 3901=//[]/red=0
ALL SETTLED
```

Both PRs were still open, one of them red. **A network blip read as "everything finished."**

The bug is not the missing retry — it is that the detector had **no representation for "I could
not tell."** Two states (`settled` / `not settled`) forced an unknown into one of them, and the
default fell to the reassuring side. The fix is a third state:

```bash
case "$S" in
  OPEN|MERGED|CLOSED) ;;                      # believed
  *) S="UNKNOWN-API"; BADCNT=$((BADCNT+1)) ;; # NOT settled, and reported
esac
# only conclude when every state was valid AND none was OPEN
if [ "$OPENCNT" -eq 0 ] && [ "$BADCNT" -eq 0 ]; then echo "ALL SETTLED"; fi
```

**Generalises past watchers:** any check that maps a failed observation onto a terminal verdict
will, under intermittent failure, report the reassuring answer. Ask of any gate, detector or
verifier: _what does it do when it cannot see?_ If the answer is "the same thing as when it sees
nothing wrong", it is unsound. This is the shared root of trap 5, `gitTry` returning `{ok:false,
out:""}` so a failed main scan reported every id free (fixed in #3901), and the `contents` API
truncating at 1000 without an error flag.
