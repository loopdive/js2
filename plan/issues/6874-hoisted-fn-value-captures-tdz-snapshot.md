---
id: 6874
title: "A hoisted function declaration taken as a VALUE before a later `const` it closes over is initialized reads that const as `null` forever — axios `toFormData` `indexes`/`dots`"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Measured 2026-10-05 on `upstream/main` `42d289a96f` (+ the
[#6417](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6417-axios-residual-round-2)
fixes, which unblocked the path):

```js
// mod.js (untyped)
export function earlyPlainCall(options) {
  const visitor = visit;          // closure VALUE materialized here
  const flag = options.flag;      // initialized AFTER
  function visit(key) {
    return key + ":" + String(flag);
  }
  return visitor("k");
}
```

`earlyPlainCall({ flag: false })` answers `"k:null"`; node answers
`"k:false"`. Moving `const visitor = visit` below `const flag` makes it
correct, and calling `visit("k")` directly is correct — the defect is the
closure VALUE capturing `flag` by value at materialization, while `flag` is
still in its TDZ. Through a nested callback (`items.forEach(function (el) { …flag… })`)
the same shape traps "dereferencing a null pointer".

axios `lib/helpers/toFormData.js` is this shape verbatim:

```js
const visitor = options.visitor || defaultVisitor;  // before ↓
const dots = options.dots;
const indexes = options.indexes;
function defaultVisitor(value, key, path) { … indexes === null ? key : key + '[]' … }
```

so `buildURL('/foo', { foo: ['bar', 'baz'] })` renders `foo=bar&foo=baz`
instead of `foo%5B%5D=bar&foo%5B%5D=baz` (axios buildURL "should support
array params with encode").

Sibling of #5356 (mutated `let` captured by a hoisted function — ref cell
minted at the first call site) and #4526 (`compileArrowAsCallback`'s
`closurePrecedesBindingInitializerStore` for callbacks). This is the
READ-ONLY, VALUE-materialization case neither covers.

## Implementation Plan

1. Where a nested function declaration's closure VALUE is materialized
   (`emitCachedFuncClosureAccess` / the hoisted-function value binding,
   `fctx.hoistedFunctionValueBindings`), compute which of its captures are
   `let`/`const` bindings whose initializer has NOT executed at that point in
   source order (reuse `closurePrecedesBindingInitializerStore`'s position
   test).
2. Capture those by ref cell instead of by value: allocate the cell eagerly at
   function-top (the #5356 `emitEagerCaptureBoxes` path, extended to
   read-only TDZ captures), so the later `const` initializer writes through the
   cell and the closure reads the live value.
3. Keep by-value capture for every binding initialized before the
   materialization point (no codegen change for the common case).
4. Regression test: the `earlyPlainCall` fixture, the forEach-nested variant,
   and a control where the const precedes the value read.
5. A/B the dogfood suites and a scoped standalone
   `language/statements/function` + `language/block-scope` slice.

## Acceptance criteria

- axios buildURL "array params with encode" passes; no suite drops.
