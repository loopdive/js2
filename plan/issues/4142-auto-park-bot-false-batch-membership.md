---
id: 4142
title: "auto-park bot reports a false batched-merge-group membership list — it enumerates the whole compare range, so a PR branch's merged-in main commits and issue references are parsed as co-member PRs"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci, tooling
language_feature: none
goal: dogfood
related: [3914, 2547, 4141, 4074, 4088]
origin: "observed on #4074's park comment while diagnosing #4141, 2026-08-03"
---

# #4142 — the auto-park bot invents batch co-members

## Symptom

The `auto-park-bot:merge-group-failure` comment on **#4074** declared:

> **This was a batched merge group** (#4001, #4029, #4033, #4045, #4075, #4133).
> The failure is attributed to the group as a whole — any member could be the
> cause, so all of them are parked. Re-enqueue them ONE AT A TIME to attribute
> the failure before removing `hold` from the rest.

None of that is true:

- **#4001, #4029, #4033, #4045 all merged on 2026-08-02**, a day before this
  merge group existed. They cannot be members of it.
- **#4075 and #4133 are issue ids, not PRs at all.**
- Every queue ref involved was `gh-readonly-queue/main/pr-4074-<base>` with
  **exactly two parents** (the queue base and this PR's head) — i.e. the group
  was **solo**, as the serial queue (`min_entries_to_merge: 1`) guarantees.

So the group had one member, #4074, and the bot named six others.

## Root cause

`prNumbersInGroup()` in `scripts/auto-park-merge-group-failure.mjs` enumerates
membership from the **compare API over the whole range**:

```js
ghMaybe(["api", `repos/${REPO}/compare/${baseSha}...${headSha}`, "--jq", ".commits[].commit.message"]);
```

then feeds every subject to `prNumbersFromCommitSubjects()`, which matches
either `^Merge pull request #(\d+)` or `\(#(\d+)\)\s*$`.

The base sha comes from the queue branch name and is an ancestor of the head, so
the range returns **every commit the queue entry's merge commit introduced** —
which is the PR branch's entire unique history, not one commit per group entry.
Two distinct leaks follow:

1. **Merged-in main commits.** #4074's branch had `origin/main` merged into it
   (correct per the merge protocol — never rebase). Every main-side squash
   commit it absorbed carries a `title (#N)` subject and is read as a co-member.
   That is exactly where #4001/#4029/#4033/#4045 came from: they are commits the
   branch *contains*, not PRs the group *holds*.
2. **Issue references are indistinguishable from squash refs.** `(#4133)` at the
   end of a subject matches the squash pattern whether it refers to a PR or an
   issue — and in this repo PR numbers and issue ids share ONE sequence, so
   there is no numeric range test that could separate them. #4075/#4133 are
   issues.

The `--self-check` fixtures at L361-387 only exercise clean, hand-written
subjects; nothing in them resembles a real long-lived branch's history, so the
unit checks pass while the production path is wrong.

## Why it matters

The bot prints an explicit protocol — "re-enqueue them ONE AT A TIME to
attribute the failure" — and then hands over a list that makes that protocol
impossible to follow. Concretely, during the #4141 investigation three parks
were initially read as unattributed because the membership list pointed at PRs
that had merged the previous day. It also means the bot may add `hold` to
unrelated open PRs whose numbers happen to appear in a branch's history,
stranding them (a held PR is skipped by `auto-enqueue` and never recovers on
its own).

The failure direction is the bad one: it over-parks and misattributes, and the
misattribution is *confident* — it is printed as a positive claim, not a guess.

## Suggested fix

Enumerate membership from the queue head's **commit graph**, not from a compare
range. Each queue entry is one merge commit stacked on the base, so the members
are the merge commits on the **first-parent path** from `head` back to `base`,
and each contributes only its **own** subject:

```
git rev-list --first-parent <base>..<head>      # one commit per queue entry
```

via `repos/{REPO}/commits?sha=<head>` walking `parents[0]` until `<base>`, or the
compare API filtered to first-parent-path commits. A commit reachable only
through `parents[1]` (the PR branch's own history) must never contribute a
number.

Secondary hardening, both cheap:

- Only accept `^Merge pull request #(\d+)` for **queue** commits; the squash
  pattern should apply only if the repo's merge method is actually squash, and
  even then only on the first-parent path.
- **Verify each candidate is an open PR whose head is in this group** before
  printing it or labelling it. A number that resolves to an issue, or to a PR
  merged before the group's base, is a parse artifact — drop it silently and
  say the group is solo.
- Fail **closed on the naming, open on the parking**: when membership cannot be
  established confidently, park only the ref-named PR (today's degraded
  fallback, which is correct) and print "solo / membership unresolved" rather
  than a speculative list.

## Acceptance criteria

- [ ] A park on a solo queue entry names exactly the ref-named PR, regardless of
      how much history the PR branch carries.
- [ ] A `--self-check` fixture reproduces the #4074 shape: a queue merge commit
      whose second-parent history contains both `Merge pull request #X` and
      `title (#Y)` subjects, asserting neither X nor Y is reported.
- [ ] A number that does not resolve to a PR in the group is never printed as a
      co-member and never receives a `hold` label.
- [ ] A genuinely batched group (if `min_entries_to_merge` is ever raised) still
      names every real member.
