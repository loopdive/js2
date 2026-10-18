---
id: 7060
title: "standalone: `anyValue.use(…)` on an `any` receiver dispatches to `DisposableStack.prototype.use` and throws \"requires a DisposableStack receiver\" instead of calling the object's own `use` property"
status: done
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
sprint: current
created: 2026-10-17
updated: 2026-10-18
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: method-calls, builtins
goal: standalone-gap
related: [7019, 7054]
loc-budget-allow:
  # 2026-10-18 (#7060) calls-closures.ts +9: the import and the guarded call into
  #   the new expressions/disposable-any-receiver-two-arm.ts.
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  # 2026-10-18 (#7060) +8: the guarded two-arm call before the existing shortcut.
  - src/codegen/expressions/calls-closures.ts::tryExternClassMethodOnAny
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

## Original plan sketch (wave 16)

Find the name-keyed builtin shortcut that admits `use` for an untyped receiver
(the `DisposableStack` member glue / `__call_m_use_*` dispatcher) and require a
brand test on the receiver before taking it, falling back to the generic
property read + call otherwise. Measure hono (`Hono#use` is called by most of
its test files) and test262 `built-ins/DisposableStack` base vs fix.

## Implementation Plan

The shortcut is in `tryExternClassMethodOnAny` (`calls-closures.ts`): under
`nativeStrings` every `dispose/defer/adopt/use` on an `any` receiver went to
`tryCompileNativeDisposableStackAnyMethodCall`, whose brand miss throws the
RequireInternalSlot TypeError. The #3033/#5241 "the program declares this
member" refusals miss `this.use = …` assigned in another module.

Fix with a two-arm branch on the brand (precedent: `tryEmitProtoOverrideTwoArm`):
`ref.test $DisposableStack(recv)` ? native DisposableStack method : the whole
call re-dispatched with the shortcut suppressed (re-entry WeakSet), which runs
the ordinary closed-struct / `$Object` dispatch. Re-dispatch recompiles the
receiver, so only identifier / `this` receivers take the two-arm; other
receivers keep the existing lowering. New leaf:
`src/codegen/expressions/disposable-any-receiver-two-arm.ts`.

## Resolution

Implemented as planned. `a.use("*", 1, 2)` on an `A` instance held in `any`
answers the stored closure's result; real DisposableStack receivers still take
the native arm (`defer`/`use`/`adopt`/`dispose` controls in the regression
test). Host lane untouched (`noJsHost` gate).

Not covered (recorded): a real DisposableStack receiver in a module that ALSO
declares a function member of the same name still hits the older #3033
refusal and throws "called value is not a function" (pre-existing; the
two-arm would allow relaxing that refusal for these four names).
