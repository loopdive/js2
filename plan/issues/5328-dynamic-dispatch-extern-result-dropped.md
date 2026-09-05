---
id: 5328
title: "Dynamic-dispatch arm returning externref into an f64 call site drops the result"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-05: the code change is ONE token (`false` -> `true` at the return
# coercion site); the +7 lines are the comment explaining why the argument-side
# guard does not apply to a result. There is nothing to extract into a subsystem
# module, and a one-token change to a dispatch ladder with no rationale beside it
# is exactly what makes the next reader revert it.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

## Problem

A call through the identifier funcref ladder (`src/codegen/expressions/call-identifier.ts`)
whose **expected result is `f64`** and whose **live arm's funcref returns `externref`**
discarded the callee's answer and substituted the `0x7FF00000DEADC0DE` undefined
sentinel. Every such call read `NaN`/`undefined` while the callee had computed
the right value.

Production witness: jest's `packages/jest-config/src/stringToBytes.ts` —
`export default stringToBytes;` (the statement form), inferred return
`number | null | undefined`, consumed through a default import. 21 of its 28
upstream unit tests read the sentinel instead of the byte count.

## Root cause

The ladder builds one `ref.test`-guarded arm per candidate signature; each arm
must leave a value of the block's declared result type. When an arm's return
type disagrees it consults `scalarBridgePlan`, and on `null` falls back to a
**dead-arm placeholder** — `drop` + `defaultValueInstrs(expectedReturn)` — whose
justification is that a signature-divergent arm can never actually run.

`scalarBridgePlan`'s `externref → f64` row is gated on `allowProvenNumberUnbox`,
which the **return** site passed as `false`:

```ts
const bridge = dispatchBridgePlan(fc.returnType!, expectedReturn!, false, …);
```

Nothing else in the planner supplies that direction, so the arm always fell
through to the placeholder. The arm is **not** dead: the ladder unconditionally
seeds an externref-returning alternate candidate
(`tryAltFuncType([{ kind: "externref" }])`) whenever the expected result is not
already externref, and a function whose declared/inferred return is
`number | undefined` is lowered with exactly that signature. So the live arm
called the function, dropped its answer, and returned `undefined`.

Why the guard exists, and why it does not apply here: for an **argument**, a
declared-`any` value may really be a Boolean/Symbol/BigInt, and running it
through the numeric ABI would erase that brand — the call site has to prove the
value is a Number first. For a **result**, `expectedReturn` **is** this call
expression's statically computed result ValType, so the compiler has already
committed to reading whatever comes back as `f64`. Refusing the unbox does not
protect the value; it destroys it.

## Fix

Pass `allowProvenNumberUnbox = true` at the **return** coercion site only.
`scalarBridgePlan` still returns `null` when `__unbox_number` is unregistered,
so no late import is pulled and the dead-arm "no index shift" invariant
(#2174) is preserved byte-for-byte. Argument bridges are untouched.

## Falsified prior diagnosis (recorded so it is not re-derived)

An earlier bisection attributed this bucket to *"an overload SET whose
signatures disagree on the return type"*. That is refuted: deleting the overload
signatures and keeping the identical implementation still reproduces. Measured
ablations on this repo:

| shape | wasm |
| --- | --- |
| `export default g;`, inferred/declared `number \| undefined` | **FAILS** (sentinel) |
| `export default g;`, `number \| void` | **FAILS** |
| `export default g;`, plain `number` | passes |
| `export default g;`, `number \| null` | passes |
| `export default g;`, `string \| undefined` | passes |
| inline `export default function g(…)` | passes |
| `export { g as default }` | passes |
| named export | passes |

The overloads are incidental. The trigger is: a declared/inferred return
including `undefined`/`void` that lowers the callee's funcref to an `externref`
result, reached through the dynamic identifier ladder with an `f64` expected
result.

## Evidence

- jest dogfood suite: **299/356 → 320/356** (`stringToBytes.test.ts` 6/28 → 27/28);
  no other file in the suite moved.
- Regression test: `tests/issue-5328-dynamic-dispatch-extern-result.test.ts`
  (untyped `.js`, two-file project — an annotated return routes to a different
  arm and passes identically with and without the fix).

## Blocked measurement on current `main` (#5332)

Between the measurement head (`4946cf70fe`) and the PR base, an unrelated
regression landed: `export default <identifier>;` in a multi-file project no
longer COMPILES (`multi-prepared-module-init-census:terminal-join`, see #5332).
That is the only shape which reproduces this defect — `export { g as default }`,
an inline `export default function`, a named export, a factory return and a
callback parameter were all measured and none of them reproduce — so the fix is
correct but currently unobservable on `main`, and jest's own
`stringToBytes.test.ts` is 0/28 there for the #5332 reason rather than 6/28.
The regression test detects that compile error and SKIPS with a pointer to
#5332; it starts enforcing the moment #5332 lifts.

## Residuals (deliberately not in this change)

- `g(0)` where the callee genuinely returns `undefined` still answers a NaN at an
  `f64` call site: the carrier cannot represent `undefined`, and giving
  `expectedReturn` the `undefSentinel` brand for a `T | undefined` return is a
  much wider change. Before this fix the same site answered the *sentinel* NaN;
  after, it answers `__unbox_number(undefined)`'s quiet NaN. Both read as
  "not a number"; neither reads as `undefined`. The one remaining
  `stringToBytes` failure (`expect(stringToBytes(undefined)).toBeUndefined()`)
  is this residual and is unchanged by the fix.
- A `boolean | undefined` return through the same ladder answers `false`
  (`defaultValueInstrs({kind:"i32"})`), unchanged before and after — the
  placeholder still owns the `externref → i32` row.
- A dependency module that `throw`s inside the default-exported function
  currently breaks the whole compiled module (measured identical before and
  after); unrelated defect, not addressed here.
