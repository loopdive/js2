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
  # 2026-11-19 (S8 review RV-S8) — select.ts further +~35: the widened-result
  #   exemption (`resultWidensToDynamic`, an IrSelectionOptions hook beside
  #   `jsDocParamLowersAsExternref`), the conditional carrier-arm check in the
  #   module-value conditional rule. Both read selector state.
  - src/ir/select.ts
  # 2026-11-19 (S8 review RV-S8) — codegen/index.ts +1: the one line wiring
  #   `resultWidensToDynamic` into planIrOverlay's selection options, beside
  #   its sibling legacy-signature hooks; the predicate itself already lives
  #   in strict-eq-stale-type.ts.
  - src/codegen/index.ts
func-budget-allow:
  # 2026-11-19 (S8 review RV-S8) — planIrOverlay +1: the same wiring line.
  - src/codegen/index.ts::planIrOverlay
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
leaves being script vars in their dynamic home (`holdsCarrier`) and method
calls answering their receiver's carrier. Reason `return-carrier-into-number`.
`yieldsModuleCarrier` names that question once for the selector.

**What from-ast actually declares (review RV-S8, measured 2026-11-19).** The
selector's resolved kind is not always the declared result: the override map
(`codegen/index.ts`) gives an unannotated function the dynamic result when
`functionReturnsWidenedValue` holds (a returned binding is written across
domains, `var n = 1; … n = 'x'`), the same result legacy registers. Probes
(selector kind / from-ast declared / lowered):

| case | selector | declared | lowered | main |
| --- | --- | --- | --- | --- |
| `return p.length` (`var p = function…`) | f64 | f64 | dynamic | withdraws |
| `var y; y = -null; return y` (with #7316) | f64 | f64 | dynamic | withdraws |
| `return n` (`n = 'x'` elsewhere) | f64 | dynamic | dynamic | IR, passes |
| `return n + 1` (same) | f64 | dynamic | dynamic | IR, passes |

So the refusal also asks the new selection hook `resultWidensToDynamic`
(codegen wires `functionReturnsWidenedValue`, beside
`jsDocParamLowersAsExternref`) and stands down where it holds. Making the
selector resolve `dynamic` there instead was tried and rejected: the move-only
scan then refuses `return n` (`return-type-not-resolvable`).

**Conditional.** `c ? p.length : 0` withdrew on main with "ternary branches
have different types (dynamic vs f64)": the module-value conditional rule
compared obvious families, and the resolver calls `p.length` f64. The rule
(now `moduleValueConditionalArmsDiffer`, out of `isPhase1Expr`) first refuses
arms that disagree on `yieldsModuleCarrier`
(`expr-module-value-conditional-mismatch`), anywhere, not only in a return.
Both arms carriers is a carrier, which the return refusal then sees.

**State (no reset, measured).** `currentFnReturnKind` is set only for
function subjects, so module-init, constructor-field and planned-closure walks
keep the previous subject's kind (seen: the harness's
`Test262Error.prototype.toString` closure walked with `f64`). It never
reaches the refusal with a carrier: a planned closure refuses a carrier result
first (`closure-return-type`), and module-init and constructor fields have no
own `return`. A shadow-instrumented compile of the 700-file sample recorded
zero carrier returns under a stale kind, and no constructed program made a
reset observable, so the resets cfa71274 added were dropped
again as untestable. A stale kind could only over-refuse, never withdraw.

**Tests.** `tests/issue-7331-carrier-return-into-number.test.ts`: the issue's
three repros, the `+` form, both-arm and mixed conditionals and `y = -null`
(refused today by its `-null`; pins the refusal once #7316 lands) are refused
at selection with no post-claim error on standalone, wasi and gc; `return
p.m()` over a carrier receiver is refused by the carrier rule, not by the
move-only scan (pins the method-call leaf); a numeric script var's read stays
IR; through the runner (standalone, gc), `return p.length` and the mixed
conditional stay legacy and pass, `return n` and `return n + 1` over a widened
var are IR and pass.

## Result

700-file seeded ES5 sample (seed 7106, census population; standalone,
original harness, compiled and run), base main `ee3fcdd6` vs this branch after
the RV-S8 fixes, 2026-11-19: IR-only and passing 130 → 130, legacy units
1,261 → 1,261, post-claim errors 41 → 41, no verdict flip, no unit's refusal
changed. No sample file carried this withdrawal. Bytes: 100 files × standalone
and gc identical to base.

Mutation check: making the method-call leaf `() => false`, dropping the
conditional carrier check, or dropping the widened-result exemption each fails
tests in the issue's test file.

Pre-existing, not fixed here: legacy answers `print.length` 0 and
`isNaN.length` 1 for `var print = function (a, b) {}` (node: 2) through the
runner on standalone and gc, same on main.
