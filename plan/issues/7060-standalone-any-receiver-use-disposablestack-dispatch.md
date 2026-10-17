---
id: 7060
title: "standalone: `anyValue.use(…)` on an `any` receiver dispatches to `DisposableStack.prototype.use` and throws \"requires a DisposableStack receiver\" instead of calling the object's own `use` property"
status: ready
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: method-calls, builtins
goal: standalone-gap
related: [7019, 7054]
---

# `any`-receiver method calls are captured by a builtin of the same name

Found while reducing [#7019](./7019-standalone-module-init-traps-cjs-graphs.md)
(hono `Hono#use`).

## Repro (standalone, 2026-10-17)

```js
// u.js
export class A { constructor() { this.use = (a1, ...hs) => hs.length; } }
```
```ts
import { A } from "./u.js";
export function t(): number { const a: any = new A(); return a.use("*", 1, 2); }
// TypeError: DisposableStack.prototype.use requires a DisposableStack receiver
```

With a typed receiver (`new A().use(…)`) the call reaches the stored closure
(fixed for rest closures by [#7054](./7054-standalone-callable-property-rest-pack.md)).
With an `any` receiver the method name alone selects the
`DisposableStack.prototype.use` builtin and its brand check rejects the
receiver. A dynamic method call must read the receiver's OWN/inherited `use`
first (§13.3.6 EvaluateCall → GetValue on the property reference) and only
reach a builtin through the receiver's actual prototype chain.

## Implementation Plan (sketch)

Find the name-keyed builtin shortcut that admits `use` for an untyped receiver
(the `DisposableStack` member glue / `__call_m_use_*` dispatcher) and require a
brand test on the receiver before taking it, falling back to the generic
property read + call otherwise. Measure hono (`Hono#use` is called by most of
its test files) and test262 `built-ins/DisposableStack` base vs fix.
