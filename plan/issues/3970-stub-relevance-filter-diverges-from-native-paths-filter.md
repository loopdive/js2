---
id: 3970
title: "INVARIANT: the stub's relevance filter and GitHub's native `paths:` filter must agree — measured, they don't on stale branches"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: s
feasibility: easy
task_type: ci
area: ci, merge-queue
goal: ci-hardening
related: [3934, 3968]
origin: "Measured on probe PR #3952 while constructing the masking experiment for #3934: a path-excluded PR took the stub's SILENT arm because the branch was stale."
---

# #3970 — the two mirrors disagree on stale branches

This is filed as an **invariant with a measurement**, not a fix proposal. Nothing
is broken today. The reason it is worth an id is that the only thing making the
divergence harmless is incidental, and it will stop being harmless the moment
anyone changes what the stub publishes.

## The invariant

`.github/workflows/test262-pr-stub.yml`'s `detect` job and
`test262-sharded.yml`'s native `paths: &test262-paths` filter are supposed to be
**mirrors**: exactly one of the two workflows owns the three test262 required
contexts on any given PR. The stub's header says so explicitly, and
`scripts/test262-paths-match.sh` exists to be the single source of truth both
sides read.

**They must agree on every PR.** They currently do not.

## The measurement

Probe PR #3952, first control round (sha `618961b3`). The PR's own diff touched
**one file**, `plan/issues/3934-probe-control-duplicate.md` — not a test262-relevant
path by any reading. Expected: stub takes the GREEN arm and publishes the three
contexts.

Observed (run 30691153399, `.github/workflows/test262-pr-stub.yml`):

```
success  test262 PR stub — detect relevance
skipped  cheap gate (main-ancestor + lint)
skipped  merge shard reports
skipped  check for test262 regressions
```

`detect` **succeeded** and decided `stub_required=false` — the SILENT arm, i.e.
"a test262 path changed, the real workflow owns these". The real workflow did not
run: GitHub's native filter correctly saw a path-excluded PR.

## The mechanism

The branch was `BEHIND`. `detect` computes the changed-file set as a **two-dot**
diff:

```
git diff --name-only $BASE_SHA $HEAD_SHA     # base TIP .. head
```

`BASE_SHA` is `pull_request.base.sha`, the base branch **tip at event time** — not
the merge base. On a stale branch that diff therefore contains every file `main`
itself changed since the branch point, which on this repo always includes
`src/**`. The matcher sees `src/...`, says `true`, and the stub goes silent.

GitHub's native `paths:` filter for `pull_request` events evaluates the **PR's
own** changed files (merge-base..head), so it is unaffected by main moving. Hence
the disagreement, and it appears precisely when a branch falls behind — which on
this repo is most branches, most of the time, since the ruleset enforces
`strict_required_status_checks_policy: true` and `main` moves every few minutes.

**#3934 did not introduce this and deliberately did not change it.** Its
acceptance criterion #3 was "the narrowed fetch must produce the SAME verdict",
and the merge-ref parents it now diffs (`HEAD^1`..`HEAD^2`) are the same two
commits as `BASE_SHA`..`HEAD_SHA`. The semantics were preserved on purpose. This
issue is about the semantics themselves.

## Why it is harmless today, and why that is not reassuring

When the stub goes silent on a PR the real workflow also skips, **nothing
publishes SUCCESS for the three names** — they land as `skipped`, and a `skipped`
required check satisfies branch protection (measured in #3934). So the PR merges
and the merge queue runs the authoritative validation on the merged state.

The safety therefore rests entirely on the incidental fact that **the divergent
arm publishes `skipped` rather than SUCCESS**. It is not protected by the mirror
being correct — the mirror is wrong, and something downstream happens to absorb
it.

Two consequences a reader would not reconstruct from the code:

1. **The stub's green arm is quietly rarer than the design assumes.** The whole
   workflow exists to publish those three contexts green on path-excluded PRs.
   On any stale path-excluded PR it doesn't — it silently declines and the
   `skipped` conclusions carry the PR instead. The mechanism the workflow was
   built for is firing less than anyone thinks.
2. **It becomes a live correctness bug on first contact with any change** that
   makes the stub's green arm authoritative, or that alters what the silent arm
   publishes, or that promotes `detect`'s verdict into a gate. At that point the
   divergence stops being absorbed — and by then this measurement is gone and the
   next person rediscovers it from a symptom.

## What "fixed" would mean

Not prescribing an approach, but the shape is: `detect`'s changed-file set must
be the PR's own diff (merge-base..head), the same set GitHub's filter uses.

Whatever is chosen must keep #3934's structural properties — the job must stay
un-killable (bounded, `continue-on-error` steps; `if: always()` verdict; job
budget unreachable) and must not restore a full-ref fetch. Note the known trap if
the changed-file list is taken from `gh api pulls/N/files`: that endpoint is
paginated and **capped at 3000 files**, and a truncated list drops paths, which
would flip a src PR onto the green arm and report SUCCESS for a name the real
workflow owns — the exact masking that PR #496 introduced and commit `c9688f33b`
backed out. Any such implementation must floor the count against
`.changed_files` and degrade when they disagree.

## Acceptance

1. A test262-**irrelevant** PR whose branch is stale (`BEHIND`) takes the stub's
   GREEN arm — the three contexts publish `success`, not `skipped`.
2. A test262-**relevant** PR still takes the silent arm regardless of staleness,
   so the two producers never both report SUCCESS for a name.
3. The mirroring ratchet in `tests/issue-3934.test.ts` still passes, extended
   with a stale-branch case.
4. `detect`'s structural properties from #3934 are unchanged: no `fetch-depth: 0`,
   step budgets sum below the job budget, verdict step `if: always()`.
