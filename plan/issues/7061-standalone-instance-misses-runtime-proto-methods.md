---
id: 7061
title: "standalone: an instance of class `C` does not see methods installed on `C.prototype` at runtime (`Object.defineProperty(C.prototype, 'getX', …)`) — axios `AxiosHeaders` accessor methods (`getContentType`, …)"
status: ready
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: classes, prototypes
goal: standalone-gap
related: [7019, 7053, 3976]
---

# Runtime-installed prototype methods are invisible to class instances

Found while reducing [#7019](./7019-standalone-module-init-traps-cjs-graphs.md)
after [#7053](./7053-standalone-class-proto-binding-slot.md) made
`AxiosHeaders.accessor([...])` initialise.

## Repro (standalone, 2026-10-17)

```js
// u.js
class H {
  get(x) { return x; }
  static add(n) { Object.defineProperty(this.prototype, "get" + n, { value() { return 7; }, configurable: true }); }
}
export default H;
```
```ts
import H from "./u.js";
export function onProto(): number { H.add("E"); const p: any = H.prototype; return typeof p.getE === "function" ? 1 : 0; } // 1 (ok)
export function onInstance(): number { H.add("E"); const h: any = new H(); return typeof h.getE === "function" ? 1 : 0; } // 0, expected 1
```

The prototype `$Object` (#3976) receives the property, but a member read on a
`$H` instance struct resolves only declared fields/methods and never consults
the class prototype object for a runtime key. axios builds
`getContentType`/`setContentType`/`hasContentType`… this way and its
`AxiosHeaders` tests call them on instances.

## Implementation Plan (sketch)

On a miss of a closed-struct instance member read (and the matching call
path), fall through to the class prototype `$Object`'s `[[Get]]` (the same
chain `Object.getPrototypeOf(instance)` already answers) before reporting
`undefined`. Measure axios `axiosHeaders.test.js` once it is admitted, and
test262 `language/statements/class` base vs fix.
