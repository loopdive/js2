---
id: 6854
title: "`o[k]()` traps (`dereferencing a null pointer`) when the typed element is a host callable rather than a compiled closure struct"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: objects, functions
goal: npm-library-support
related: [4526]
---

# Problem

Found while reducing Redux's `store[$$observable]()[$$observable]()` for
[#4526](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4526-redux-runtime-null-deref-illegal-cast-clusters).
Single-file JS repro (measured 2026-10-05, JS host lane):

```js
const key = (() => (typeof Symbol === "function" && Symbol.observable) || "@@observable")();
function make() { return { [key]() { return 7; } }; }
export function t() { return make()[key](); }   // Node: 7 — Wasm: RuntimeError: dereferencing a null pointer
```

`const f = make()[key]; f.call(o)` works, and `typeof make()[key]` is
`"function"`. The literal takes the open-object path (runtime computed key),
so the method value is the host function minted by `__make_getter_callback`.
`compileCallableElementAccessCall` (`src/codegen/expressions/calls-closures.ts`,
single-candidate path) does `any.convert_extern` + a guarded cast to the
closure self type: the cast yields null, `emitNullCheckThrow` only throws when
the ORIGINAL value is also null, and the following `struct.get` on the null
self traps.

# Implementation Plan

1. In the single- and multi-candidate paths of
   `compileCallableElementAccessCall`, when the guarded cast misses on a
   non-null element, fall back to the dynamic host call
   (`__extern_method_call`-style call of the value with the receiver, the
   same tail `compileCallablePropertyCall` uses for non-closure values)
   instead of continuing to `struct.get`.
2. Regression test: the repro above plus a Node-oracle comparison; control:
   the compiled-closure element case still takes the direct `call_ref` (WAT
   assertion that no host call is emitted when the cast hits).

# Related observation (not this issue's root cause)

`bind(add, (x) => x)("Hello")` — an immediate call-of-call on a JS function
whose return is `bindOne(...)` OR an object — throws
`TypeError: class is not a function` on both the base and fixed trees, while
`const b = bind(add, …); b("Hello")` works. Worth its own reduction.
