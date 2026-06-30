---
id: 2876
title: "Standalone: RegExp cluster (125 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 682, 2885]
umbrella: 2860
blocked_on: 2885
---

> **Blocked on #2885** (standalone descriptor-reflection core). ~70 of the 125
> fail via `Object.getOwnPropertyDescriptor(RegExp.prototype, <accessor>)` →
> undefined → `.get` deref TypeError — the builtin-proto intrinsic-accessor
> reflection defect specced in #2885. Land #2885's core (PR1+PR2) first.

# Standalone: RegExp.\* failures (de-masked)

## Problem

~**125** `built-ins/RegExp/**` tests are host-pass but standalone-fail, de-masked
by #2870 from the phantom ToPrimitive signature (#2862).

## Representative repro

```js
// test/built-ins/RegExp/prototype/global/this-val-regexp-prototype.js
var get = Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get;
assert.sameValue(get.call(RegExp.prototype), undefined);
```

`getOwnPropertyDescriptor(RegExp.prototype, 'global').get` → getter-reflection on
`RegExp.prototype` accessor members; standalone throws a Wasm exception.

## Root cause (to triage)

Standalone RegExp reflection (`.source`/`.flags`/`.global`/`.sticky`/… getters)
over `RegExp.prototype` is the established #1914 surface; the accessor-descriptor
`.get` reflection + brand-checked invocation on the prototype object is not fully
materialised standalone. Overlaps the dual RegExp backend (#682) and native-proto
glue. Triage with `runTest262File(file, cat, undefined, "standalone")`.

## Test plan

Standalone fail → pass, verify-first, full `merge_group` + standalone high-water.
`ctx.standalone` only.
