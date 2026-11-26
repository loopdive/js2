---
id: 7451
title: "`tests/issue-3000-e` has 2 failing host-lane tests on main"
status: ready
created: 2026-11-22
updated: 2026-11-22
priority: low
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354]
---

# #7451 — `tests/issue-3000-e` has 2 failing host-lane tests on main

## Problem

Two tests in `tests/issue-3000-e*.test.ts` fail on `main` in the JS-environment lane (seen 2026-11-22 while reviewing an unrelated PR). They are not in a required check, so the failure is silent.

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- Both tests pass, or are deleted with a reason if they pin retired host-lane behaviour.
