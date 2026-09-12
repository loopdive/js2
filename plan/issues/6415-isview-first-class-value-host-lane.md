---
id: 6415
title: "`ArrayBuffer.isView` read as a FIRST-CLASS VALUE answers false for every carrier on the JS-host lane"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Measured while closing [#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity)
(same probe, both before and after that fix — this is pre-existing and
untouched by it):

```js
// untyped .js half
export function isViewViaHostFn(value) {
  const f = ArrayBuffer.isView; // first-class VALUE read
  return f(value);
}
```

`isViewViaHostFn(new Uint8Array(3))` and `isViewViaHostFn(<host Uint8Array>)`
both answer **false** in compiled code on the JS-host lane. Node answers `true`
for both. The DIRECT call form — `ArrayBuffer.isView(value)` in the same
untyped module, same values — answers `true` after #5370.

So the two spellings of the same predicate disagree, which is exactly the
divergence #5150 removed on the standalone lane and left open here.

## Why

`src/codegen/builtin-value-read.ts` has a first-class `ArrayBuffer.isView`
closure, but it opens with:

```ts
case "ArrayBuffer.isView": {
  if (!noJsHost(ctx)) return null;
```

so on the host lane the value read falls through to the generic host-property
route. Whatever that produces does not reach the `__arraybuffer_isView` import
that #5370 corrected (that import now re-asks through `_wrapForHost`, so a
branded carrier reads as a real view). Two arms are worth measuring before
choosing:

* the host-lane value read resolves `ArrayBuffer` then `.isView` through
  `__extern_get`, and the resulting dynamic call hands the callee the RAW
  WasmGC carrier rather than its `_wrapForHost` mirror; or
* the closure is built but with the standalone `isViewRefTestInstrs` body,
  which cannot see a host externref at all.

The standalone `isViewRefTestInstrs` chain is NOT the fix for the host lane on
its own: it shares the `$Vec` carrier between `number[]` and TypedArrays, so a
plain array literal would start reading as a view. The host lane has an exact
answer available (the import) and should use it.

## Acceptance criteria

1. `const f = ArrayBuffer.isView; f(x)` answers identically to
   `ArrayBuffer.isView(x)` on the JS-host lane for: a compiled carrier, a
   host-built typed array, and — anti-vacuity — a plain array literal (`false`)
   and a `DataView`.
2. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
3. A/B over the 17 dogfood suites at one HEAD; nothing regresses.
4. Standalone lane byte-identical (this is a host-lane arm).

## Dispatch

Model: **opus**. One located arm; the design point is whether the host-lane
closure should call the import or whether the generic dynamic-call path should
marshal its arguments, and the second answer would be much larger in blast
radius.
