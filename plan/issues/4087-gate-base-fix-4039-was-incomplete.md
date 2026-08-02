---
id: 4087
title: "#4039's gate-base fix was INCOMPLETE — at least 5 more scripts still hardcode `origin/main`, including `pre-dispatch-gate.mjs`, which therefore reads merged-ness from the FORK's stale main"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: [4002, 4039, 4045, 4080]
---

# #4039 fixed three sites and never swept for the rest

Filed by the lead 2026-08-02, against **its own earlier fix**. Surfaced by the
`H-crashes` lane hitting the symptom, then confirmed by an exhaustive sweep of
`upstream/main`.

## Background

#4002/#4039 established that in an agent checkout `origin` is the **fork**
(`ttraenkler/js2`), whose `main` lags upstream — **189 commits** as measured
today. Any gate that diffs against `origin/main` therefore treats every commit
upstream landed since the last fork sync as part of the branch's change-set.

#4039 introduced `resolveMainRef()` in `scripts/lib/change-scope.mjs` and wired
**three** sites: `change-scope.mjs`, `check-issue-ids.mjs`, and
`scripts/hooks/changed-root-tests.sh`. **It never audited for other scripts
doing their own base resolution.** That is the identical failure mode as #4080's
family — *a correct treatment exists and consumers were never wired to it* —
committed by the fix that was supposed to end it.

## Verified on `upstream/main`

Only two files reference `resolveMainRef` (`check-issue-ids.mjs`,
`lib/change-scope.mjs`; plus the shell twin in `changed-root-tests.sh`). These
resolve a base **independently**:

| script | line | default |
| --- | --- | --- |
| `scripts/check-issue-spec-coverage.mjs` | 44 | `ISSUE_COVERAGE_BASE \|\| "origin/main"` |
| `scripts/check-verdict-oracle-bump.mjs` | 164 | `VERDICT_ORACLE_BASE \|\| "origin/main"` |
| `scripts/check-merged-issue-integrity.mjs` | — | `base-ref` default `origin/main` |
| `scripts/check-baseline-floor-staleness.mjs` | 52 | `MAIN_REF ?? "origin/main"` |
| `scripts/pre-dispatch-gate.mjs` | 65, 70 | `git ls-tree … origin/main` / `git show origin/main:…` |

## ⚠ The `pre-dispatch-gate.mjs` case is the dangerous one

That gate decides **"is this issue already done — do NOT re-implement"** by
reading the issue file from `origin/main`:

```js
const issueOnMain = sh("git", ["ls-tree", "-r", "--name-only", "origin/main", …]);
const body        = sh("git", ["show", `origin/main:${issueOnMain[0]}`]);
if (status === "done" || status === "wont-fix") blockers.push(…);
```

In a fork checkout `origin/main` is stale, so an issue that **is** `done` on real
main but whose file has not reached the fork's main **reads as not-done, and the
gate raises no blocker**. It therefore *permits* the duplicate dispatch it exists
to prevent — a silent false-negative in the primary defence against cross-lane
duplicate work.

This is the same shape as #4045 (a ledger answering from the wrong book) and
#4002 (gates blaming files the branch never touched): **an instrument answering
honestly about a different question.**

## The symptom that surfaced it

`check-issue-spec-coverage` **exits 0 locally and fails in CI**. Only
`ISSUE_COVERAGE_BASE=upstream/main` reproduces the CI verdict. An agent trusting
the green local run pushes and burns a cycle — measured today on PR #4015.

## Work

1. Route every script in the table through `resolveMainRef()`. Keep the existing
   env overrides winning, exactly as #4039 did.
2. **Then sweep for the general case rather than fixing this list** — the defect
   here was a fix applied to known sites instead of to a searched population.
   `grep -rn 'origin/main' scripts/ .husky/` and classify each hit as
   *diff base* (must resolve) vs *prose/comment* (leave).
3. Make every one of them **print the base it used**, as #4039's three do
   (`base: merge-base(upstream-remote(origin-is-a-fork))`). A wrong base must be
   visible, not silent.

## ⚠ CI cannot regression-test this — same as #4039

In Actions `origin` **is** upstream, so buggy and fixed resolvers agree there by
construction. A CI-only test is vacuous. #4039's issue documents the
throwaway fork-shaped-repo lab that does reproduce it; reuse that, and note its
recorded trap: **branching the test repo from the FORK's main makes both arms
agree** — the divergence only appears when the branch is cut from `upstream/main`,
which is the real workflow.
