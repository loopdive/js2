---
id: 4070
title: "Add a `never` exhaustiveness check to `verify.ts` `collectUses` — a new IR kind currently fails at runtime, not compile time"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: n/a
goal: backend-agnostic-ir
---
# Add a `never` exhaustiveness check to `verify.ts` `collectUses` — a new IR kind currently fails at runtime, not compile time

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found by the #2952 slice-4 dev (2026-07-25) while adding two new IR instruction kinds. Small, high-leverage type-safety fix.

PROBLEM: the local `collectUses` switch in `src/ir/verify.ts` has NO `never` exhaustiveness default. When a new IR instruction kind is added without a corresponding case, it does not fail to compile — it surfaces as a **runtime TypeError at claim time**. That is the worst failure shape for this codebase: the IR path demotes failures to a severity-`warning` channel, so a claim-time throw can become a silent legacy fallback rather than a loud error.

WHY IT MATTERS NOW: the IR migration's whole remaining programme is "add more IR kinds" (#2952 tail-position switch + string-literal cases, for-in, #3518's R2-R8 spine, #2949 dynamic values). Every one of those is an opportunity to hit this. The cost of the gate is a few lines; the cost of not having it is a silent miscompile discovered later.

PRECEDENT: this pattern is already the established convention elsewhere in the repo — per CLAUDE.md, the emitter's `default` case IS a `never` exhaustiveness check, so "a new union variant without an encoding case is a compile error." `collectUses` simply never got the same treatment. This is bringing one straggler in line with an existing house rule, not inventing a policy.

SCOPE:
1. Add the `never`-typed default to `collectUses` in `src/ir/verify.ts` so a missing case is a compile error.
2. Sweep for sibling switches over the IR instruction union that lack the same guard (verify.ts, lower.ts, passes/, from-ast.ts) and fix them the same way. Do not change behavior — this is purely making an existing hole loud.
3. Confirm `pnpm run typecheck` still passes and that deliberately removing a case now fails to compile (prove the gate actually works; a guard that doesn't fire is worse than none).

ALSO RECORDED (separate, pre-existing, do NOT conflate): `tests/issue-1169n`'s `??` fallback test fails identically on pristine main — a hard `[IR-FALLBACK]` where a demote was expected. Already documented in #2952; not caused by slices 3/4.
