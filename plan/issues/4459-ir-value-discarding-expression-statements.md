---
id: 4459
title: "IR: adopt value-discarding expression statements (`x + 1;`, `x;`, `cond ? a : b;`)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: statements
goal: ir-full-coverage
related: [3518, 3583]
origin: "2026-08-15 IR-migration session — matrix residual on the ExpressionStatement row (measured in #3583)"
---

# #4459 — Adopt value-discarding expression statements

## Problem

The `ExpressionStatement` adoption-matrix row is `mixed`: calls, assignments,
compound assigns and pre/post `++ --` claim, but VALUE-DISCARDING statements
still reject (measured 2026-08-15, #3583):

- `x + 1;` → `nontail-compound-or-binary-stmt`
- `x;` / `1;` / `cond ? a : b;` → `nontail-exprstmt-other`

These shapes are common in real code (expression statements for side effects
of getters/calls inside ternaries, dead reads kept for documentation) and each
occurrence rejects the WHOLE containing function.

## Implementation plan (fable lane, 2026-08-15)

1. Lower a value-discarding expression statement as: lower the expression via
   the existing expression arms, then DROP the produced value (emit `drop` for
   a value-kinded result; nothing for a void result). Reuse the buffered
   statement machinery from #2952 slice 2 (`if.stmt` pattern) for placement
   inside loop/try bodies.
2. Evaluation-order discipline: the expression must still evaluate fully for
   side effects (calls, getter reads through claimed surfaces). Shapes whose
   sub-expressions the IR cannot lower keep rejecting through the normal
   expression arms — this slice removes only the STATEMENT-position gate, so
   claim ⇔ lowering parity is inherited from the expression layer.
3. Retire the two selector arms (`nontail-compound-or-binary-stmt`,
   `nontail-exprstmt-other`) for lowerable expressions; keep them for
   expressions the phase-1 walker cannot admit.
4. Tests `tests/issue-4459.test.ts`: claim + runtime semantics (side-effecting
   discarded call; discarded ternary with side-effecting arms — only the taken
   arm evaluates) + dual-run legacy↔IR equality + negative boundary (a
   discarded expression containing a rejecting construct still demotes
   cleanly).
5. Matrix row update via `scripts/gen-ir-adoption.mjs` + `pnpm run
   gen:ir-adoption`.

## Acceptance criteria

1. The four measured shapes above claim and run correctly (node-equivalent).
2. `check:ir-fallbacks` no growth; `gen:ir-adoption --check` clean.
3. ExpressionStatement row Notes updated from measurement, not prose.
