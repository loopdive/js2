---
id: 3432
title: "Top-level function-declaration closures stored in array literals read back host-non-callable inside nested functions (testTypedArray harness, ~1.8k tests)"
status: ready
created: 2026-07-18
priority: high
feasibility: hard
task_type: bugfix
area: codegen-closures
goal: test262-conformance
model: fable
sprint: current
horizon: m
related: [3419, 3417, 3370]
---

# #3432 — `argFactory.bind` non-callable: declaration-closures in arrays lose host callability

## Problem

With #3419 landed (duplicate-`isPrimitive` early error fixed, var-counter i32
gate, sandbox TypedArray globals), the former 2,050-test `Duplicate identifier`
bucket now executes and dies overwhelmingly (34/40 of a deterministic sample) at:

```
TypeError: Function.prototype.bind called on non-callable
  in testWithAllTypedArrayConstructors() at testTypedArray.js:269
  var boundArgFactory = argFactory.bind(undefined, constructor);
```

## Verified reduction (2026-07-18, fable-5)

Per-element probe over `typedArrayCtorArgFactories`
(`[makePassthrough, makeArray, makeArrayLike]` + pushes) read **inside a nested
function** through an alias (`var ctorArgFactories = typedArrayCtorArgFactories`):

```
k0:ERR k1:ERR k2:ERR k3:ok(function) k4:ERR k5:ERR k6:ERR k7:ERR
```

- k0-2 (`makePassthrough/makeArray/makeArrayLike`) — top-level **function
  declarations** referenced in the array literal → `.bind` throws non-callable.
- k3 (`makeIterable`) — **function expression** assigned to a var, `.push`ed →
  `.bind` works.
- k4 (`makeArrayBuffer`) — declaration, `.push`ed → ERR. k5-7 — expressions
  assigned inside an `if` block → ERR (so expression-vs-declaration is not the
  whole story; k3 vs k5-7 differ in… TBD — k3 is guarded by `typeof Symbol`,
  k5-7 by `ArrayBuffer.prototype.resize` and close over `copyIntoArrayBuffer`).
- Reading the SAME array at **top level** (module init): every element's
  `typeof` is "function" and `.bind` works (fake-bind4 probe passed).
- Minimal shapes (`function add(){}; var fs=[add]; fs[0].bind(undefined,2)`)
  pass — the loss needs the nested-function + aliased-read context.

`typeof argFactory === "function"` SUCCEEDS on the same value whose `.bind`
throws — so the wrapper is recognized by `__typeof` but the host
`__extern_method_call(recv, "bind", …)` receiver is not a callable bridge
(likely the raw closure-struct wrapper instead of a `_wrapForHost` function
bridge). Suspect the dynamic element-read path inside a function returns the
un-bridged element, while the top-level read path (or the store path used by
`.push` from a var holding an already-bridged closure) preserves callability.

Repro probes (copy into `.tmp/`): see #3419's `## Follow-up filed` section;
probe files `fake-bind5.js` / `fake-bind6.js` shapes are embedded there.

## Value

~1,800 tests (the residual of the 2,050 bucket) in `built-ins/TypedArray*` —
the single largest post-#3419 recovery lever in the host lane.

## Suggested starting points

- Host bridge: `_wrapForHost` / `__make_callback` / wasmClosureDynamicBridge in
  `src/runtime.ts` — what does `__extern_method_call` receive for a closure
  element read out of a wasm vec via the externref path?
- Codegen: array-literal element store for identifier references to top-level
  function declarations (closure materialization — does it store the raw
  closure struct where the dynamic read path expects a host-bridged value?).
- Compare the top-level read path (works) vs nested-function aliased read
  (fails) to find where the bridging diverges.
