---
id: 5339
title: "hono helper/dev: the whole test module fails before any test runs (0/8) — and the harness reports it with a null wasmError"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/senior-dev
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

`src/helper/dev/index.test.ts` is **0/8** in the hono upstream suite. All
eight tests fail with a **null** per-test `wasmError` — the file dies as a
unit, before any `it()` body executes. This file also used to strand the
*whole* suite silently (fixed in #5326 by the per-file watchdog), so it has
already cost this effort once.

Measured on a clean detached worktree at main `c9a8b48616`. hono overall
244/324.

## Evidence

- Eight entries in `tests/dogfood/report/hono-upstream-suite.json` for this
  file, all `status: "failed"`, all `wasmError: null`.
- **Reporting trap, load-bearing here:** for a whole-module failure the
  message is *not* on the tests. Look in `report.compile.details[N]` for this
  file — `errors[0]` (codegen/compile error), or `validationError` (module
  emitted but does not validate), or `runtimeError` (throws inside
  `__module_init`). Four agents have misread "wasmError: null" as "no error".
- Run alone through `compileAndRunUpstreamModule`, the file settled with
  `native 0/0, wasm undefined` — **zero tests registered on the native lane
  too**. So the first thing to establish is whether this is a compiler failure
  at all, or the harness's transform of this file (it uses `showRoutes` /
  `inspectRoutes`, which print; the test may stub `console.log`, and a stub
  that is never restored is exactly what #5326's swallowed-stdout bug was).

## Acceptance criteria

1. The report names the actual failure for this file (no more null-only
   record), **and** either the file passes ≥ 6/8 or the issue is re-filed with
   the confirmed root cause and a repro if it is a harness problem rather than
   a compiler one.
2. If a compiler fix: regression test under `tests/` failing on the parent,
   passing with the fix, untyped `.js` two-file fixtures, plus an anti-vacuity
   control.
3. A/B at one HEAD, 17 suites, per test file — hono improves, nothing else
   moves (anchors in #5338).
4. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

1. **Get the real error first.** After a suite run, print
   `report.compile.details.find(d => d.file.includes("helper/dev"))` in full.
   Three branches:
   - `success: false` → codegen error; go to step 3.
   - `validates: false` → invalid Wasm; the new required gate
     (`check:dogfood-validation`) should also catch this class — confirm it
     does, then go to step 3.
   - `success && validates` with `runtimeError` → `__module_init` threw; go
     to step 2.
2. **If it throws at init**: compile the generated entry
   (`.hono-upstream-suite-generated/src/helper/dev/index.ts`) directly,
   instantiate, and call `instance.exports.__module_init()` with the suspect
   host function monkey-patched to log — this is how the axios `beforeEach`
   blocker (#5295) was found in minutes. Also check whether the **native**
   lane registers zero tests: if native is also 0/0, the transform or the
   file's own `console.log` stubbing is the problem, and the fix is in
   `tests/dogfood/hono-upstream-suite.mjs` / `upstream-suite-runner.mjs`, not
   `src/`.
3. **If it is a compiler error**: reduce with a negative control via a
   standalone `.mjs` (model `.tmp/markedbisect/globalset.mjs`; sanity-check
   with a deliberately-false assertion). The file's distinctive ingredients
   are `new Hono().use(...).get(...).post(...)` **method chaining on a class
   instance across many calls**, `inspectRoutes(app)` returning an array of
   object literals compared with `toEqual`, and `showRoutes` writing to
   `console.log`. Ablate those in that order.
4. Fix at the site; prefer a subsystem module over a god-file allowance.
5. Regression test, A/B.

## Dispatch

Model: **opus**. The failure mode is not yet known (could be codegen,
validation, init-throw, or harness), so the agent must branch on evidence
rather than follow a fixed recipe.

## Resolution

Fixed on `main` at `a1469a5454`. **It was a compiler bug — branch 2 of the
plan (invalid Wasm), not the harness.** The suspected harness/transform lead
in the Evidence section was a false trail (see "Corrections" below).

### The real error

The plan's step 1 was right about where to look. `report.compile.details` for
this file carried:

```
success: true, validates: false,
validationError: CompileError: WebAssembly.compile():
  Compiling function #340:"getColorEnabledAsync" failed:
  type error in return[0] (expected i32, got externref) @+315383
```

`getColorEnabledAsync` is hono's own `dist/utils/color.js`, pulled in
transitively by `helper/dev`. Nothing in the file's "distinctive ingredients"
(method chaining, `toEqual` on object literals, `console.log` stubbing) was
involved.

### Root cause

A value-returning **IIFE is inlined** into its caller, so every `return` in
its body must become `local.set <ret>; br <iife-exit>` — there is no Wasm
function to return from. `patchReturns`, the rewriter in
`src/codegen/expressions/call-tail-dispatch.ts`, walked `if.then`, `if.else`
and `<block>.body`, but **not the `catches[].body` / `catchAll` arms of a
legacy `try`**. A `return` inside a catch clause therefore survived as a Wasm
`return` and returned from the ENCLOSING function.

hono hits it exactly:

```js
async function getColorEnabledAsync() {
  const isNoColor = navigator !== void 0 && navigator.userAgent === "Cloudflare-Workers"
    ? await (async () => { try { return "NO_COLOR" in (…); } catch { return false; } })()
    : !getColorEnabled();
  return !isNoColor;
}
```

The IIFE's ret local is `externref` (its type is `Promise<boolean>`), the
enclosing function's Wasm result is `i32` — so the escaping `return` pushed an
`externref` where an `i32` was required and the module did not validate. That
is why the per-test `wasmError` was `null`: the failure is on the MODULE, and
none of the eight tests ever ran.

The same omission also produces **silently wrong values whenever the two
return types happen to agree** — no validation error, no diagnostic:

```js
function f() { const v = (function () { try { throw new Error("boom"); } catch { return 1; } })(); return v + 10; }
f()   // native 11, wasm 1
```

The void-IIFE arm of the same file (`patchVoidReturns`) *did* walk the catch
arms — the two walkers were copies and drifted. The fix therefore extracts one
walker, `patchInlinedIifeReturns` in
`src/codegen/expressions/iife-return-patch.ts`, parameterised by the result
local (`null` = void), so the two arms cannot diverge again. Both `try` arms
resolve at `depth + 1` because a legacy `try` has one label shared by `do`,
every `catch` and `catch_all`.

Standalone/WASI was never affected: `buildStandardTryTable` materialises
handlers as nested `block`s, which the generic `body` recursion already
reached.

### Corrections to this issue's Evidence

- "**native 0/0, wasm undefined** — zero tests registered on the native lane
  too" is **wrong**. Re-measured through `compileAndRunUpstreamModule` on a
  clean base, the native lane registers **8/8 and passes 8/8**. That
  observation is the `tsx`-worker-spawn artefact the dispatch brief warns
  about; it sent the investigation toward a harness hypothesis that had no
  basis.
- The `showRoutes` / `console.log`-stubbing suspicion is unrelated to the
  module failure.

### Result

`src/helper/dev/index.test.ts`: **0/8 → 1/8**, and the module now compiles,
validates and executes, so the report names a real error for each remaining
test instead of `null`.

**The ≥ 6/8 acceptance bar is NOT met, and it cannot be met by this fix.** The
seven residual failures are two *different* defects, both now confirmed with
repros and filed:

| residual | tests | cause |
| -------- | ----- | ----- |
| [#5365](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5365-host-closure-bridge-loses-length-and-name) | 6 (`inspectRoutes` + all 5 `showRoutes`) | in JS-host mode a closure that crosses a call boundary as a value reports `length === 0` / `name === undefined` (it is the `wasmClosureBridge` wrapper). hono classifies routes with `handler.length > 1` and labels them with `handler.name`, so every route reads as a non-middleware `[handler]`. |
| [#5366](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5366-class-instance-field-from-constructor-option-reads-null) | 1 (`getRouterName`) | `new Hono({ router: new RegExpRouter() })` leaves `app.router === null`, so `app.router.match(...)` throws. |

`length` alone would take the file to 5/8; `length` + `name` to 7/8; both plus
#5366 to 8/8. Neither is a variation of this bug, and #5365 in particular
changes `_wrapWasmClosure`, which is on every host callback in every package —
it needs its own A/B, not a rider on this one.

### Verification

- Regression test `tests/issue-5339-iife-return-in-catch.test.ts`, untyped
  `.js` two-file fixtures: **2/8 on the parent, 8/8 with the fix**. The two
  that pass on the parent are the anti-vacuity controls (`return` in the try
  body; no `try` at all) — same shapes, catch clause never entered.
- Gates green: `check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
  `check:oracle-ratchet`, `check:dead-exports`, `check:dogfood-validation`,
  `tsc --noEmit -p tsconfig.ts7.json`. The extraction into its own module
  makes `call-tail-dispatch.ts` and `compileTailDispatch` **smaller**, so no
  budget allowance was needed.
- A/B over all 17 dogfood suites at one HEAD (`a1469a5454`), base vs fix,
  compared **per test file**. Base and fix differ only in
  `src/codegen/expressions/call-tail-dispatch.ts` (+ the extracted module);
  every suite ran one at a time from the same worktree.

  | suite | base | fix | Δ | | suite | base | fix | Δ |
  | ----- | ---- | --- | - | - | ----- | ---- | --- | - |
  | hono | 220/324 | **221/324** | **+1** | | prettier | 101/151 | 101/151 | 0 |
  | axios | 200/231 | 200/231 | 0 | | redux | 66/82 | 66/82 | 0 |
  | jest | 335/356 | 335/356 | 0 | | styled-components | 9/9 | 9/9 | 0 |
  | cookie | 63740/63740 | 63740/63740 | 0 | | stylelint | 108/108 | 108/108 | 0 |
  | clsx | 32/32 | 32/32 | 0 | | tailwindcss | 13/13 | 13/13 | 0 |
  | jsdom | 6/6 | 6/6 | 0 | | three | 17/18 | 17/18 | 0 |
  | lodash | 58/62 | 58/62 | 0 | | uuid | 75/75 | 75/75 | 0 |
  | marked | 9/30 | 9/30 | 0 | | webpack | 16/16 | 16/16 | 0 |
  | moment | 10/10 | 10/10 | 0 | | **total** | **65015** | **65016** | **+1** |

  **Exactly one test file moved:** `hono/src/helper/dev/index.test.ts`
  `0/8 → 1/8`. No other file in any suite changed either its pass count or its
  denominator.

- `tests/equivalence/` gate, all 8 shards: no new regressions.

### The plan asked whether `check:dogfood-validation` catches this class — it does not

Measured directly: with the **buggy** source restored (`git`-clean base, only
`call-tail-dispatch.ts` reverted), `node scripts/check-dogfood-validation.mjs`
exits **0**. hono *is* in its gated set, so this is a coverage gap, not an
omission of the package.

The gate compiles each package's **declared entry module**
(`npm-compat-catalog.json` → hono `package/dist/index.js`) and asserts
`compile.success ⇒ validates`. `dist/index.js` never imports `utils/color.js`
— `getColorEnabledAsync` is reachable only through `helper/dev`, which only a
test file pulls in. So the invalid function is never emitted in the module the
gate compiles.

The invariant the gate asserts is sound; its **input set** is entry-module
shaped. A validation failure in any submodule that the declared entry does not
reach is invisible to it, and that is precisely the shape that killed a whole
upstream test file here. Widening it (e.g. compiling each package's exported
subpath map, not just the main entry) would be a cheap, well-targeted
follow-up, but it is a change to the gate's contract and belongs in its own
issue rather than in this fix.
