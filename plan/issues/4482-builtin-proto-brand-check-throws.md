---
id: 4482
title: "ES5 standalone: builtin prototype-method brand checks — wrong-receiver calls must throw real TypeErrors (RegExp 6 + Number 6 + Date/Boolean tail, ~16 rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
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
