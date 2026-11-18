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
produced (`staticTypeOfFor`): an f64 reads as "number". `void 0`, and anything else the hint coerces, lowers to an f64,
so the answer described the coercion, not the value.

## Implementation Plan

- **Module.** The comparison moves to `src/ir/typeof-static-answer.ts` as `staticTypeofOf(irType, sourceTag)`.
  `staticTypeOfFor` moves there unchanged as `irTypeofTag`, so `from-ast.ts` shrinks by 10 lines. The module imports
  only types.
- **Source tag.** `uniformJsTagOfFact(fact)` sits in `src/checker/oracle.ts`, beside `jsTagOfFact`, which it reuses.
  A union counts as one tag only if every member has that tag and it holds neither `null` nor `undefined`: `1 | 2`
  is "number", and the answers of `typeof` are "string". Without the union rule, `c ? 1 : 2` and `typeof typeof x`
  would leave the IR path. Without the null/undefined rule, `c ? void 0 : 1` (number parts plus `undefinable`)
  would answer "number" on the Prepared path. from-ast already imports the oracle module, so no `ir -> checker`
  import edge is added.
- **Rule.** The IR type's tag is the answer only when the source tag agrees. A source type of `undefined` or `void`
  is answered "undefined", because every value of that type is undefined. The operand is still lowered first, so
  its effects happen exactly once. A disagreement is `unproven`, and from-ast demotes it by name ("typeof operand
  lowered as number has source type mixed"):
  - on the ordinary pipeline, the function falls back to the legacy code generator, which answers correctly;
  - on the Prepared path, the program is refused.

  A tag that varies at runtime keeps the existing dynamic dispatch: `exactDynamicPrimitiveTypeofFamilies`, then
  `dyn.typeof`.
- **Oracle.** The lane's oracle is used, or a `TsCheckerOracle` over the lane's checker. The Prepared producer passes
  a checker without an oracle; this is the same fallback that `lowerFunctionAstToIr` uses for its i32 array planning.
  `strictNullChecks` is pinned on for every lane (`src/checker/index.ts`), so a non-union "number" fact excludes
  `undefined`.
- **Quality criterion.** There is one recogniser, the oracle's fact. There is no second walk over the AST, no raw
  checker call, and `from-ast.ts` does not grow.

## Result

- **Correctness.** The table in Problem now gives node's answer on the ordinary pipeline, for both the JS
  environment and `--target standalone`.
  - A 47-program sweep (`void` of literals, calls and commas, `?:` mixes, `undefined`, `null`, typed locals, i32
    `|` and `>>>`, comparisons, `!`/`-`/`+` of `void 0`, `typeof typeof`, a switch on `typeof`, effects counted)
    has 0 wrong answers. Against `origin/main`, 12 programs go from wrong to right; no other result changes.
  - Every program that was on the IR path stays there.
  - On the Prepared path, `typeof void 0` and the switch on it answer like node. `c ? void 0 : 1` refuses by name;
    it was a wrong answer on the #7354 T/X branch.
- **Tests.** `tests/issue-7361-typeof-static.test.ts` has 59 tests:
  - 26 programs × {gc, standalone} compared with node;
  - two same-tag unions that must stay on the IR path;
  - Prepared acceptance (right answer returns, wrong answer throws) and the Prepared refusal.

  Five mutations each fail it:
  - restore the IR-type answer: 25 failures;
  - drop the `undefined` answer: 10;
  - drop the null/undefined guard: 1;
  - drop the union rule: 4;
  - drop the `unproven` demotion: 1.
- **Bytes.** Ordinary output was compared on 200 test262 files × {default, standalone} against `origin/main`: all
  16 `expressions/typeof` files, all 9 `expressions/void` files, files using `typeof` in Number, Boolean, the
  conditional operator, switch, comma and `!`, 100 ES5-sample files, and 48 rows of the 411-row list.
  - 199 files are byte-identical; 1 is a compile error on both sides.
  - The one changed file is `language/expressions/typeof/undefined.js` (`typeof void 0 === "undefined"`). It fails
    on main and passes with the fix, on both targets.
- **Gates.** These pass: typecheck; loc and func, also with `LOC_GATE_BASE=origin/main` after merging main;
  coercion-sites; oracle-ratchet; dead-exports; import-cycles; the compiler-boundaries inventory (CI mode,
  `--base origin/main`; the new module is classified); and `changed-root-tests.sh` with the interpreter engine.
- **Pre-existing failure, not caused by this change.** `tests/issue-7104-dynamic-undefined-return.test.ts` fails:
  `empty` and `bareReturn` are rejected by IR selection (`call-graph-closure`). Every IR outcome of its program is
  identical on `origin/main` and this branch.
