---
id: 6846
title: "async: a nested `await` that is its statement's first observable step falls to the synchronous pass-through — `f(await p)`, `const [a, b] = await p`, `{ body: await p }` see the Promise"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
# (#6846/#6847, 2026-10-05) The replay arm must sit at the three points inside
# `lowerLinearStatements` that decline a non-canonical await (its segment
# shape is the file-private `LowerState`); the #6847 for-of changes extend
# `lowerRegionBody` / `analyzeTryCatchAsync` in place. The decision logic
# itself lives in the new `analysis/async-leading-await-replay.ts` and
# `analysis/async-for-of-region.ts`.
loc-budget-allow:
  - src/codegen/async-cps.ts
---

## Problem

`lowerLinearStatements` (`src/codegen/async-cps.ts`) accepts an `await` only
DIRECTLY as a statement's return operand / identifier initializer / expression
statement / identifier-assignment RHS, plus three bounded nested shapes
(`returnedConstructorAwait`, `replaySafeNestedCallAwait`, the #6504 spilled
call — the last two expression-statement only). Any other nested await makes
the whole function decline to the legacy synchronous pass-through, where
`await` is an identity and the Promise OBJECT flows on as the value.

Measured on upstream/main `c3e3fab33d` (untyped `.js`, `compileProject`, host
lane), each callee genuinely suspending (`await null` / a host promise):

| shape | Wasm | node |
| --- | --- | --- |
| `return show(await sus())` | `object:[object Promise]` | `string:v` |
| `return "x" + (await sus())` | `x[object Promise]` | `xv` |
| `const [a, b] = await declHost()` | `TypeError: value is not iterable` | `7` |
| `return String(await arrowStr("ok"))` | `[object Promise]` | `ok` |
| `return show(await Promise.resolve("p"))` | compile error "async shape not supported" | `string:p` |

hono: `cloneRawRequest` builds `{ body: await req[cacheKey](), … }` —
`src/request.test.ts` "clones consumed request object" reads
`"[object Promise]" is not valid JSON`; the `getCryptoKey`-style
`show(await getKey())` shape is the same defect.

## Implementation Plan

The resume machine already has the substitution needed: a resume binding that
carries `awaitTarget` (`nestedAwaitBinding`) makes `compileExpression` read THAT
AwaitExpression from the delivered local (`fctx.asyncAwaitValueLocals`) when the
containing statement is recompiled in the resume state. Re-compiling the
statement after the resumption is sound exactly when everything evaluated
before the await is free of observable effects and reads only values the
suspension cannot change.

1. New module `src/codegen/analysis/async-leading-await-replay.ts`:
   `isLeadingReplaySafeAwait(stmt, awaitNode, checker)`. Walk from the await to
   the statement root (return operand / expression / the single declarator's
   initializer — any binding pattern); at each ancestor collect the operands
   evaluated BEFORE the await's branch (§13 evaluation order: call callee then
   earlier args, binary left, element-access object, earlier array elements /
   object properties / template spans, computed property names) and require
   each to be replay-safe: literals, identifiers bound to `const` / function /
   class / import, a fixed set of stable ambients (`String`, `JSON`, …) and
   plain property reads off them. Decline when the await may not be evaluated
   (conditional / `&&` `||` `??` arm, optional chain, compound assignment,
   spread before it).
2. `async-cps.ts`: `replayLeadingAwait(st, …)` pushes the segment with
   `nestedAwaitBinding(awaitNode)` and makes the statement the next lead
   (`return` sets `sawReturnAwait`, and is declined in a try/finally region
   unless `allowReturnInTry`). Called at the three points that currently
   `return false` for a non-canonical await: the variable-statement arm, the
   return arm, and the final fall-through — AFTER the existing arms, so every
   shape they already own keeps its bytes.
3. Out of scope: two awaits in one statement (`expect(await a).not.toEqual(await b)`
   — the second await follows observable work, the `expect(…)` call).

Acceptance: the table above matches node; regression test with a base-failing
row per shape plus a decline control (`let` operand before the await keeps the
pre-change behaviour); hono `request.test.ts` "clones consumed request object"
passes; standalone test262 async scope flat.

## Resolution

Implemented as planned (`src/codegen/analysis/async-leading-await-replay.ts`,
`replayLeadingAwait` in `async-cps.ts`). Every row of the table above now
matches node, including the settled-operand row that used to be a hard
compile error. The `f(count(), await p)` control still declines (count runs
once). Regression test `tests/issue-6846-nested-leading-await-replay.test.ts`.

Measured with the sibling fixes of this PR at one HEAD (base sources from
`c3e3fab33d` vs the branch's sources), all suites sequential:

| suite | base | fix |
| --- | --- | --- |
| hono | 271/324 | **292/324** (293 with the final #6450 async-wrap line; node-lane suites hono/axios/jest/lodash/uuid re-run on it: 293 / 210 / 336 / 59 / 75) |
| axios | 208/231 | **210/231** |
| marked | 16/30 | **18/30** |
| prettier | 75/151 | 75/151 |
| redux | 67/82 | 67/82 |
| lodash | 59/62 | 59/62 |
| jest | 336/356 | 336/356 |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| moment | 10/10 | 10/10 |
| test262 standalone, 429 async rows (`language/{expressions,statements}/async-*`, `await`, async methods, async for-of) | 360 pass / 50 fail / 19 CE | identical non-pass set |

hono "clones consumed request object" is this issue's `{ body: await … }`
shape. The other movers outside cookie/body — hono `request.test.ts` +1,
`buffer.test.ts` +1, axios `canceledError` / `AxiosError` +2, marked `Hooks`
+2 — moved with the PR as a whole; which fix moved each was not isolated. Out
of scope and filed:
[#6863](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6863-async-two-awaits-in-one-statement)
(two awaits in one statement).
