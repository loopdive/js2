---
id: 7460
title: "Merge queue: two test262 shards of a merge-group run were cancelled from outside, with no failing test"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: low
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354]
---

# #7460 — Merge queue: two test262 shards of a merge-group run were cancelled from outside, with no failing test

## Problem

Run 45070148390 (merge group of PR 7403, 2026-11-22): standalone shards 80/102 and 98/102 were cancelled at the same second (21:16:56 UTC) while running; 100 shards were green, no `merge shard reports` job ran, the run ended as failed, and auto-park did not act. A single re-run of the failed jobs passed and the PR merged. Nothing pushed to main at that time. Cause unknown; candidates: a concurrency group shared with a `pull_request` run (PR 7408 was opened at 21:17), runner loss.

## Acceptance criteria

- The cause is identified from the workflow's concurrency settings and the run's audit trail.
- A cancelled merge-group shard is retried once automatically or parks the PR with a clear message; it never leaves the PR waiting silently.
