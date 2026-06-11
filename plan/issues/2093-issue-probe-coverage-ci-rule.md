---
id: 2093
title: "issue→probe coverage CI rule: bugfix issues cannot flip to done without a permanent probe/test reference"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
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
