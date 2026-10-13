---
id: 6944
title: "Prototype chain through a constructor-instance prototype (`Derived.prototype = new Inheriter()`) dead-ends: host `_fnctorProtoLookup` walks with native getPrototypeOf, standalone `__extern_get` stops at a non-`$Object` node (Octane deltablue)"
status: done
sprint: current
created: 2026-10-10
updated: 2026-10-10
completed: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: prototype-chain, constructor-functions
goal: property-model
related: [874, 6945, 1712, 2660, 2680, 2739, 3138, 4616, 4480]
assignee: "ttraenkler/claude-session-c-octane-host-fnctor-proto-walk-struct-ancestors-20261010"
loc-budget-allow:
  # 2026-10-10 (#6944): runtime.ts +~17 — the struct-ancestor hop in the two host
  # walks + the `in` arm's fnctor-chain consult; object-runtime.ts +~36 — helper
  # reservation/fill wiring and test-before-cast guards at the five
  # `__fnctor_proto_start` consumers (the re-entry helpers themselves live in
  # the new src/codegen/fnctor-struct-proto-hop.ts).
  - src/runtime.ts
  - src/codegen/object-runtime.ts
flat-dir-budget-allow:
  - src/codegen/fnctor-struct-proto-hop.ts # 2026-10-10 (#6944): struct-valued [[Prototype]] hop bodies for object-runtime.ts; sits with its flat fnctor-* siblings (fnctor-instance-prototype.ts, fnctor-escape-gate.ts)
func-budget-allow:
  # 2026-10-10 (#6944): same wiring, inside the two god-functions that own it.
  - src/runtime.ts::resolveImport
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #6944 — inherited lookup dead-ends when a prototype is itself a `new F()` instance

Found by the Octane triage (#874, Session C, 2026-10-10). Octane `deltablue.js`
fails with `addConstraint is not a function` (gc) / `WebAssembly.Exception`
(standalone). Fixing this issue alone does NOT make deltablue pass — the
inheritance helper also needs #6945 (verified: with the one-line fix below
applied, deltablue still fails on `.tmp/db19.js`, which is #6945's shape).

## Problem

The classic pre-ES6 inheritance idiom (deltablue's `Object.prototype.inheritsFrom`):

```js
function Inheriter() { }
Inheriter.prototype.hello = function () { return "hello" + this.x; };
function Derived() { this.x = 2; }
Derived.prototype = new Inheriter();          // prototype IS a constructor instance
export function main() { var d = new Derived(); return d.hello(); }
```

(`.tmp/db12.js`; `.tmp/db13.js` is the same with `var p = new Inheriter(); Derived.prototype = p`.)

| case  | node     | gc                                   | standalone                                   |
| ----- | -------- | ------------------------------------ | -------------------------------------------- |
| db12  | `hello2` | `RUNTIME value is not callable`      | `TypeError: called value is not a function`  |
| db13  | `hello2,true` | `RUNTIME value is not callable` | `hello2,true` (passes)                       |

`.tmp/db15.js` shows the read itself is the failure: `typeof d.hello` is
`undefined` on both lanes while `Object.getPrototypeOf(d) === Derived.prototype`
and `typeof Derived.prototype.hello === "function"` are both true (`.tmp/db14.js`,
`.tmp/db18.js`). `Derived.prototype = Object.create(Inheriter.prototype)` works
(`.tmp/db6.js`, `.tmp/db11.js`) — the chain breaks only when the intermediate
node is a `$__fnctor_<F>` instance struct.

Two-level chains through the same idiom (`.tmp/db20.js`, `.tmp/db21.js`:
`UnaryConstraint.prototype = new Inheriter()` with `Inheriter.prototype =
Constraint.prototype`, `this.addConstraint()` inside the ctor) fail the same way
on both lanes — that is deltablue's `addConstraint is not a function`.

## Root cause

### gc / host lane — CONFIRMED

`_fnctorProtoLookup` (`src/runtime.ts:297-323`) resolves the instance's
prototype via `_fnctorCtorProto` (sidecar `prototype` of the registered ctor
closure) and then walks ancestors with

```ts
cur = Object.getPrototypeOf(cur);      // runtime.ts:319
```

For a WasmGC struct ancestor (the `new Inheriter()` instance) native
`getPrototypeOf` is `null` — the struct's user-level [[Prototype]] lives in the
`_fnctorInstanceCtor` / `_wasmStructProto` records, which the walk never
consults. The #2739 helper `_structUserProto(cur, exports)` (`runtime.ts:~340`)
is exactly that resolution (explicit `setPrototypeOf` link first, then the
fnctor instance→ctor `.prototype`, then native). Replacing line 319 with
`cur = _structUserProto(cur, exports);` was tried as a throwaway patch:
db1/db5/db12/db13/db15/db20/db21 all produce node's output on gc. The same
native walk exists in `_lookupDescriptorNoProxy` (`runtime.ts:5943-5955`, used
by the strict [[Set]] pre-check), and the `__extern_method_call` arm at
`runtime.ts:15433` calls `_fnctorProtoLookup(obj, method)` WITHOUT `exports`
(so `_fnctorCtorProto`'s `__sget_prototype` fallback is unreachable there).

### standalone lane — SUSPECTED (mechanism read from the emitted code; not yet patched)

`__extern_get`'s inherited walk (`src/codegen/object-runtime.ts:~2650-2690`)
resolves a `$__fnctor_<F>` receiver's prototype through the
`__fnctor_proto_start` ladder (`fillFnctorPrototypeDispatchArms`,
`object-runtime.ts:9508-9540`: `ref.test $__fnctor_F → global.get
__fnctor_proto_F`) and then REQUIRES the result to be an `$Object`
(`ref.test objectTypeIdx`; comment: "A non-`$Object` (or null) ends the explicit
walk"). When `Derived.prototype` holds a `$__fnctor_Inheriter` struct (db18's
WAT: `__fnctor_Inheriter_new` returns `(ref null $__fnctor_Inheriter)`, and the
S2 write `Derived.prototype = <new-expr>` stores that struct in
`__fnctor_proto_Derived`), the walk ends after one hop. Direct reads on that
node (`dp.hello`, `Object.getPrototypeOf(dp) === Inheriter.prototype`) work
because they go through the per-fnctor arms, which is why db18 reports
`function,true,function,true,true,function` with `typeof d.hello` undefined.
db13 passes because `var p = new Inheriter()` makes `p` a reconstructed value the
write path canonicalizes to an `$Object` view. `.tmp/db25.js` traps `illegal
cast` on `"hello" in d`, same chain.

## Implementation Plan

Spec: §10.1.8.1 OrdinaryGet step 3 — on an own miss, `parent.[[Get]](P,
Receiver)` recursively; §10.1.7.1 HasProperty likewise; §7.3.21 OrdinaryHasInstance
walks the same chain. Every chain node must be resolved the way `[[GetPrototypeOf]]`
resolves it, whatever its representation.

**gc (host)** — `src/runtime.ts`:
1. `_fnctorProtoLookup` (`:319`): `cur = _structUserProto(cur, exports)`.
   Keep the `guard < 16` bound; add a visited `Set` so a cycle (the pre-#6945
   shared-Inheriter case produces one) ends the walk with `undefined` instead
   of looping to the guard.
2. `_lookupDescriptorNoProxy` (`:5943`): same substitution for struct nodes.
3. `__extern_method_call` arm (`:15433`): pass `callbackState?.getExports()`.
4. Audit the other `_fnctorProtoLookup` call sites (`:5824, :8207, :13373,
   :13450, :13536, :14468, :14489, :14791, :14810`) — they pass `exports`
   already; nothing else changes.

**standalone** — `src/codegen/object-runtime.ts`:
5. In the `__extern_get` inherited walk (`:~2665-2690`), when the
   `__fnctor_proto_start` result is non-null but not an `$Object`, do not end
   the walk: loop — call `__fnctor_proto_start` on THAT value (a fnctor struct
   maps to its ctor's prototype global) until an `$Object` or null is reached,
   bounded (same 16-hop guard as the host). Apply the identical hop in the
   companion walkers: `__extern_has` (`in`, `.tmp/db25.js`), the
   `__fnctor_proto_start`-based arms of `__extern_method_call`
   (`fillFnctorPrototypeDispatchArms`, `:9508`) and `__getPrototypeOf`.
   Alternative with the same effect: canonicalize the S2 prototype STORE
   (`tryCompileFnctorPrototypeAssign`, `src/codegen/expressions/fnctor-prototype.ts:507`)
   so a fnctor-struct rhs is stored as its `$Object` view, as #4643 already does
   for callables — pick whichever keeps `Object.getPrototypeOf(dp) ===
   Inheriter.prototype` true (db18 column 4).

**Tests** (`tests/issue-6944-proto-chain-fnctor-instance.test.ts`, both lanes
through public `compile()` vs node): db12, db13, db15 (`typeof d.hello`,
`f.call(d)`, `d["hello"]()`, `d.hello()`), db18/db25 (`in`, computed key,
`getPrototypeOf` identity), db20/db21 (two levels, call inside the ctor and
after), plus negative controls: a chain with a `null` prototype
(`Object.create(null)` node) still answers `undefined`; a cyclic chain made
through `Object.setPrototypeOf` is still rejected by the set path and the walk
terminates.

**Acceptance**: all of the above equal node on gc and standalone; Octane
`deltablue.js` passes once #6945 lands too (`.tmp/octane-probe.mjs deltablue`);
test262 host + standalone floors unchanged (this only adds hops to walks that
previously answered `undefined`).

## Ownership note

`src/runtime.ts` and `src/codegen/object-runtime.ts` are in Session A's
WasmGC/shared-IR area; Session C implements at the project lead's direction.
Functions touched: `_fnctorProtoLookup`, `_lookupDescriptorNoProxy`, the
`__extern_method_call` fnctor-proto arm (runtime.ts); the `__extern_get`
inherited-walk emission, `fillFnctorPrototypeDispatchArms`, optionally
`tryCompileFnctorPrototypeAssign` (codegen).

## Implementation notes (2026-10-10, Session C)

Implemented per the plan; deviations and why:

**Host (`src/runtime.ts`)** — plan steps 1-4 as written: `_fnctorProtoLookup`
advances with `_structUserProto(cur, exports)` and carries a visited `Set`;
`_lookupDescriptorNoProxy` hops struct nodes through `_structUserProto`
(16-hop bound, since that chain may cycle); the `__extern_method_call` arm
passes `exports`. **Added:** the `__extern_has` struct arm now consults
`_fnctorProtoLookup` after the own-property probe. Without it `"hello" in d`
stayed `false` on gc (db25 column 3): a dynamic `in` on a fnctor instance never
consulted the fnctor chain at all — one-level cases only passed because the
compiler folded them statically.

**Standalone** — the plan's "loop `__fnctor_proto_start` until an `$Object`"
would skip the struct node's OWN properties (its typed fields and expando bag:
`Mid.prototype = new Base()` with `this.name` set in `Base`). Instead the
walkers re-enter on the struct link, which is exactly §10.1.8.1 step 3
(`parent.[[Get]](P, Receiver)`):
- `__extern_get` → `__fnctor_struct_proto_get(link, key, receiver)` →
  `__reflect_get_receiver`, so an accessor further up still gets the ORIGINAL
  receiver (test `structAncestorOwnFieldsAndReceiver`);
- `__extern_has` → `__fnctor_struct_proto_has(link, key)` → `__extern_has`;
- termination: `__fnctor_struct_proto_ok(link)` walks the struct links up front
  (pure; a struct link always leads to its own ctor's per-NAME global, so a
  revisit is a cycle) and declines anything that has not reached an `$Object`
  or a dead end in 16 hops, which also bounds the re-entry depth;
- the helpers live in the new `src/codegen/fnctor-struct-proto-hop.ts`
  (reserved before the walkers bake their calls, forwarders filled once
  `__reflect_get_receiver`/`__extern_has` exist).

The `illegal cast` (db25) was not the walk: three per-key method-cache sites
`ref.cast` the proto-start answer to `$Object` after only a null check
(`__method_cache_lookup`, `unshiftExternGetProtoCacheArm`, the
`fillFnctorPrototypeDispatchArms` inline cache). They now `ref.test` first; a
struct link is simply never a cache owner. `__extern_has_with_implicit_object_proto`
had the same cast and now tests. `__isPrototypeOf`'s fnctor seed
(`prototype-chain-bodies.ts`) steps over struct links to the first `$Object`
(the target is always an `$Object`, so no struct link can match), which makes
`leaf instanceof Base` true through two struct links.

**Not done (residual, not needed by the plan's cases or deltablue):**
- standalone `x instanceof M` where `M.prototype` is ITSELF a struct (the
  `__isPrototypeOf` target must be an `$Object` today; node: true, js2: false);
- the standalone `__extern_set` decision walk still ends at a struct link, so a
  setter / non-writable data property inherited THROUGH one is not honoured on
  assignment (it inserts an own property instead).

**Validation** — `tests/issue-6944-proto-chain-fnctor-instance.test.ts`, 10
cases × {gc, standalone}, real source through `compile()` vs node's output:
base 3/20 pass (standalone `viaVariable`, both `cycleAndNullProtoTerminate`
controls), head 20/20 (also 20/20 without the #6945 commit). Octane
`deltablue` (`.tmp/octane-probe.mjs`): gc now runs to completion
(`run(1) -> 1`) together with #6945; standalone still throws — see #6945's
residual.
