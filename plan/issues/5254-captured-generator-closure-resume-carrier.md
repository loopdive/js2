---
id: 5254
title: "Standalone: captured native generator state loses its resume carrier through a getter-returned closure"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
task_type: conformance
area: codegen, generators, closures
es_edition: ES2015
goal: standalone-gap
created: 2026-09-01
origin: "#3591 diagnostic Test262 cohort"
related: [3591, 5255]
---

# #5254 — captured generator state does not retain its native resume carrier

## Problem

The standalone rows
`built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js` and
`built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`
fail with `Generator.prototype.next requires that 'this' be a Generator`.
Both create a native `g()` iterator inside a `next` getter, capture it as
`n`, and return a closure that later invokes `n.next()`:

```js
get next() {
  let n = g();
  return function () {
    return n.next();
  };
}
```

This is not the #3591 module-init stale dispatcher. Its final native-state arm
exists, but the captured native state crosses the closure carrier as an opaque
value and reaches the resume ladder without the state brand required by the
native arm. The outer `chunks()` / `windows()` lazy iterator is only the path
that exposes the inner closure call.

## Direction

First trace the exact capture storage, closure invocation result, and opaque
resume receiver boundary. Preserve the native state identity through that
boundary (or recover it with a narrowly typed carrier) before changing generic
iterator dispatch. Do not widen #3591's `__any_iter_next` fallback or alter the
finalized stale-dispatch ladder without a reduced repro proving it is involved.

## Acceptance criteria

- A focused standalone regression captures `const n = g()` in a returned
  closure and proves `n.next()` retains native generator identity.
- Both exact `chunks` and `windows` exhaustion rows pass through the isolated
  standalone runner.
- #3591's forced module-init-pass-2 `.next()` / `.return()` / `.throw()` case,
  its no-`env` import assertion, and generator carrier controls stay green.

## Handoff evidence

On #3591's final diagnostic rerun, the isolated seven-row list was **4 pass,
3 fail**. These two rows failed at line 26 with the native
GeneratorValidate `TypeError`; they are now owned here. The third diagnostic
row is separate dynamic-`this`/property-call work in #5255.
