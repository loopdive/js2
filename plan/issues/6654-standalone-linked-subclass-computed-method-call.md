---
id: 6654
title: "standalone: a computed-key method call on an instance of a subclass of a linked provider class loses the receiver and collapses a spread"
status: in-progress
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/sendev-s72
created: 2026-09-20
# 2026-09-20 (#6654 / #5383 S72): +13 LOC in the dispatch driver — one 5-line
# dispatch arm (a predicate call + the delegation to the existing #6641
# terminal) plus its two explanatory comments, one of which records the
# MEASUREMENT that justifies not adding a twin arm on the resolved-key path.
# The arm cannot live in the leaf: the thing being fixed is the ORDER of the
# arms inside `compileTailDispatch`, so it has to be expressed there. The
# mechanism itself (the predicate) is in `standalone-dynamic-parent-class.ts`.
loc-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
---

# #6654 — `instance[method](...args)` on a subclass of a LINKED provider class

Part of the standalone Temporal provider stack ([#5383](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5383-standalone-temporal-provider)),
slice S72. Standalone/wasi only.

## The rows

Two four-family rows, both red for the same reason:

| row | reported error |
| --- | --- |
| `test/built-ins/Temporal/Duration/prototype/abs/subclassing-ignored.js` | `TypeError: Cannot read properties of undefined (reading a class field)` |
| `test/built-ins/Temporal/ZonedDateTime/prototype/add/subclassing-ignored.js` | `TypeError: invalid receiver: method called with the wrong type of this-object` |

Both enter `temporalHelpers.js::checkSubclassingIgnored`, whose second helper,
`checkSubclassConstructorUndefined`, is the first to use the shape:

```js
class MySubclass extends construct { constructor() { ++called; super(...constructArgs); } }
const instance = new MySubclass();
const result = instance[method](...methodArgs);
```

`construct` is a LINKED PROVIDER class (`Temporal.Duration`), so #6640 makes
`MySubclass` externref-backed with a runtime provider parent: `instance` IS the
carrier the provider's own constructor minted. The FIRST helper,
`checkSubclassConstructorNotObject`, uses `new construct(...)` — a direct
provider instance — and was already correct, which is why the failure surfaces
one helper in.

## Root cause

`MySubclass` is a genuine class declaration in `ctx.classSet`, so
`elemAccessReceiverIsUserClass` (`src/codegen/expressions/calls.ts`) answers
`true` and the user-class arms in `call-tail-dispatch.ts`
(`tryEmitClassDynamicMemberCall` / `tryEmitInlineDynamicCall`) claim the
computed call before the spread-capable, receiver-binding
`tryEmitGenericComputedMethodCall` (#6641) arm can see it. Those arms resolve a
member by CONSUMER-SIDE struct identity, which a provider-minted carrier does
not have, and they are fixed-arity. Two independent wrong answers follow:

1. **the receiver is not bound** — an inherited method that reads an internal
   slot sees `this === undefined` (`abs`; the ZonedDateTime row's message is the
   provider's own brand check reporting the same thing); and
2. **a spread collapses to one argument** — the source array arrives as formal
   zero.

The DOT spelling never had either problem: `instance.abs()` falls through every
specific arm to the link `methodCall` terminal, which resolves through the
provider's prototype chain at run time and binds `this`.

### Reduction (`.tmp/s72/probes/p1.test.ts`, host-free two-module fixture)

Base tree (`bccd46c552`) → fix:

| probe | base | fix |
| --- | --- | --- |
| `i[m](...A2)` on a subclass-of-linked instance | `echo:p,q,undefined:1` | `echo:p,q:2` |
| `i[m]()` where the method reads `this` | `!Cannot read properties of undefined (reading a class field)` | `30` |
| the verbatim `checkSubclassConstructorUndefined` shape | `echo:p,q,undefined:1` | `echo:p,q:2` |
| CONTROL `i.echo("p","q")` (dot) | `echo:p,q:2` | unchanged |
| CONTROL `i.echo(...A2)` (dot + spread) | `echo:p,q:2` | unchanged |
| CONTROL `i.slot()` (dot, reads `this`) | `30` | unchanged |
| CONTROL direct provider instance `i[m](...A2)` | `echo:p,q:2` | unchanged |
| CONTROL `i["echo"](...A2)` / `i["slot"]()` (LITERAL computed key) | already correct | unchanged |
| CONTROL plain LOCAL `class LocalSub extends LocalBase` computed call | unchanged | unchanged |

## The fix

`isLinkedDynamicParentClass` (`src/codegen/standalone-dynamic-parent-class.ts`)
asks the #6640/#6644 registry `ctx.classLinkedDynamicParentExpr` whether the
element-access receiver's class has a linked provider parent. That registry is
populated ONLY in a standalone/wasi link consumer, so the discrimination costs
nothing outside this lane. ONE splice in `call-tail-dispatch.ts` — the
RUNTIME-key element-access dispatch point, immediately before the user-class
arms that mis-claim — routes such a receiver to
`tryEmitGenericComputedMethodCall`, i.e. to the same
`__extern_method_call(recv, key, argv)` terminal the dot spelling reaches, with
#6616's `tryEmitSpreadHostArgs` argv.

Two scope decisions, both measured rather than assumed:

- **NOT gated on a spread being present.** The no-spread case (`instance[m]()`,
  the `abs` row) is broken by the unbound receiver alone.
- **NO twin splice on the statically-resolved-key arm.** `i["echo"](...A2)` →
  `echo:p,q:2` and `i["slot"]()` → `30` on the BASE tree, so that arm's own
  lowering is already correct there; a twin would take over a working lowering
  for no measured gain (the S68 precedent). A comment at that site records the
  measurement so the omission does not read as an oversight.

## Residuals measured, NOT fixed

1. **`Construct.prototype.method.call(inst, …)` through a link answers
   `undefined`** (`.tmp/s72/probes/p1.test.ts` case 4, both trees) — the
   provider's `prototype` object's method READ, a different mechanism.
2. **A computed-key spread call on a plain LOCAL subclass is still wrong**
   (`localComputed('echo', A2)` → `L:p,q,undefined:2` on both trees) — the same
   fixed-arity collapse, in the non-linked user-class arm. General, not
   link-specific; widening that arm is a much larger blast radius and is not
   this slice's.
