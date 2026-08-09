---
id: 3636
title: "claim-issue.mjs --allocate hands out already-taken ids, even WITH the full PR scan"
status: ready
created: 2026-07-25
priority: high
horizon: s
feasibility: medium
area: tooling
goal: ci-hardening
related: [2531, 1616]
---

# #3636 — the id allocator hands out taken ids

## Five collisions in one sprint

| #   | shape                             | detail                                                                                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | cross-lane                        | `--allocate` gave 3585; another lane landed `3585-*` on main mid-flight → renumbered to 3592                                                            |
| 2   | **self**-collision                | one agent filing two issues in quick succession got **3589 twice** → parked PR #3581 on the #1616 integrity gate                                        |
| 3   | main-vs-PR                        | PR #3614 introduces `3620-*` while main already has a different `3620-*`                                                                                |
| 4   | cross-lane, **full scan enabled** | `--allocate` **with** the PR scan returned **3619**, already used by open PR #3614; **3620 and 3621 likewise taken** (#3614/#3615) → renumbered to 3622 |
| 5   | main-vs-PR                        | PR #3627 adds `3630-*` after PR #3626 merged a different `3630-*`                                                                                       |

## The regression

The earlier working theory was that `--no-pr-scan` was the proximate cause — one agent's
_both_ collisions came from it, while every full-scan allocation held. **Case 4 refutes
that**: the full scan returned an id already used by an open PR, and the next two were
taken as well.

So the open-PR half of the scan is **not reliably seeing in-flight ids**. That is the bug.

> **SUPERSEDED — see "Case 6" below.** The one case measured end to end
> (2026-07-31, #3889) shows a **complete scan behaving correctly**: the id was free when it
> was reserved, and a second agent wrote a file against it 32 minutes later. Cases 1-5 were
> attributed to the scan by inference, not measurement, and case 6 shows that inference can
> be wrong. Treat "the scan is the bug" as an open question, not a finding, and re-verify a
> case before building on it.

## Why each one is expensive

The collision is invisible at PR level and only fails in the **`merge_group`** — via
`check:issue-ids:against-main` (id already on main) or the **Issue integrity + link gate
(#1616)** (two files with the same id in one tree). Both live in `quality`. So a green PR
gets parked later, costing a full CI round-trip plus a manual diagnosis each time.

**Note the two distinct gates** — don't pattern-match on one; case 2 hit #1616, case 3 hits
`against-main`.

## Case 6 (2026-07-31, #3889) — measured, and it exonerates the scan

Investigated from #3880. Two agents wrote `3889-*` files; the CI open-PR gate caught it, the
allocator did not. Reconstructed timeline, from the reservation ref and the GitHub API:

| time (UTC) | event                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| 09:15:17   | reservation `3889.json` written, **`pr_scan: "ok"`** — a COMPLETE scan           |
| 09:21:53   | reservation `3890.json`, `pr_scan: "ok"`                                         |
| 09:31:56   | reservation `3891.json`, **`pr_scan: "off"`**                                    |
| 09:47:26   | PR **#3884** created (`issue-3889-autoenqueue-trigger-gap`), **3 changed files** |
| 09:50:51   | PR **#3887** created — "…**file #3889** for the frozen editions artifact"        |

**The allocator was right.** At 09:15 neither PR existed, so nothing had taken 3889 and
reserving it was correct. The collision was created 32 minutes LATER by a second agent
writing a `3889-*` file for a different issue. (It was subsequently renumbered — the
editions issue is `3892-editions-artifact-frozen-missing-test262-submodule.md` on main.)

**So the defect is NOT in the scan. It is that `--allocate` reserves an id and then nothing
ever checks that the file you create uses the id you reserved.** The reservation and the
file creation are completely decoupled: an agent can reserve 3890, write `3889-*`, and no
local tool objects.

**Be precise about what verify-after-allocate buys: cycle time, not coverage.** The CI
`Issue-ID open-PR collision gate` (#3598) _does_ catch this, and demonstrably did on
2026-07-31 — an agent hit it and renumbered cleanly in about two minutes. So the guard rail
below closes no open hole; it moves the same detection from _after a CI round-trip_ to
_before the file is written_. That is worth having at the queue tax measured this sprint,
but an issue that implies new coverage will later be read against the CI gate and look
wrong.

This also **rules out the most attractive competing hypothesis**, which is worth recording
so nobody re-derives it:

> `tests/issue-2943.test.ts > falls back to REST pagination for >100-file PRs` is **RED on
> `origin/main`** (verified against main's own copy of the script, so it predates #3880). In
> `scripts/lib/open-pr-issue-files.mjs` the >100-file REST fallback does
> `byPr.set(n, hits)` / `byPr.delete(n)` — it **replaces** the GraphQL first-page hits
> rather than unioning them, so first-page ids are dropped when the fallback engages.
>
> That looks like an exact fit for "the full scan returned a taken id" — **but it cannot
> explain case 6: PR #3884 has 3 changed files, so the >100-file path never engaged.** In
> production REST `--paginate` returns a superset anyway, which is why replace has not bitten
> yet. It remains a real latent defect (any partial REST result silently discards known ids,
> and an empty one `delete`s the PR entirely) and it should be a union, not a replace. But it
> is a separate, still-unwitnessed bug.

### The asymmetry principle (state once, apply everywhere)

**Fail toward over-inclusion.** For every predicate in this tooling the two errors have
wildly different costs:

| direction                                                             | cost                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| over-include (reserve an id that was free, hold a lock that was free) | wasted number, blocked work — annoying, recoverable                                |
| under-include (hand out a taken id, report a held lock as free)       | **two agents on one id / one issue** — the collision the tooling exists to prevent |

So the id universe must only ever **grow** (union, never replace), and heldness must treat an
unrecognised status as **held** (a terminal-state blacklist, not an `in-progress` whitelist —
see #3880). Same principle, two call sites; keeping it stated once is easier than maintaining
two local rules that can drift apart.

Note the diagnosis was only possible because #3880 added `pr_scan` forensics to the record.
It was NOT possible to attribute _who_ reserved what: every record of that era carries
`assignee: ""`. #3880 adds `requested_by`, which would have named both agents here.

## Investigate

1. ~~Does the open-PR scan paginate?~~ Yes, both levels (PRs and files), and case 6 shows a
   complete scan behaving correctly. Ruled out for case 6; see above.
2. Is there a caching or a stale-fetch step between the scan and the reservation?
3. Does the reservation on the orphan `issue-assignments` ref propagate fast enough for a
   second `--allocate` seconds later? Case 2 (self-collision) suggests not.

## Guard rails to add regardless of root cause

- **Verify-after-allocate**: re-check the returned id against `main` ∪ open PRs ∪ the
  assignments ref immediately before writing files, and fail loudly on a hit.
- **Renumbering is itself a trap**: a `git mv` that leaves the in-file `id:` unstaged
  produced a _re-collision_ this sprint. The only signal was gh's
  `Warning: 1 uncommitted change` on `pr create`. After any renumber, **grep the whole
  change-set for the old id and require zero hits** — filename, `id:` frontmatter, heading,
  cross-refs, test names, PR title, and rationale comments in code.
- **Verify the incumbent with `git ls-tree origin/main`, not by assumption.** The lead
  asserted which of two same-id files was already on main and had it exactly inverted.

## Status — partially addressed, deliberately NOT closed

Landed here:

- **The diagnosis**, measured rather than inferred (case 6 above). It **exonerates the
  open-PR scan**, which was this issue's stated root cause ("the open-PR half of the scan is
  not reliably seeing in-flight ids. That is the bug"). It is not.
- **The REST-fallback union fix** — `scripts/lib/open-pr-issue-files.mjs` no longer replaces
  the GraphQL first page. This turns `tests/issue-2943.test.ts > falls back to REST
pagination for >100-file PRs` from **red on main** back to green, and
  `tests/issue-3636.test.ts` pins the two newly-corrected behaviours (kill-switch verified:
  reverting to `set` makes all three red).

**Still open, and it is now the headline:** an id is reserved by `--allocate` and then
nothing local checks that the file you create uses that id. See the framing note above —
this buys **cycle time, not coverage**, since the CI `Issue-ID open-PR collision gate`
already catches it. Sketch:

```bash
node scripts/claim-issue.mjs --verify-id <id> [--by <agent>]
#  exit 0  the id is free, or reserved BY YOU
#  exit 3  reserved by someone else / already on main / in an open PR
```

Call it immediately before writing `plan/issues/<id>-<slug>.md`, and after any renumber.

### BLOCKING requirement — THE ID SCAN MUST FAIL LOUD

State it as a property, not as a banned API. The narrow version ("don't use the contents
API") invites the next implementer to swap endpoints and keep the swallow.

> **A scan that cannot report its own failure is a placebo, not a verifier.** An id
> universe that is silently a _floor_ rather than the truth must never be reported as a
> clean result — it converts a collision CI would have caught into one that looks
> pre-cleared, while the tool reports that it checked. Strictly worse than no verifier.

Two independent routes into that state were found on 2026-07-31, which is why this is a
property and not a rule about one call:

1. **Truncation.** `gh api "repos/…/contents/plan/issues?ref=main"` caps at **1000**
   entries and says nothing; `plan/issues/` holds ~3,364. It returned **zero** `39xx`
   files. Caught only by a **positive control** — the same call returned zero `38xx` files
   while `3880`/`3884`/`3886` demonstrably exist on `main`. Use the tree API, which
   reports its own completeness:

   ```bash
   gh api "repos/loopdive/js2/git/trees/main:plan/issues" --jq '{n: (.tree|length), truncated}'
   # -> { "n": 3364, "truncated": false }
   ```

   **Assert BOTH halves: `truncated == false` AND a floored row count.** A bare
   `truncated == false` passes happily on an empty tree from a bad ref — truncation is one
   way to under-report, an empty or short read is another, and both present identically as
   "no ids taken".

2. **Swallowed failure.** `claim-issue.mjs` never used the contents API — it reads main
   with `ls-tree`. But `idsFromMain()` returns an **empty set** when that read fails, so a
   failed main scan reports _every id free_. Same shape, different route, and the more
   dangerous of the two: with main contributing nothing, `contiguousMax()` is computed from
   open PRs ∪ reservations alone and can hand out a drastically low, long-taken id.

Same family as `pr_scan: "degraded"` in #3880 — and note that #3880 fixed this property for
the **assignment ref** (tri-state reads, `die` on a failed read) while leaving the **main
scan** on the old swallow. Fixing one read path is not fixing the property.

### A live case that needs no scan at all

**PR #3903 adds a `3916-standalone-gen-rest-pattern-spill` issue file while `main` already
carries `3916-array-from-nonvec-source-map-closure-illegal-cast`** — two different issues,
one id, found 2026-07-31.

(Written without the `plan/issues/…md` path prefix on purpose: the #1616 link gate resolves
any such string against **`main`**, and the incoming file is only in an open PR — so citing
it accurately by full path fails `quality`. That is a third flavour of the same trap, after
a glob that matches nothing and a glob inside the warning about globs. See the
`pre-commit-checklist` note.)

Note what makes this the strongest argument for the guard rail: **the incumbent is already
on `main`.** No open-PR scan, no reservation ref, no network race — a single
`git ls-tree origin/main plan/issues/` at write time catches it. It is the cheapest case
there is, and it still got through, because nothing checks at write time.

**Also re-check the earlier cases against the corrected diagnosis.** Cases 1-5 were all
attributed to a faulty scan. Case 6 shows that attribution can be wrong, and cases 2 (the
self-collision — "3589 twice", which smells like the same reserve-then-write-something-else
shape) and 5 look worth re-reading before any further scan work is done. Do not build a scan
fix on an unverified premise a second time.

## NOT the same issue

#3602 is `compile-timeout dstr-iter family` — unrelated. It was mis-cited as covering this
class; it does not.
