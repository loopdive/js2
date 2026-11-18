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

- **Module.** The answer moves to `src/ir/typeof-static-answer.ts` as `staticTypeofOf(irType, operand, types)`.
  `staticTypeOfFor` moves there unchanged as `irTypeofTag`, so `from-ast.ts` shrinks.
- **Rule.** The IR type's tag is the answer only when the operand's SOURCE type agrees. The source type comes from
  `TypeOracle.staticJsTypeOf`, the existing oracle query that the IR's other `typeof` users rely on. A source type of
  `undefined` or `void` is answered "undefined", because every value of that type is undefined; the operand is
  still lowered first, so its effects happen exactly once. A disagreement is `unproven`, and from-ast demotes it
  by name: on the ordinary pipeline the function falls back to the legacy generator, and on the Prepared path it is
  refused. A tag that varies at runtime keeps the existing dynamic dispatch (`exactDynamicPrimitiveTypeofFamilies`,
  then `dyn.typeof`).
- **Oracle.** The lane's oracle is used, or a `TsCheckerOracle` over the lane's checker. The Prepared producer passes
  a checker without an oracle; this is the same fallback that `lowerFunctionAstToIr` uses for its i32 array planning.
- **Quality criterion.** There is one recogniser, the oracle query; there is no second walk over the AST. No raw
  checker calls are added. `from-ast.ts` does not grow.

## Result

Filled in by the implementation commit.
