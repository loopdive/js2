---
id: 3598
title: "check:issue-ids should detect collisions against OPEN PRs, not only main — the gap that silently parks PRs"
status: done
completed: 2026-07-25
sprint: 77
created: 2026-07-24
updated: 2026-07-30
priority: high
horizon: s
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [2531, 2547, 1616]
origin: "PR-queue shepherd, 2026-07-24/25. FIVE duplicate-id collisions in ~3h across four lanes; THREE surfaced only as merge_group auto-parks, one of those against a stale head whose renumber had already landed."
---

# #3598 — the issue-id gate checks `main` but not open PRs, so collisions surface as merge-queue parks

## Problem

There is an **asymmetry** between the two halves of the id-collision defence:

| component                                | scans                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `claim-issue.mjs --allocate`             | `origin/main` ∪ **every open PR's added issue files** ∪ the `issue-assignments` ref |
| `check:issue-ids:against-main` (CI gate) | `main` **only**                                                                     |

`--allocate` already scans open PRs, precisely because two branches can each add
the same id while **neither file is on `main` yet**. The CI gate does not. So the
gate cannot see the very collision the allocator was built to prevent.

Consequence: when two open PRs claim the same id, **both are green at PR level**.
The collision only materialises once the first one merges. Depending on timing:

- if the loser's checks re-run after the winner lands → the gate fires loudly at
  PR level (the good case);
- if the loser reaches the merge queue first → the duplicate is caught only by
  the `--check` duplicate-id gate in the `merge_group`, which **auto-parks** the
  PR with a `hold` (#2547). A park is far more expensive than a red check: it
  needs a human/shepherd to diagnose, and a parked PR is skipped by
  `auto-enqueue`, so it strands until someone intervenes.

## Evidence — five collisions, 2026-07-24/25, within ~3 hours

**Collision A — id 3584** (`plan/issues/3584-*`): PR #3577 vs PR #3579. Caught at
PR level, but only because #3577 merged first. `--allocate` had reserved the id
at `22:05:41Z`; #3579 was opened ~29 min later.

**Collision B — id 3589** (`plan/issues/3589-*`): PR #3582 vs PR #3581. This one
was **invisible at PR level** — `check:issue-ids:against-main` was green on #3581
because #3582 had not merged when its checks ran. It surfaced only in the
`merge_group`:

```
Issue integrity + link gate (#1616)
--check FAILED: 1 duplicate IDs
```

…which auto-parked #3581 with a `hold`. Reserved at `22:30:26Z`; #3581 opened
~5 min later.

**Collision C — id 3597, and it caught THIS issue file.** While the present issue
was being written it was itself allocated id 3597 — which PR #3585
(`plan/issues/3597-auto-park-step-aware.md`, opened `23:15:13Z`) had already
taken. This file was renumbered to **#3598**; #3585 was ~12 min earlier and keeps 3597.

Collision C is the most informative of the five, because **`--allocate` should
have prevented it and did not**. PR #3585 was already open when
`claim-issue.mjs --allocate` handed out 3597 at `23:27:46Z`, yet the open-PR scan
did not see its added file. So the open-PR scan is not merely _absent from the
gate_ (the headline problem) — it is **also unreliable in the allocator**, whether
through caching, pagination, an API hiccup, or the file arriving in a push after
the PR was opened. Whatever the mechanism, it means the reservation ref cannot be
treated as authoritative on its own, which strengthens the case for enforcing at
the gate: **verification at merge-decision time beats reservation at allocation
time.** A manual per-PR scan for the replacement id (3598) found it genuinely
free.

**Collision D — id 3597 again, and it reached the merge queue.** After Collision
C was resolved by renumbering this file to 3598, PR #3585 **merged**, putting
`3597-auto-park-step-aware.md` on `main` — and PR #3589 (which then still carried
the old `3597-issue-id-gate-*.md`) was **auto-parked** by the `merge_group`
duplicate-id gate.

Collision D exposes a failure mode that **no amount of allocation-time discipline
can fix**: the renumber commit had _already landed on the branch_, but the
merge-group run had started **before** that push, so the queue validated a
**stale head** and parked a PR that was already correct. Reservation hygiene
cannot help here — only a PR-level check that sees the _current_ head against the
_current_ set of open PRs.

**Collision E — id 3598, this file's own replacement id.** PR #3593
(`3598-fyi-source-executor-reuse.md`, opened `00:56:47Z`) collided with this file
once #3589 merged at `01:07:37Z`. Again invisible at PR level; again surfaced
only as a `merge_group` auto-park. Renumbered to **#3599**.

### Tally

**Five collisions in ~3 hours**, across four independent lanes:

| #   | id   | PRs            | surfaced at                  |
| --- | ---- | -------------- | ---------------------------- |
| A   | 3584 | #3577 vs #3579 | PR level (lucky)             |
| B   | 3589 | #3582 vs #3581 | **merge queue**              |
| C   | 3597 | #3585 vs #3589 | pre-emptive sweep            |
| D   | 3597 | #3585 vs #3589 | **merge queue** (stale head) |
| E   | 3598 | #3589 vs #3593 | **merge queue**              |

**Three of five surfaced only in the merge queue**, each costing an auto-park,
a diagnosis, and a manual `hold` removal. One (C) was caught only because a
shepherd happened to run a manual sweep. Exactly one was caught by the intended
mechanism, and that was luck of merge ordering.

## Root cause of the collisions themselves (why this will recur)

`origin/issue-assignments` held **only one** reservation record for each of 3584
and 3589 — in both cases the record belonging to the PR that reserved via
`claim-issue.mjs --allocate`. The colliding branches left no record at all, i.e.
that lane is **not going through `--allocate`**.

That is the important framing: **the fix must not depend on every lane
cooperating with the reservation protocol.** Reservation is advisory; the gate is
the enforcement point. Making the gate see open PRs works regardless of how the
id was chosen.

## Proposed fix

Extend the PR-level gate to compare a branch's **added** issue files against the
union of `main` **and every other open PR's added issue files** — reusing the
open-PR scan `claim-issue.mjs --allocate` already implements, rather than writing
a second one.

Design points:

- **Added files only.** A PR that _modifies_ an existing `plan/issues/<id>-*.md`
  is not a collision. A naive id-only comparison flags all of those as false
  positives (confirmed empirically — a first pass at this flagged five PRs that
  were all ordinary modifications).
- **Compare full filenames, not just ids** — same id + same filename ⇒
  modification; same id + different filename ⇒ real collision.
- **Report both sides**, so whoever reads the red check knows which PR they raced
  and can apply the tie-break without digging.
- **Tie-break, to state in the failure message**: the merged/queued PR keeps the
  id; the other renumbers via `claim-issue.mjs --allocate`. Reservation timestamps
  on `origin/issue-assignments` break ties when neither is queued yet.
- **Fail soft on API unavailability.** The open-PR scan needs network; if it
  cannot run, warn rather than blocking every PR on a GitHub outage. The existing
  against-main check stays hard.
- **Re-check at the head the queue actually validates.** Collision D parked a PR
  whose renumber had already landed, because the `merge_group` run started before
  that push. Whatever the gate reports must be derived from the head under
  validation, and a park should be re-evaluated against the current head before a
  human is asked to act on it.

## Acceptance criteria

1. Two open PRs adding the same issue id ⇒ **both** get a red `quality` check at
   PR level, before either reaches the merge queue.
2. A PR that merely modifies an existing issue file is **not** flagged.
3. The failure message names the colliding PR and states the renumber command.
4. The `merge_group` `--check` duplicate-id gate remains as the backstop (this
   change should make it near-unreachable in practice, not replace it).
5. Works regardless of whether the colliding branch used `--allocate`.

## Interim mitigation

A pre-emptive sweep script is in use by the PR-queue shepherd — it walks every
open PR's added issue files and compares against `main`, distinguishing
modifications from real collisions. Cheap to run once per sweep loop until this
gate lands.

## Handover (PR-queue shepherd → incoming dev, 2026-07-25)

Reassigned mid-implementation. **What survives on branch `issue-3598-gate-open-prs`
is `scripts/lib/open-pr-issue-files.mjs` — complete and verified live.** The two
call-site edits were lost to a `git reset --hard` that also caught uncommitted
work (my error; the probe commits only captured a `.md`). They were verified
working end-to-end before that, so this section records exactly what they did —
reimplementing them is ~150 lines of mechanical work, but the _findings_ below
are the expensive part and should not be re-derived.

### Design intent — one scan, not two

The root asymmetry is that `claim-issue.mjs --allocate` already scans
`main ∪ every open PR's added issue files ∪ the reservation ref`, while the CI
gate only ever compared against `main`. **Do not write a second scanner** — that
guarantees drift, and the allocator's copy carries hard-won #2943 hardening
(one batched GraphQL query instead of 1+N calls, REST `--paginate` fallback for

> 100-file PRs, 3× retry with backoff, and `complete: false` on total failure so
> callers degrade _loudly_).

So the module was extracted **verbatim** from `idsFromOpenPRs`, generalised to
return `{ byPr: Map<prNumber, paths[]>, complete }`. Paths-per-PR is the richer
primitive: ids derive from paths, not the reverse, and the gate needs the PR
number so a failure can _name the PR you raced_. `openPrIssueIds()` is the thin
id-only wrapper preserving the allocator's exact `{ ids, complete }` contract.

`claim-issue.mjs` then delegates to it (keeping its own loud warning at the call
site) and drops its now-dead `PR_FILES_QUERY` / `PR_SCAN_*_TIMEOUT_MS` consts.
**Verified after refactor:** `--allocate --dry-run` → `#3609 (scanned 3128 used
ids; PR-scan on)`.

### The gate — `check-issue-ids.mjs --against-open-prs`

A `mode` alongside `against-main`, sharing an extracted `introducedFiles(base)`
helper (present at HEAD, absent at the merge-base with base) so both modes agree
on what "this branch added" means.

Four properties, **all empirically verified against the live repo**:

1. **Different filename, same id ⇒ FAIL.** Probe added
   `3607-synthetic-collision-probe.md`; correctly reported
   `#3607: this branch adds … but open PR #3590 already adds
…/3607-standalone-current-summary-never-committed.md` (link-checker note:
   path prefix elided — that file exists only in PR #3590, not on this branch).
2. **Same filename ⇒ PASS.** Renamed the probe to #3590's exact filename → not
   flagged. Two PRs touching one issue file is a modification, not a collision.
   An id-only comparison flags all of these (a first pass flagged five, all
   ordinary modifications) — **compare filenames**.
3. **Self-exclusion.** `GATE_PR_NUMBER`/`PR_NUMBER` excludes the PR being
   validated, or it always collides with itself. Verified: setting
   `GATE_PR_NUMBER=3590` made case 1 pass.
4. **Fail-soft.** `complete: false` ⇒ warn and `exit 0`. See below.

Failure output names both sides, states the tie-break (merged/queued PR keeps the
id; otherwise the earlier `origin/issue-assignments` reservation wins), and gives
the `--allocate` + `git mv` recipe.

### Fail-open vs fail-closed — deliberate, and it matters

**Fail-OPEN (warn, exit 0).** This gate needs network on every PR; fail-closed
would wedge _every_ PR on a GitHub blip or rate-limit, converting an outage into
a total merge freeze. It is **additive**: `--against-main` stays hard, and the
merged-state dup gate remains the backstop. Degrading loudly (never silently) is
the same posture #2943 chose for the allocator, and for the same reason.

### Dead ends / hazards already hit

- **Rate limits & pagination** — solved by inheriting #2943's batched query +
  REST fallback + retry. Don't reimplement naively; `gh pr view --json files`
  silently truncates at 100 files.
- **Renames.** A PR that _renames_ an issue file shows both paths in its file
  list, so the old id can still appear as "added" by that PR. Not observed
  causing a false positive (every renumber this week renamed _away from_ the
  contested id, so the surviving path is the new one), but it is the most
  likely false-positive source — worth a test.
- **`grep` lies on some files.** Plain `grep` returns nothing on
  `scripts/diff-test262.ts` (treated as binary despite clean UTF-8). Use
  `grep -a` when auditing these scripts; it produced one confidently-wrong
  conclusion during this work.
- **Don't `git reset --hard` with uncommitted work.** How the call-site edits
  were lost. Commit real work _before_ stacking throwaway probe commits.

### The probe was scaffolding, not a test

The synthetic-collision commits were deliberately throwaway (they add a fake
issue file). **They should not survive to merge.** But the three behaviours they
proved (1/2/3 above) deserve real coverage — ideally with `openPrIssueFiles`
stubbed so the test is hermetic and needs no network, rather than hitting the
live API.

### Stale-head (Collision D) — genuinely a separate fix

Collision D park-held a PR whose renumber had **already landed**: the
`merge_group` run started before the push, so the queue validated a stale head.
**This gate cannot fix that** — it is a PR-level check, and by construction the
stale-head case is the queue evaluating an older commit than the branch has.
The fix belongs where the park is _raised or acted on_: either re-evaluate a
park against the PR's current head before applying the `hold`, or have the park
comment state the SHA it judged so a reader can see it is stale. Recommend
keeping it out of #3598's scope and filing it separately against the auto-park
bot (#2547/#3597 territory) — folding it in would blur a clean PR-level gate
with queue-lifecycle logic.

## Implementation notes (senior-dev, 2026-07-25)

Landed on branch `issue-3598-gate-open-prs`, building on the handover module.
Probe/test coverage: `tests/issue-3598-open-pr-id-gate.test.ts` (hermetic — the
scan result is injected, no network).

### What landed, and WHY it is shaped this way

- **`check-issue-ids.mjs --against-open-prs`** — new mode, wired into the
  `quality` job (ci.yml, `pull_request` only) as
  `check:issue-ids:against-open-prs`, with `GATE_PR_NUMBER` from the event for
  self-exclusion. It shares `introducedIssueFiles(base)` with `--against-main`
  (extracted, behaviour-preserving) so both modes agree on what "this branch
  added" means, and calls the API **only when the branch actually introduces
  issue files** — the common no-issue-file PR pays zero network cost, which is
  what keeps the per-PR rate-limit budget trivial (one batched GraphQL query
  even in the paying case, inherited from #2943).
- **One scan, one code path**: the gate and `claim-issue.mjs --allocate` both
  consume `scripts/lib/open-pr-issue-files.mjs` (the shepherd's extraction,
  preserved verbatim in its hardened parts). `claim-issue.mjs` now delegates —
  its local `PR_FILES_QUERY`/`idsFromOpenPRs` body and `ISSUE_ID_RE` copy are
  gone, so the allocator and the enforcement point cannot drift.
- **Fail-OPEN on scan failure (deliberate, stated in the PR):** the scan needs
  network on every gated PR; fail-closed would convert a GitHub blip or
  rate-limit into a red check on EVERY open PR at once — a total merge freeze
  caused by the very gate meant to prevent stalls. It degrades LOUDLY
  (`⚠ … DEGRADED … passing WITHOUT PR-vs-PR coverage`) and the `merge_group`
  duplicate-id `--check` remains the hard backstop. `--against-main` (pure git,
  no network) stays hard-fail.
- **Rename hazard closed at the scan layer**: the GraphQL query now requests
  `changeType` and `liveIssuePaths()` drops `DELETED` entries (REST fallback:
  `select(.status != "removed")`). A _detected_ rename lists only the new path,
  but an UNdetected one (similarity too low) appears as ADDED-new +
  DELETED-old — without the filter, a PR that renumbered AWAY from a contested
  id would still read as claiming it: the top false-positive source, now unit-
  tested. This also stops a genuinely-deleted issue file from claiming its id.
- **Same-filename ⇒ PASS** (two PRs modifying one issue file) and
  **self-exclusion** are implemented in a pure `findOpenPrCollisions()` in the
  lib, hermetically tested. All four behaviours were ALSO re-verified live
  against the real repo with a throwaway probe commit (collision vs PR #3590
  correctly named; self-exclusion via `GATE_PR_NUMBER=3590`; same-filename
  pass; degraded-scan fail-open) — the probe commit was dropped before push,
  per the handover ("scaffolding, not a test").

### Collision C root-caused — the allocator's scan was NOT unreliable

The evidence section above says PR #3585 "was already open when `--allocate`
handed out 3597, yet the open-PR scan did not see its added file." That framing
is subtly WRONG, and the correction matters. PR #3585's commit timeline:

- at allocation time (23:27:46Z) its head was `068b33490` (pushed 23:20:41Z),
  whose issue file was **`3590-auto-park-step-aware.md`** (path prefix elided
  for the link checker — that pre-rename filename no longer exists anywhere) —
  the PR was still numbered #3590;
- the commit `fix(#3597): renumber 3590 -> 3597` was authored **23:45:28Z — 18
  minutes AFTER the allocation**, itself resolving a _different_ collision
  (3590), and it hand-picked 3597 without consulting `--allocate` or the
  reservation ref (which already held `3597.json`, reserved 23:27:46Z).

So the scan returned exactly what existed; the colliding id materialised on the
branch later. A live cross-check of the batched scan against per-PR REST file
lists (all open PRs) found **zero mismatches**. Conclusion: there is no
allocation-time fix — ids appear on branches at arbitrary times, which is
precisely why enforcement had to move to verdict time (this gate). Had the gate
existed, the moment the 3597 renumber was pushed while both PRs were open, the
loser would have gone red at PR level instead of auto-parking in the queue.

Residual forensic gap closed: the reservation entry on
`origin/issue-assignments` now records `pr_scan: ok|degraded|off`, so any
future collision can be root-caused post-hoc instead of guessing whether the
scan was degraded (the stderr-only warning was the reason Collision C initially
resisted diagnosis).

### Stale-head (Collision D): DEFERRED — filed as #3609

Confirmed out of scope, per the handover's reasoning: a PR-level gate
structurally cannot fix the queue validating an older commit than the branch
has. Filed **#3609** against the auto-park bot (re-evaluate the park against
the PR's current head before applying `hold`, or at minimum record the judged
SHA in the park comment).
