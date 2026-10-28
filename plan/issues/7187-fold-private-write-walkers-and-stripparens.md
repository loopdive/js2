---
id: 7187
title: "Fold the private identifier-write walkers and stripParens copies into shared helpers"
status: ready
sprint: current
created: 2026-10-28
updated: 2026-10-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
goal: ir-full-coverage
parent: 4495
related: [4495, 7014, 3795]
---

# #7187 — Fold the private write walkers and `stripParens` copies

The "Leave it better" follow-up from [#4495](4495-string-slot-widening-dynamic-assignment.md):
the duplicates #4495 did not fold.

## Problem

1. **Two private write walkers bypass the shared enumerator**
   (`identifierWritesOf`, `src/shared/binding-writes.ts`):
   - `src/ir/dynamic-local-widening.ts` (#3795). It only ever widens, so a
     missed write is not unsound, but it drifts from the enumerator.
   - `src/ir/const-binding-writes.ts#bodyWritesIdentifier` (#7014). It
     ignores destructuring and for-of targets, so a `[x] = …` or
     `for ([x] of …)` write to a `const` loop variable never reaches #7014's
     TypeError demotion.
     - Today the answer is still right: `for (const x of [1]) { [x] = [2]; }`
       throws TypeError on 4/4 cells (PR #6954), because the legacy path catches it.
     - The IR decision is made on an incomplete write set, so this is a drift
       risk, not a known wrong answer.
2. **`stripParens` and `unwrapParens` exist in about 20 private copies.**
   - `stripParens` is now exported from `src/shared/binding-writes.ts`, a
     write-enumeration module, and imported by the literal lowerer.
   - Private `stripParens` copies:
     - `codegen/function-ctor-reflective-call.ts:49`
     - `codegen/expressions/callable-property-host-value.ts:50`
     - `codegen/declarations/assigned-shape-divergent-objects.ts:48`
     - `codegen/classes/class-heritage-runtime-get.ts:49`
     - `codegen/classes/class-heritage-comma.ts:26`
   - `unwrapParens` variants:
     - `ir/ambient-typeof.ts`
     - `ir/module-bindings.ts`
     - `ir/with-environment.ts`
     - `ir/select-planned-closure-operands.ts`
     - `codegen/helpers/self-guarded-constructor.ts`
     - `codegen/expressions/misc.ts`
     - `codegen/expressions/eval-inline.ts`
     - `codegen/expressions/unary-updates.ts`
     - `codegen/async-await-hoist.ts`
     - `codegen/standalone-unavailable-globals.ts`
     - `codegen/generators-native-general.ts`
     - `codegen/generator-yield-linearize.ts`
     - `codegen/statements/control-flow.ts`
   - Some variants also strip TS wrappers (`as`, `!`, `<T>`), so they are
     two helpers, not one.

## Implementation Plan (sketch)

- **Where.** A generic AST helper module in `src/shared/`, for example
  `ast-unwrap.ts`, with `stripParens` and a TS-wrapper-stripping sibling.
  `binding-writes.ts` imports it instead of exporting its own.
- **Walkers.** Replace both private walks with `identifierWritesOf` (with
  `updates` set as each caller needs). For #7014, every write kind the
  enumerator names counts as a write to the const binding.
- **Reuse.** This removes about 20 helper copies and two walkers. Each
  replacement is an import swap.
- **Acceptance.**
  - `[x] = [1]` and `for ([x] of [[1]])` on a const loop variable reach
    #7014's demotion and still throw TypeError on both lanes.
  - The IR claim decisions are byte-identical over the playground and
    equivalence corpora, except the newly caught const writes.
  - **Quality:** no private parens or wrapper unwrapper remains.
