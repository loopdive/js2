---
id: 7456
title: "Ordinary pipeline: wrong values for a script var written only through shorthand destructuring"
status: done
created: 2026-11-23
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
goal: core-semantics
sprint: Backlog
related: [7354]
---

# #7456 — Ordinary pipeline: wrong values for a script var written only through shorthand destructuring

## Problem

A script-level `var` that a function writes only through a shorthand destructuring assignment (`({ g } = o)`, `[{ g }] = a`, nested forms) is treated as never written, and later reads give a stale value. Found on main on 2026-11-22 while reviewing #7354 H2 (which made the shared writes query see these targets; the ordinary output did not change in 34 programs x 2 targets, so the wrong values come from another analysis). Failing probe shapes: a string var in a nested pattern, a string var read in a function, a number array, a class instance, a function-expression var, a function declaration, a nested shorthand.

## Acceptance criteria

- Each probe shape gives node's answer on the default and standalone targets.
- One analysis decides "is this binding written"; it resolves shorthand targets with `getShorthandAssignmentValueSymbol`.

## Implementation Plan (2026-11-26, head 41f0654e8c)

**Measured on this head** (ordinary `compile`, default and `standalone`, against node): the string, number,
array, class-instance, function-expression and nested shapes all give node's answer now, on both targets. Only
the **function declaration** shape fails, and it fails for every write form, not only shorthand:

| program (`function h(){return 1}` …) | node | both targets |
| --- | --- | --- |
| `({ h } = { h: function(){return 2} }); h()` | 2 | 1 |
| `({ k: h } = …)`, `[h] = […]`, `({ x: { h } } = …)`, `({ h = fn } = {})` | 2 / 3 | 1 |
| `h = k` (another declaration), `h = o.k`, `h = mk()` | 2 | 1 |
| `h = function(){return 2}` | 2 | 2 |

Reading `h` as a value is right (`({h} = {h: 5}); h` gives 5).

**Cause.** The write analysis is not the culprit: `registerReassignedFunctionGlobals` (`src/codegen/index.ts`)
records every one of these writes (the shorthand through `ctx.oracle.valueDeclarationOf`, which asks
`getShorthandAssignmentValueSymbol`) and backs `h` with the live global `__mod_h`; the write stores into it. The
CALL ignores it: `compileBoundIdentifierCall` (`src/codegen/expressions/call-identifier.ts`) goes to the live global
only for a runtime-eval or Annex B binding (`hasLiveFunctionBinding`) or when `closureMap` has an entry for the
name. `closureMap` is filled only by `h = <function literal>`, so every other write falls through to the
`funcMap` direct call (or the inlined body) of the original declaration.

**Fix.** In `compileBoundIdentifierCall`, after the closure-call arm and before the `funcMap` arm: when the callee is a
reassigned module-scope function declaration, call through `tryEmitInlineDynamicCall` (the call the runtime-eval
arm already uses) instead of the declaration's body.

- Reuses `reassignedFunctionBindingIsDynamic` (`declarations/reassigned-function-binding-widening.ts`), the
  existing "is this a reassigned module function binding, resolved by declaration identity" predicate; no new
  predicate.
- Placed after the closure arm, so `h = function(){}` programs keep their bytes; only calls that took the stale
  direct call change.
- Removes the duplicated `#4133/#4134` comment paragraph in the same function, so the function does not grow.

**Not in this change.** `({ n = 5 } = {})` gives `NaN` for any number target (local `let` too, and
`[n = 5] = []`): a destructuring-default bug in the assignment lowering, not a write-analysis one, and the array
form is out of this lane's area. Reported separately.

**Acceptance.**
- Correctness: each shape above gives node's answer on both targets; pinned in
  `tests/issue-7456-reassigned-function-declaration-call.test.ts`, which fails on main.
- Bytes: ordinary output identical on ~180 programs except those calling a reassigned function declaration.
- Code quality: one guarded five-line arm reusing the existing predicate and dynamic-call helper; no new
  module, no budget grant.

## Result (2026-11-26, branch `claude/7456-shorthand-destructuring-var` from main 41f0654e8c)

- **Fix**: one arm in `compileBoundIdentifierCall` (`src/codegen/expressions/call-identifier.ts`), after the
  closure-call arm: a callee that `reassignedFunctionBindingIsDynamic` names is called through
  `tryEmitInlineDynamicCall`. The duplicated `#4133/#4134` comment in the same function is removed; the file and
  the function do not grow (LOC gate net +0).
- **Tests**: `tests/issue-7456-reassigned-function-declaration-call.test.ts`, 27 programs x 2 targets = 54 rows,
  all pass. With main's `call-identifier.ts` restored: 32 fail (all 16 function-declaration rows on both targets),
  22 pass (2 unchanged-behaviour rows and 9 script-var guard rows, which already pass on main).
- **Bytes** (ordinary `compile`, default and standalone, this head vs main 41f0654e8c): 179 test262 programs
  (80 `expressions/assignment/dstr`, 75 `statements/variable/dstr`, 24 without destructuring) plus 33 probes,
  424 compiles. 386 identical; 38 differ, all 19 probes that call a reassigned function declaration, on both
  targets. Every test262 program is identical (36 of them throw inside `compile` on both heads with the stub
  harness, 46 are compile errors on both).
- **Gates**: typecheck, LOC, func budget, coercion sites, oracle ratchet, dead exports, import cycles: exit 0; LOC
  and func budget also with `LOC_GATE_BASE=origin/main`. Neighbouring destructuring, #2931, #4491, Annex B and
  equivalence destructuring files: the 18 failures they show fail identically on main.

### Not done here

- `({ n = 5 } = {})`, `[n = 5] = []` give `NaN` (also for a local `let`): a destructuring-default bug in the
  assignment lowering, not a write analysis. Needs its own issue.
- Two write analyses of a function binding remain (`registerReassignedFunctionGlobals` and the IR call planner's
  `reassigned` set in `src/ir/imported-functions.ts`); both already resolve shorthand targets through the value
  symbol, so folding them is a cleanup, not a fix (see #7354 H2 "Known, not done").
- A nested `function h` inside another function still calls the top-level `h` when both exist (`funcMap` is keyed by
  bare name); unchanged by this fix.
