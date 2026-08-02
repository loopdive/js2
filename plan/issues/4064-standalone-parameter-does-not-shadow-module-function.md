---
id: 4064
title: "A parameter does not shadow a module-level function of the same name in standalone — silently infinite-recurses"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: core-semantics
---
# A parameter does not shadow a module-level function of the same name in standalone — silently infinite-recurses

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found by L-strwith 2026-08-01 while working an unrelated lever (String.prototype).
A/B-confirmed by file-copy revert against upstream/main (no stash). NOT introduced by
any current work. Nobody owns it.

⚠ THIS IS A CORRECTNESS BUG, NOT A CONFORMANCE NUMBER. Prioritise it on that basis:
it does not merely fail a test, it makes correct user code hang. Any program with
this shape silently infinite-loops in standalone mode.

REPRO (minimal, standalone target):
    function g(test) { return test(); }
    export function test() { return g(() => 7); }
  Node: returns 7.
  standalone: "Maximum call stack size exceeded".

MECHANISM (hypothesis, NOT yet root-caused — verify before fixing): the parameter
`test` does not shadow the module-level function declaration `test`, so the call
`test()` inside `g` resolves to the module-level function rather than the argument,
and recurses forever. This is a scope-resolution defect in the standalone lowering,
almost certainly in identifier resolution / environment-record construction, not in
codegen for calls.

WHY IT MATTERS BEYOND ITS OWN TESTS:
- It cost L-strwith a full test run before being identified, because the failure
  presents as a stack overflow in an unrelated test rather than as a scoping error.
- Shadowing a same-named outer binding with a parameter is an extremely common JS
  idiom, and test262 harness code uses it. Any test whose harness hits this shape
  fails for a reason that has nothing to do with what it is testing — so this may
  be inflating unrelated buckets across the corpus.
- FIRST ACTION: census how many corpus files contain a parameter that shadows a
  same-named module-level function declaration. That converts "one repro" into a
  population, and may explain part of the 202 unclassified files in the tail census
  (PR #3980). Use trigger-shape enumeration: files without the shape compile
  identically and cannot move.

CHECK BOTH LANES before scoping — L-strwith reported it as a standalone
observation; whether the host/gc lane shares it is unmeasured and changes the owner.

DISCIPLINE: validate any probe against Node FIRST (this one was), no `as any` casts
(test262 has none), positive-control the census detector, and re-run apparent flips
solo — contention flakes are live on this box.

Allocate an id at pickup (`node scripts/claim-issue.mjs --allocate --by ttraenkler/<agent>`,
CLAIM_ASSIGN_REMOTE=upstream, and EXPORT GIT_AUTHOR_NAME/EMAIL or it exits 6).
