---
id: 4045
title: "`claim-issue.mjs` reservation ledger is split-brain — it writes the FORK's `issue-assignments` ref while the collision gate reads UPSTREAM's"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
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

**Until this is fixed, state the ref alongside any claim assertion**, and treat
"the ledger says X" as unusable evidence on its own. Today the **CI open-PR
collision gate (#3598) is the only thing that actually arbitrates** — it reads
open-PR *file contents* rather than the ledger, which is why it caught all three
collisions above. Note that even it is a point-in-time check, not a lock: it
cannot see a PR opened after its scan (that is how 4046 slipped through).

Same root cause family as the `origin`-is-the-fork verification trap: CLAUDE.md documents `origin` as upstream, which is false in this checkout, and tooling written against that assumption silently reads or writes the wrong book.
