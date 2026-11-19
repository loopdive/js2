---
id: 7331
title: "IR: `.length` of a dynamic script var (`print.length`) is claimed, then withdrawn (dynamic result into a declared f64 return)"
status: done
completed: 2026-11-19
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7287, 7330, 7332]
loc-budget-allow:
  # 2026-11-19 (S8) — select.ts +18: isPhase1ReturnValue (shared by the tail
  #   and the early-return arm, which both called isPhase1Expr directly) and
  #   its carrier leaves; it reads the selector's return-kind state, so it
  #   cannot leave this file.
  - src/ir/select.ts
---

# #7331: `return p.length` on a dynamic script var withdraws the function

## Problem

`function h() { return p.length; }` over a script var in its dynamic module
home is claimed. The read lowers to the dynamic carrier, but the function's
declared result is `f64` (the checker types `length` as `number`), so from-ast
withdraws the unit after the claim (`irPostClaimErrors`). The output is still
correct (legacy fallback), but this breaks the claim-then-withdraw rule (set in the
[#7147 PR review](https://github.com/loopdive/js2/pull/7147): a selector admission
that from-ast then rejects counts as a blocker).

## Repro (bare compile; standalone, wasi and gc alike)

Pre-existing on main `b631a4bc`:

```js
var p = function (a, b) {}; function h() { return p.length; } h();
```

`h`: `return[0] type dynamic not assignable to declared result f64`.

Exposed by #7164 (head `c0dcb01a`), whose slice A binds a lib-named script var
(`print`, `isNaN`) to its `var` (main gives `[]`):

```js
var print = function (a, b) {}; function h() { return print.length; } h();
var isNaN = function (a, b) {}; function h() { return isNaN.length; } h();
```

## Direction

Either the return converts the carrier with ToNumber for a declared `f64`
result (the conversion legacy applies), or the selector refuses a dynamic
`.length` read into a typed return. Pin a bare compile of the three repros
with `irPostClaimErrors` empty.

## Implementation Plan

Reproduced on main `ee3fcdd6` (2026-11-19), all three lanes, all three repros
(and `return p.length + 1`).

**Cause.** The selector's return arms (`isPhase1Tail`, and the early-return
arm of the body walk) admit any Phase-1 expression. A script var in its
dynamic module home lowers to the carrier, and so does `.length` on it; the
checker types the read `number`, so the function's result resolves to `f64`,
and `coerceReturnValue` has no carrier-to-number arm.

**Fix (honest refusal, `src/ir/select.ts`).** One helper,
`isPhase1ReturnValue`, shared by both return arms: a number result refuses a
value that `producesCarrier` (the one shared definition of "lowers to the
carrier", `analysis/carrier-expression.ts`) says is the carrier, with the
leaves being script vars in their dynamic home (`holdsCarrier`). Reason
`return-carrier-into-number`.

No ToNumber lowering: legacy converts, but the `f64` result is the checker's
reading of the initializer, and a script var can be reassigned, so a
converted return would be wrong where JS returns the value unchanged.

**Quality acceptance.** No new carrier definition (reuses `producesCarrier`
and `holdsCarrier`); both return arms go through one helper.

**Tests.** `tests/issue-7331-carrier-return-into-number.test.ts`: the issue's
three repros and the `+` form are refused at selection with no post-claim
error on standalone, wasi and gc; a numeric script var's read stays IR; the
value is right through the runner (standalone, gc).

## Result

700-file seeded ES5 sample (seed 7106, census population; standalone,
original harness, compiled and run), base main `ee3fcdd6` vs this branch,
2026-11-19: IR-only and passing 130 → 130, legacy units 1,261 → 1,261,
post-claim errors 41 → 41, no verdict flip, no unit's refusal changed. No
sample file carried this withdrawal. Bytes: 100 files × standalone and gc
identical to base.
