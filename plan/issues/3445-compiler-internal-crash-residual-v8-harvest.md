---
id: 3445
title: "compiler internal-error / stack-overflow crash residual (v8 harvest): 'Cannot read properties of undefined' + 'Maximum call stack' — ~28 both lanes"
status: ready
created: 2026-07-19
priority: low
task_type: bug
area: compiler-correctness
goal: test262-conformance
model: fable
sprint: current
related: [3417, 438, 523, 1606, 2587, 1607]
---

# #3445 — compiler internal-crash residual (v8 harvest, 2026-07-19)

## Summary

Low-count but **genuine compiler crashes** (the compiler throws a JS
`TypeError`/`RangeError` while compiling, rather than emitting a diagnostic).
The prior internal-error trackers (#438, #523, #1606, #2587, #1607) are all
`status: done`; no open tracker covers the current residual. Crashes warrant a
tracker even at low count.

## Sub-buckets (both lanes, official)

| signature | default | standalone |
| --- | ---: | ---: |
| `Internal error compiling expression: Cannot read properties of undefined (reading '…')` | ~5 | ~7 |
| `Internal error compiling statement: Cannot read properties of undefined (reading '…')` | ~4 | ~4 |
| `Cannot read properties of undefined (reading a class field)` | ~5 | — |
| `Internal error compiling expression: Maximum call stack size exceeded` | ~1 | ~2 |
| **total** | **~15** | **~13** |

## Sample paths

- `test/language/expressions/object/11.1.5-0-1.js` (object-literal — undefined `declarations`, cf. done #1606, re-exposed)
- `test/language/statements/for-in/cptn-expr-abrupt-empty.js` (statement compile — undefined property)
- `test/language/expressions/optional-chaining/optional-call-preserves-this.js` (Maximum call stack — recursive walker on optional-call TCO)

## Root cause (hypothesis)

An AST node reaches a codegen path expecting a resolved symbol/type that is
`undefined` (object-literal `declarations`, class-field metadata), and a deep /
mutually-recursive expression walker (optional-chaining call, tagged-template
TCO) overflows the JS stack — the same families as the done #1606 (object-literal
undefined declarations) and #2587/#1607 (recursive-walker stack overflow),
re-surfaced under the v8 workload. Likely an incremental guard / iterative-walker
extension of those fixes.

## Suggested fix

1. Reproduce `object/11.1.5-0-1.js` and add the missing null guard where
   `declarations` is read (extend #1606's fix to this node position).
2. Convert the optional-call / tagged-template recursive walker to the iterative
   form used by #1087 for the max-call-stack cases.

## Regression note

Prior internal-crash trackers closed at earlier baselines; this residual is the
current v8-baseline standing surface with no open owner.

## Implementation Plan (architect, 2026-07-19 — both dominant crashes reproduced with captured stacks)

### Crash A — "Cannot read properties of undefined (reading 'flags')" (statement bucket)

Reproduced with `language/statements/for-in/cptn-expr-abrupt-empty.js` (body
alone, host lane). Captured raw stack (instrumented the catch at
`src/codegen/statements.ts:95-101`):

```
TypeError: Cannot read properties of undefined (reading 'flags')
    at checkObjectLiteral (typescript.js:78659)
    at checkExpressionWorker → checkExpression → getTypeOfExpression
    at getRegularTypeOfExpression → checkObjectLiteral   (recursing)
```

The crash is **inside the TypeScript checker**, not our code. Trigger: the test
body is `eval('… for (a in { x: 0 }) …')` — the **eval-inline path**
(`src/codegen/expressions/eval-inline.ts`) parses the eval string into a
DETACHED synthetic AST and compiles it; some codegen path then calls a
`ctx.checker` query (`getTypeAtLocation`-family) on a synthetic node that was
never bound by the program's binder → TS's `checkObjectLiteral` reads
`links/symbol.flags` of undefined and throws. The `Internal error compiling
statement` wrapper (`statements.ts:100`) then converts it to a compile error.

**Fix**: the eval-inline compilation context must never route synthetic nodes
into the raw checker. Options, in order of preference:
1. In the oracle (`src/checker/oracle.ts`), guard every checker query with a
   synthetic-node check (`node.pos < 0 || !node.getSourceFile?.()` or a
   dedicated `ctx.inSyntheticEval` flag set by eval-inline) → return the
   `any`-equivalent answer instead of querying. This fixes the whole class,
   not one node kind. (Per CLAUDE.md, new type queries go through `ctx.oracle`
   — this makes the oracle the enforcement point.)
2. Narrow: eval-inline sets a ctx flag; the object-literal compile path checks
   it before its `getTypeAtLocation` call. Only if (1) turns out too invasive.

Note the `declarations`-reading crash on `object/11.1.5-0-1.js` did NOT repro
body-alone — it needs the full harness assembly; re-derive its stack with the
same instrumentation trick (2-line temporary `console.error(e.stack)` in the
`statements.ts:100` / `expressions.ts:852` catches) before fixing.

### Crash B — "Maximum call stack size exceeded" (expression bucket)

Reproduced with
`language/expressions/optional-chaining/optional-call-preserves-this.js`.
Captured stack: `compileCallExpression` recursing through
`src/codegen/expressions/calls.ts:5760` (with periodic re-entry at
`calls.ts:5408`) — the callee-unwrap arm that builds a
`ts.factory.createCallExpression(unwrapped, …)` **synthetic call** and recurses
(`calls.ts:5753-5760`). When the unwrap makes no progress (the rebuilt call's
callee re-enters the same arm — the optional-chain `(a?.b)()` shape), it
recurses until the JS stack dies.

**Fix**: make the unwrap provably monotonic —
- before recursing, check `unwrapped !== expr.expression` AND that `unwrapped`'s
  kind is not one that re-dispatches into the same synthetic-rebuild arm; if no
  progress, fall through to the generic callee compile (or report a targeted
  diagnostic) instead of recursing;
- belt-and-braces: add a `syntheticCallDepth` counter on ctx (cap ~64) that
  converts runaway recursion into a clean "unsupported callee shape" error.
  This mirrors the #1607/#2587 recursion-guard family cited above.

### Edge cases
- Crash-A guard must not change behavior for REAL (bound) nodes — oracle
  answers stay identical when a source file with a binder is present.
- Crash-B: legitimate nested unwraps (parenthesized, non-null-assert chains)
  must still resolve — only the no-progress case may bail.

### How to test
- `tests/issue-3445.test.ts` with the two repro files via `compile()` — assert
  `success === true` OR a real diagnostic (never an `Internal error compiling`
  message and never a process-level throw).
- Scoped run of `language/expressions/optional-chaining/**` and the for-in
  cptn-* cluster on both lanes.
- Grep the CI shard report for `Internal error compiling` — target ~0 for
  these two signatures (~20 of the ~28).
