---
id: 6860
title: "hono `concurrent.test.ts` 0/6: an INLINE async arrow with a destructured parameter, passed to `test.each`, runs on the synchronous pass-through — `await Promise.all(…)` answers immediately"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-09
completed: 2026-10-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
loc-budget-allow:
  # 2026-10-09 (#6860): resume prologue re-maps param aliases (`const run = async ...` -> `__self`); +24 LOC, +4 in the resume builder
  - src/codegen/async-frame.ts
func-budget-allow:
  # 2026-10-09 (#6860): resume prologue re-maps param aliases (`const run = async ...` -> `__self`); +24 LOC, +4 in the resume builder
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
---

## Problem

hono `src/utils/concurrent.test.ts` is 0/6 (rows 1–4: `running.size` is
`count` after `await Promise.all(resultPromises)`, expected `0`; rows 5–6
`toEqual` mismatch). Measured with the
[#6846](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6846-async-nested-leading-await-replay)/[#6847](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6847-async-for-of-continue-guard-and-destructured-binding)/[#6859](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6859-async-assigned-param-lost-across-await)
fixes applied (branch `wave10-hono`), instrumenting a copy of the generated
test: inside the test body `await Promise.all([1, 2])` yields a value whose
`.length` is `NaN` and the final `Promise.all` "resolves" with `[]` BEFORE any
job continues past its own `await` — the body is on the synchronous
pass-through, where `await` is an identity.

Bisect (all files use the real upstream shim; `IR=1`/`IR=0` both fail):

| registration of the SAME body | result |
| --- | --- |
| `test.each\`…\`('n', async ({ concurrency, count }) => { … })` (inline) | fails |
| `describe('x', () => { test.each\`…\`(…inline…) })` (as upstream) | fails |
| `const body = async ({ concurrency, count }) => { … }; test.each\`…\`('n', body)` | passes |
| `test('n', async () => { const concurrency = 10; const count = 10; … })` | passes |
| small JS `run(async ({ a }) => { await Promise.all([a, 2]) … })` | passes |

So it is the inline async arrow WITH a destructured parameter, with this body
(closures that capture `let resolve` written by a `new Promise` executor, a
`Set`, `createPool`), that the async planner declines. Which gate declines it
is not yet identified.

## Implementation Plan

1. Reproduce with `.tmp`-style probe: copy the generated
   `concurrent.test.ts`, keep the shim, swap the registration per the table.
2. Instrument the activation decision (`asyncFnNeedsHostDrive` and the
   planners it consults: `planLinearAwaits`, `planTryCatchCfg`,
   `computeAsyncSpills`, the spill type gate `isSpillSafeType`) for the inline
   arrow vs the `const`-bound one; the difference between the two is the
   activation context (closure lifted from a call argument vs a module-level
   binding) and the derived-parameter capture (`collectDerivedPatternParams`).
3. Fix the decline at its gate; add a regression test with the inline and the
   `const`-bound registration (anti-vacuity: the latter must keep passing).

Expected: hono `concurrent.test.ts` 0/6 → 6/6.

## Resolution

Two defects, neither in the async planner (the planner accepted the body —
`asyncFnNeedsHostDrive` answered `true` for the inline arrow too):

1. **The inline arrow never reached the async engine.** `test.each\`…\`(name, body)`
   is a call whose callee is a TAGGED TEMPLATE. `isHostCallbackArgument`'s #4616
   call-of-call carve-out (`factory(cases)(name, body)` → closure path) tested
   `ts.isCallExpression(callee)` only, so the arrow was classified as a HOST
   callback and compiled through `compileArrowAsCallback`, which has no async
   activation — every `await` became an identity (`each:NaN`). A const-bound
   body is an identifier argument and took the closure path, which is why the
   bisect table split on inline vs bound, not on the destructured parameter.
   Fix: the carve-out also accepts `ts.isTaggedTemplateExpression(callee)`
   (`closures/callback-classification.ts`).
2. **Once driven, hono's `createPool` hung at concurrency 1.** Its
   `const run = async (fn, promise, resolve) => { … setTimeout(() => run(…)) … }`
   is self-recursive; closures.ts binds the self name to `__self` (local 0). The
   async resume function rebuilds params under their OWN names only, so `run`
   lost the alias and the recursive call ran on the wrong closure (captures
   reset, arguments dropped) — the retry loop never drained. Fix:
   `buildAsyncFrameInfo` records every alternate name of a param slot
   (`paramAliases`) and the resume prologue re-maps them (`async-frame.ts`).

hono `concurrent.test.ts` 0/6 → 6/6. Regression:
`tests/issue-6900-hono-accepts-concurrent-client.test.ts` (inline tagged body,
const-bound control, concurrency-1 pool).

