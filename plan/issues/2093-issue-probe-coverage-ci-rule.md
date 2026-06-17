---
id: 2093
title: "issue→probe coverage CI rule: bugfix issues cannot flip to done without a permanent probe/test reference"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [2092]
origin: "2026-06-11 analysis program (report 06 §2); stub 08-C8"
---

# #2093 — nothing forces a repro into the permanent suite

## Problem

Nothing forces a bugfix issue's repro into the permanent test suite — the
next sweep's bugs will again have no armor. The June fix wave added
issue-NNNN tests by convention only.

## Root cause

No gate.

## Plan

`scripts/check-issue-spec-coverage.mjs` wired into the required `quality`
job: WARNING when an issue reaches `status: ready` without a probe
reference; HARD FAIL when a PR flips `status: done` with no probe/test
reference in the issue file or PR. Cutoff `created >= 2026-06-15` (no
retroactive noise).

## Acceptance criteria

- Gate live in `quality`; a done-flip without test reference fails CI
- Pre-cutoff issues unaffected

## Dupe check

The fork's post-merge automation issue (2048 slug) covers status flipping,
not test coverage. New (analysis program).

## Resolution (2026-06-16, dev-b)

- **`scripts/check-issue-spec-coverage.mjs`** — diffs the issue files CHANGED in
  the PR (against `origin/main`, falling back to `HEAD^`) and, for those
  `created >= 2026-06-15`:
  - `status: done` with NO probe/test reference → **HARD FAIL** (exit 1)
  - `status: ready` with NO probe/test reference → **WARNING** only
  A probe reference is satisfied by either a `tests/issue-<id>.test.ts` file on
  disk OR a cited `tests/…test…(.ts|.mjs|.js)` / `test262/…` path in the issue
  body. Non-behavioural `task_type`s (infrastructure/tooling/docs/process) are
  exempt — they have no runtime repro. Skips cleanly when no diff base resolves
  (never blocks a build it can't reason about); `--all` scans every issue.
- **`package.json`** — `check:issue-spec-coverage` script.
- **`ci.yml` `quality` job** — new "Issue→probe coverage gate (#2093)" step
  (fetches the base ref, runs with `ISSUE_COVERAGE_BASE=origin/main`).

The cutoff keeps the gate off the pre-existing backlog (this issue itself is
pre-cutoff + infra, so its own done-flip is exempt).

Tests: `tests/issue-2093.test.ts` (6 cases — done-without-probe FAIL; done-with
`tests/issue-<id>.test.ts` pass; done-with-test262-body-cite pass; pre-cutoff
grandfathered; ready→WARNING-not-fail; infra task_type exempt). All pass.

**Acceptance:**
- [x] Gate live in `quality`; a done-flip without test reference fails CI
- [x] Pre-cutoff issues unaffected (created < 2026-06-15 skipped)
