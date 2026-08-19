---
id: 4464
title: "ES5 standalone: language/statements/function bucket — 48 failures in coherent families (strict caller/arguments poison, constructor-return semantics, fn.prototype auto-object, module-init null-deref)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function
goal: standalone-gap
loc-budget-allow:
  # RE-AUDITED at completion against `npm run check:loc-budget` — every entry
  # below is CONSUMED by the shipped diff (the gate names each one and its
  # delta); none was dropped as no-longer-needed, and no entry was added.
  #   new-super.ts        +84  the `new <FunctionExpression>` lowering had to
  #                            construct a receiver, thread it as a trailing
  #                            parameter and return it — [[Construct]] lowering
  #                            lives here and nowhere else.
  #   control-flow.ts     +30  §10.2.1.3 step 13 is a RETURN rule, so its
  #                            externref arm belongs beside the existing
  #                            nominal-struct arm in compileReturnStatement.
  #   context/types.ts    +25  two new FunctionContext bits + the doc comments
  #                            explaining why they are NOT `isConstructor`.
  #   fnctor-escape-gate  +12  the post-`return` reachability cut in field
  #                            derivation.
  # The F1 poison arms (+77 in function-poison-pill.ts, +10 in
  # -access.ts) and the new construct-return-value.ts needed NO grant — they
  # are inside their own subsystems' budgets.
  - src/codegen/expressions/new-super.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/context/types.ts
  - src/codegen/fnctor-escape-gate.ts
func-budget-allow:
  # RE-AUDITED at completion against `npm run check:func-budget`; all three are
  # consumed (+16 / +68 / +12). compileNewFunctionExpression carries the bulk
  # because the receiver mint, the trailing-parameter thread and the arity
  # normalisation are one indivisible sequence at one call site — splitting it
  # would move operands away from the emission order that makes them correct.
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
  - src/codegen/expressions/new-super.ts::compileNewFunctionExpression
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
related: [4426, 4456, 4442]
origin: "2026-08-15 ES5-standalone session — baseline bucket analysis after wave 10; 48/8115 ES≤5 rows fail under language/statements/function, third-largest tractable bucket (with=deferred, descriptor lane=#3251-owned)."
---

# #4464 — language/statements/function: 48 ES5 standalone failures

## Problem

48 es5id rows under `test/language/statements/function/` fail standalone
(baseline fetched 2026-08-15 16:15, post-#4561 promote). Signatures from the
baseline JSONL group into coherent families:

- **F1 — strict caller/arguments poison (8 files)**: `13.2-{5,6,9,10,13,14,17,18}-s.js`
  — accessing `.caller`/`.arguments` on a strict-mode function must throw
  TypeError; nothing is thrown.
- **F2 — [[Construct]] this/return semantics (~9 files)**: `S13.2.2_A15_T1..T4`
  (constructor returns primitive → `new` must yield the created object;
  props read back null/NaN), `S13.2.2_A16_T1..T3` (property-on-null at
  runtime), `S13.2.2_A18_T1/T2` (`arguments.callee` in constructor call).
- **F3 — fn.prototype auto-object (~7 files)**: `S13.2_A1_T1/T2`,
  `S13.2_A4_T1/T2`, `S13.2.2_A1_T1/T2`, `S13.2.2_A19_T7/T8` — every function
  must own a `.prototype` object with `constructor` back-ref;
  `__func.prototype !== undefined` fails, `isPrototypeOf(new F())` fails.
- **F4 — module-init null-deref crash (4 files)**: `S13.2.2_A6_T2`,
  `S13.2.2_A7_T1`, `S13.2.2_A8_T1/T2` — `dereferencing a null pointer
  [in __module_init()]`. Crash class: diagnose first, may be one emission bug.
- **F5 — misc singletons** (not in scope unless trivial): Math.sin standalone,
  `__get_builtin` CE, arguments-override semantics (S13_A15_*), etc.

## Implementation Plan

1. Re-verify each family live with the `.tmp/run-one.mts` driver before
   touching anything (the baseline may lag main by a few merges).
2. Triage F4 FIRST (crash class beats wrong-answer class): get the real
   trap site via `emitWat` on one repro; likely one shared emission defect.
3. Then pick the 1–2 largest families where the fix is a bounded emission
   change. F1 is likely the cleanest: strict-function metadata exists at
   compile time; the poison arm can be a compile-time-known throw on
   `.caller`/`.arguments` reads of strict functions (mind: only when the
   VALUE is a strict function — dynamic receivers need the runtime arm to
   decline, absent-not-wrong).
4. F2/F3 touch the closure/constructor substrate — read
   `src/codegen/expressions/new-indexed.ts`, `closure-prototype-edge.ts`
   (#2660 M3), `function-instance-meta*.ts` (#4437) before deciding; if the
   fix needs the #3976 class-object conversion, record the dependency and
   stop rather than bolt a parallel substrate.
5. Scoped sweep before/after over `language/statements/function/` (all
   ~190 files, standalone) — report pass counts from your own runs; zero
   regressions tolerated elsewhere: run the fn-family pins
   (issue-4436/4437/4440/4442/4443/4456 tests).

## Acceptance criteria

- ≥15 of the 48 rows flip to pass (F1+F4 alone are 12; F2 or F3 gets past
  that bar).
- Zero regressions in the scoped sweep and fn-family pins.
- Families NOT fixed get residual rows with owners in this file.

## Root cause (per family)

**F1 — poison accessors never installed on a `Function(…)` product.**
`tryCompileFunctionPoisonRead` decides "is this receiver a strict function?"
through `sourceFunctionForValue`, which can only answer for functions that have
a **source declaration in this program**. `var foo = new Function("'use
strict';")` has none — its body is a runtime string — so the arm declined and
`foo.caller` read `undefined` instead of throwing. §13.2 step 19-20 installs the
`[[ThrowTypeError]]` accessors regardless of HOW the function was created, and
the strictness question is nevertheless decidable at compile time whenever the
body argument is a **literal**: a Directive Prologue is a syntactic property of
that string.

**F2 — `new <FunctionExpression>` was not a construction at all.**
`compileNewFunctionExpression` called the lifted body and then pushed a literal
`ref.null.extern`, with the comment "we don't construct actual objects". There
was no receiver, so `this.prop = 1` had nothing to write to and the first
property read on the result trapped. Two smaller defects sat underneath it: the
call site pushed one operand per call-site argument with no arity
normalisation, and a `return` in the body fell through the generic value-return
path.

**F2b / F4 — the fnctor DECLARATION path's crash class was three defects, not
one.** `S13.2.2_A6_T2`'s `dereferencing a null pointer` came from
(a) `emitFnctorConstructorArguments` pushing surplus `new F(a, b)` arguments
that the `call` then consumed, so every declared parameter read the argument to
its right — on this branch's base that shape did not even VALIDATE
(`local.set[0] expected type externref, found f64.const`); (b) `deriveFnctorFields`
deriving a slot from a `this.x = …` that sits **after** an unconditional
`return`, i.e. code that never runs, so the read answered the slot's null
default instead of `undefined`; and (c) a `return <primitive>` in a fnctor
constructor being coerced to the struct return type — `ref.null $__fnctor_F` —
because §10.2.1.3 step 13 was gated on `isConstructor` (class constructors)
only.

**F5 (dead-binding elision) — early errors were deleted with the binding.**
`elideDeadTopLevelBindings` runs as a pre-pass **before** the program is parsed
for diagnostics. It already refused to drop binding NAMES carrying early errors,
but not initializers, so `"use strict"; var f = function (param, param) {};`
(never referenced) compiled clean — three `negative: phase: parse` files had no
error left to report.

## Fix

| file | change |
| ---- | ------ |
| `src/codegen/function-poison-pill.ts` | `isStrictFunctionConstructorValue` — recognises `Function(<literal>)` / `new Function(<literal>)` with a `use strict` Directive Prologue, directly or through one variable binding. Declines on a shadowed `Function`, a non-literal body, or a directive that is not first. |
| `src/codegen/function-poison-pill-access.ts` | routes that predicate into both the read arm and the assignment arm. |
| `src/codegen/expressions/new-super.ts` | `compileNewFunctionExpression` mints a `__new_plain_object` receiver at the call site, threads it as a **trailing** parameter (leading would shift the `arguments` materialisation's fixed `paramOffset`), returns it, and normalises arity (surplus arguments evaluated in source order then dropped; missing ones defaulted). `compileNewFunctionDeclaration` marks its context `isFnctorConstructor`. |
| `src/codegen/construct-return-value.ts` (new) | the §10.2.1.3 step-13 runtime Type(V) probe for the externref arm — null tested FIRST and separately (`__typeof_object(null)` answers 1 by design), functions counted as Objects. Declines, emitting nothing, when the predicates are absent. |
| `src/codegen/statements/control-flow.ts` | `compileReturnStatement` applies step 13 for the externref receiver, and extends the existing nominal-struct arm to `isFnctorConstructor`. |
| `src/codegen/context/types.ts` | `isFnctorConstructor` + `constructThisExternLocal`. Deliberately NOT reusing `isConstructor`, which also gates `new.target` off a class-id global that no fnctor `new` site writes. |
| `src/codegen/fnctor-constructor-identity.ts` | surplus-argument drop (evaluated for side effects, then dropped). |
| `src/codegen/fnctor-escape-gate.ts` | per-list reachability cut after an unconditional `return`/`throw`. A return nested in an `if` leaves the tail reachable and is left alone. |
| `src/compiler/early-errors/index.ts`, `src/deadcode-elide.ts` | `subtreeHasEarlyError` + the elision guard. Over-reporting is harmless here: a false positive only KEEPS a dead binding. |

## Test Results

All numbers below are from runs executed on this branch. The base column is
`origin/main` reproduced in place by reverting exactly the files this change-set
touches (`.tmp/base-*` copies captured from `git show origin/main:<path>`), so
the two columns differ by this diff and nothing else.

**Scoped sweep — `language/statements/function/`, standalone, all 256 `.js`
files, `runTest262File(..., "standalone")`:**

| state | pass | fail | compile_error |
| ----- | ---- | ---- | ------------- |
| `origin/main` | 194 | 60 | 2 |
| this branch | **209** | 45 | 2 |

**+15 flips, 0 regressions** (no `pass → non-pass` and no other status change):

```
13.2-5-s   13.2-6-s   13.2-9-s   13.2-10-s  13.2-13-s
13.2-14-s  13.2-17-s  13.2-18-s                        (F1, 8)
S13.2.2_A16_T1  S13.2.2_A16_T2  S13.2.2_A16_T3         (F2, 3)
S13.2.2_A6_T2                                          (F2b/F4, 1)
13.1-4gs   13.1-8gs   enable-strict-via-outer-script    (F5, 3)
```

**Adjacent buckets** (`language/expressions/new/` + `language/expressions/function/`,
128 files, same A/B): 83 → **84** pass, 0 regressions
(`use-strict-with-non-simple-param.js` flips).

**Fn-family pins** — `tests/issue-4436 4437 4440 4442 4456 4460`: 95/95 pass.

**New pins** — `tests/issue-4464.test.ts`: 20/20 (17 assertions + 3 `it.fails`
residual pins).

**Gates**: `typecheck`, `lint` (changed files), `check:loc-budget`,
`check:func-budget`, `check:stack-balance`, `check:oracle-ratchet`,
`check:pushraw`, `check:codegen-fallbacks`, `check:ir-fallbacks`,
`check:test-vacuity-shapes`, `check:issue-spec-coverage` — all OK.

**Pre-existing failures on `origin/main`, NOT caused by this change** (verified
identical at base and on this branch, same test names): `issue-3520-ir-unit-identity`
(2), `issue-2608-new-this-fnctor-static` (4), `issue-4155-fnctor-shape-regression`
(1), `issue-743-derivation-defaults` (2). Worth a separate triage task.

## Residuals

| family | files | why not fixed here | owner |
| ------ | ----- | ------------------ | ----- |
| **F3 — `fn.prototype` auto-object** | `S13.2_A1_T1/T2`, `S13.2_A4_T1/T2`, `S13.2.2_A1_T1/T2`, `13.2-17-1`, `13.2-18-1` | Needs every function value to own a prototype OBJECT with a `constructor` back-ref **and** `new F()` to link instances to it — `S13.2.2_A1_T1/T2` assert `__PROTO.isPrototypeOf(new F())`. A fnctor instance is a nominal struct with no prototype link, so this is the **#3976 class-object conversion**, not a second prototype substrate. Measured: `F.prototype === undefined` on both base and this branch. A partial fix (a fresh object with no instance linkage) would flip 2–4 files while shipping a prototype that is not actually the instances' prototype. | **blocked on #3976** |
| **F2 residual — DECLARATION fnctor returning an object** | `S13.2.2_A7_T1`, `S13.2.2_A8_T1/T2`, `S13.2.2_A15_T1..T4` | The fn-EXPRESSION path yields an externref object, so its `return <object>` can override the receiver. The DECLARATION path yields a nominal struct whose property reads are typed from the checker's instance type — the sweep shows exactly that signature (`__obj.prop` answers `1`/`null`/`NaN` where `"A"` was written to a plain object). Handing back an arbitrary object requires re-typing every read at the `new` site: the same #3976 conversion. Improvement banked anyway: base **trapped** here (`dereferencing a null pointer`), it now answers the receiver. | **blocked on #3976** |
| **F1 residual — computed `Function(body)`** | (none in the bucket) | Deliberate decline, not a defect: strictness of a non-literal body is not decidable at compile time, and unknown strictness must answer `undefined` rather than throw. Pinned `it.fails`. | n/a |
| **`with`-dependent** | `S13.2.2_A18_T1/T2` | `with` is a deferred feature project-wide. | deferred |
| **F5 misc singletons** | `S13.2.1_A5_T2` (`Math.sin` standalone), `S13.2.2_A8_T3` (`__get_builtin` CE), `S13_A15_*` (arguments override), `unscopables-*`, `scope-param-*` | Unrelated single defects, each its own root cause. | unclaimed — file individually if pursued |
