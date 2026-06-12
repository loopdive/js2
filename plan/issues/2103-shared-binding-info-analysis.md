---
id: 2103
title: "shared binding-info analysis — one mutation/capture/declaration-order oracle for all lowerings"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
related: [1970]
origin: "2026-06-11 analysis program (report 01 family F7 parent); stub 08-D18"
---

# #2103 — every lowering keeps its own stale binding snapshot

## Problem

Each lowering maintains a private snapshot of binding facts and forgets to
invalidate it: localMap shadows leak across if-branches (block-scope
issue), for-of/for-in iterate stale snapshots (mutation-not-observed
family), isStaticNaN ignores reassignment, rethrow ignores catch-param
reassignment, Map-destructuring conversion buffers go stale (#1970).
~12 June issues (BIND family).

## Root cause

No single binding-info oracle (assigned-after-init? captured? declaration
order? shadowing depth?) consulted by closure capture, const-folding,
snapshot caching, and scope save/restore.

## Fix direction

A per-function binding-analysis pass (one walk, memoized) exposing
queries; lowerings consume it instead of private snapshots. Large (M+);
members remain individually fixable meanwhile — this is the structural
parent for sprint 64+.

## Acceptance criteria

- The cited members' tests pass from oracle-backed lowerings
- A mutation-after-snapshot fuzz probe class stops regressing

## Dupe check

Member issues filed (several already fixed point-wise); no oracle issue
exists. New (analysis program).
