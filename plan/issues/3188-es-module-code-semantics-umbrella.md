---
id: 3188
title: "UMBRELLA: ES module-code semantics (~174 fails) — namespace objects, cross-module TDZ, module early errors + wrapTest export collision"
status: ready
created: 2026-07-12
priority: medium
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: ES2015
language_feature: modules
goal: core-semantics
sprint: current
horizon: l
related: [1089, 2971, 1512, 34, 1696]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F5)"
---

# #3188 — UMBRELLA: ES module-code semantics

## Problem

`language/module-code` has **174 non-pass** on the default lane (baseline
2026-07-12) and is the last whole-ES-surface with **no live tracking**: only
ancient #34 (multi-memory module linker), #2971 (TLA sibling-module
evaluation) and #1512 (dynamic-import early errors) graze it; dynamic import
itself is #1089 (ready, ~330 more `language/expressions/dynamic-import`
fails). Static-module semantics have no umbrella.

Error-shape census:

```
 26+26  returned N / ConformanceError                 ← semantics wrong
 17     expected SyntaxError, no diagnostic            ← module early errors unenforced
 14     [object WebAssembly.Exception]
 10     Cannot access property on null/undefined
  9+2   assert.throws(ReferenceError, …)               ← cross-module / indirect-binding TDZ
  6     Duplicate identifier 'test' / Duplicate export name 'test'   ← RUNNER artifact
  5     Reflect.has called on non-object               ← module namespace object
  4     No dependency provided for extern class "C"
```

## Slices (file children as picked up)

1. **[S, ready-first] Runner artifact — ✅ DONE (2026-07-12, dev-find-wasm)**.
   The 6 `Duplicate export name 'test'` records were NOT a test's own `test`
   export (none exist) — they are the `top-level-await/syntax/*-await-expr-obj-literal.js`
   tests whose `await { function() {} }` operand misparses. The runner compiles
   the top-level-await body SYNCHRONOUSLY (wrapTest TLA path emits it at module
   top level, not inside `async`), so TS treats `await` as an identifier and the
   trailing `{ … }` as a *block statement*, which swallows the wrapper's
   `export function test()` during error recovery. Fix: `parenthesizeAwaitBraceOperand`
   rewrites `await { … }` → `await ({ … })` in the TLA path (a no-op in a real
   async context), so the `{ … }` parses as the await operand in every position
   (top-level statement, `typeof`/`void`, for-header, `export var/let x = await {…}`).
   Measured: TLA-syntax dir 205→211 compileOK / 6→0 CE, zero regressions.
   Tests: `tests/issue-3188.test.ts`.
2. **Module early errors (17)** — duplicate exports, undefined export names,
   `import`/`export` position errors: enforce at compile time via the TS
   checker diagnostics or a targeted static-semantics pass (same pattern as
   the #3026 negative-test lineage).
3. **Module namespace object semantics** — @@toStringTag, [[Has]]/Reflect.has
   on the namespace, non-extensibility, binding views (`ns.localN` shapes —
   19 in the dynamic-import bucket share this substrate with #1089).
4. **Cross-module TDZ / indirect bindings** — `assert.throws(ReferenceError)`
   on access-before-evaluation; live-binding reads after mutation.

## Notes

- Slices 3-4 share their substrate with #1089 (dynamic import returns the
  same namespace object) — coordinate; whoever lands first builds the
  namespace-object representation.
- test262 module tests declare `flags: [module]`; verify the runner compiles
  those as module code (not wrapped script) before attributing semantic fails.

## Acceptance criteria (umbrella)

1. ✅ Slice 1 landed (6 `top-level-await/syntax/*-obj-literal` records flip
   compile_error→pass; the misparse no longer swallows the wrapper's `test`
   export). Umbrella stays `ready` for slices 2-4.
2. Children filed for slices 2-4 with measured test lists.
3. `language/module-code` non-pass < 100 (from 174) as children land.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F5.
