---
id: 6464
title: "standalone: an `Object.create(C.prototype)` instance handed across the module link answers `null` for every accessor and method read — the Temporal polyfill builds every `X.from(…)` result this way, so all five `from` constructors return objects whose `.day`/`.equals`/`String()` are `null`"
status: in-progress
assignee: ttraenkler/dev-5383-s13
sprint: current
priority: high
horizon: m
parent: 5383
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
---

# standalone: `Object.create(proto)` instances do not survive the module link

## Problem

On `--target standalone` with the compiled `@js-temporal/polyfill` linked in as a
provider module (#5383), every `Temporal.X.from(…)` hands back an object whose
accessor and method reads answer `null`:

```js
Temporal.PlainDate.from("1976-11-18").day        // null   (expected 18)
String(Temporal.PlainDate.from("1976-11-18"))    // null
Temporal.ZonedDateTime.from(…).equals            // undefined
```

while the control built with `new` answers correctly:

```js
new Temporal.PlainDate(1976, 11, 18).day         // 18
```

The polyfill does not use `new` for `from`: it builds results with
`Object.create(intrinsic.prototype)` plus WeakMap slot writes (bundle symbol
`pn`, ~L1946 of `linkPolyfillSource(setupTemporalPolyfill()).source`).

S12 measured the same shape **inside one module** and it answers correctly, so
this is a cross-module (link-boundary) defect, not a module-local one.

S12 attributed ~40 of the 360 rows in the three-family sample to this residual.

## Implementation Plan

(written after the census — see `## Census` below)
