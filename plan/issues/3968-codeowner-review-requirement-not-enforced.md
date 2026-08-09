---
id: 3968
title: "`docs/ci-policy.md` §2 documents a CODEOWNER-review requirement that the ruleset does not enforce — decide whether to enforce it or document its absence"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: easy
task_type: ci
area: ci, merge-queue, policy
goal: ci-hardening
related: [3934, 1525]
origin: "Found while fixing #3934's required-check-list drift: the same ruleset query that proved `linear-tests` is not required also shows there is no `pull_request` rule at all."
---

# #3968 — §2's review requirement is a control the project believes it has and does not

## The evidence

The ruleset governing `main` contains exactly two rules:

```bash
gh api repos/loopdive/js2/rules/branches/main --jq '[.[].type]'
# ["required_status_checks","merge_queue"]
```

There is **no `pull_request` rule**, which is the rule type that carries
`required_approving_review_count`, `require_code_owner_review`,
`dismiss_stale_reviews_on_push` and `require_last_push_approval`. Classic branch
protection is not filling the gap either — that endpoint answers `404`:

```bash
gh api repos/loopdive/js2/branches/main/protection
# {"message":"Branch not protected", "status":"404"}
```

Verified 2026-08-01. Re-run both rather than trusting this date.

## What the docs claim

`docs/ci-policy.md` §2 "Reviewer policy" states, as policy that is applied:

- "**At least one approving review from a CODEOWNER** is required before a PR
  can merge."
- "**Stale reviews are dismissed** when new commits are pushed to the PR branch."
- "**The PR author cannot approve their own PR**, including admins."
- "**Code-owner review is required for every protected path** — the CODEOWNERS
  entry is treated as authoritative, not advisory."

None of those four is enforced. `CODEOWNERS` still routes review *requests*, so
the mechanism looks alive from inside a PR — reviewers get requested, the
Reviewers box populates — but nothing blocks a merge on it. §2 also builds a
`[skip-review]` label exception class on top of a requirement that does not
exist, so the exception is currently indistinguishable from the rule.

## Why this is worth its own issue rather than a docs patch

This is a different kind of finding from the `linear-tests` drift fixed in
#3934. That one was a **typo in a list** — the doc named a seventh required
check that was never in the ruleset, and correcting the prose fully resolved it.

This one is a **control the project believes it has**. Correcting §2 to say
"reviews are not enforced" *documents* the hole; it does not close it. And the
opposite move — adding a `pull_request` rule so the docs become true — changes
what is enforced on `main` for every contributor and every agent. That is an
enforcement-policy decision for the user, the same class as
`scripts/enable-branch-protection.sh` (which still lists `linear-tests` and
targets the dead classic API, and was deliberately left unedited in #3934 for
exactly this reason).

So this issue deliberately does **not** pick one. It records the measurement and
presents the decision.

## The decision

**Option A — enforce it.** Add a `pull_request` rule to the ruleset with
`require_code_owner_review: true`, `required_approving_review_count: 1`,
`dismiss_stale_reviews_on_push: true`. Makes §2 true as written.

- Note the interaction that has to be thought through first: **every agent PR in
  this project is self-merged.** With reviews enforced and self-approval
  disallowed, no dev agent could land its own work without a second party. That
  is either the point or a full stop, depending on intent, and it is not a
  decision to make by side effect.

**Option B — document the absence.** Rewrite §2 to state that review is
advisory: `CODEOWNERS` routes review requests, the merge gate is the six
required checks plus the merge queue. Keep the `[skip-review]` section only as
convention. Cheapest, honest, changes no behaviour.

**Either way**, §2 should carry the verification command inline the way §1 and
§7 now do after #3934, so the next reader re-checks instead of trusting prose.

## Acceptance

1. `docs/ci-policy.md` §2 matches the live ruleset — whichever direction the
   decision goes.
2. §2 carries the `gh api repos/loopdive/js2/rules/branches/main` query inline.
3. If Option A: the ruleset actually contains a `pull_request` rule afterwards,
   verified by re-running the query, and the self-merge interaction above is
   explicitly addressed in the same change.
4. If Option B: the `[skip-review]` exception class is either removed or
   restated as convention, since an exception to an unenforced rule is noise.

## Notes

- Related unresolved discrepancy from the same sweep (#3934):
  `scripts/enable-branch-protection.sh` still lists `linear-tests` as required
  and PATCHes the classic protection API, which `main` does not use. Documented
  in §8; not fixed, for the same "that is an enforcement change" reason.
- The ruleset does enforce **strict** required status checks
  (`strict_required_status_checks_policy: true`), which is why PRs report
  `BEHIND` until they are up to date with `main`. That part of the docs is
  accurate.
