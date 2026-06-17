---
id: 2084
title: "module-global object access: reads re-emit null-check+throw per access (survives -O); writes have NO check and trap instead of TypeError"
status: done
completed: 2026-06-16
assignee: ttraenkler/dv3
sprint: 62
created: 2026-06-11
updated: 2026-06-16
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

## Resolution (2026-06-16, dv3) — write-path null guard (acceptance (a))

Recovered the suspended write-path fix and re-applied it against current
`upstream/main` (the suspended worktree's `assignment.ts` had drifted off an
older main and could not be copied wholesale). In `compilePropertyAssignment`
(`src/codegen/expressions/assignment.ts`), the struct-field store path now
null-guards the receiver: when the receiver is a nullable `(ref null $T)` and
not statically provably non-null, it stashes the RHS, `ref.is_null`-checks the
receiver, and emits `typeErrorThrowInstrs(ctx, target)` on null — otherwise the
direct `local.tee` / `struct.set` is preserved. The guard predicate
(`structObjResult.kind === "ref_null" && !isProvablyNonNull(...)`) mirrors the
array-element write guard already in this file, so `new Foo()` / `this` writes
keep their unguarded fast path.

A null-receiver write now throws a **catchable** `TypeError` instead of trapping
uncatchably — closing the error-model divergence (family #581/#2025).

Tests: `tests/issue-2084.test.ts` (4 cases) — catchable TypeError on null write,
normal module-global write, class instance-field write, compound + nested
writes. All green; `tsc --noEmit` clean.

**Carried forward (acceptance (b), separate follow-up):** eliminating the
per-access READ null guard for statically-non-null module objects (non-nullable
globals initialised in the start function) is an efficiency optimisation with a
high blast radius (start-function init ordering, every member-read site). It is
*not* a correctness bug — left for a dedicated issue. This PR closes the
correctness half (the error-model bug named by the title/#581 family).
