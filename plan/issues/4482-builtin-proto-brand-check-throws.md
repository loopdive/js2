---
id: 4482
title: "ES5 standalone: builtin prototype-method brand checks — wrong-receiver calls must throw real TypeErrors (RegExp 6 + Number 6 + Date/Boolean tail, ~16 rows)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: brand-checks
goal: standalone-gap
related: [3171, 3174, 3175, 4465]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. RegExp bucket: 6× '(e instanceof TypeError)' rows; Number: 6× same; plus scattered Boolean/Date 'not generic' rows. #3175's remaining-work list named this family (~12) in 2026-07."
# Comment-dominated growth in three god-files/functions. The new PREDICATES
# (~145 LOC) went into a new module, `src/codegen/expressions/member-override-scan.ts`,
# which is why `calls.ts` shows +0. What is left in each god-file is the
# decline GATE itself — a condition on an existing `if`, plus the note that
# says which test262 row it was measured against and why the predicate is
# receiver-precise. Splitting a three-line gate out of the arm it guards would
# move the rationale away from the code it constrains.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/builtins.ts::compileDateMethodCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
---

# #4482 — builtin prototype-method brand-check throws

## Problem

§15.x.4 "is not generic" clauses: `Number.prototype.toString.call("s")`,
`RegExp.prototype.exec.call({})`, `Boolean.prototype.valueOf` on a
non-Boolean — must throw TypeError (a real instance, catchable, and
`instanceof TypeError` true). Standalone either answers a value, traps, or
throws something that fails `instanceof TypeError`. Measured: 6 RegExp rows
+ 6 Number rows with the `(e instanceof TypeError)` signature, plus the
Boolean/Date tail. #3175 sized the Number half at ~12 files in July and
named the dependency: prototype methods extracted as VALUES need a brand
preamble at their reflective entry.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`).
   Matrix: {Number,RegExp,Boolean,Date} × {toString,valueOf,exec,test} ×
   {direct call on wrong receiver via .call(), transferred method} → what
   happens today (value/trap/wrong-class throw).
2. The shared brand-preamble pattern is #3171/#3174 (boxed-builtin brands);
   real TypeError INSTANCES come from `buildThrowJsErrorInstrs` (#3175
   landed it for RangeError — same helper, TypeError class). The reflective
   entries are the dispatch arms in `array-object-proto.ts` and the
   per-builtin lanes (#4465's String work is the freshest example of adding
   receiver handling to those arms — coordinate: if #4465 is unmerged,
   branch from its branch or record the overlap).
3. Brand test must be NOMINAL (branded struct `ref.test`, boxed-builtin
   brand fields), never structural — zero-capture canonicalization makes
   structural tests lie (#4426/#4429 records).
4. Absent-not-wrong: if a receiver's brand cannot be decided at the arm,
   decline to the existing behavior rather than throwing on a maybe.
5. Controls: the positive-path suites for each builtin stay green
   (`es5-standalone-number-format`, RegExp pins, issue-4465 pins if
   present); scoped sweeps over `built-ins/{Number,RegExp}/prototype`.

## Acceptance criteria

- ≥10 of the ~16 brand rows flip; zero regressions in the four builtins'
  scoped sweeps.

## Root cause

**The premise in the plan above is wrong, and measuring it first is what made
the fix small.** The plan says the reflective entries need a brand preamble.
They already have one. On the base commit, every one of these rows ALREADY
threw a real `TypeError` when the transferred intrinsic was stored under a name
the receiver's own prototype does not carry:

```js
var s = new Object();
s.myValueOf = Number.prototype.valueOf;
s.myValueOf();      // base: TypeError  ✓  — brand preamble present and working
s.valueOf   = Number.prototype.valueOf;
s.valueOf();        // base: the OBJECT — no throw at all
```

Both halves appear in the SAME test262 file (block #2 and block #1 of
`S15.7.4.4_A2_T04`), so the same base binary answered correctly and incorrectly
depending only on the NAME the intrinsic was stored under. That rules out a
missing brand check and points one layer earlier.

The defect is **shadowing**: a static arm keyed on the receiver's TypeScript
type answers `<recv>.<sameName>()` from the prototype it knows about, so the own
slot the program just wrote is never read and the preamble never runs. Four arms
did this — `compileDateMethodCall` (any `DATE_METHODS` name), the generic
`toString` fallback, the `valueOf` fallback (`Object.prototype.valueOf`, i.e.
identity), and the String-family arm. Two more shapes never reached the dynamic
dispatch at all: a `defineProperty`-installed member (readable but not callable)
and a bracket-key call `o["m"]()`.

## Fix

One predicate, four declines, two widenings.

**`src/codegen/expressions/member-override-scan.ts` (new)** — the reusable
guard the campaign wanted, at two precisions:

| predicate | precision | correct for |
| --- | --- | --- |
| `sourceHasMethodReassignment` (#1397, stays in `calls.ts`) | whole file, assignment only | admitting a dynamic exit |
| `sourceHasMethodOverride` | whole file, assignment ∪ `defineProperty` | admitting a dynamic exit |
| `sourceOverridesMethodOnReceiver` | **this binding**, assignment ∪ `defineProperty` | **declining a static arm** |

The split is absent-not-wrong applied to a compile-time scan, and it is
load-bearing: over-admitting a dynamic exit costs a fast path, but
over-declining a static arm returns a WRONG answer for a receiver that never
acquired the slot. A whole-file scan would have disarmed `d.valueOf()` on an
un-overridden `Date` because of an unrelated `x.valueOf = …` elsewhere in the
file. That case is pinned as a control.

Declines (all `ctx.standalone`, all receiver-precise):

1. `expressions/builtins.ts::compileDateMethodCall` — any `DATE_METHODS` name.
2. `expressions/call-receiver-method.ts` — the generic `toString` fallback.
3. `expressions/valueof-fallback.ts` — the `valueOf` fallback. Declining beats
   widening `__dyn_valueOf`'s oracle gate: that helper only probes `$Object`
   receivers, so a `$Date` still fell to its identity arm.
4. `expressions/call-receiver-method.ts::declinesToOwnOrInheritedSlot` — the
   String-family arm. This is the predecessor's WIP predicate, kept and
   extended: it now also covers a PRIMITIVE receiver whose member miss matters
   because the module wrote onto a builtin prototype (`ctx.protoNamedDirty`,
   the #4176 pre-scan flag) — the `Object.prototype.exec = …; ".".exec(m)`
   shape.

Widenings of the dynamic side:

5. `expressions/stored-member-closure-call.ts` — admission test moves from
   `sourceHasMethodReassignment` to `sourceHasMethodOverride`, so a
   `defineProperty`-installed member becomes CALLABLE. The READ already worked
   (`Object.defineProperty(d,"zz",{value:7}); d.zz === 7` was true on base);
   only the invocation was dropped by the graceful `ref.null.extern` fallback.
6. `tryEmitStoredMemberClosureCall` accepts an element-access callee with a
   string-literal key, wired into `call-tail-dispatch.ts` immediately before
   its local graceful fallback. Non-literal keys are left alone — the source
   scan cannot name the member a runtime key will resolve to.

## Test Results

All numbers below are from runs executed in this worktree via the brief's
single-test driver (`runTest262File(..., "standalone")`), A/B'd with file
copies (`.tmp/base-*.ts` captured at first edit, `.tmp/ab.sh` to flip). Base =
the pre-WIP tree; "new" = this change-set including the predecessor's WIP.

**Brand rows (the acceptance measure).** Corpus: every file under
`built-ins/{Number,RegExp,Boolean,Date,String}/prototype` matching
`instanceof TypeError` — 46 files.

| | base | new |
| --- | --- | --- |
| fail | 12 | **0** |
| pass | 34 | 46 |

**Scoped regression sweep.** 575 files: everything under
`built-ins/{Number,RegExp,Boolean,Date,String,Object}/prototype` matching the
markers that can reach any changed arm (`defineProperty|defineProperties`,
`.toString =`, `.valueOf =`, `new {String,Number,Boolean}(`,
`.prototype.<name> =`, `.prototype[`). New side run in full (343 pass / 215
fail / 17 compile_error); base side run over BOTH partitions, so every cell is
a run I executed:

- base over the 232 new-side non-passes → **0 passed on base**, i.e. **zero
  regressions**;
- base over the 343 new-side passes → 17 failed on base, i.e. **17 flips**.

**Flip list** (all base `fail` → new `pass`):

```
built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T1.js
built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T3.js
built-ins/Boolean/prototype/valueOf/S15.6.4.3_A2_T1.js
built-ins/Boolean/prototype/valueOf/S15.6.4.3_A2_T3.js
built-ins/Boolean/prototype/valueOf/S15.6.4.3_A2_T4.js
built-ins/Number/prototype/toString/S15.7.4.2_A4_T01.js
built-ins/Number/prototype/toString/S15.7.4.2_A4_T03.js
built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T01.js
built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T03.js
built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T04.js
built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T05.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T4.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T6.js
built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T8.js
built-ins/RegExp/prototype/test/S15.10.6.3_A2_T4.js
built-ins/RegExp/prototype/test/S15.10.6.3_A2_T6.js
built-ins/RegExp/prototype/test/S15.10.6.3_A2_T8.js
```

The 5 Boolean rows are the "Boolean/Date tail" the issue predicted; they do not
carry the `instanceof TypeError` string, so the 46-file candidate corpus missed
them and only the wider sweep found them. **17 flips ≥ the ≥10 bar; 0
regressions.**

**Pins.** `tests/issue-4482.test.ts` — 22 tests, all green (11 fix rows across
four families, 6 controls, 3 `it.fails` residual pins). Named controls, run by
me: `tests/es5-standalone-number-format.test.ts` (green),
`tests/es5-standalone-regexp.test.ts` (green), `tests/issue-4465.test.ts`
(20/20 green). No eval-tier arm is needed — the suite mints nothing from a body
string. `npm run typecheck` green.

## Residuals

Each has an executable `it.fails` pin in `tests/issue-4482.test.ts`, so it
closes itself the day someone fixes the cause.

1. **`Object.defineProperty` on a CLOSED object-literal type installs nothing.**
   `var d = {x:1}; Object.defineProperty(d,"zz",{value:7}); d.zz` reads
   `undefined`. `new Object()`, an evolving-`any` binding and a `Date` receiver
   all work, which bounds this to the closed-struct lowering, not to
   `defineProperty` itself. Owner: object-runtime / literal lowering — not this
   issue's arms.
2. **`typeof` on a value returned through `__apply_closure` reads `"object"`.**
   `o.valueOf()` now correctly answers `7`, but `typeof v === "number"` is
   false. A boxing/`typeof` gap on the dynamic-call return path.
3. **Mixing the dot and bracket spellings in one module breaks the dot call.**
   `var a = o.g(); var b = o["g"]();` — `b` is 7, `a` is `undefined`. Each
   spelling is correct alone. **Measured identically on the BASE commit**, so
   this predates #4482 and is not caused by the new bracket arm; it is why the
   F3 controls are one-spelling-per-module.

Not attempted, and outside the measured corpus: the `Date`-receiver rows only
needed the `defineProperty` half; there is no evidence here about
`Object.defineProperties` (the scan handles it, no test262 row exercised it).
