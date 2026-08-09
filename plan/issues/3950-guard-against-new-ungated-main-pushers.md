---
id: 3950
title: "nothing stops the NEXT workflow from pushing to main un-gated — the #3915 gate has no enforcement"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: s
feasibility: medium
task_type: infrastructure
area: ci
goal: release-pipeline
depends_on: [3915]
related: [1951, 3914]
---

# The #3915 gate is a convention, not a constraint

## Problem

#3915 established that **every push to `main` from a workflow must be gated on
the merge queue**, because an un-gated one discards the in-flight `merge_group`
validation (and `[skip ci]` does not prevent that). Four workflows push `main`;
all four are now gated — two inline from #1951, two via
`scripts/main-push-queue-gate.mjs` from #3915.

**Nothing enforces the fifth.** The rule lives in `docs/ci-policy.md` prose and
in a test that hardcodes today's four-workflow list
(`tests/issue-3915-main-push-queue-gate.test.ts`, "class coverage"). A new
workflow that pushes `main` without the gate passes every required check, and
the only symptom is the one #3915 documents as **invisible**: no failure, no
park, no label — a green validation silently vanishes and a new one starts.

That is exactly how this bug survived: `benchmark-refresh` had been pushing
`main` un-gated since #1216, through the entire #1951 discussion that named the
mechanism, because #1951 only fixed the two pushers its author was looking at.

## Why it was not bundled into #3915

The obvious implementation — a script that greps `.github/workflows/*.yml` for
`git push` and demands a nearby gate reference — has to accept **two** shapes
(the shared script, and #1951's inline `mergeQueue` GraphQL query), and has to
classify every `git push` in the tree, including the several that legitimately
target the baselines repo or `labs/graph-data`. A textual gate with two accepted
shapes and a fuzzy target-detection heuristic is plausibly more expensive to
maintain than the thing it guards. It deserves its own design, not a rider on a
fix.

## What a good version does

The load-bearing property is not "find `git push`" — it is **"no push to `main`
can be introduced without the author making a decision."** Options, roughly in
increasing order of robustness:

1. **Annotation-required.** Every `git push` line in `.github/workflows/**` must
   carry a machine-readable target declaration
   (`# main-push: gated` / `# main-push: no — pushes <repo/branch>`). The check
   fails on any unannotated `git push`, so an unrecognised push form is a hard
   error rather than a quiet pass — the "must be able to say I don't know"
   discipline applied to the checker itself. Costs a one-time annotation pass
   over ~12 workflows.
2. **Detect by credential.** Every push to `main` in this repo goes through the
   `MAIN_DEPLOY_KEY` deploy key (GITHUB_TOKEN is blocked by ruleset GH013). So
   "job references `MAIN_DEPLOY_KEY`" is a much tighter and more meaningful
   predicate than "job contains `git push`", and it has no false positives from
   baselines-repo pushes. **This is probably the right one** — the capability,
   not the syntax.
3. **Server-side.** A branch-ruleset or a `push`-triggered audit workflow that
   flags any commit on `main` authored by `github-actions[bot]` that landed
   while the queue was non-empty. Detects the actual event rather than the code
   shape, but only after the fact.

Option 2 plus a narrow version of option 3 (report-only) is likely the best
value: one grep for a secret name, and an after-the-fact signal that makes the
invisible failure visible.

## Acceptance criteria

- [ ] A new workflow job that can push `main` (i.e. references
      `MAIN_DEPLOY_KEY`) fails CI unless it also invokes the queue gate or
      carries an explicit, reviewed exemption.
- [ ] The check is positive-controlled: removing the gate from
      `benchmark-refresh.yml` must fail it. A test that has not been seen fail
      is not a test.
- [ ] Any exemption records _why_, so the next reader can tell a deliberate
      exemption from an oversight.
- [ ] The hardcoded four-workflow list in
      `tests/issue-3915-main-push-queue-gate.test.ts` is replaced by, or
      cross-checked against, the derived list.
