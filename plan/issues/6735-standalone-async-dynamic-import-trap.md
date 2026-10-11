---
id: 6735
title: "standalone: `import()` inside an async function body is a hard compile error — jest-util/jest-config, eslint, stylelint, jsdom stop at it; lower it as a rejection"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [3494, 3509, 6725, 6747, 6761]
files:
  - src/codegen/async-scheduler.ts
  - src/codegen/async-value-sink-unwrap.ts
  - src/codegen/expressions.ts
  - src/codegen/expressions/standalone-dynamic-import.ts
  - src/ir/backend/lower-contracts.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - tests/issue-6735-standalone-async-dynamic-import.test.ts
# 2026-09-29 — the IR `await` arm must stay in lockstep with the codegen
# unwrap (#1373b C-1): one optional resolver hook + its call, +5 / +2 LOC.
# The shared builder (~30 LOC) lives in async-scheduler.ts so the IR reaches it
# through its existing edge — a new ir -> codegen import fails #3113.
loc-budget-allow:
  - src/codegen/async-scheduler.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
func-budget-allow:
  - src/ir/integration.ts::makeResolver
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
---

# #6735 — async-body `import()` blocks whole standalone graphs

## Problem

`detectStandaloneDynamicImports` (`src/compiler.ts`, #3494/#3509) reports

    Standalone dynamic import is unsupported until compileMulti provides internal module records and namespace objects

for every `import()` that is not inside a plain (non-async, non-generator)
function body. #3509 made the plain-function case a run-time TypeError trap;
async bodies stayed fatal because "a direct synchronous throw would not
preserve their rejection semantics".

That keeps whole package graphs from compiling even though the `import()` only
runs on a path the program may never take. After #6725 linked jest's lazy
`require` edges, jest's standalone-dynamic lane stops here:

- `jest-util/build/index.js:1045` — `async function importModule(...) { … await import(moduleUrl.href) … }` (inside `try`)
- `jest-config/build/index.js:2426`, `2437` — `registerTsLoader`: `await import('ts-node')` / `await import('esbuild-register/dist/node')`

eslint, stylelint and jsdom report the same diagnostic.

## Root dependency

Measured 2026-09-28 (standalone, `compileMulti`, allowJs):

```js
async function f(x) { const m = await g(x); return m; }
function g(x) { throw new TypeError("sync"); }
export function run() { const p = f(1); /* … */ return 1; }
```

`run()` throws `TypeError: sync` synchronously; per spec `f(1)` returns a
rejected promise. So a standalone async function does not convert a throw in
its body into a rejection, and the #3509 trap cannot simply be extended.

## Acceptance criteria

- A throw inside a standalone async function body (before or after its first
  `await`) rejects the returned promise instead of escaping the call.
- `import(x)` inside an async function (declaration, expression, arrow, method)
  compiles under `--target standalone` and rejects with a TypeError naming the
  missing module loader (#3494) when reached.
- jest's standalone-dynamic lane moves past this diagnostic (next blocker
  recorded here); eslint/stylelint/jsdom re-measured.

## Implementation Plan

Re-measured 2026-09-29 on main `c8b4f0ef36` before planning: #3494 (PR #6279)
already removed the `detectStandaloneDynamicImports` refusal, so no `import()`
is a compile error any more and jest's standalone-dynamic lane is past it. What
remained was run-time behaviour inside async bodies:

- An async **declaration** is claimed by the frame engine: `await import(x)`
  rejects / reaches `catch` correctly.
- An async **arrow, function expression or method** is not claimed on the
  standalone lane (`planAsyncClosureActivation` parks drive-lane closures) and
  runs the synchronous pass-through. Its `await` (`emitStandaloneAwaitUnwrap`)
  read `$Promise.value` whatever the state, so `await import("ts-node")`
  continued with `undefined`: the function FULFILLED and a surrounding `catch`
  never ran. Same for any already-rejected promise
  (`await Promise.reject(e)`).
- A non-literal specifier never had ToString applied, so a throwing
  `toString` rejected with the generic TypeError instead of its own reason.

Steps (executed):

1. `async-value-sink-unwrap.ts`: `emitStandaloneAwaitUnwrap(…, rejectedThrows)`
   — the `await` consumer (`expressions.ts`) passes `true`: a `$Promise` in
   state REJECTED is marked handled (#2958, wasi tracker) and its reason is
   thrown with the JS exception tag. The throw reaches the body's own `try`, or
   the existing async call-site repair that turns it into the returned
   promise's rejection. The #6428 value sink keeps the plain read.
2. IR lockstep: the `await` arm of `lower-generic.ts` calls a new optional
   resolver hook `rejectedAwaitThrow` that `integration.ts` implements with the
   same builder (`async-scheduler.ts::rejectedAwaitThrow`, reached through the
   IR's existing async-scheduler import — no new ir -> codegen edge, #3113), so
   the two lowerings cannot drift.
3. `standalone-dynamic-import.ts`: a non-literal first argument whose ToString
   can run user code (externref / object literal) is kept in a local after all
   arguments are evaluated (GetValue stays a synchronous throw), then
   `ToString` runs inside a tagged try; a caught completion becomes the
   rejection reason (§13.3.10.1 IfAbruptRejectPromise), otherwise the #3494
   TypeError.

Out of scope, filed: an async declaration awaiting a `never`-typed callee still
throws synchronously —
[#6747](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6747-standalone-async-never-callee-sync-throw)
(call site and activation use different "is driven" predicates).

## Resolution

- Regression `tests/issue-6735-standalone-async-dynamic-import.test.ts`:
  parent 4/14 pass, fix 14/14 (TypeError rejection from arrow / function
  expression / class method / object method / declaration; `catch` delivery in
  the jest-util `importModule` shape for arrow / method / declaration; any
  awaited rejected promise; fulfilled await unchanged; ToString-abrupt
  rejection in async and plain position; GetValue throw still synchronous).
  `tests/issue-3494-*` and `tests/issue-3509.test.ts` stay green (42/42 with
  the new file).
- Scoped standalone test262 (1,778 paths: `language/expressions/dynamic-import`,
  `expressions/{async-arrow-function,async-function,await}`,
  `statements/async-function`, the four class `async-method[-static]` dirs,
  async `object/method-definition`, `module-code/top-level-await`;
  `scripts/run-test262-paths.mts --standalone`): parent
  `{ pass: 1146, fail: 370, compile_error: 91, skip: 171 }` → fix
  `{ pass: 1164, fail: 352, compile_error: 91, skip: 171 }`, +23 / -5.
  - Gains: the 6 `try-{return,throw}-finally-reject` rows, 13
    `*-specifier-tostring-abrupt-rejects` rows, 2 `nested-async-arrow-function-
    return-await-*` rows, 2 `import-attributes/*trailing-comma-reject` rows.
  - The 5 losses were vacuous passes: `nested-async-arrow-function-await-
    {eval-rqstd-abrupt-urierror,eval-script-code-target,instn-iee-err-ambiguous-
    import,instn-iee-err-circular}` and `top-level-await/dynamic-import-of-
    waiting-module` passed only because the arrow's `await` swallowed the
    rejection, so the `.catch` assertion never ran. They need fixture modules
    the standalone graph does not load; their `nested-async-function-await-*`
    declaration twins already failed identically on the parent
    (`Expected SameValue(«"TypeError"», «"URIError"»)`).
- JS-host byte-identical: acorn plus 24 async/import snippets compiled for the
  default target hash the same before and after (standalone acorn too); only
  the intended standalone programs change.
- jest standalone-dynamic lane: unchanged by this PR — #3494 had already moved
  it past the `import()` refusal. Before and after:
  `'node:fs' call to 'readFileSync' requires the --allow-fs flag (or { allowFs: true } in CompileOptions) for non-WASI targets (#1491). Refusing to emit the host import to prevent accidental capability leakage.`

## Reverted — 2026-09-29

#6301's code and its test were reverted in #6313, together with #6299. The
issue files stay; this issue is `ready` again.

**What broke.** With #6301 on `main`, two ES5 rows fail in standalone, and ES5
is a completed edition, so the per-edition ratchet blocks every merge group:

- `harness/asyncHelpers-throwsAsync-native.js`
- `harness/asyncHelpers-throwsAsync-custom-typeerror.js`

**Why.** #6301 is right: `await` of an already-rejected promise must throw. The
rows were passing vacuously. `assert.throwsAsync` calls its `func` argument
through an untyped parameter, and in standalone an async closure called that
way throws synchronously (and returns a raw value, not a promise, on success).
So `throwsAsync` rejected with "the function threw synchronously", and the test
body's `await p` used to swallow that. With #6301 the `await` throws and the
rows fail. The underlying bug is #6761.

**Evidence.** Merge-group run 36542630445 (`main` + #6301 only) already lists
`asyncHelpers-throwsAsync-native.js` among the ES5 failures; the #6299 and
#6303 groups before it do not. Locally (`runTest262File`, standalone), both
rows fail on `main` and pass with #6301's code reverted.

**Re-land.** Re-apply #6301 after #6761 lands, and check both rows pass.

