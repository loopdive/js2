---
id: 7318
title: "IR: `throw <number|boolean literal>` is claimed by the selector, then demoted by from-ast (post-claim demote)"
status: ready
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
related: [7274, 7132, 7281, 7113]
---

# `throw <literal>`: claim then demote

## Problem

A `<module-init>` that contains `throw 1` (or `throw 1.5`, `throw true`) is
claimed by the selector, then refused by from-ast. The unit demotes to legacy
with a warning, so this is a post-claim demote (a selector/builder
disagreement), not a miscompile.

- **Where it demotes:** `lowerThrowStatement` in `src/ir/from-ast.ts`, at the
  `throwOperandAdmissible(irOperandFamily(...))` check,
  `demoteToLegacy("throw-value-unsupported", "ir/from-ast: throw val not in slice 9 …")`.
- **Why the selector disagrees:** the rule is `throwOperandAdmissible`
  (`src/ir/analysis/operand-admissibility.ts`). An f64, i32 or boolean value
  has no externref box at a throw. Only the planned-closure walk
  (`select-planned-closure-operands.ts`) applies it at selection. The
  function-body and `<module-init>` throw arms in `select.ts` do not, so the
  selector claims what from-ast refuses.

It is pre-existing: `var v = 4; try { throw 1 } catch (v) {}` demotes the same
way with no buffer involved. #7274 slice 2 (PR #7161) makes it reachable from
more test262 files, because a DataView module-init that also throws a literal
used to stop at selection and is now claimed (RV7161 N4).

## Repro

```js
var v = new DataView(new ArrayBuffer(4));
try { throw 1; } catch (e) {}
assert.sameValue(v.byteLength, 4);
```

On standalone, with `JS2WASM_IR_SHAPE_DIAG=1` and `trackIrOutcomes`,
`<module-init>` reports `ir/from-ast: throw val not in slice 9 (<module-init>)`.
The test passes, but on the legacy route. Same for
`var v = 4; try { throw 1; } catch (v) {} assert.sameValue(v, 4);`.

## Related

- **#7132** lists `throw 1` under "Not taken". There the f64 box arm
  (`numericThrow: "number-boundary"`) is projected only on the program-source
  path, and booleans have no arm.
- **#7281** (PR #7147) covers only a throw whose operand is a string concat
  with a scalar binding.
- **#7113** introduced `throwOperandAdmissible` for the closure walk.

## Acceptance

Either of these is acceptable:
- **Parity fix (smallest):** the function-body and module-init selector throw
  arms apply `throwOperandAdmissible`, so a scalar throw refuses at selection.
  It becomes a pre-claim refusal (`throw-value-unsupported`), not a demote.
- **Coverage fix:** lower a scalar throw (box the number or boolean into the
  thrown externref) on the lanes that can, and admit it at selection exactly
  there.

Both fixes must also:
- leave no post-claim `throw-value-unsupported` demote in the wrapped ledger
  (stride 40, standalone) or in the repro above;
- keep gc output byte-identical.
