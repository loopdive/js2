---
id: 2797
title: "diff-test host path: untyped arrow/closure value & dynamic method dispatch — arrow-this NaN, callback drops result, method-chain traps"
status: ready
sprint: Backlog
created: 2026-06-28
updated: 2026-06-28
priority: medium
feasibility: hard
model: fable
reasoning_effort: high
task_type: bug
area: codegen
language_feature: closures
goal: trustworthiness
related: [2787, 11, 1382]
origin: "2026-06-28 — #2787 differential-corpus triage (cluster A3)"
---

# #2797 — Host-path untyped arrow/closure + dynamic method dispatch

## Problem (cluster from #2787 diff-test triage)

Three `closures/*` corpus programs fail. All use **untyped JS** (no type
annotations), so the compiler cannot statically resolve the callee/`this` and
must use the dynamic `any` dispatch path — which produces wrong values or traps.

### A — arrow function captured `this` → NaN

`tests/differential/corpus/closures/07-arrow-this.js`

```js
function f() {
  this.x = 10;
  const g = () => this.x; // arrow: lexical this
  return g();
}
console.log(f.call({})); // V8: 10   js2wasm: NaN
```

The arrow should capture the enclosing function's `this` lexically. Via `.call({})`
the dynamic `this.x` read returns NaN instead of 10.

### B — arrow passed as a callback param drops its return value

`tests/differential/corpus/closures/09-callback.js`

```js
function apply(arr, fn) {
  const out = [];
  for (let i = 0; i < arr.length; i++) out.push(fn(arr[i], i));
  return out;
}
console.log(apply([1, 2, 3], (x) => x * x).join(",")); // V8: 1,4,9  js2wasm: ,, (empty)
```

The arrow `(x) => x*x` called through the untyped `fn` parameter yields
undefined/empty for every element — the call-through-funcref returns nothing.

### C — method chain on a returned object literal traps

`tests/differential/corpus/closures/08-method-chain.js`

```js
function chain(start) {
  let n = start;
  const api = {
    add(x) {
      n += x;
      return api;
    },
    sub(x) {
      n -= x;
      return api;
    },
    val() {
      return n;
    },
  };
  return api;
}
console.log(chain(10).add(5).sub(2).val()); // V8: 13   js2wasm: runtime: [object WebAssembly.Exception]
```

Dynamic method dispatch on the returned object-literal `api` (with closure
captures over `n`) traps at runtime.

## Repro

```bash
FORCE_COLOR=0 npx tsx scripts/diff-test.ts   # closures/07, 08, 09 (07/09 mismatch, 08 runtime_error)
```

## Root cause (hypothesis)

The untyped/dynamic dispatch path mishandles:

- arrow `this` capture when the enclosing function is invoked via `.call`,
- calling an arrow through an untyped function-typed parameter (funcref call
  returns the wrong/empty value),
- method dispatch + closure-capture on an object literal returned from a
  closure (illegal-cast / WasmGC trap).

These may share one root cause (the `any`-receiver / funcref dynamic-call
substrate) or be three adjacent bugs. Existing #11 (arrow callbacks) and #1382
(wasm-closure not JS-callable bridge) are related and `done`; the corpus shows
the untyped idiomatic forms still break — confirm regression vs current main.

## Acceptance criteria

- `closures/07-arrow-this.js`, `closures/09-callback.js`,
  `closures/08-method-chain.js` all match V8 in `scripts/diff-test.ts`.

## Notes

- Harder (feasibility: hard) — touches the dynamic `any`-receiver / funcref
  dispatch substrate. Lower priority than #2795/#2796 (which are more localized
  coercion/enumeration fixes). May warrant an architect spec before dev work.
