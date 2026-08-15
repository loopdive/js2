---
id: 4464
title: "ES5 standalone: language/statements/function bucket — 48 failures in coherent families (strict caller/arguments poison, constructor-return semantics, fn.prototype auto-object, module-init null-deref)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function
goal: standalone-gap
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
