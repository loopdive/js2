---
id: 4458
title: "Legacy direct-codegen mis-compiles <T>x and x satisfies T to 0"
status: done
completed: 2026-08-15
priority: high
task_type: bug
area: codegen
sprint: 78
horizon: s
model: opus
assignee: ttraenkler/opus-4458
related: [3583]
loc-budget-allow:
  - src/codegen/expressions.ts
func-budget-allow:
  - src/codegen/expressions.ts::compileExpressionInner
---

# #4458 — legacy direct-codegen mis-compiles type-erased wrapper expressions

## Problem

The **legacy** direct AST→Wasm front-end silently mis-compiled two of the three
type-erased wrapper expressions:

| form | legacy path (before) | IR path |
| --- | --- | --- |
| `x as T` (`AsExpression`) | correct | correct |
| `<T>x` (`TypeAssertionExpression`) | **evaluates to `0`** | correct |
| `x satisfies T` (`SatisfiesExpression`) | **evaluates to `0`** | correct |

`x as T` was **not** affected — the legacy dispatcher already had that arm. The
task brief flagged all three as suspect; measurement narrowed it to two.

The failure was **silent**: `compile()` returned `success: true` with an empty
`errors` array. There was no compile error and no warning — just a wrong value.

Discovered during #3583 (2026-08-15). The IR front-end grew unwrap arms for all
three forms in `isPhase1Expr`/`lowerExpr`, so only functions the **IR selector
rejects** (fallback bodies, non-claimed shapes) kept the wrong behaviour. That
made the bug invisible to any test whose body the IR path happens to claim.

## Reproduction

`2 ** 1` is used as a deliberate IR-selector rejector to force the legacy
fallback. It is empirically load-bearing: with it the wrapper yields `0`,
without it the IR path yields the operand. (The exact IR rejection *reason*
string was not extracted — the behavioural flip is the evidence.)

```ts
export function test(): number {
  const x: number = 7;
  const y = <number>x;
  return y + 2 ** 1;   // expected 9, got 2  →  y evaluated to 0
}
```

Measured on `92f78620` (probe over all three forms × legacy/IR-claimed):

```
PASS as (legacy via **):        ret=9  (expected 9)
FAIL angle (legacy via **):     ret=2  (expected 9)
FAIL satisfies (legacy via **): ret=2  (expected 9)
PASS as (plain):                ret=9
PASS angle (plain):             ret=9
PASS satisfies (plain):         ret=9
```

The emitted WAT for the failing case shows the operand replaced by a constant,
with **no diagnostic**:

```wat
(func $test (result f64)
  (local $x i32)
  (local $y i32)
  i32.const 7
  local.set 0
  i32.const 0      ;; <-- `<number>x` became 0
  local.tee 1
  f64.convert_i32_s
  f64.const 2
  f64.add
  return)
```

## Root cause

Two missing arms in the legacy expression dispatcher
`compileExpressionInner` (`src/codegen/expressions.ts`). It handled
`AsExpression` and `NonNullExpression` but had **no** `TypeAssertionExpression`
or `SatisfiesExpression` case, so both fell all the way through to the tail:

```ts
reportError(ctx, expr, `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`);
return null;
```

The silence is the second half of the root cause, and it is what let this
survive: the caller `compileExpressionBody` wraps the inner compile in the
**#1919 speculative transaction**. On a `null` result it runs
`rollbackSpeculative(ctx, fctx, snap)`, which discards the partial body **and
the errors the inner compile leaked**, then calls `pushDefaultValue` — emitting
`i32.const 0` / `f64.const 0`. So the `Unsupported expression` diagnostic was
raised and then thrown away, converting a would-be compile error into a wrong
answer. Verified: on base, `<T>x` in const-init, return, and call-argument
position all compile with `success=true, errors=[]`.

Notably the file already unwrapped `TypeAssertionExpression` in three *other*
places (the null/undefined numeric fast-path at ~L723/L786/L812) — so the node
kind was known to the module; only the value-producing dispatcher missed it.
`SatisfiesExpression` was absent from `src/codegen/expressions.ts` entirely,
although ~15 other `src/codegen/**` modules already unwrap it.

## Fix

`src/codegen/expressions.ts`, in `compileExpressionInner`. Rather than adding
two more parallel arms beside `isAsExpression`, the existing `as` arm is widened
to cover all three erased forms — they have identical lowering, and one arm
makes that explicit (and costs 8 fewer lines in a god-file):

```ts
if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isSatisfiesExpression(expr)) {
  return compileExpressionInner(ctx, fctx, expr.expression, expectedType);
}
```

Forwarding `expectedType` unchanged is what makes this a pure unwrap: the
operand is compiled into exactly the context the wrapper occupied, so the
wrapper is erased rather than re-typed.

### Budget allowances (LOC + function)

The same +8 lines trip two gates, both granted in the frontmatter above:

- **LOC** — `src/codegen/expressions.ts` is a gated god-file (cap 1670) → 1678.
- **Function** — `compileExpressionInner` (cap 660) → 668.

Justification for both:

- A dispatcher arm has exactly one correct home — the dispatcher. The gate's
  standard remedy ("add to the subsystem module, not the barrel/driver") does
  not apply: relocating the erased-wrapper case would split it from the
  `AsExpression` arm it is definitionally identical to, in a different file.
- The change was already minimised. The first cut added two separate arms
  (+18); folding all three into one condition cut that to +8, of which **6 are
  the comment** and 2 are code. The net *executable* growth is two `||` clauses.
- It is a correctness fix for a silent miscompile, not a feature.

## Test Results

`tests/equivalence/issue-4458-type-assertions.test.ts` — 16 cases covering
`<T>x`, `x satisfies T` and `x as T` (control) across const-initializer, return,
call-argument and nested-wrapper positions, over number/string/boolean/array
operands, plus two side-effect cases asserting the wrapper does not swallow a
call in its operand. Each legacy case is paired with an IR-claimed twin so the
two front-ends are pinned to the same answer.

| | fix | base (`92f78620`) |
| --- | --- | --- |
| `issue-4458-type-assertions.test.ts` | 16 / 16 pass | **12 fail**, 4 pass |

The 4 that pass on base are exactly the intended controls: both `x as T` cases
and the two IR-claimed variants. This confirms the suite guards the real defect
rather than passing vacuously.

Other gates:

- `pnpm run check:ir-fallbacks` — **OK**, no unintended / post-claim /
  module-level increases vs. baseline.
- Scoped equivalence run (`gradual-typing`, `destructuring-type-coercion`,
  `iife-and-call-expressions`, `compound-assignment-nonref-element`,
  `illegal-cast-assert-throws`) — 118 / 118 pass.
- `tests/equivalence/yield-as-expression.test.ts` has **1 pre-existing failure**
  ("yield without value used as IIFE argument"). Verified identical on base
  (1 failed / 3 passed both with and without the fix) — unrelated to #4458, not
  introduced here, and left untouched.

Budget gate: `budget-status --pick` reported 100% remaining, per-agent share
100%, horizon ≤ XL. This is an `S`-horizon task, well inside the allowance — no
allowance exception needed.

## Notes / follow-up

The #1919 speculative rollback swallowing a `reportError` is the reason a
missing dispatcher arm degrades to a **wrong value** instead of a compile error.
That is a general hazard, not specific to these two node kinds: any future
unhandled expression kind on the legacy path will fail the same silent way.
Worth a separate issue — e.g. let `reportError` mark `Unsupported expression`
`sticky` (the mechanism already exists, #3725, and is honoured by the same
rollback) so the diagnostic survives the unwind. Deliberately **not** changed
here: it would alter behaviour for every other unhandled kind at once and needs
its own conformance measurement.
