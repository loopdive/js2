---
id: 4459
title: "IR: adopt value-discarding expression statements (`x + 1;`, `x;`, `cond ? a : b;`)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
assignee: ttraenkler/opus-4459
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
# The statement-position gate lives in the two selector walkers and their two
# lowerer twins; splitting a 4-arm predicate out of them would need the
# module-private `shapeNo`/`isPhase1Expr`/`isPhase1ConditionExpr` threaded as
# callbacks, which costs more than the +130/+22 lines it saves.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
# `isPhase1StatementListInScope` sat exactly ON its 347-line budget, so the
# one-line arm + its comment trips the gate no matter how it is worded; the
# arm has to live in this walker because that is where the statement-position
# gate is.
func-budget-allow:
  - src/ir/select.ts::isPhase1StatementListInScope
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

## What landed (2026-08-15)

**The lowering already existed.** `lowerDiscardedExpression` (from-ast.ts) has
always handled paren / `void` / ternary / comma / call discards — it is the
path `return voidCall()` and bare statement calls take. Step 1 of the plan
("lower … then DROP the produced value") therefore needed no new lowering: the
IR simply never consumes the SSA result, and the existing `if.stmt` arm-buffer
machinery was already in place for the ternary. The whole gap was the
STATEMENT-POSITION gate in the selector.

- `src/ir/select.ts` — `isPhase1DiscardedExpr` mirrors `lowerDiscardedExpression`
  arm for arm; `expressionStatementIsPhase1Discardable` is the shared gate used
  by BOTH the top-level statement-list walker and the body-buffer walker.
- `expressionStatementMutatesAtTopLevel` (exported, also consumed by from-ast)
  keeps every mutating shape on its dedicated arm — those arms carry binding
  bookkeeping (`clearProjectionBinding`, class-binding propagation, module-slot
  writes) that the generic expression walker does not do.
- `probeShape` snapshots and restores `shapeRejectDetail` **and** the latched
  `typedShapeRejectReason` around a declined probe. Without the second one a
  failed probe could have moved a function into a different
  `check:ir-fallbacks` bucket — a gate failure caused purely by diagnostics.
- `src/ir/from-ast.ts` — both dispatchers fall through to
  `lowerDiscardedExpression` for non-mutating shapes; a mutating shape reaching
  there is a genuine selector↔builder divergence and still throws.

## Test Results

`tests/issue-4459.test.ts` — **32 passed**.

Newly claiming (all emission-backed via `irBodyEmitted`, all legacy-equivalent):
`x + 1;` · `x;` · `1;` · `cond ? a : b;` · `-x;` · `a, b;` · `void e;` ·
`(e);` · nested ternaries · `x / 0;` — at top level and inside `for` / `while`
/ `try` body buffers.

Evaluation-order evidence for the discarded ternary (two counters, encoded as
`a * 10 + b`, so taken-arm-only is distinguishable from both-arms):

| source | expected | legacy | IR |
| --- | --- | --- | --- |
| `c=true;  c ? hitA() : hitB()` | 10 (not 11) | 10 | 10 |
| `c=false; c ? hitA() : hitB()` | 1 (not 11) | 1 | 1 |
| nested, one of three leaves | 10 | 10 | 10 |
| condition-before-arm order log | 12 | 12 | 12 |

Residual, measured with `JS2WASM_IR_SHAPE_DIAG=1` — the two named arms survive
for shapes the walker cannot admit, exactly as plan step 3 requires:

| shape | arm |
| --- | --- |
| `o.x += 1;` / `a[i] += 1;` | `nontail-compound-or-binary-stmt` |
| `a = b = 1;` | `nontail-assign-nonprop-lhs` |
| `o.x++;` | `nontail-incdec-stmt` |
| `new.target;` / parenthesized arrow | `nontail-exprstmt-other` |

Negative boundary: a discarded expression containing an unlowerable call
demotes with the documented `external-call` capability code (a `select`-stage
rejection, not a post-claim invariant failure) and the program still compiles
and runs via legacy.

Gates: `check:ir-fallbacks` OK (no unintended / post-claim / module-level
increases) · `gen:ir-adoption --check` up to date · `check:ir-only` host lane
**37/37**, standalone **17/37 emitted, 20 unsupported, 0 invariants** —
byte-identical to the same run against unmodified `origin/main` files (A/B
measured, not inferred) · `check:oracle-ratchet` OK · `lint` OK ·
`check:issue-ids:against-main` OK · typecheck: 491 errors, all the known
`@types/node` noise under symlinked `node_modules`, zero in the changed files
(base measured at 491 too).

`equivalence-gate` — **all 8 shards run locally, all "no new equivalence
regressions"**: 1,661 passing, 24 failing and every one already in
`scripts/equivalence-baseline.json`. Shards 2 and 4 additionally report
baseline entries that now PASS (coercion `+` under standalone-O, a
`Math.pow` test262 pattern); those are from main advancing underneath the
branch, not from this change, so the baseline is deliberately NOT ratcheted
here.

Pre-existing on `origin/main`, NOT caused by this change — verified by running
the same suites against base copies of `select.ts` / `from-ast.ts`:
`ir-scaffold` ×2, `issue-3529-selector-preclaim` ×4, `ir-nullish-coalesce` ×3.
