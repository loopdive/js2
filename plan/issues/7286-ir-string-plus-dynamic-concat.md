---
id: 7286
title: "IR: `string + <dynamic>` concatenation — measured: only `$DONE`, blocked behind #7284"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7284, 7277, 2949]
assignee: "ttraenkler/c-lead"
---

# #7286: `string + <dynamic>` concatenation

## Problem

A `+` with one string-family operand and one dynamic operand
(`'…' + error.name + ': ' + error.message` in `$DONE`, `'Expected ' + x` across
the harness) refuses the unit (`move-only[concrete]` on the BinaryExpression).
It needs legacy's `+`: ToPrimitive (default hint) on the dynamic operand, then
ToString — not `dyn.to_string`.

## Measurement (2026-11-06, base #7277 branch `b6c06be1` on main 8b349439)

Wrapped ledger, stride 40, standalone, `JS2WASM_IR_SHAPE_DIAG=1`,
`--files-json`, with #7277 in. Legacy units whose first refusal is a
`BinaryExpression` containing `+` (138 files):

| unit | origin | parts | first refusal | shape |
| --- | --- | ---: | --- | --- |
| `$DONE` | harness | 130 | `move-only[concrete]` | `'Test262:AsyncTestFailure:' + error.name + ': ' + error.message` — **string + dynamic** |
| `counter`, `g`, `fn1`…`fn5` | test | 16 | `tail-/nontail-module-compound` | module-var `+=` — a different shape |
| `hide` (`Atomics/isLockFree/corner-cases.js`) | test | 1 | `move-only[concrete]` | `hide(k - 3, x) + x` — numeric `dyn + dyn`, not a concatenation |

**The string + dynamic population is `$DONE` alone (130 units), and none of
it can move:** `$DONE` calls `__consolePrintHandle__`, which stays legacy until
#7284's follow-up (1) (a call through the prelude's `var print = function …`),
and the call-graph closure withdraws a caller of a legacy callee. Files where a
string + dynamic `+` is the only blocker: 0. Zero-legacy delta of an
implementation today: 0 files, 0 units.

### What legacy emits, and what the IR already has

Binary `+` with a dynamic operand is `emitAnyAddFromExternTemps`
(§13.15.3): ToPrimitive with the default hint on each operand (`Symbol.toPrimitive`,
then `valueOf` before `toString`; a Symbol operand throws TypeError; a Date
takes the string hint through its own `@@toPrimitive`), then string concat if
either side is a string, else numeric add. The IR already owns exactly that
dispatch as `__ir_dyn_add` (#7223, `src/codegen/dyn-ops.ts`
`ensureDynamicAdd`, behind `dyn.add`-style runtime calls `IR_DYN_ADD_FN`), on
the externref carrier — no new op and no new import.

## Implementation plan (ready for when #7284 (1) lands)

- **Module.** The selector's dynamic scan (`dynamicUsesAreMoveOnly`,
  `src/ir/select.ts`) beside its existing dynamic-`+` arm: admit a `+` whose one
  operand is string-family and the other dynamic **in a concrete-string
  position** (a call argument into a string slot, a string local), and nothing
  else. from-ast reads the same admission.
- **Lowering.** Box the string operand, `__ir_dyn_add(lhs, rhs)` in source
  order (left-to-right ToPrimitive), then `dyn.string_carrier` — a string
  operand makes the result a string by §13.15.3 step 4, so the checked recovery
  never fails. Nested `'a' + d1 + 'b' + d2` folds left: each step's result is
  already a string and re-enters the same arm.
- **Out.** `+=` on module vars (the `*-module-compound` refusals), numeric
  `dyn + dyn`, any dynamic-receiver method call on the result (#7261).
- **Acceptance.** Objects with `valueOf` / `toString` (order, a throwing
  method, a method returning an object → TypeError), Symbols (TypeError), Dates
  (string hint), `null` / `undefined`, `-0` / `NaN` / `1e21`, booleans, arrays,
  nested concats — identical to legacy on standalone and gc; `$DONE(error)`
  output matching character for character on failing async copies.

## Follow-ups

- Blocked on #7284 follow-up (1): the module-var closure call that keeps
  `__consolePrintHandle__`, and therefore `$DONE`, legacy.
