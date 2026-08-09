---
id: 2747
title: "for-in: constructor-function prototype-chain enumeration (S12.6.4_A6*) + Object.defineProperty array+accessor ordering"
status: ready
sprint: current
goal: es5
feasibility: hard
depends_on: []
priority: high
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-27
updated: 2026-06-27
parent: 2739
related: [1712, 2660, 2706, 2731]
---
# #2747 — for-in fnctor prototype chain (b) + defineProperty array order (c)

**Carved from #2739** (dev2, 2026-06-27). #2739 PR landed the **setPrototypeOf**
half (a): `Object.setPrototypeOf(struct, proto)` now records a `_wasmStructProto`
link (host import `__host_set_struct_proto`) and the for-in walk advances through
`_structUserProto`. This issue is the remaining two halves, both carved because
they carry **regression risk against the load-bearing #1712 acorn prototype-method
machinery** and need careful, floor-validated work.

## (b) Constructor-function prototype chain — `S12.6.4_A6.js`, `S12.6.4_A6.1.js`

```js
function FACTORY(){ this.prop=1; this.hint="hinted"; }
FACTORY.prototype = { feat:2, hint:"protohint" };
var __instance = new FACTORY;
for (key in __instance) __accum += key + __instance[key];
// must include prop1, feat2, hinthinted (own `hint` shadows proto `hint`)
```

Verified-first (current main, after #2739 part a): for-in over `__instance`
enumerates **nothing** (and `__instance["feat"]` reads `undefined`). Root cause
(architect-verified, #2739 plan): `new FACTORY` builds a `$__fnctor_FACTORY`
struct whose `__register_fnctor_instance` (#1712 instance→ctor link) fires **only
when the fnctor has a closure global** (`ctorGlobalIdx` defined). A fnctor that is
only `new`'d (never used as a value) has no closure global, so neither the
instance→ctor link nor the host-mode `FACTORY.prototype = {…}` write happens (the
host fall-through `__extern_set($closure,"prototype",…)` misses `ref.test $Object`
and drops). The `FACTORY.prototype` object and the `new FACTORY` instance never
rendezvous on a shared identity.

### Why carved — the #1712 collision risk (dev2 verify-first finding)

The two tractable fixes both risk the #1712 acorn surface:

1. **Force the closure global for every `new`'d fnctor** (architect's preferred):
   so `__register_fnctor_instance` fires and `F.prototype=` writes the closure
   sidecar uniformly. BUT the prototype-assign (`F.prototype = {…}`) compiles
   BEFORE the construct (`new F`) in source order, so the global must be minted at
   FUNCTION-DECLARATION time for both sites to share it — a change on the hot
   function-decl path.
2. **Reuse `_wasmStructProto` + a per-fnctor proto global** (rendezvous): have
   `_structUserProto` / `_fnctorProtoLookup` ALSO consult `_wasmStructProto` for
   fnctor instances. BUT routing host `F.prototype = {…}` to the proto global (away
   from the `__extern_set($closure,"prototype")` path) **breaks #1712's read path**
   (`_fnctorProtoLookup` → `_sidecarGet(ctor,"prototype")`) for acorn's
   closure-global fnctors unless reads are migrated to the same source — a
   two-channel divergence. Also, having `_structUserProto` consult the
   `_fnctorInstanceCtor` link changes for-in output for **existing** #1712 fnctor
   instances (acorn Parser), which must be validated against the acorn prototype-
   method tests.

So (b) needs a coherent single-prototype-source design across construction,
`F.prototype=` write, for-in walk, AND the #1712 read path — architect/senior-dev
scope with full `merge_group` floor + acorn-dogfood validation. Do NOT ship a
half-measure that diverges the two channels.

## (c) `Object.defineProperty` array+accessor ordering — `order-after-define-property.js`

Architect-verified split (#2739 plan): assert #1 (plain object) ALREADY PASSES.
Only assert #2 — `defineProperty(arr,"a",{get,enumerable,configurable}); arr.b=2;`
redefine `a` → `["a","b"]` — fails, and **only in the full-harness
`runTest262File` run** (an isolated `compile()` probe of the array snippet returns
the correct `["a","b"]`). A full-program-compilation interaction (array vec +
accessor-descriptor sidecar for-in under assert.js), NOT the prototype-link
defect. MUST reproduce via `runTest262File(".../order-after-define-property.js")`.

## (d) Reflect.setPrototypeOf / `o.__proto__ = v` mirrors (deferred from #2739 part a)

#2739 part a wired only `Object.setPrototypeOf` (the gc/host arm at
`calls.ts`) to `__host_set_struct_proto`. The same one-line treatment should
mirror to **`Reflect.setPrototypeOf`** (`calls.ts` ~7593) and the
**`o.__proto__ = v`** write path (assignment.ts) so all three record the
`_wasmStructProto` link. Low-risk (same import); folded here to keep the
setPrototypeOf capability complete.


### (d) — LANDED (carve-out PR, 2026-06-27)

Routed both sinks through the same `__host_set_struct_proto` channel the
Object.setPrototypeOf gc/host arm uses:
- **`Reflect.setPrototypeOf(o, p)`** (host arm, `calls.ts`): now calls BOTH
  `__host_set_struct_proto` (populates `_wasmStructProto` for the for-in walk via
  `_structUserProto`) AND the existing `__reflect_setPrototypeOf` (preserves the
  host-wrapper `Reflect.getPrototypeOf` round-trip, incl. a non-weak-key-able
  empty `{}` target — keeps #1466 green). The standalone Reflect arm already
  routed to `__object_setPrototypeOf` (untouched).
- **`o.__proto__ = v`** (assignment.ts `compilePropertyAssignment`): intercepted
  as the §B.2.2.1 `Object.prototype.__proto__` setter = SetPrototypeOf(o, v), so
  it no longer writes an OWN enumerable `__proto__` data property. Host →
  `__host_set_struct_proto`; standalone → native `__object_setPrototypeOf` (with
  `compileProtoArg` inline-literal reification). Assignment expression yields the
  RHS (§13.15.2).

Verify-first (host, mirroring the #2739 test): for-in over an object whose proto
was set via `Reflect.setPrototypeOf` / `o.__proto__=` now matches the
`Object.setPrototypeOf` case (`p1,p2,p3,p4,`), including multi-level chains and
set-to-null. Tests in `tests/issue-2747.test.ts`. No new regressions (the
pre-existing #1472/object-mutability/closed-imports failures are unrelated).

**(b) and (c) remain OPEN** — architect-scoped (the #1712 two-channel divergence
+ full-harness defineProperty ordering). This carve-out does NOT close #2747.

## Acceptance criteria
- `S12.6.4_A6.js`, `S12.6.4_A6.1.js`, `order-after-define-property.js` flip
  fail→pass. No regression in `statements/for-in/` (esp. `order-simple-object`,
  `order-property-on-prototype`) or the #1712 acorn prototype-method surface.
  Reflect.setPrototypeOf / `__proto__` for-in walk works. Full `merge_group` floor.

## Notes
- Split from #2739 (PR fixes part a). The #1712 read/write prototype channel is
  `_fnctorInstanceCtor` → `_sidecarGet(ctor,"prototype")` (runtime.ts ~74); the
  new setPrototypeOf channel is `_wasmStructProto` (runtime.ts ~49). Unify them.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — carve-out that explicitly does NOT close the issue. Group (d) carve-out (Reflect.setPrototypeOf + __proto__= mirror __host_set_struct) landed. The two remaining halves — constructor-function prototype-chain enumeration (S12.6.4_A6*) + defineProperty array-order — remain, carved due to the #1712 collision risk. Stays in-progress.
