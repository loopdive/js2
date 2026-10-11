---
id: 6669
title: "linked graphs: a module-level variable resolved to ANOTHER module's same-named top-level function (styled-components `oe` vs stylis `oe` — wasm-opt \"call param types must match\")"
status: done
sprint: current
created: 2026-09-24
completed: 2026-09-24
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1058, 4133, 3505, 6662, 6670, 6664]
---

# #6669 — a module-level variable must not bind to another module's function

## Problem

After #6662 the styled-components **standalone-dynamic** npm-compat lane
compiled but failed optimization:

```
wasm-opt -O4 failed: [wasm-validator error in function re] call param types must match, on
(call $oe (ref.cast (ref null $struct.0) (any.convert_extern (local.get $20))) …
```

(raw module: `call[5] expected type (ref null 6) [$AnyString], found anyref`).

`re` is styled-components' hoist-non-react-statics helper:

```js
const …, oe = Object.getPrototypeOf, se = Object.prototype;
function re(e, t, n) { if ("string" != typeof t) { const o = oe(t); … } }
```

`$oe` in the binary is **not** that alias: it is stylis's minified top-level
`function oe(e, r, a, n)` (lifted to 7 captured native-string slots + 4 args).
The minifiers of the two packages picked the same short name. It never
reproduced "in isolation" because it needs two modules.

## Root cause

`ctx.funcMap` is keyed by bare name across the linked graph. Two independent
places treated stylis's `oe` as styled-components' binding:

1. `registerModuleGlobal` (module-global-registration.ts) skips creating a
   module cell when `funcMap[name]` is a defined user function — correct for
   `function f(){}; var f;` in ONE source, wrong across sources. So
   `const oe = Object.getPrototypeOf` got no cell at all.
2. The identifier call path then found no visible storage and fell through to
   `funcMap.get("oe")` → a direct `call` into stylis's string-typed body.

#4133's per-source re-binding only covers names that BOTH modules declare as
functions, and #1058's `withDeclarationBoundCallee` only covers a callee that
resolves to a function declaration; this is the variable-vs-function case.

It also miscompiles JS-host silently (the call validates there because params
are externref, but calls the wrong function).

## Implementation Plan (executed)

- `src/codegen/module-global-registration.ts` — `functionIsFromAnotherSource`:
  the funcMap entry only suppresses the variable's cell when the function's
  declaration (`ctx.sourceFunctionDeclarationByHandle`) is in the SAME source
  file as the variable. Single-source programs (all of test262) are unchanged.
- `src/codegen/expressions/declaration-bound-callee.ts` —
  `isForeignFunctionShadow` / `withWithheldForeignCallee`: when the callee
  resolves (via `ctx.oracle.aliasedValueDeclarationOf`) to a top-level
  `VariableDeclaration` that has a module cell, and the funcMap handle belongs
  to a FunctionDeclaration in a different file, withhold `funcMap[name]` (and
  the name-keyed inliner entry) for the duration of the call so it dispatches
  through the variable's value. Identifier initializers (possible genuine
  aliases of that function) keep the historical direct call. Source-function
  handles are stable-regime ids (#1916 S3), so the restore is exact.

## Resolution

- `tests/issue-6669-cross-module-var-shadows-function.test.ts`: 4 tests
  (standalone + gc, closure call + object-argument shape). Parent 0/4
  (standalone traps / gc returns NaN), fix 4/4.
- styled-components standalone-dynamic lane: `optimization-error` (the `re`
  diagnostic above) → past optimization. The next invalid function in the same
  binary (`De`) was a separate standalone `in` bug, fixed as #6670; the lane
  now stops at `host-import-error: standalone binary retained 18 host
  import(s)` (DOM/timer globals, #6664).
