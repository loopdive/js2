---
id: 7061
title: "standalone: an instance of class `C` does not see methods installed on `C.prototype` at runtime (`Object.defineProperty(C.prototype, 'getX', …)`) — axios `AxiosHeaders` accessor methods (`getContentType`, …)"
status: done
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
sprint: current
created: 2026-10-17
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: classes, prototypes
goal: standalone-gap
related: [7019, 7053, 3976]
loc-budget-allow:
  # 2026-10-18 (#7061) object-ops.ts +14: the method-shorthand `value` reroute in
  #   `compileObjectDefineProperty`'s standalone block; property-access-dispatch.ts
  #   +3: import + two demand-record calls (logic in classes/runtime-proto-install-demand.ts).
  - src/codegen/object-ops.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  # 2026-10-18 (#7061) the shorthand-`value` reroute (+14) and one demand call (+1).
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
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

## Original plan sketch (wave 16)

On a miss of a closed-struct instance member read (and the matching call
path), fall through to the class prototype `$Object`'s `[[Get]]` (the same
chain `Object.getPrototypeOf(instance)` already answers) before reporting
`undefined`. Measure axios `axiosHeaders.test.js` once it is admitted, and
test262 `language/statements/class` base vs fix.

## Implementation Plan

Two defects, measured separately:

1. **Demand.** The instance miss is served by `__class_proto_lookup`, whose
   arm per class exists only when `ctx.standaloneRuntimeKeyClassProtos` holds
   the class (#5383 S2h). Runtime-KEY reads record that demand; a
   statically-named `h.getE` does not — the probe answered correctly as soon
   as an unrelated `o[k]` appeared in the module. Record the demand where the
   program MUTATES the prototype: a static `C.prototype` / `this.prototype`
   (static method) read that is the base of an assignment target or the first
   argument of `Object.defineProperty/defineProperties/assign`,
   `Reflect.defineProperty/set`. Per class (ancestors + descendants via
   `recordStandaloneRuntimeKeyClassMemberRead`). New leaf
   `src/codegen/classes/runtime-proto-install-demand.ts`, two call lines in
   `property-access-dispatch.ts`.
2. **Method-shorthand descriptor value.** `Object.defineProperty(o, k, {
   value() {…} })` stored `undefined`: the inline literal fast paths read
   `value` only from a `PropertyAssignment`. On standalone, route such a
   literal through `emitDefinePropertyDescRuntime` (the route an
   identifier-bound descriptor already takes and that answers correctly).

## Resolution

Both implemented. The issue's repro (`H.add("E")`, then `typeof new H().getE`)
answers `function`; `h.getF()` answers 7; `K.prototype.zz = fn` inside a
function is visible to instances; a shorthand descriptor keeps its default
attributes (`writable/enumerable false`, `configurable` as given).

Not covered (recorded): a prototype aliased first (`const p = C.prototype;
Object.defineProperty(p, …)`) does not record the demand.
