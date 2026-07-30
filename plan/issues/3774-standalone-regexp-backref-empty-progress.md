---
id: 3774
title: "Standalone RegExp quantified empty backreferences exhaust the step limit"
status: in-review
created: 2026-07-28
priority: high
task_type: bugfix
area: codegen
goal: es5
es_edition: 5
assignee: ttraenkler/codex-es5-regexp-backref-progress
sprint: current
related: [1539, 1912, 1959]
---

# #3774 — Standalone RegExp quantified empty-backreference progress

## Problem

The RegExp compiler classifies every backreference as non-nullable. A
backreference can instead match empty when its capture did not participate or
when the participating capture spans zero input units. Quantifying that
backreference therefore omits the existing `PROGRESS` guard and repeatedly
matches at the same input position until the standalone VM exhausts its step
limit.

The two current-main ES5 Test262 failures in this root-cause family are:

- `built-ins/RegExp/S15.10.2.5_A1_T5.js`
- `built-ins/RegExp/S15.10.2.9_A1_T5.js`

Both exercise `/(a*)b\1+/`. Host passes 2/2; standalone fails 0/2 with
`RangeError: regular expression step limit exceeded`.

## Specification

ECMAScript 2026
[RepeatMatcher §22.2.2.3.1](https://tc39.es/ecma262/2026/multipage/text-processing.html#sec-repeatmatcher)
rejects a further repetition after the minimum has been satisfied when the
iteration did not advance its end index. Its accompanying note names
`/(a*)b\1+/.exec("baaaac")` and requires the result `["b", ""]`.

[BackreferenceMatcher §22.2.2.7.2](https://tc39.es/ecma262/2026/multipage/text-processing.html#sec-backreferencematcher)
continues without consuming input for an unset capture and uses the captured
range length otherwise, which can also be zero.

## Fix

Conservatively classify backreferences as nullable. This reuses the progress
instruction added by #1959 for quantified nullable bodies. Over-approximation
only adds a cheap comparison for quantified backreferences; consuming
backreferences continue repeating while their input position advances.

## Acceptance criteria

- Both ES5 Test262 cases pass in standalone and remain passing in host.
- The TypeScript reference VM and standalone Wasm return the spec result.
- A consuming quantified-backreference control remains greedy.
- The complete classified ES5 RegExp cohort has no regressions or non-target
  status/error-signature drift in same-SHA A/B measurement.

## Verification

Control and candidate use exact `origin/main@108c41ecf166b195741a6f2509539471868156b7`.
The classified ES5 RegExp union contains 500 files: 499 occur in the canonical
host baseline and all 500 occur in the canonical standalone baseline.

- Same-SHA local host union: 466/500 → 466/500, zero status or non-pass
  signature changes. Restricting to the 499-file canonical host membership is
  465/499 → 465/499.
- Same-SHA local standalone: 406/500 → 408/500.
- Exact transitions: the two listed tests change from step-limit failure to
  pass. There are zero pass losses and zero other status/signature changes.
- Refreshed canonical baseline records classify host as 467/499 and standalone
  as 405/500; these artifact counts are reported separately from the
  local-vs-local A/B.
- Focused and related #1912/#1959 tests pass 81/81.
- Typecheck, scoped format/lint, LOC/function budgets, oracle ratchet, pushRaw,
  dead-export, IR-adoption, codegen-fallback, and coercion-site gates pass.
