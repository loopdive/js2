---
id: 1979
title: "IR: mid-body `if (cond) stmt;` in a void function silently skips ALL subsequent statements when cond is true"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1228, 1131, 1850, 1858]
origin: "2026-06-10 deep-audit sweep (IR agent): verified on main @ 0c753ea88, IR path"
---

# #1979 — early-return-if rewrite treats non-terminating then-arms as terminating

## Problem

The Phase-2 "early-return if" rewrite turns `if (cond) <tail>; <rest>` into
`if (cond) <tail> else { <rest> }` — sound only when the then-arm terminates.
Slice 14 (#1228) made a non-terminating `ExpressionStatement` a valid void
"tail", so the true branch **returns** instead of falling through.

## Repro (verified; IR path proven via claim logs + flips with `experimentalIR: false`)

```ts
class Box { v: number = 0; }
function g(b: Box): number { b.v = b.v + 100; return b.v; }
function h(b: Box): number { b.v = b.v + 1; return b.v; }
export function f(b: Box, a: number): void {
  if (a > 0) g(b);   // non-terminating then-arm
  h(b);              // must run regardless
}
```

`f(b, 1)` → IR: `b.v = 100` (h skipped) — legacy: `101` — node: `101`.

## Root cause

- `src/ir/select.ts:797-801` accepts the mid-body if with
  `isPhase1Tail(thenStatement, …, isVoidReturn)`; select.ts:1213-1215 accepts
  any ExpressionStatement as a void tail.
- `src/ir/from-ast.ts:481-517` (`lowerStatementList`) lowers the then-arm via
  `lowerTail`, which for void functions lowers the expression and **emits
  `terminate({kind:"return"})`** (from-ast.ts:586-590).

Scope constraint: only claimed when `<rest>` itself ends in a claimable tail —
a trailing for-loop shape falls back and is unaffected.

## Fix direction

Require the then-arm to be a *terminating* tail (return/throw or block ending
in one) in the mid-body early-if context: don't pass the `isVoidReturn`
relaxation into `isPhase1Tail` from select.ts:799, or don't let `lowerTail`'s
void-ExpressionStatement arm synthesize a return when reached via the
`lowerStatementList` rewrite (from-ast.ts:512). Alternatively lower
non-terminating then-arms as a plain side-effect `if` followed by the rest.

## Acceptance criteria

- Repro matches Node/legacy (`101`)
- True early-return `if (cond) return; rest` unregressed
- IR fallback counts don't grow (fix in lowering, not by rejecting)

## Dupe check

#1228 (introduced the relaxation; tests only cover early-*return*),
#1131/#1850/#1858 umbrellas — none mention this.

## Resolution (2026-06-12)

Fixed in `src/ir/from-ast.ts` `lowerStatementList`, in lowering (the selector
still claims the shape, so IR fallback counts are unchanged):

1. Added `thenArmTerminates(stmt)` — true for `return`/`throw`, a block ending
   in a terminating tail, or an `if/else` where both arms terminate.
2. The mid-body `if (cond) <then>; <rest>` branch now splits on it:
   - **Terminating then-arm** → the original early-return rewrite
     (`if (cond) <tail> else { <rest> }`) — unchanged.
   - **Non-terminating then-arm** → a converging guard: `br_if cond → then /
     cont`; the then-block lowers the side effect and `br`s to `cont`; the
     false branch targets `cont`; `cont` holds `<rest>` (or the implicit void
     return when `<rest>` is empty). Both paths run the rest.
   - The compile-time constant-fold branch (`evaluateConstantCondition`) got
     the same split — a true-but-non-terminating then-arm now lowers its side
     effect and falls through instead of synthesizing a return.

### Test Results

New `tests/issue-1979.test.ts` — 6 cases, all pass:
- `if (a>0) g(b); h(b);` → `f(b,1)=101` (was `100`, h skipped), `f(b,0)=1`.
- Non-terminating guard at end of fn → runs (`101`/`1`).
- True/false early-RETURN guard → still short-circuits / falls through
  (`0`/`1`) — unregressed.
- Non-void early-return recursion `fact(5)=120` — unregressed.

`tests/issue-1228.test.ts` (9/9), `tests/issue-1280.test.ts`,
`tests/ir/issue-1373*.test.ts`, `tests/ir/issue-1392.test.ts` all pass.
`pnpm run check:ir-fallbacks` OK (no unintended increases). `tsc --noEmit`,
`biome lint`, `prettier --check` clean. Pre-existing `tests/ir/passes.test.ts`
/ `inline-small.test.ts` failures are unrelated (confirmed on clean main).
