---
id: 7547
title: "Prepared path: one closure-capture analysis; a closure capturing a closure is refused where it is made"
status: done
completed: 2026-11-26
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: ir
goal: ir-full-coverage
depends_on: [7492]
related: [7354]
---

# #7547 — a closure capturing a closure on the Prepared path

## Problem

The native WasmGC closure carrier has no field for a closure-typed capture. A program that makes such a closure is
refused as a whole, at physical setup: "closure capture closure needs its actual native carrier owner"
(`src/ir/program/native-source-closure-requirements.ts`). The program is refused even when it never calls that
closure. For example, `function g(){ var b = function(){…}; var a = function(){ return b() + 1; }; … }` does not
compile.

#7492 refused the same shape for hoisted nested declarations by name in `makeHoistedClosures`, so that the enclosing
function aborts instead. That ran `analyseCaptures` twice per declaration, and left function expressions refused at
program level (PRV-7492 review, follow-up b).

## Measured

Main `c3b7be66`, ES5 Prepared census (9,174 files, `scripts/ir-census/prepared-census.mts --harness real`, with
abort rows):

- 0 rows carry the physical-setup refusal, either as a first stop or as an abort.
- On #7492's head `c9e2ec5e`, 0 of the 2,132 re-measured files abort on its refusal.

The shape sits behind other walls today. This issue is a quality fold, with no measured yield.

## Implementation Plan

- **Module:** `src/ir/from-ast.ts`, `lowerClosureExpressionWithSignature`. This is the one place every closure is
  made (literal, hoisted declaration, descriptor closure), right after its single `analyseCaptures`. A
  closure-typed capture is refused there by name. The refusal is owned by the function the closure is made in, so
  that function gets the abort body.
- **Gate:** a resolver capability, `refusesClosureCapturedClosure()`. Only the Prepared native lane's resolver sets
  it (`src/ir/source-dynamic-contracts.ts`). The ordinary pipeline and the JS environment have no such gap and do
  not ask, so their bytes are unchanged.
- **Removes:** the second `analyseCaptures` and the refusal in `makeHoistedClosures`.
- **Quality criterion:** one capture analysis per closure, and one refusal site for every closure source.

### Unscheduled: the carrier itself

The real fix is a closure-typed capture field in the native closure shape
(`src/backend/wasmgc/resources/native-source-closures.ts`, `scalar()` in
`native-source-closure-requirements.ts`). Once it exists, `refusesClosureCapturedClosure` goes away. It is to be
scheduled when a census shows files behind it.

## Acceptance criteria

1. #7492's pins pass, with the refusal text updated. A function-expression pair that is never called compiles and
   agrees with node. Called, it aborts by name.
2. Ordinary pipeline and JS-environment bytes are identical (`scripts/byte-diff-corpus.mts` sample corpus).
3. No census file lost on #7492's measured set.
