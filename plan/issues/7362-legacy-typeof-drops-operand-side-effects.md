---
id: 7362
title: "Legacy `typeof` drops its operand's side effects when the answer is static"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7361]
---

# #7362 — Legacy `typeof` drops its operand's side effects when the answer is static

## Problem

When a function compiles through the legacy (direct AST→Wasm) path, `typeof <operand>` whose answer is known at
compile time answers the tag but never runs the operand. ECMAScript evaluates the operand first
(`UnaryExpression : typeof UnaryExpression`, step 1), so calls and assignments inside it must happen.

Found in the adversarial review of [#7361](7361-typeof-static-answer-from-hinted-operand.md) (review round 3), which
fixes the same shapes on the IR path only.

## Reproduction (2026-11-19, `origin/main` `ee3fcdd6`)

Each program is `export function g() { <body> }` in a `.js` file, compiled with the default target and with
`--target standalone`; both give the same wrong answer. The function goes to legacy in all three.

| Declarations | Body | node | js2wasm |
| --- | --- | ---: | ---: |
| `var n = 0;` | `var t = typeof (n = 5, void 0); return t === "undefined" ? n : -1;` | 5 | 0 |
| `var n = 0; function f() { n = n + 1; return 1; }` | `var t = typeof (n = 5, void f()); return t === "undefined" ? n : -1;` | 6 | 0 |
| `var n = 0; function f() { n = n + 1; return 1; }` | `var t = typeof void f(); var u = (n = n + 10, 1); return t === "undefined" ? n : -1;` | 11 | 10 |

A statement-position `typeof (n = 5, void 0); return n;` keeps the effect (answers 5); the loss is in the value
position.

## Acceptance criteria

- The three programs answer like node on both targets.
- The operand still runs exactly once (pin a call counter).
- JS-environment output for programs whose `typeof` operand has no side effects stays byte-identical.

## Implementation Plan

Measured 2026-11-19 on `claude/7362-legacy-typeof-effects` (base `0b938509be`): all three rows reproduce on both
targets, `irCompiledFuncs` is empty for each. The comparison form `typeof (n = 5, void 0) === "undefined"` and a
non-void operand `typeof (n = 3, 1)` lose the effect the same way; so does a getter read `typeof o.x`.

**Cause.** Both legacy typeof ladders in `src/codegen/typeof-delete.ts` answer from the operand's TypeScript type and
emit only the constant: `compileTypeofExpression` (the `typeofFold` arm, ~L2054) and `compileTypeofComparison`
(the `staticTypeof` arm, ~L2422). Neither compiles the operand. The only thing either emits for it is the #6798 TDZ
guard (`tf.emitTypeofTdzGuard`), which acts on identifiers only. The statement form survives because
`compileExpressionStatement` (#4433) compiles the operand alone and never reaches `typeof`.

**Fix** — module `src/codegen/typeof-static-folds.ts`, the home of the fold helpers:

- New `emitFoldedTypeofOperand(ctx, fctx, operand)`: what a fold must still evaluate of its operand. An operand that
  `expressionRunsUserCode` (module-init-collection, the predicate the statement form already uses) flags is compiled
  and dropped; otherwise the existing TDZ guard runs (which emits nothing for a non-identifier). Both fold sites
  call it in place of `emitTypeofTdzGuard`, which becomes module-private.
- It runs after the #5312 uninitialised-field arm, which reads the field itself, so a field read is not evaluated
  twice. The TDZ guard (identifiers) and that arm (property reads) never apply to the same operand, so the reorder
  does not change bytes.
- Reuse: `dropBigIntKernelCall` is the same compile-and-drop step; it becomes the general `compileForEffect` and
  serves both the BigInt fold and the new path. The comparison arm's hand-written constant becomes the existing
  `tf.emitStaticTypeofComparison`.
- Scope: an operand the predicate calls inert (identifier, literal, `void 0`, `typeof x`, a function expression,
  …) emits exactly what it did. Member reads are in the predicate (getter, nullish base), so `typeof o.p` now
  compiles the read and drops it. The statement path is unchanged.

**Acceptance.** The three rows, the comparison form and a getter read answer like node on both targets, with a call
counter at exactly one; the functions under test are legacy. A byte corpus (test262 `language/expressions/` typeof,
void, comma, conditional; pure and effectful typeof programs) differs from base only where the predicate flags the
operand, and every differing test262 row keeps its verdict. Code quality: one new exported helper, no new
predicate, one compile-and-drop helper instead of one per fold, no cast, no growth grant.

**Prototype measurement (2026-11-19, not committed; parked by the lead after the plan).** The fix above was
prototyped on this branch and then reverted:

- A 15-row test (the rows above, comparison forms, a getter read, call counters, statement forms, `void 0`), all
  asserting `g` is legacy, passed 30/30 on both targets; on base it failed 24/30. The 6 base passes were the
  statement and `void 0` rows.
- Byte corpus, 91 programs × 2 targets: 152 of 182 identical. The 30 that differed, each on both targets:
  - test262 `typeof/`: `bigint`, `built-in-exotic-objects-no-call`, `native-call`, `null`, `proxy`, `string`,
    `symbol`. Their operands are calls or `new`.
  - pure-list programs the predicate flags: `(a < b)` (ToPrimitive on non-literal operands), `o.p`, `s.length`
    (member reads).
  - effect programs: `(n = 5, void 0)`, `(n = 5, void f())`, `(n++, x)`, `(c ? f() : 1)`, `(o.p = 2)`.
- The 53 test262 rows in typeof/void/comma/conditional kept their verdicts on both lanes: 50/53, with the same
  3 failures as base.
- Not finished: a 1,480-row test262 slice of member-read and parenthesized typeof operands, run branch against base.
  Member reads are the widest part of the change, so that slice is the check to run before landing.

## Suspended Work (lane S1, 2026-11-20)

- Branch `claude/7362-legacy-typeof-effects` (stacked on #7304's branch, which has since merged to main), head = this
  commit, branch only, no PR. Claimed for `ttraenkler/c-lead`.
- Done: repro on both targets, cause, Implementation Plan (above). A prototype fix and its test were measured and
  reverted; saved in the S1 session scratchpad (`bytes7362/prototype-fix.diff`,
  `issue-7362-legacy-typeof-operand-effects.test.ts`) — they do not survive the session, so re-derive from the plan.
- Next: merge `origin/main` (contains #7361 now); implement the plan's `emitFoldedTypeofOperand` in
  `src/codegen/typeof-static-folds.ts`; the test file; the byte-identity run, which per the lead must include the
  1,480-row test262 run over member-read and parenthesized `typeof` operands (JS-environment bytes may change only for
  operands that may run user code); gates; PR with `hold`.
