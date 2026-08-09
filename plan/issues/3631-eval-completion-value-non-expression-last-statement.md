---
id: 3631
title: "eval returns `undefined` when the last statement is not an ExpressionStatement — completion value not implemented"
status: ready
sprint: current
goal: es5
priority: high
horizon: m
feasibility: medium
---

# eval completion value: non-ExpressionStatement last statement returns `undefined`

## Problem

`tryStaticEvalInline` (`src/codegen/expressions/eval-inline.ts`) computes the
eval result from the **last statement only**, and only when that statement is an
`ExpressionStatement`. Every other last-statement kind falls into this arm:

```ts
// Non-expression last statement (throw, var, if, etc.) — compile it and
// push `undefined` as the eval result.
compileStatement(ctx, fctx, last);
emitUndefined(ctx, fctx);
return { kind: "externref" };
```

Per §19.2.1.1 / the Script evaluation semantics, `eval` returns the **completion
value** of the Script, which propagates out of `if`, `while`, `do-while`, `for`,
`try`, `switch` and plain blocks. It is not `undefined` merely because the
outermost node is a statement rather than an expression.

## Probe (current HEAD, host mode, `tests/probe-eval-mvp.test.ts` — gitignored)

| probe                                            | got         | spec | verdict  |
| ------------------------------------------------ | ----------- | ---- | -------- |
| `eval("if (true) { 41 + 1 }")`                   | `undefined` | `42` | **FAIL** |
| `eval("var i=0; do { i=i+1; 7 } while (i < 1)")` | `undefined` | `7`  | **FAIL** |

Both were re-run against unmodified `origin/main` (`3a262054c6`).

## Measured denominator — honest, and small

Baseline: `loopdive/js2wasm-baselines` `test262-current.jsonl`, fetched
2026-07-25 18:21. Population = ES5-classified (post-#3626 classifier),
`eval`-dependent, host lane: **775 tests, 484 not passing**.

Inside that population, the failures whose reported signature is a
completion-value mismatch are the `do-while` / `while` families:

| test                                         | reported failure                       |
| -------------------------------------------- | -------------------------------------- |
| `language/statements/do-while/S12.6.1_A3.js` | `__evaluated === 1. Actual: undefined` |
| `language/statements/do-while/S12.6.1_A5.js` | `__evaluated === 1. Actual: undefined` |
| `language/statements/do-while/S12.6.1_A7.js` | `do-while returns (normal, V, empty)`  |
| `language/statements/do-while/S12.6.1_A8.js` | `__evaluated === 4. Actual: undefined` |
| `language/statements/while/S12.6.2_A5.js`    | `__evaluated === 1. Actual: undefined` |
| `language/statements/while/S12.6.2_A7.js`    | `while returns (normal, V, empty)`     |
| `language/statements/while/S12.6.2_A8.js`    | `__evaluated === 4. Actual: undefined` |

**7 ES5 tests measured.** Corpus-wide (all editions) was **not** measured — do
not quote a larger number without measuring it. All 7 are in the _folded_ path,
so the fix is host-free and applies to **both** the host and standalone lanes;
the standalone lane is where a folded-path fix has no host fallback masking it.

## Why this is not a 5-line change

Correct completion-value semantics need a **completion-value slot** that
statement codegen writes to (the last _value-producing_ statement wins, and
`if`/loops/`try`/`switch`/blocks propagate their inner value), not a special case
on the outermost node. That is why this is filed rather than patched inline: the
change touches `compileStatement`'s contract for eval bodies. A narrower first
slice — propagate the completion value out of `Block`, `IfStatement`,
`WhileStatement`, `DoStatement` and `ForStatement` only — covers all 7 measured
tests.

## Acceptance criteria

- `eval("if (true) { 41 + 1 }")` returns `42`; `eval("var i=0; do { i=i+1; 7 } while (i<1)")` returns `7`.
- The 7 tests listed above pass in the host lane.
- No regression in `tests/issue-2923-eval-const-broaden.test.ts` (the folded-path
  standalone contract: no `__extern_eval` import leak).

## Not covered here

Direct eval with a runtime string (#3630), eval in standalone mode (#1066),
AnnexB B.3.3 function-in-block hoisting (#2200 / #2552).
