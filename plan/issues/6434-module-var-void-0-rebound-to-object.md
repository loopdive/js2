---
id: 6434
title: "module `var x = void 0` later rebound to an object gets an i32 slot — the object is truncated to 0"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

A module-level `var x = void 0;` that is later assigned an object gets an
**i32** Wasm global slot, so the assignment stores
`i32.trunc_sat(__unbox_number(obj))` — i.e. `0` — and every later read sees a
null pointer instead of the object.

`moduleGlobalWasmType` (`src/codegen/declarations.ts` ~L3483–3620) deliberately
excludes the `void 0` initializer arm when choosing a module global's type. The
exclusion is load-bearing for a different reason: the #4491 note records that
widening it regressed the test262 filter harness cases
`15.4.4.20-9-2/-3/-4/-6`. So this is a typing change with a known blast radius,
not an oversight to be flipped.

Split out of
[#6413](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6413-hono-jsx-dom-closure-fallthru-externref),
where it was masked: the same fixture used to fail `WebAssembly.compile`
outright. With #6413's `||=` reorder landed the module validates and the defect
becomes a runtime trap instead.

This is hono's shape. `dist/jsx/base.js` declares `let nameSpaceContext` and
`jsxFn` does `nameSpaceContext ||= createContext("")`; bundled subpaths that
emit `var nameSpaceContext = void 0;` therefore lose the namespace context for
`<svg>` / `<head>` even though the module now compiles.

## Reproduce

Two untyped `.js` files plus a TS entry, compiled with
`compileProject(..., { allowJs: true, skipSemanticDiagnostics: true, target: "gc", platform: "node" })`:

`ctx.js`

```js
var createContext = (v) => ({ value: v, kind: "ctx-6434" });
export { createContext };
```

`main.js`

```js
import { createContext } from "./ctx.js";
var nameSpaceContext = void 0;
var tag = (t) => {
  if (t === "svg" || t === "head") {
    var got = (nameSpaceContext ||= createContext(""));
    return got ? got.kind : "null";
  }
  return "plain";
};
export function run() { return tag("svg") + "|" + tag("head") + "|" + tag("div"); }
```

Native: `ctx-6434|ctx-6434|plain`. Wasm (with #6413 applied): the module
validates and then traps with `RuntimeError: dereferencing a null pointer`.
Replacing `var nameSpaceContext = void 0;` with a bare `var nameSpaceContext;`
runs correctly — that is the whole difference.

## Acceptance criteria

1. The fixture above returns `ctx-6434|ctx-6434|plain` under the JS-host (gc)
   target.
2. A regression test that fails on the parent commit and passes with the fix,
   with the bare-`var` form kept as an anti-vacuity control.
3. **A full test262 A/B on the changed consult, reported in the PR.** The
   #4491 note names `15.4.4.20-9-2/-3/-4/-6` specifically; a net-negative or a
   regression in the filter-harness bucket blocks the change. If the widening
   cannot be made test262-neutral, close as `wont-fix` with the measurement
   rather than shipping a partial.

## Notes

The likely shape is to consult `bindingHasMixedAssignmentCarrier` at module
scope — the same question the function-local path already answers — rather than
widening the `void 0` arm unconditionally. That keeps the `void 0`-and-only-ever
-a-number bindings on their i32 slots, which is what the #4491 regression was
about.
