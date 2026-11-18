---
id: 7361
title: "IR `typeof` answered from the hinted IR type: `typeof void 0` was \"number\""
status: done
sprint: current
created: 2026-11-18
updated: 2026-11-18
completed: 2026-11-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7354, 7106, 7104]
---

# #7361 — `typeof` answered from the hinted IR type: `typeof void 0` was "number"

## Problem

This is a wrong answer on the ordinary pipeline (the JS environment and `--target standalone`) and on the Prepared
path:

```js
export function g() { return typeof void 0 === "undefined"; } // node: true; IR: false
```

Measured on `origin/main` `c3f8802445`. Each program returns its result from a function and is compared with node.
"ir" means the function was compiled by the IR path; "legacy" means it went to the older non-IR code generator.

| Program | Ordinary default and standalone | Prepared |
| --- | --- | --- |
| `typeof void 0 === "undefined"` / `=== "number"` | wrong (ir) | refuses |
| `typeof (c ? void 0 : void 0) === "undefined"` | wrong (ir) | refuses |
| `typeof (0, void 0) === "undefined"` | wrong (ir) | refuses |
| `typeof void f() === "undefined"` | wrong (ir) | refuses |
| `switch (typeof void 0) { case "undefined": … }` | wrong (ir) | wrong |
| `typeof (c ? void 0 : 1)` | correct (legacy) | refuses (wrong on the #7354 T/X branch) |

These are correct everywhere: `typeof undefined`, `typeof null`, a call returning undefined, literals, `!0`, `-x`,
typed locals and `NaN`.

## Cause

`lowerTypeOf` (`src/ir/from-ast.ts`) lowers its operand under an f64 hint and answers from the IR type the lowering
produced (`staticTypeOfFor`): an f64 reads as "number". The `void` arm of `lowerExpr` honours that hint: under any
non-dynamic hint it returns the f64 NaN sentinel ("numeric consumers use its ToNumber result"), so `typeof void x` read
"number". The siblings are right for their own reasons, not because of the hint:

- the identifier `undefined` ignores the hint and always lowers to the carrier's `dyn.undefined`, so `typeof` takes the
  runtime `dyn.typeof` path;
- `null` under an f64 hint is refused (`bare 'null' in non-reference context`), so the function goes to legacy;
- a call to a function that returns nothing is refused as a value (`returned void used as expression`) and goes to
  legacy.

`void` is the only operand the f64 hint turns into a value of the wrong kind. The IR type is otherwise truthful; only
its reading of the NaN sentinel is not. The IR already recognises that sentinel syntactically (`isValueVoid`, which
`irOperandFamily` uses to call such an f64 "undefined" rather than "number").

## Implementation Plan

- **Module.** `lowerTypeOf` stays in `src/ir/from-ast.ts`, split into two siblings:
  - `lowerTypeOfValue` is the old body, unchanged (the static answer from the IR type, the #5092 two-family dispatch,
    `dyn.typeof`).
  - `lowerTypeOfVoidLeaves` handles an operand with a value-`void` leaf. It splits the operand at its leaves, which
    is exact JavaScript: `typeof (a, b)` is `a` for effects then `typeof b`; `typeof (c ? a : b)` is
    `c ? typeof a : typeof b`; parentheses and type assertions are transparent. A `void x` leaf lowers `x` once with
    `lowerDiscardedExpression` (the call the `void` arm itself makes) and answers "undefined". Any other leaf goes to
    `lowerTypeOfValue`.
  - The `?:` split reuses `lowerConditionalBranches`, the helper every conditional lowering shares (only the chosen arm
    runs, each arm in its own scope copy). It keeps `lowerConditional`'s fold of a constant `typeof <ambient>` test,
    because the selector admitted only the live arm.
- **Predicates.** `isValueVoid` and the new `hasValueVoidLeaf` move to `src/ir/analysis/operand-admissibility.ts`,
  beside `conditionalJoinArmFamily` (the other syntactic value-`void` rule). They share one walk, `valueLeafOf`.
  `valueLeafOf` uses the shared `skipOuterExpressions`. from-ast's private copy of that function
  (`unwrapMixedPrimitiveProjection`, identical body) is folded into it.
- **Byte identity.** An operand without a value-`void` leaf goes to `lowerTypeOfValue` exactly as before.
- **No TypeScript types.** The rule reads only syntax. No oracle and no checker. There is no new demotion: the only
  refusals are the ones each leaf's own lowering already had.
- **Removed from round 1:** `src/ir/typeof-static-answer.ts`, `uniformJsTagOfFact` in `src/checker/oracle.ts`, the
  fallback `TsCheckerOracle`, and the `compiler-boundaries.json` entry.
- **Quality criterion.** No new module. `from-ast.ts` stays inside its LOC budget: the moved predicates and the folded
  duplicate pay for the new arm. Each value-`void` question goes through one walk.

### Round 1 (superseded)

Round 1 took the answer from the operand's source type through the oracle (`src/ir/typeof-static-answer.ts`,
`uniformJsTagOfFact`) and demoted when it disagreed with the IR type. Review round 1 rejected it: a source type is a
claim that a cast can contradict, and the demotion fired after IR-first had skipped the legacy body.

## Result

Measured on this branch after merging `origin/main` `c5497e48c6`. "Main" is that commit's `from-ast.ts`, swapped in by
a file copy.

| Program | Default and standalone, main → branch | Prepared, main → branch |
| --- | --- | --- |
| `typeof void 0` (and `void 1`, `void "a"`, `void true`, `((void 0))`, `void void 0`) | wrong (ir) → right (ir) | wrong → right |
| `typeof (0, void 0)`, `typeof (c, void 0)` | wrong (ir) → right (ir) | refused → refused (TS "left side of comma" diagnostic) |
| `typeof (c ? void 0 : void 0)` | wrong (ir) → right (ir) | wrong → right |
| `typeof (c ? void 0 : 1)`, `: "s"`, `: true` | right (legacy) → right (legacy) | wrong or refused → right |
| `switch (typeof void 0)` | wrong (ir) → right (ir) | wrong → right |
| `typeof void f()`: `f` runs once, a throw propagates | wrong (ir) → right (ir) | refused (`__ir_dyn_add`, from `n = n + 1`) → same; the throwing case is right |
| `typeof (void 0 as any as number)` (.ts) | wrong (ir) → right (ir) | not applicable |

- **Sweep.** 348 programs: 68 operands × {`=== "undefined"`, `"number" !==`, `=== "boolean"`, `"string" ===`, the
  value used through a tag chain}, plus 18 parameter, switch and effect programs. Each runs on the ordinary default
  and standalone targets and the Prepared path, and is compared with node. The operands cover `void` forms, `?:`
  mixes, commas, `undefined`, `null`, calls, literals, `NaN`/`-0`/`Infinity`, i32 `|`/`>>>`/`<<`, comparisons,
  `typeof typeof`, lying casts in `.ts`, and `any`/`unknown` parameters in `.js` and `.ts`.
  - On the branch: 0 wrong answers and 0 compile errors.
  - Against main, 68 rows change, with 146 lane results going wrong → right (or refused → right on Prepared).
    No result gets worse. No ordinary function moves between the IR and legacy paths.
  - A further 20 position probes (`for`/`while`/`do` bodies, `if`/`else` arms, a `switch` case, `try`/`finally`,
    `&&`/`||`, nested functions, unused results with effects, `var` redeclared across loops) show 13 rows going
    wrong → right and no other change.
- **Tests.** `tests/issue-7361-typeof-static.test.ts`, 91 tests:
  - 39 programs × {gc, standalone} compared with node, including review items 1–3;
  - 6 programs per target that must stay on the IR path: `void`, a comma, `?:`, two lying casts, and the
    `typeof JSON` fold;
  - 6 Prepared programs, each checked twice: the right answer returns and a wrong answer throws;
  - 1 Prepared refusal by name (a dynamic leaf beside a `void` leaf: `dyn.typeof`).
- **Mutations.** 13 mutations, 0 survivors. Failures per mutation:
  - always take `lowerTypeOfValue`: 30;
  - drop the `void` leaf: 30;
  - skip the `void` leaf's operand effects: 7;
  - drop the comma split: 4;
  - skip the comma's left effects: 2;
  - drop the `?:` split: 6;
  - drop the `typeof <ambient>` fold: 2;
  - `||` → `&&` in `hasValueVoidLeaf`: 3;
  - drop its `?:` arm: 6;
  - drop the comma walk in `valueLeafOf`: 4;
  - peel parens only (not assertions) at the start of `valueLeafOf`: 2;
  - no peel on the comma's right side: 2;
  - no peel in `lowerTypeOfVoidLeaves`: 14.
- **Bytes.** Ordinary output was compared on 200 test262 files × {default, standalone}: all of `expressions/typeof`
  and `expressions/void`, `typeof` users in conditional, comma, switch, if, Number, Boolean and logical operators,
  and rows of the 411-row ES5 list.
  - 199 files are identical; one of them is a compile error on both sides.
  - The one changed file is `language/expressions/typeof/undefined.js`. Through `runTest262File` it fails on main
    (`Expected SameValue(«"number"», «"undefined"»)`) and passes on the branch, on both targets.
- **Gates.** These pass: typecheck; loc and func, also with `LOC_GATE_BASE=origin/main` (net +19 LOC, `from-ast.ts`
  within budget); coercion-sites; oracle-ratchet; dead-exports; import-cycles; `check:ir-dialect`; the
  compiler-boundaries inventory (`--base origin/main`); and `changed-root-tests.sh` with the interpreter engine.
  - These existing test files pass: the Prepared entry and runtime tests, the #7188 test, and eleven typeof/void test
    files (#1896, #2175, #2668, #4376, #4555, #4607, #5092, #6434, #6604, #6622, and the dynamic void module test).
  - `issue-4529` (1 test) and `issue-7106-ambient-static-calls` (4 tests) fail identically on main.

### Review round 1

1. **New compile failure on an untyped parameter** (`function k(x){ return typeof x === "number" ? 1 : 0 }`, and
   the `if (typeof x === "number") return x + 1` form). The source-type rule and its demotion are gone, and the new
   path adds no demotion. Both programs, and an `any`/`unknown` `.ts` twin, compile and answer like node on both
   targets. They are in the test file.
2. **`typeof ((1 as any) as undefined)` answered "undefined".** No TypeScript type is read now. It answers "number"
   from the IR type, as on main (tested).
3. **Lying casts went to legacy** (`1 as unknown as string`, `"a" as any as boolean`, `true as any as number`). They
   stay on the IR path with main's answer (tested, including an IR-path assertion). Assertions are now transparent
   to the `void` check, so `void 0 as any as number` answers "undefined" (it was wrong on main).
4. **Mutation survivors.** The new logic has 13 mutations and none survive (see Result).

### Known, not this change

These are wrong on main and on this branch. Each function goes to the legacy generator, which answers from the
cast or declared type:

- `typeof x!` where `x?: number` is undefined;
- `typeof (null as unknown as undefined)`;
- `typeof v()` where `v(): void` returns `1 as any`.

On the Prepared path, `typeof` of a dynamic value is still refused by name (`dyn.typeof has no Prepared intrinsic`).
