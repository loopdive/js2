---
id: 6410
title: "A block-bodied IIFE inside an awaited expression makes the driven async frame's resume function invalid (`not enough arguments on the stack for local.set`) — the whole module fails to validate"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
language_feature: async, closures
related: [5372, 5367, 4302, 2906]
---

## Problem

When a host-driven async function (JS-host GC lane, `asyncFnNeedsHostDrive`)
awaits an expression that contains an **immediately-invoked function
expression / arrow with a block body**, the emitted resume function fails
WebAssembly validation and takes the whole module with it:

```
CompileError: Compiling function "__async_resume_ff" failed:
  not enough arguments on the stack for local.set (need 1, got 0)
```

Measured on upstream/main `225f400089` (typed `.ts` two-file project,
`compileProject`, `target: "gc"`, `platform: "web"`, `experimentalIR`;
`compile.success === true`, `WebAssembly.validate === false`), identical on
the linear path and on the pre-existing CFG (`if`-arm, multi-declarator
conditional) path, so it predates #5372's hoisting:

```ts
// lib.ts
export function later<T>(v: T): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), 1));
}
export function run<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
```

```ts
// entry.ts
import { later, run } from "./lib.js";

// c8 — linear: INVALID
export async function c8(): Promise<boolean> {
  const v = await (async () => { return true; })();
  return !v;
}
// c9 — if-arm CFG: INVALID
export async function c9(cond: boolean): Promise<boolean> {
  let v = false;
  if (cond) v = await (async () => { return true; })();
  return !v;
}
// c16 — a SYNC block-bodied IIFE inside the awaited call's arguments: INVALID
export async function c16(cond: boolean): Promise<boolean> {
  const v = cond ? await later((() => { return true; })()) : false;
  return !v;
}
// c18 — `async function` expression IIFE: INVALID
export async function c18(cond: boolean): Promise<boolean> {
  const v = cond ? await (async function () { return true; })() : false;
  return !v;
}
```

The same module validates when the IIFE is concise-bodied (`await (async ()
=> true)()`), when the block IIFE has no `return` (`await (async () => { n =
1; })()`), when a block-bodied async arrow is merely passed as an argument
(`await run(async () => { return 1; })`), and when the arrow is bound first
(`const g = async () => true; await g()`). Untyped `.js` reproduces it too
(`const v = await (async () => { return "I"; })();`).

## Reduction table (all measured on upstream/main `225f400089`, JS-host lane)

| awaited expression | module |
| --- | --- |
| `await (async () => { return true; })()` (linear) | **invalid** |
| same, inside an `if` arm (`if (cond) v = await …`) | **invalid** |
| same, as the pre-#5372 multi-declarator conditional arm | **invalid** |
| `await later((() => { return true; })())` (sync block IIFE in an argument) | **invalid** |
| `await (async function () { return true; })()` | **invalid** |
| `await (async () => true)()` (concise body) | valid |
| `await (async () => await later(1))()` (concise, awaits inside) | valid |
| `await (async () => { n = 1; })()` (block body, no `return`) | valid |
| `await run(async () => { return 1; })` (block arrow as an argument) | valid |
| `const g = async () => true; await g()` | valid |

## Impact

hono `src/utils/color.ts` `getColorEnabledAsync` is exactly this shape
(`const isNoColor = cond ? await (async () => { try { return … } catch { return
false } })() : !getColorEnabled()`); it is imported by `src/helper/dev`, so
once #5372's hoisting started driving that function the whole
`src/helper/dev/index.test.ts` module stopped validating (1/8 → 0/8). #5372
therefore keeps any statement whose awaited operand contains a block-bodied
IIFE off its hoisting lane (`awaitedExprHasBlockIife` in
`src/codegen/async-await-hoist.ts`) so such functions keep their pre-hoisting
behaviour; that gate is a workaround for THIS hole and should go once the
resume emitter handles the shape.

## Where to look

- `src/codegen/async-frame.ts`, `ensureAsyncResumeFunction` /
  `buildStateBody`: a segment's `awaitedExpr` is re-compiled inside the resume
  function. The block-bodied IIFE is most likely inlined there (a `return`
  inside the inlined block has to become the block's result value), and in
  the resume `FunctionContext` the value never reaches the `local.set` that
  delivers it. Compare the WAT of `c8` against the concise `await (async () =>
  true)()`, which validates.
- The gate to remove afterwards: `awaitedExprHasBlockIife` in
  `src/codegen/async-await-hoist.ts` (#5372) — with the emitter fixed, its
  `r13` regression row in `tests/issue-5372-await-in-conditional-operand.test.ts`
  should then read the awaited value on the true arm as well.

## Acceptance criteria

1. Every "invalid" row of the table validates and returns the native value.
2. Regression test under `tests/` with the table as a two-file fixture
   (`WebAssembly.validate` asserted, then the values), failing on the parent
   for the invalid rows.
3. hono `src/helper/dev/index.test.ts` stays ≥ 1/8 through
   `tests/dogfood/hono-upstream-suite.mjs` with the #5372 gate removed.
4. A/B at one HEAD over the 17 dogfood suites, per test file.
