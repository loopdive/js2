---
id: 6903
title: "Dynamic `fn.name` on a compiled function reads undefined on the host lane (hono dev helper 5/8)"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
related: [4437, 4616]
---

## Problem

hono `src/helper/dev/index.test.ts` is 5/8: `inspectRoutes`/`showRoutes`
print `[middleware]` / `[handler]` where upstream prints `namedMiddleware` /
`namedHandler`, because

```js
var handlerName = (handler) => handler.name || (isMiddleware(handler) ? "[middleware]" : "[handler]");
```

reads `.name` through an untyped parameter. Measured 2026-10-07 on upstream
main (`e7760d1c2a`), JS-host lane, through the upstream shim:

| shape | `getName(f)` with `const getName = (h) => h.name` |
| --- | --- |
| `function foo() {}` | `undefined` (expected `"foo"`) |
| `const bar = function () {}` | `undefined` (expected `"bar"`) |
| `const baz = (a) => a` | `undefined` (expected `"baz"`) |
| `getLen(baz)` (`h.length`) | `1` — correct |
| `baz.name` (static) | `"baz"` — correct |

The static read folds at compile time; the dynamic read reaches the host
`__extern_get` with a closure struct whose sidecar has no `name`. #4616 stamps
`name` into the sidecar only for NAMED function expressions; declarations and
NamedEvaluation (`const x = () => …`, §8.4.5) get nothing. #4437's
`$__fn_instance_meta` slot is the carrier designed for this.

## Implementation Plan

1. Route the dynamic `name` read through the #4437 metadata carrier where a
   closure has one (`__builtinfn_get_meta`-style export the runtime can probe
   from `__extern_get` for closure structs), instead of a per-creation
   `__extern_set` sidecar stamp — the stamp costs a host call per closure
   creation, which the dom benchmarks cannot afford.
2. Populate the metadata name for function declarations and for NamedEvaluation
   (`const`/`let`/`var` initializer, property assignment, default export).
3. Regression: the table above as a two-file untyped fixture, with the static
   read and `.length` as controls. Expected: hono dev 5/8 → 8/8.
