---
id: 2084
title: "module-global object access: reads re-emit null-check+throw per access (survives -O); writes have NO check and trap instead of TypeError"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [2017, 581]
origin: "2026-06-11 WAT quality review (fable agent): observed on main"
---

# #2084 — read/write asymmetry on (ref null $T) module globals

## Problem

For `const o = {x:1}; o.x; o.x = 42;` at module scope, every READ emits
`global.get $o / ref.is_null / (if (then throw TypeError) (else
struct.get))` — even immediately after `global.set (struct.new …)`, and
the guard survives -O verbatim. Every WRITE emits `global.get $o /
struct.set` with NO check — a null receiver traps uncatchably instead of
throwing TypeError (error-model divergence, same family as #581/#2025).

## Root cause

Module objects live in `(ref null $T)` mutable globals; the member-read
path emits the guard per access while the assignment path skips it
(src/codegen/expressions.ts member access vs assignment lowering).

## Fix direction

(a) Symmetry: add the guard to the write path (catchable TypeError).
(b) Efficiency: use non-nullable globals initialized in the start
function where the initializer is statically non-null, eliminating the
read guards entirely.

## Acceptance criteria

- Null-receiver write throws catchable TypeError
- Statically-initialized module objects emit no per-access null checks

## Dupe check

#2017 (getter-only write), #581 (trap catchability family) — the
store-path gap and the guard redundancy aren't covered. New (low).

## Suspended Work (2026-06-11, infra incident)

The implementing dev was terminated by a team-store wipe near completion.
State preserved in worktree `/workspace/.claude/worktrees/issue-2084-global-guard`
(branch `issue-2084-global-guard`): UNCOMMITTED 38 insertions in
src/codegen/expressions/assignment.ts (write-path null guard) plus
tests/issue-2084.test.ts. Likely close to done — review the diff, run the
test, finish acceptance (read-guard elimination half may be unstarted),
commit (✓), push `--no-verify`, PR with `-R loopdive/js2`.
