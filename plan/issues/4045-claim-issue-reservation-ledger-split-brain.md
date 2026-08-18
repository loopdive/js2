---
id: 4045
title: "`claim-issue.mjs` reservation ledger is split-brain — it writes the FORK's `issue-assignments` ref while the collision gate reads UPSTREAM's"
status: done
completed: 2026-08-03
assignee: ttraenkler/senior-4096-elision
sprint: 78
created: 2026-08-02
updated: 2026-08-18
related: [4117, 3598, 2531, 3880]
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `claim-issue.mjs` reservation ledger is split-brain — it writes the FORK's `issue-assignments` ref while the collision gate reads UPSTREAM's

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Root cause of the 2026-07-28 id-collision chain, found by the #3715 lane and VERIFIED independently.

**The bug**, `scripts/claim-issue.mjs:149` (the report said `:74`; the constant has
since moved — corrected 2026-08-02):
```js
const REMOTE = process.env.CLAIM_ASSIGN_REMOTE || "origin";
```
with the comment above it stating the `issue-assignments` orphan ref "lives on the FORK (origin) — keep REMOTE = origin for ALL reservation-ref operations".

But in agent worktrees `origin` IS the fork (`ttraenkler/js2`), while **CI's collision gate and other lanes read the UPSTREAM ledger**. Measured 2026-07-28: fork ref at `0f90e2311`, upstream ref at `31a3427d2` — **different SHAs, two disjoint books**.

**Consequence:** a reservation made from a fork-origin worktree is invisible to everyone else, so `--allocate` hands out ids that are already taken. It defeats the entire purpose of the atomic-reservation design (#2531), which exists precisely so two lanes can't pick the same number.

**Measured blast radius (one night, three PRs):**
- #3715 reserved 3750/3751/3752 on the fork ledger.
- #3723 took 3750/3751 via upstream and MERGED (11:54Z) — now on main.
- #3719 took 3752.
- #3715 had to renumber **twice**, ending at 3753/3754/3755 via `CLAIM_ASSIGN_REMOTE=upstream`.
- Separately, a hand-picked (non-allocated) 3752 in a foreign commit collided again.
- One id (#3753) was burned as a bare reservation during the churn.

**The inconsistency that makes this clearly a bug, not a design choice:** the same script ALREADY handles the fork problem for `main` — around line 86 it picks `upstream` when that remote exists, and lines 76-77 warn that `origin/main` "lags upstream by thousands of commits, so 'next free off origin/main' returns ids already taken on upstream/main". The assignments ref simply never got the same treatment.

**Proposed fix:** default `CLAIM_ASSIGN_REMOTE` to the same remote the gate's tie-break reads (i.e. resolve `upstream` when present, exactly like the main-ref logic already does), and/or write reservations to BOTH ledgers so fork-origin and upstream-origin lanes converge. Add a positive control proving a reservation made in a fork-origin worktree is visible to an upstream-reading gate — without that control the fix is unverifiable and would look identical to the current broken state.

**Workaround meanwhile:** `CLAIM_ASSIGN_REMOTE=upstream node scripts/claim-issue.mjs --allocate`, mirroring to the fork ledger.

---

## Update 2026-08-02 — still live, three more collisions in a single session

Re-measured while filing this issue. Ledger tips: fork `e698bf07b`, upstream
`a949bee25` — **still two disjoint books**, ~5 days after the original report.

Three fresh collisions in one session, all from this mechanism:

| id | claimants | outcome |
| --- | --- | --- |
| 4047 | this lane + `H-descriptor` | ceded to H-descriptor |
| 4046 | this lane + PR #4002 | this lane renumbered to 4073 |
| 4076 | this lane + `H-errmodel` | ceded to H-errmodel; took 4078 |
| 4072 | `H-crashes` + PR #4002 | H-crashes renumbered to 4077 |

Two things this pinned down that the original report did not:

**1. The workaround only works if EVERY lane uses it.** `H-errmodel` had been
passing `CLAIM_ASSIGN_REMOTE=upstream` on *every* call — allocate, claim,
release **and** check — which is the only reason its own reads and writes stayed
coherent. Lanes that use the default (`origin`) still write to the fork book, so
a partially-adopted workaround produces exactly the same collisions while
*looking* like it is working for whoever adopted it. It is a per-lane habit, not
a repo-level guarantee.

**2. A `--check` result is meaningless without naming the ref it came from.**
Measured directly: `claim-issue.mjs 4076 --check` reported
**`#4076 is UNASSIGNED` (exit 0)** from a fork-reading worktree at the same
moment the upstream book held
`#4076 CLAIMED by ttraenkler/H-errmodel since 2026-08-02T04:26:14Z`. Same
command, same id, opposite answers — and both exit 0. The identical thing
happened with #4010, where one lane got exit 3 (claimed) and another got exit 0
(unassigned), stranding the issue on a claim that did not exist from where the
next dispatcher was standing.

### ⚠ It manufactures plausible WRONG diagnoses — do not file what it suggests

The #4072 collision is worth recording in full, because the split-brain did not
merely hide a claim — it **produced a confident, wrong root cause** that was
about to be filed as its own defect.

The agent that hit it reported: *"#4002 reached 4072 by renumbering away from an
earlier collision and **never recorded it on the assignments ref** —
`claim-issue.mjs --check 4072` still answers UNASSIGNED. The renumber path is
what re-opens the hole #2531/#3880 exist to close."*

That is a coherent, specific, actionable-sounding defect in the **renumber
path**. It is also false. Checked against both books at the same moment:

```
origin (fork) : #4072 is UNASSIGNED                                   (exit 0)
upstream      : #4072 is CLAIMED by ttraenkler/claude since 03:25:45Z (exit 3)
```

The renumber **did** record the reservation — on the upstream ledger. The
`--check` read the fork ledger, because `CLAIM_ASSIGN_REMOTE` defaults to
`origin` and `origin` is the fork. There is nothing wrong with the renumber path.

**So the failure mode of this bug is not just "collisions". It is "an agent
reads one book, gets a self-consistent story, and files a defect against
innocent code."** That is the same shape as the gate-base defect in #4002/#4039,
where agents "fixed" other agents' files to silence phantom blame. Cost here was
caught only because a second lane checked both refs.

### What is genuinely broken, separately from the ledger

`--allocate` reported **`pr_scan=ok`** while handing out an id that an open PR
had already held for **40 minutes**. The open-PR scan is a **point-in-time
check, not a lock**, and it is the second of the two mechanisms that were
supposed to make allocation safe. Both failed together here.

**Working practice until this lands** (adopted from the lane that hit #4072):
after `--allocate`, independently re-scan every open PR's added issue files
rather than trusting `pr_scan=ok`.

**Until this is fixed, state the ref alongside any claim assertion**, and treat
"the ledger says X" as unusable evidence on its own. Today the **CI open-PR
collision gate (#3598) is the only thing that actually arbitrates** — it reads
open-PR *file contents* rather than the ledger, which is why it caught all three
collisions above. Note that even it is a point-in-time check, not a lock: it
cannot see a PR opened after its scan (that is how 4046 slipped through).

Same root cause family as the `origin`-is-the-fork verification trap: CLAUDE.md documents `origin` as upstream, which is false in this checkout, and tooling written against that assumption silently reads or writes the wrong book.

---

## RESOLVED 2026-08-03 — one book, and it is upstream's

Fixed here, with #4117 folded in as a second incident (see the boundary note
below). The proposed fix in this file was "default `CLAIM_ASSIGN_REMOTE` to the
same remote the gate's tie-break reads, **and/or** write to BOTH ledgers". Only
the first half was taken, deliberately: dual-writing makes two books that must
agree, which is the same failure surface with an extra step. One authoritative
book, plus a read-only union while the old one drains, has a single answer by
construction.

### What changed

1. **`scripts/claim-issue.mjs` resolves the assignment ref to UPSTREAM** by
   default, via a picker that mirrors `pickMainRemote()` — the function that has
   resolved `main` to upstream since #2177 for the identical reason. That
   inconsistency was already named in this file as the thing that makes it a bug
   rather than a design choice. `CLAIM_ASSIGN_REMOTE` still overrides.
2. **Reads are the UNION of the authoritative book and any legacy book; writes
   go only to the authoritative one.** Records therefore migrate forward on the
   next write about that id, and the fork's book drains instead of being
   orphaned. Flipping the default without this would have re-created the
   collision from the other side: at the moment of the flip the fork's book held
   live reservations (4113, 4116, 4117) that upstream's did not.
   On a conflicting key **the authoritative book wins** — the same tie-break the
   #3598 gate applies, so the two arbiters cannot disagree — and the conflict is
   REPORTED rather than hidden.
3. **`--check` sees reservations and names the book that answered.** This file
   measured `--check 4076` answering `UNASSIGNED` (exit 0) at the same instant
   the other book said `CLAIMED by ttraenkler/H-errmodel` (exit 3). It now
   prints `read <remote>/issue-assignments`, flags a LEGACY-book answer, warns
   when a book was unreadable, and distinguishes three states that were
   previously collapsed into "UNASSIGNED":
   `CLAIMED` (exit 3) · `RESERVED — id TAKEN, nobody working` (exit 0) ·
   `UNASSIGNED` (exit 0). The middle one is new: the tool that WRITES `reserved`
   records could not previously see what it had just written.
4. **`scripts/pre-dispatch-gate.mjs` no longer reads the ledger itself.** It
   named `origin/issue-assignments` through `git show`, which was wrong twice —
   the fork's book, *and* a remote-tracking ref only as fresh as the last fetch.
   It now delegates to `claim-issue.mjs --list --json`, the choice
   `budget-status.mjs` already made, so there is ONE reader and the rules cannot
   drift apart again. An unreadable ledger is a WARNING, never a silent
   "unclaimed".
5. **A `--allow-unscanned` escape does NOT excuse an unreadable legacy book.**
   That flag is consent to a degraded open-PR scan; an operator who accepted
   "gh is offline" has not thereby accepted "an entire reservation book is
   invisible". The separate consent is `--allow-unmerged-books`.

### Evidence — both books, before and after

```
BEFORE (2026-08-02)
  upstream/issue-assignments:4113.json  codex,  in-progress, claimed_at 21:10:58Z
  origin/issue-assignments:4113.json    me,     reserved,    reserved_at 21:35:13Z, pr_scan "ok"
  $ claim-issue.mjs --check 4113   ->  "#4113 is UNASSIGNED"                      (exit 0)

AFTER
  $ claim-issue.mjs --check 4113
    NOTE: #4113 also has a record on origin/issue-assignments (reserved / -). …
    #4113 is CLAIMED by ttraenkler/codex (since 2026-08-02T21:10:58Z).
    claim-issue: REFUSED — … (read upstream/issue-assignments; also present on
                 origin/issue-assignments as reserved/- (shadowed))            (exit 3)

  $ claim-issue.mjs --check 4116     # reserved on the fork book only
    #4116 is RESERVED — the id is TAKEN, nobody is working on it …
    claim-issue: OK — … (read origin/issue-assignments; LEGACY book …)         (exit 0)
```

### Controls (`tests/issue-4045-one-assignment-ledger.test.ts`, 10)

Hermetic: two local bare repos wired as `origin`=fork / `upstream`=upstream, and
the competing lane writes to the book with **plain git, never through the script
under test** — a control that creates the rival record with the same tool would
pass even if that tool were still writing to the wrong book.

Kill-switch: reverting `claim-issue.mjs` alone fails **7 of 10**. The 3 that
survive are labelled in-file as what they are — two migration guards that are
trivially true when the fork IS the default book, and one preserved-behaviour
guard (the authoritative-book refusal) that exists to stop a future "resilience"
patch from adding a fork fallback.

`tests/issue-3880.test.ts` and `tests/issue-3965.test.ts` still pass (49 total).
One #3880 assertion was rewritten rather than deleted: it required
`--check` to print `is UNASSIGNED` after `--complete`, which conflated the LOCK
being free (its subject) with the ID being free (the sibling test's subject). It
now asserts the property — exit 0, `NO ACTIVE CLAIM`, `id is TAKEN` — so it still
fails if the lock stops being freed.

### Boundary with #4117 — kept, not merged away

#4117 was filed independently the next day, before this file was found. Same
mechanism, so **this issue is the primary record**; #4117's unique contribution
is preserved there and is worth keeping:

- a **fourth incident** (4113), and
- a **correction that stops this file's PR-scan finding from over-generalising**.
  This file records `--allocate` reporting `pr_scan=ok` while an open PR had
  held the id for **40 minutes** — a genuine scan defect. In the 4113 incident
  the scan was **innocent**: PR #4055 was created at 21:46:23Z, *eleven minutes
  after* the 21:35:13Z reservation, so a correct scan would still have answered
  `ok`. Check the timestamps before blaming the scan; the two incidents look
  identical and have different causes.

### Still open — NOT fixed here

- **The open-PR scan is a point-in-time check, not a lock.** The 40-minute case
  above is real and untouched by this change. So is the ~11-minute
  reservation-to-PR window: an id reserved now and PR'd later is invisible to a
  scan that runs in between. Both are accepted by design here, with the #3598
  CI gate as the backstop that actually arbitrates (it reads open-PR *file
  contents*, and it is what caught 4113). Closing the window would need a real
  lock, which is a different design.
- The legacy book is read, never rewritten. Stale records left on the fork are
  shadowed and reported, not cleaned up — rewriting another repo's ref to tidy
  it is not this tool's business. Once drained, set
  `CLAIM_ASSIGN_LEGACY_REMOTES=""` to drop the extra round-trip.
