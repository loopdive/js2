---
id: 6679
title: "fixups: a `return_call`'s ref-null retype walks backwards across `global.set` and turns the bare-call receiver reset into a struct null (lodash `baseUpdate` invalid Wasm)"
status: ready
sprint: Backlog
created: 2026-09-24
updated: 2026-09-24
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6673, 4077]
---

# #6679 — `return_call` args fall back to the legacy backward walk and mis-pair `ref.null.extern`

## Problem

With [#6673](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6673-standalone-lodash-closure-capture-stack-balance)
fixed, lodash 4.18.1's npm-compat **standalone-dynamic** lane compiles through
codegen and now fails Wasm validation (first error):

```
wasm-opt -O4 failed: [wasm-validator error in function baseUpdate] global.set value must have right type, on
(global.set $global$616
 (ref.null none)
)
```

V8 says the same on the unoptimized binary:
`Compiling function #867:"baseUpdate" failed: global.set[0] expected type externref, found ref.null of type (ref null 427)`.

`baseUpdate` is `return baseSet(object, path, updater(baseGet(object, path)), customizer);`.
The bare call `updater(...)` is wrapped by `emitBareCallReceiverReset`
(`global.get $__current_this; local.set prev; ref.null.extern; global.set $__current_this; …; local.get prev; global.set $__current_this`),
and the whole thing is an argument of the tail call `return_call $baseSet`.

`fixups.ts` retypes `ref.null.extern` call args to `ref.null $T` when the
param is a ref type. The exact forward model (`locateCallArgProducers`,
#4077) refuses `return_call` (it is a terminator in `instrPopsPushes`), so
every tail call uses the legacy backward walk, which counts `global.set` as an
argument producer; the pairing shifts and the receiver-reset
`ref.null.extern` is rewritten to `ref.null 427` (a ref-cell type).

## Fix (prototyped, verified on lodash)

In `locateOperandProducers` (`src/codegen/call-arg-producers.ts`), record a
`return_call`'s operands from its callee type (`callTargetFuncType`) and then
stop. With that change lodash's `baseUpdate` validates and the lane moves on to
[#6680](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6680-lodash-pullat-basepullat-extra-stack-value).
`cross-hierarchy-operands.ts`'s `requiredOperandTypes` already handles
`return_call`, so it picks up the new entries too — measure JS-host bytes
(fixups are shared) and add a reduced `return f(a, g(b))`-with-bare-call test.

## Acceptance criteria

- A reduced fixture (tail call whose argument is a bare call of a parameter,
  callee has a ref-typed param) validates in both lanes.
- lodash's standalone-dynamic lane moves past the `baseUpdate` validator error.
