---
id: 5293
title: "`__class_call_<m>_vararg` exports the wrong function — a stale index publishes a vec helper under the bridge's name"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
loc-budget-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
---

## Problem

`emitMethodDispatch` computed the export's function index **before** building
the body:

```ts
const funcIdx = ctx.numImportFuncs + mod.functions.length;   // ← taken here
…
// body construction for the vararg arm:
const newSizedIdx = ensureVecNewSized(ctx, restInfo.vecTypeIdx);
const elemSetIdx  = ensureVecElemSet(ctx, restInfo.vecTypeIdx);
…
mod.functions.push({ name: exportName, typeIdx: bridgeTypeIdx, … });
mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
```

`ensureVecNewSized` / `ensureVecElemSet` **mint and append functions of their
own** (`mintDefinedFunc` + `pushDefinedFunc`). By the time the bridge itself was
pushed, the precomputed index belonged to the first helper minted, and
`mod.exports` published that helper under `__class_call_<m>_vararg`.

The module is well-formed — this is not a validation failure. The export simply
has the helper's `(f64) -> …` signature:

```js
const va = instance.exports.__class_call_use_vararg;
va.length;              // → 1     (the helper), expected 2
va(recv, [{}]);         // → TypeError: Cannot convert object to primitive value
```

`class-method-host-bridge.ts` calls it as `callFn(receiver, argsArray)`, so the
receiver is coerced toward a number and the throw lands at the JS→Wasm boundary
with **no Wasm frame below it** — which is why it looked like a runtime bug
rather than a codegen one.

Only the vararg arm is affected: the fixed-arity arms build no helpers, so
their precomputed index stayed correct.

## Reached whenever the receiver is a mutable binding

A `let` puts the receiver in a live-binding global, so it reads back as
`externref` and the call goes through the host bridge instead of a direct typed
call. `const` receivers were fine, which made this present as a
`let`-vs-`const` mystery:

```js
class C { use(...e) { return e.length; } }
let g; g = new C();
g.use({});               // → "Cannot convert object to primitive value"
// const g = new C();    // → fine
```

## Fix

Take the index immediately before `mod.functions.push`, after the body (and
therefore every helper it minted) is complete.

## Measured

- `tests/class-vararg-bridge-export.test.ts`: **all 5 cases fail on the parent
  commit; all 5 pass with the fix.** They cover the export's declared arity,
  packing the host argument array into the rest vec, a `let`-bound receiver, a
  `const`-bound receiver, and `this` threading.
- **marked's failure mode changes completely.** Before: all 30 tests died with
  `Cannot convert object to primitive value` before marked did any work. After:
  the hooks install, marked parses, and the failures are ordinary assertion
  mismatches (`actual=<p>text</p> expected=<h1>text</h1>`). Still 0/30 — a
  further defect keeps the registered `preprocess` hook from affecting output —
  but the package is no longer blocked at the door.
- Sixteen upstream npm suites re-run: no package number changed.

**On the test fixtures:** the call site must be untyped (`(g as any).use(…)`).
A typed member access resolves to a direct call and never reaches the host
bridge, so it cannot exercise this at all — an earlier draft did that and
passed identically with and without the fix.
