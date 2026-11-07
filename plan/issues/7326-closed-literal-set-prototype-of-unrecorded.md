---
id: 7326
title: "Standalone: `Object.setPrototypeOf` on a function-local closed struct literal is not recorded"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: runtime
goal: core-semantics
related: [7304, 7319]
---

# #7326: `setPrototypeOf` on a closed struct literal is ignored

## Problem

On standalone, a function-local object literal such as `var q = { x: 1 }` is a
closed struct, not an `$Object`. `Object.setPrototypeOf(q, proto)` leaves no
trace on it: not in `$proto`, not in the closed-object prototype edges. So `in`,
reads and the prototype chain all ignore the new prototype.

A second, related gap: `__object_proto_singleton` is reserve-then-fill. It
keeps its `ref.null.extern` body unless the module materialises the Object
`$NativeProto`. So `Object.getPrototypeOf({x:1})` answers `null` in such a
module even though no `setPrototypeOf` ran. That makes `getPrototypeOf` unusable
as a terminal oracle for runtime helpers.

## Repro (`--target standalone`, main `b631a4bc`, vs node)

```js
function h(p, k) { return k in p; }
function g(p) { return p.y; }
var q = (function () { var q = { x: 1 }; Object.setPrototypeOf(q, { y: 2 }); return q; })();
// node: h(q, "y") === true, g(q) === 2
// standalone: false, undefined

var r = (function () { var q = { x: 1 }; return q; })();
// node: Object.getPrototypeOf(r) === Object.prototype
// standalone (module that never reads Object.prototype): null
```

`{}` (empty literal), a literal that later gains a key, and module-level
literals are `$Object`s and record the change correctly. Only the closed
function-local literal is affected.

## Why it matters

#7304 can answer `"toString" in q` exactly for every receiver family except
this one. For a closed literal it cannot tell `setPrototypeOf(q, null)` from an
ordinary `{x:1}`, so it keeps each caller's base answer (legacy 1, IR 0). Making
those rows exact needs this issue first.

## Direction

Record the prototype of a closed struct when `setPrototypeOf` targets it. The
closed-object prototype edges (`closed-object-prototype-edges.ts`) already
model a replaced prototype for closed objects; find why this literal does not
reach them. A closed literal that may be the target of `setPrototypeOf` could
also be promoted to `$Object`. Then let the `in` helpers'
`fillInHelperBuiltinTerminal` ask that record.
