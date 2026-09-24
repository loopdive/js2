---
id: 6673
title: "standalone: lodash `baseMerge` callback reads the enclosing function's local for a captured constructor (`stack-balance invariant: '__cb_7' references local 327`)"
status: ready
sprint: Backlog
created: 2026-09-24
updated: 2026-09-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6661, 6665]
---

# #6673 — lodash standalone compile: captured `Stack` read through the outer local index

## Problem

With the #1474 match/search/split refusals gone
([#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value)),
lodash 4.18.1's npm-compat **standalone-dynamic** lane reports this as its
first error (it was already present behind the refusals — the parent's full
error list carries it too, and #6661 recorded it):

```
Codegen error: stack-balance invariant (entry): '__closure_72' references local 327, but only 3 params + 59 locals are declared (locals: 3:__self_cast, 4:stack, 5:Stack, 6:object, ...
```

(on upstream/main 7d94ea72bf; the closure was named `'__cb_7'` with 61
locals on d772cc772d). The closure is the `baseFor` callback inside `baseMerge` (`lodash.js:3647`):

```js
baseFor(source, function(srcValue, key) {
  stack || (stack = new Stack);
  ...
}, keysIn);
```

`Stack` is a captured binding (the callback's local 5), but the emitted
`new Stack` reads `local.get 327` — the index `Stack` has in the enclosing
`runInContext` function — i.e. the constructor callee was resolved against the
outer function's `localMap` instead of the closure's capture.

## Acceptance criteria

- A reduced fixture (outer function with many locals declaring a constructor,
  an inner callback that `new`s it through a `||` assignment) compiles under
  `--target standalone` and runs like Node.
- lodash's standalone-dynamic lane moves past the stack-balance invariant.
