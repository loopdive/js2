---
id: 7555
title: "CLAUDE.md: one issue per PR"
status: done
sprint: current
created: 2026-11-27
updated: 2026-11-27
completed: 2026-11-27
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: docs
area: process
goal: ci-hardening
related: [7354]
---

# #7555: one issue per PR

## Problem

The #7354 slices (L0a, L0b, L0c, W2, A1a, O2, …) each became a section of one
issue file instead of an issue of their own. The file is now too long to read,
and an issue no longer says what one PR did.

## Implementation Plan

Add the project lead's rule to CLAUDE.md, in "Merge protocol" next to the
docs-only rule: every code PR has its own issue file; a larger effort keeps a
parent issue that lists its children; docs-only PRs stay grouped.

## Result

CLAUDE.md carries the rule. Open PRs keep the issue they have.
