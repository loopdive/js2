---
id: 3967
title: "fix(codegen): `this['x'] = v` does not reach a same-named script `var x` — the global object and the var binding are still two stores"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen
goal: core-semantics
created: 2026-08-01
related: [3956, 2726]
---

# #3967 — a global-object element write does not update the same-named `var`

## Problem

A script `var x` IS a property of the global object (§9.1.1.4.15
CreateGlobalVarBinding), so writing `this['x'] = v` must be observable through
the bare `x` read, and vice versa. It is not:

```js
// test/language/statements/variable/S12.2_A11.js (shape)
var __declared__var;
this['__declared__var'] = "baloon";
if (__declared__var !== "baloon") { /* fails: __declared__var === undefined */ }
```

Measured standalone, 2026-08-01 (after #3956): `__declared__var` reads back
`undefined`. The write lands on the native globalThis `$Object`; the read
resolves to the Wasm module global that backs the `var`. Two stores, one name.

## Why #3956 does not cover this

#3956 fixed the case where the name has **no** other binding: the write now
reaches `__module_init` and the read routes through `emitImplicitGlobalRead`
against the same global object. Here the name **does** have a binding — a
module global — which correctly wins at the read site
(`src/codegen/expressions/identifiers.ts`, module-globals branch precedes the
implicit-global branch). That precedence is right; what is missing is that the
two stores are not aliased.

`ctx.globalObjectVarBindings` (populated by `recordScriptVarBindingNames`)
already records exactly the set of names in this situation, and
`isNonConfigurableGlobalObjectDelete` already consults it for `delete`, so the
information needed to alias them is present.

## Options

1. Mirror on write: a `globalThis`/`this`-rooted write whose key is in
   `globalObjectVarBindings` also writes the module global (and the reverse for
   a `var` write). Cheap, but two stores can still drift via a dynamic key.
2. Single store: back a script `var` with the global-object property itself
   when the module contains any global-object write at all. Slower for the
   common case; correct by construction.

Option 1 is the smaller first slice; sizing needs the population count.

## Scope

Found while measuring #3956; kept out of that PR so its +37 / −0 stayed
attributable.

## Acceptance criteria

- [ ] `var x; this['x'] = 1; x === 1` holds in both lanes
- [ ] `var x = 1; this.x === 1` holds in both lanes
- [ ] A/B measured over the affected population with denominators, both directions
