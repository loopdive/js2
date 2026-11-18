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
  - `lowerTypeOfVoidLeaves` handles an operand that can yield a `void` value. It splits the operand at its leaves,
    which is exact JavaScript: `typeof (a, b)` is `a` for effects then `typeof b`; `typeof (c ? a : b)` is
    `c ? typeof a : typeof b`; parentheses and type assertions are transparent. A `void x` leaf lowers `x` once with
    `lowerDiscardedExpression` (the call the `void` arm itself makes) and answers "undefined". Any other leaf goes to
    `lowerTypeOfValue`.
  - The `?:` split reuses `lowerConditionalBranches`, the helper every conditional lowering shares: only the chosen
    arm runs, and each arm gets its own scope copy.
  - The fold of a constant `typeof <ambient>` test (the selector admitted only the live arm) is one helper,
    `foldedAmbientConditionArm`, used by `lowerConditional` and by the split.
- **The leaf question.** "Can the operand yield a `void x` value?" is a "some" over the shared walker
  `everyYieldedValue` (`src/ir/analysis/carrier-expression.ts`: `?:` arms, comma and `=` right sides). Each leaf is
  peeled of assertions (`skipOuterExpressions`) only inside this question.
  - An `=` leaf (`typeof (y = void 0)`) passes the question, but the split does not open it. It goes to
    `lowerTypeOfValue` exactly as on main.
- **`isValueVoid` keeps main's reach.** Parens and a comma's right side only, matching the selector's operand
  families; `irOperandFamily` is its only caller.
  - It moves unchanged to `src/ir/analysis/operand-admissibility.ts`, beside `conditionalJoinArmFamily`.
  - `conditionalJoinArmFamily` stays separate. It classifies ONE `?:` arm into a family (string, number or boolean
    literal, or `void`) for the dynamic join, and walks nothing. `isValueVoid` asks one question of one value through
    commas. Neither is a yielded-value walk.
- **Duplicate removed.** from-ast's private `unwrapMixedPrimitiveProjection` had the same body as the shared
  `skipOuterExpressions`, so it is folded into it.
- **Byte identity.** An operand with no `void` leaf goes to `lowerTypeOfValue` exactly as before.
- **No TypeScript types.** The rule reads only syntax: no oracle and no checker. There is no new demotion; the only
  refusals are the ones each leaf's own lowering already had.
- **Removed from round 1.** `src/ir/typeof-static-answer.ts`, `uniformJsTagOfFact` in `src/checker/oracle.ts`, the
  fallback `TsCheckerOracle`, and the `compiler-boundaries.json` entry.
- **Quality criterion.** No new module. `from-ast.ts` stays inside its LOC budget. One walker answers the leaf
  question.

### Round 1 (superseded)

Round 1 took the answer from the operand's source type through the oracle (`src/ir/typeof-static-answer.ts`,
`uniformJsTagOfFact`) and demoted when it disagreed with the IR type. Review round 1 rejected it: a source type is a
claim that a cast can contradict, and the demotion fired after IR-first had skipped the legacy body.

## Result

Measured on this branch, merged with `origin/main` `c5497e48c6`. "Main" means that commit's `from-ast.ts` and
`operand-admissibility.ts`, swapped in by file copy.

| Program | Default and standalone, main → branch | Prepared, main → branch |
| --- | --- | --- |
| `typeof void 0` (and `void 1`, `void "a"`, `void true`, `((void 0))`, `void void 0`) | wrong (ir) → right (ir) | wrong → right |
| `typeof (0, void 0)`, `typeof (c, void 0)` | wrong (ir) → right (ir) | refused → refused (TS "left side of comma" diagnostic) |
| `typeof (c ? void 0 : void 0)` | wrong (ir) → right (ir) | wrong → right |
| `typeof (c ? void 0 : 1)`, `: "s"`, `: true`, `(c ? (d ? void 0 : 1) : 2)` | right (legacy) → right (legacy) | wrong or refused → right |
| `switch (typeof void 0)` | wrong (ir) → right (ir) | wrong → right |
| `typeof void f()`: `f` runs once, a throw propagates | wrong (ir) → right (ir) | refused (`__ir_dyn_add`, from `n = n + 1`) → same; the throwing case is right |
| `typeof (void 0 as any as number)` (.ts) | wrong (ir) → right (ir) | not applicable |

- **Sweep.** 376 programs, each run on the ordinary default and standalone targets and the Prepared path, and
  compared with node:
  - 68 operands × {`=== "undefined"`, `"number" !==`, `=== "boolean"`, `"string" ===`, the value used through a tag
    chain};
  - 18 parameter, switch and effect programs;
  - 25 position probes: `for`/`while`/`do` bodies, `if`/`else` arms, a `switch` case, `try`/`finally`, `&&`/`||`,
    nested functions, unused results with effects, `var` redeclared across loops, nested mixed `?:`, an `=` leaf;
  - review round 2's three programs.

  Results against main:
  - 83 rows change: 170 lane results go wrong → right, and 10 Prepared results go refused → right.
  - No result gets worse.
  - **No function moves between the IR and legacy paths.**

  Wrong answers that remain on the branch are all wrong on main as well:
  - review round 2's three programs, listed under Known;
  - `typeof (y = void 0)`, which is a compile error on main and the branch ("Type 'undefined' is not assignable to
    type 'number'").
- **Tests.** `tests/issue-7361-typeof-static.test.ts`, 99 tests:
  - 39 programs × {gc, standalone} compared with node, including review items 1–3;
  - 9 programs per target that must stay on the IR path: `void`, a comma, `?:`, two lying casts, the `typeof JSON`
    fold, and review round 2's three programs;
  - 8 Prepared programs, each checked twice: the right answer returns and a wrong answer throws. Two of them are the
    nested `?:`;
  - 1 Prepared refusal by name (a dynamic leaf beside a `void` leaf: `dyn.typeof`).
- **Mutations.** Of 12 mutations, 11 are killed (failure counts in brackets):
  - the leaf question:
    - always false [33];
    - no assertion peel at the leaf [2];
    - "every" instead of "some" [4];
  - the `void` leaf:
    - dropped [33];
    - its operand effects skipped [7];
  - the comma split:
    - dropped [6];
    - its left effects skipped [2];
  - the `?:` split:
    - dropped [7];
    - arms recurse only through `isValueVoid` [1];
  - the `typeof <ambient>` fold dropped [2];
  - `isValueVoid` peels assertions [6], which kills the round-2 must-fix in the other direction.

  The survivor is "arms lowered with the outer `cx` instead of the arm's scope copy"; see Review round 2, item 4.
- **Bytes.** Ordinary output was compared on 200 test262 files × {default, standalone}: all of `expressions/typeof`
  and `expressions/void`, `typeof` users in conditional, comma, switch, if, Number, Boolean and logical operators,
  and rows of the 411-row ES5 list.
  - 199 files are identical; one of them is a compile error on both sides.
  - The one changed file is `language/expressions/typeof/undefined.js`. Through `runTest262File` it fails on main
    (`Expected SameValue(«"number"», «"undefined"»)`) and passes on the branch, on both targets.
  - Review round 2's three programs are byte-identical to main on both targets.
- **Gates.** These pass:
  - typecheck;
  - loc and func, also with `LOC_GATE_BASE=origin/main` (net +13 LOC, `from-ast.ts` within budget);
  - coercion-sites, oracle-ratchet, dead-exports, import-cycles and `check:ir-dialect`;
  - the compiler-boundaries inventory (`--base origin/main`);
  - `changed-root-tests.sh` with the interpreter engine.

  Existing tests:
  - These pass: the Prepared entry and runtime tests, the #7188 test, and eleven typeof/void test files (#1896,
    #2175, #2668, #4376, #4555, #4607, #5092, #6434, #6604, #6622, and the dynamic void module test).
  - `issue-4529` (1 test) and `issue-7106-ambient-static-calls` (4 tests) fail identically on main.

### Review round 1

1. **New compile failure on an untyped parameter** (`function k(x){ return typeof x === "number" ? 1 : 0 }`, and
   the `if (typeof x === "number") return x + 1` form).
   - The source-type rule and its demotion are gone, and the new path adds no demotion.
   - Both programs and an `any`/`unknown` `.ts` twin compile and answer like node on both targets. They are in the
     test file.
2. **`typeof ((1 as any) as undefined)` answered "undefined".** No TypeScript type is read now. It answers "number"
   from the IR type, as on main (tested).
3. **Lying casts went to legacy** (`1 as unknown as string`, `"a" as any as boolean`, `true as any as number`).
   - They stay on the IR path with main's answer (tested, including an IR-path assertion).
   - Assertions are transparent to typeof's own `void` question, so `void 0 as any as number` answers "undefined".
     It was wrong on main.
4. **Mutation survivors.** See Result.

### Review round 2

1. **Must-fix: `isValueVoid` peeled assertions outside `typeof`.** It moved three `.ts` functions from IR to legacy
   via `irOperandFamily`.
   - `isValueVoid` is back to main's reach (parens and the comma's right side), moved unchanged.
   - Assertions are peeled only in typeof's own leaf question.
   - The three programs are byte-identical to main again. A test pins them on the IR path, which kills the
     assertion-peeling mutation (6 failures).
   - Their wrong answers on main are listed under Known.
2. **`hasValueVoidLeaf` duplicated `everyYieldedValue`.** It is gone. The leaf question is a "some" over
   `everyYieldedValue`. Why `conditionalJoinArmFamily` stays separate is under Implementation Plan.
3. **The `typeof <ambient>` fold was copied.** It is now one helper, `foldedAmbientConditionArm`, used by
   `lowerConditional` and by the split.
4. **Test gaps.**
   - **Nested `?:`.** `typeof (c ? (d ? void 0 : 1) : 2)` is now tested on Prepared for both inner arms. The
     "recurse through `isValueVoid`" mutation fails.
   - **Arm scope copy (rebutted, not simplified).** The split passes `lowerTypeOfVoidLeaves` itself as
     `lowerConditionalBranches`' arm callback, so each arm gets the helper's scope copy by construction. The
     outer-`cx` variant is a wrapper lambda written on purpose, not a simplification. It would also be unsound: a
     `void (s = "é")` arm records a string-encoding fact for `s`, and with the outer `cx` that fact would leak into
     the other arm's lowering.
   - No program could distinguish the two today. Three candidates, each run × {default, standalone} ×
     {`utf8Storage` off, on}, all compile through legacy: a string assignment in one arm and a `charCodeAt` read in
     the other. The Prepared path has no string locals. The mutation therefore survives.

### Known, not this change

These are wrong on main and on this branch:

- answered from the cast or declared type in legacy:
  - `typeof x!` where `x?: number` is undefined;
  - `typeof (null as unknown as undefined)`;
  - `typeof v()` where `v(): void` returns `1 as any`;
- on the IR path, where `void` under an assertion reads as a number in a comparison or a typed store (`.ts`, default
  and standalone):
  - `return (void 0)! === undefined ? 1 : 2;` gives 2 (node: 1);
  - `return (void 0 as any) == null ? 1 : 2;` gives 2 (node: 1);
  - `var x: number = 1; x = (void 0 as any); return x !== x ? 1 : x === undefined ? 3 : 2;` gives 1 (node: 3).

  The fix for these belongs to `irOperandFamily` and the selector's operand families together; peeling assertions in
  one of them alone moves the functions to legacy.
- the legacy generator answers 0 for
  `function g(c: number) { var s = "é一"; var r = 0; var t = typeof (c ? (s = "ab", void 0) : (r = s.charCodeAt(1), void 0)); return r; }`
  with `g(0)` (node: 19968). This was found while probing item 4 and is not related to `typeof` lowering in the IR.

On the Prepared path, `typeof` of a dynamic value is still refused by name (`dyn.typeof has no Prepared intrinsic`).
