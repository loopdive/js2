---
id: 2984
title: "Standalone gOPD-on-builtin descriptor MOP (~178: getOwnPropertyDescriptor on builtin objects / proto receivers)"
status: ready
sprint: current
priority: high
horizon: xl
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2861, 2863, 2896, 2949, 2989]
origin: "#2965 descriptor-cluster triage — follow-up class 1"
---

# #2984 — standalone gOPD-on-builtin descriptor MOP

## Problem

Follow-up from #2965 (descriptor cluster). `getOwnPropertyDescriptor` on a
builtin object or a builtin **prototype/constructor** receiver has no
meta-object protocol on the standalone lane, so the dynamic
`__getOwnPropertyDescriptor` native either returns `undefined` or hard-CEs.
Subsequent `.value`/attribute reads then throw or the compile fails outright.
~178 tests across the descriptor cluster hinge on this. It is the substrate
gap that **co-blocks #2989** (dynamic-descriptor `defineProperty` spec
TypeErrors landed there, but the reachable test262 assertions that would flip
run gOPD-readback first, so #2989 measures net-0 until this lands).

This is design-only — no implementation in this issue. It is a **spec seed**
to size the work and record why the existing machinery does not extend.

## The three substrate sub-problems

The ~178 failures decompose into three distinct substrate buckets, each with
its own root cause. They are NOT one fix.

### (1) Proto-receiver reification (~124 tests) — the big rock

`Object.getOwnPropertyDescriptor(Array.prototype, "forEach")` compiles
**host-free** (no CE) but returns `undefined` instead of a real data
descriptor. Root cause: **builtin methods are not first-class values in
standalone mode.** `Array.prototype.forEach` is synthesized inline at each
call site (or dispatched through a receiver-typed lowering); there is no
reified `Array.prototype` object carrying a property table, and no reified
function value to place in the descriptor's `.value` slot. The dynamic
`__getOwnPropertyDescriptor` native walks the open-object runtime's own
property table, finds nothing for a synthetic proto receiver, and returns
`undefined`. Spec attributes for a builtin method are `{ writable: true,
enumerable: false, configurable: true, value: <the method fn> }`; we can
answer the three boolean attributes from a static table, but the `.value`
slot requires a **real function value** for the builtin method — which the
standalone lane does not currently materialise.

### (2) Builtin-ctor-as-receiver (~63 tests) — hard CE

`Object.getOwnPropertyDescriptor(Array, "isArray")` **hard-CEs** with
`"__get_builtin not yet supported"`. Root cause: **builtin constructors are
not resolvable dynamic-shape receivers.** In standalone mode `__get_builtin`
refuses-loud (the open-object runtime does not expose it — see
`src/codegen/property-access.ts` ~L3943), so a constructor used as a _dynamic_
gOPD receiver reaches the `__get_builtin` shortcut with no static-constant
folding available and emits the located refusal instead of a descriptor.
Static member reads like `Array.isArray(x)` already resolve (constant
emitter), but the _reflective_ `gOPD(Array, "isArray")` form has no path.

Buckets (1) and (2) overlap: both need a reified builtin object (the
`.prototype` object in (1), the constructor object in (2)) that owns a
queryable property table whose entries can yield real descriptors.

### (3) Plain-object accessor-descriptor readback (~29 tests) — separate deferred substrate

A smaller bucket: `gOPD` on a **plain user object** with an accessor
(get/set) property returns a data descriptor or drops the accessor, because
the descriptor-readback path does not round-trip `get`/`set` function slots.
Root cause is distinct from (1)/(2) — it is an accessor-descriptor
representation gap in the open-object runtime (get/set closures + `call_ref`
to invoke them on read), not a builtin-MOP gap. **Track/deliver separately**;
it is deferred substrate of its own and should not be folded into the builtin
MOP work.

## Why `__builtinfn_gopd` does not extend to this

The existing `__builtinfn_gopd` machinery (introduced by #2861/#2863/#2896,
registered in `src/codegen/object-runtime.ts` ~L499) answers gOPD **only for
`name` / `length` on a builtin FUNCTION closure value** — i.e. when the
_receiver itself_ is already a first-class builtin function value and the key
is one of its own two metadata properties. It returns a fixed data descriptor
(`{ writable:false, enumerable:false, configurable:true }`) or null.

It does not extend to #2984 because:

- Its receiver is a **builtin function value**, not an `X.prototype` object
  or a constructor object. In (1)/(2) the receiver is a _namespace/proto_
  object that is not reified at all — there is nothing for `__builtinfn_gopd`
  to key off.
- It only knows two keys (`name`, `length`). The proto-receiver case needs to
  answer **every builtin method name** owned by that prototype, with a
  `.value` slot that is a real function value — a fundamentally larger table.
- Its `.value`-less fixed descriptor is exactly what falls short: the spec
  descriptor for a builtin method **must carry the method as `.value`**, which
  is the piece the standalone lane cannot currently produce.

So the fix is not a widening of `__builtinfn_gopd`'s key set; it needs a
builtin **object** meta-object protocol sitting a layer up, plus first-class
reification of the method values it points at.

## Rough shape of a real fix

Design sketch only (sizing, not a spec):

1. **Reify builtin prototype/constructor objects** as queryable meta-objects
   on the standalone lane — a per-builtin static descriptor table keyed by
   property name, produced at codegen time (Array.prototype → {forEach, map,
   filter, …}; Array → {isArray, from, of, …}). This is the shared
   prerequisite for buckets (1) and (2).
2. **Materialise builtin method values as first-class function values** so a
   descriptor's `.value` slot can hold the actual method (funcref/closure),
   not just its metadata. This is the heavy part — it touches how builtin
   methods are lowered (inline-at-callsite today) and interacts with the
   value-representation substrate.
3. **Route dynamic `gOPD(receiver, key)`** so a builtin-object receiver is
   recognised (not sent to the refusing `__get_builtin` shortcut) and
   dispatched into the meta-object table, building a full data descriptor
   ({value, writable, enumerable, configurable}) from the static entry.
4. Keep the host/gc lane **byte-inert** (gated on `ctx.standalone`, same
   reserve/fill discipline as the existing natives so late-import funcIdx
   shifts stay invariant).
5. Bucket (3) — accessor readback on plain objects — is a **separate**
   deliverable (get/set closure round-trip + `call_ref`), split out.

## Related representation-family work (same D1-disease class)

This is the **D1 "type-erased value representation"** disease class per the
June audit (`plan/log/analysis-2026-06/00-program-overview.md`): lowering
picks representation from the Wasm ValType rather than the JS type, so builtin
methods never become first-class JS values that a descriptor can point at.
Cross-reference **#2949** (IR dynamic value representation — a JsTag-carrying
`dynamic` kind in `IrType` to make untyped JS claimable): the ability to hold
a builtin method as a first-class tagged value is the same
representation-family capability #2949 is building. #2984's method-value
reification (step 2 above) should be designed to sit on top of #2949's
`dynamic`-kind substrate rather than inventing a parallel boxing scheme —
otherwise it re-breeds the D4 "duplicated representation" drift the audit
warns about.

## Acceptance

- gOPD on builtin proto/ctor receivers returns spec-correct descriptors
  (including a real `.value`) on the standalone lane; host/gc lane unchanged
  (byte-inert).
- Buckets (1) and (2) measured on the `built-ins/*/getOwnPropertyDescriptor`
  and `built-ins/Object/getOwnPropertyDescriptor` standalone subsets with zero
  regressions on a passing-test sweep.
- Bucket (3) split into its own follow-up (accessor-descriptor readback).
- Once landed, re-measure #2989 — its dynamic-descriptor TypeError assertions
  should become reachable and flip.
