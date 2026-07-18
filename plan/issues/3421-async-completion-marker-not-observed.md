---
id: 3421
title: "Async harness protocol broken: $DONE marker never observed — 4,617 host-lane tests"
status: done
created: 2026-07-18
completed: 2026-07-18
assignee: ttraenkler/fable-5
priority: high
feasibility: medium
task_type: bugfix
area: runtime, codegen-declarations
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3370, 3417, 3419]
loc-budget-allow:
  - src/codegen/declarations.ts
---

# #3421 — "async completion marker not observed": the $DONE protocol never worked under oracle v8

## Problem

The single biggest host-lane failure bucket on the 2026-07-18 baseline:
**4,617** tests fail with exactly `async completion marker not observed`.
Verify-first showed even the MINIMAL async test fails:

```js
// flags: [async]
Promise.resolve(1).then(function () {
  $DONE();
}); // → marker not observed
$DONE(); // → marker not observed
print("Test262:AsyncTestComplete"); // → leaks to REAL stdout
```

So this was never about async semantics — the harness PROTOCOL
(`$DONE` → `__consolePrintHandle__` → `print` → `console.log` → runner
capture) was broken at TWO independent links.

## Root causes (verified 2026-07-18, fable-5)

1. **`resolveImport` `case "console_log"` ignored `deps.console`**
   (`src/runtime.ts`). The runners pass a capturing `consoleProxy` via
   `buildImports(manifest, { console: consoleProxy }, …)`, but the console_log
   intent bound the GLOBAL `console` directly — the marker printed to real
   stdout and the runner's `fixtureOutput`/`output` array stayed empty.
   Fix: resolve the method off `deps.console` (per-method fallback to the
   global for partial proxies — the runner proxy has only log/error/warn).

2. **The runtime shim's `var print = fn` was denied module-global storage**
   (`src/codegen/declarations.ts` `registerModuleGlobal`). The gate
   `funcMap.has(name) → "shadowed by a user function" → skip` conflated
   genuine user functions with HOST IMPORTS: the lib scan registers the
   ambient DOM `declare function print(): void` as an `env.print` import, so
   the shim's top-level `var print = function (v) { console.log(v); }` never
   got its `__mod_print` global. `closureMap` had the closure but no storage —
   every cross-function call (`$DONE` runs inside `doneprintHandle.js`
   functions) compiled to a dropped no-op (`myDone` WAT: `i32.const 0; drop`).
   Fix: generalize the #2669 discrimination — only a DEFINED function
   (`fnIdx >= numImportFuncs`) shadows the var; an import-indexed entry does
   not (JS: the script-level `var` binding wins over the ambient global).
   Position-dependence (body-defined `print` clones worked, shim-position
   failed) is explained by the lib scan only firing when the source references
   lib globals — the full harness always does.

## Verification

- Probe chain (all `flags: [async]`, via `runTest262File`): direct `print`,
  `__consolePrintHandle__`, `$DONE()`, `print`-from-function, and the real
  `Promise.resolve().then($DONE)` / `async function` shapes — 0/6 passed
  before, **6/6 pass** after.
- **30-file deterministic sample of the 4,617 bucket: 0 → 17 pass (57%)**;
  extrapolated ≈ **2,600 recovered tests**. The 13 residuals now report their
  REAL async failures through the working protocol
  (`Test262:AsyncTestFailure: …` with genuine reasons — wasm exceptions,
  destructuring nulls, `'this' must be global object`, …) instead of the
  blanket marker timeout, so they become individually triageable.
- Canary: 40-file deterministic spread of currently-PASSING tests — 40/40
  still pass (no collateral from the module-global shadow change).
- `tests/issue-3421.test.ts` — deps.console capture routing unit test.
