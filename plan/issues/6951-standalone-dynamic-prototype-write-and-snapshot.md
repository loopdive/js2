---
id: 6951
title: "Standalone: a dynamic `ctor.prototype = v` write lands in the closure's property bag, and `[[Prototype]]` is resolved live through the per-name global instead of snapshotted at construction (Octane deltablue; standalone half of #6945)"
status: ready
sprint: current
created: 2026-10-10
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype-chain
goal: standalone-gap
related: [874, 6945, 6949, 6944]
---

# #6951 — standalone dynamic prototype write and construction-time prototype snapshot

Split out of #6945 (gc half in PR https://github.com/loopdive/js2/pull/6624). Depends on #6949. Probe files named below lived in a Session C scratch worktree; the shapes are reproduced inline in the table.
## Implementation Plan (2026-10-10, Session C planning pass; supersedes #6945 "plan step 3")

Standalone first failure of Octane `deltablue.js` (function trace, `wasm-opt
--log-execution`): `BinaryConstraint` ctor (driver line 741, `this.addConstraint()`,
reached via `EqualityConstraint`/`ScaleConstraint` → `BinaryConstraint.superConstructor.call`)
→ `Constraint` → `__protoidx_*`/`__obj_find` walk → `TypeError: called value is not
a function`. The walk cannot reach `Constraint.prototype.addConstraint` because the
chain `inheritsFrom` built is wrong on this lane. Two independent defects, both
measured on this branch with 8-line probes (node vs standalone):

| probe | shape | node | standalone | defect |
| --- | --- | --- | --- | --- |
| `.tmp/s2c.js` | `function setp(c,p){c.prototype=p}; setp(D,{t:7}); new D().t` | `true,7,true` | `false,undefined,false` | **G2** dynamic `prototype` write lands in the closure's own-property bag |
| `.tmp/s1.js` | `F.prototype={tag:"A"}; a=new F(); F.prototype={tag:"B"}; b=new F()` | `A,B,false` | `B,B,true` | **G3** `[[Prototype]]` is resolved LIVE through the per-name global, never snapshotted at construction |
| `.tmp/db30.js` | nested `Inheriter`, `return new Inheriter()` | `A,B,false` | `undefined,undefined,true` | G3 + the approval gate (`return`-position site → `keep-static`; see #6949, which must land FIRST) |
| `.tmp/db19.js` / `.tmp/db27.js` | deltablue `inheritsFrom` / `inherits` | `true,2,1` | throws | G2 + G3 |

G3 alone makes the gc lane's per-activation closure (landed above) UNNECESSARY on
standalone: each `inheritsFrom` activation writes `Inheriter.prototype` (per-name
global, canonical `$Object`) and then constructs — a construction-time snapshot
gives every instance the value that was current at ITS `new`, which is §10.1.14
GetPrototypeFromConstructor exactly.

### G2 — route a dynamic `<closure>.prototype = v` to the per-fnctor global

- `src/codegen/closure-props.ts` `buildFnctorPrototypeWriteArm` (`:352-437`): today
  the `"prototype"` key on a constructible closure writes the closure BAG
  (`__defineProperty_value`, flags `0xb9`). Before `writeOwn()`, add an identity
  ladder: for each prototype edge (`collectPrototypeEdges`,
  `src/codegen/closure-prototype-edge.ts:204`) `local.get 0; any.convert_extern;
  global.get <valueGlobalIdx>; any.convert_extern; ref.eq; if → local.get 2;
  call __proto_from_function (PROTO_FROM_FUNCTION, canonical form — the same
  store `tryCompileFnctorPrototypeAssign` performs, fnctor-prototype.ts:623);
  global.set <protoGlobalIdx>; <SET_RESULT_SUCCESS>; return`. Mint it as ONE
  reserve-then-fill helper `__closure_proto_set(target, value) -> i32` in
  `closure-prototype-edge.ts` (twin of `__closure_proto_of`, filled by
  `fillClosurePrototypeEdge`, `:264`), and call it from the write arm so the arm
  bakes no edge list of its own. Fallback: no edge → the existing bag write
  (a value-bound / arrow / member-held function keeps bag semantics, which is what
  `__native_construct` reads).
- Read side is already `closurePrototypeEdgeGetArm` (`:530`) → `__closure_proto_of`;
  nothing to do.
- Edge case: `F.prototype = v` where `v` is not an object (§10.2.5 MakeConstructor
  allows any value; `new F()` then uses `%Object.prototype%`) — store as-is, the
  `ref.test $Object` in `__fnctor_proto_start`'s consumers already handles a
  non-`$Object` link.

### G3 — construction-time `[[Prototype]]` snapshot for `$__fnctor_F` instances

- **Layout**: `src/codegen/fnctor-identity-fields.ts` `appendFnctorInternalFields`
  (`:22-70`): after `$constructor`, append `{ name: "$proto", type: externref,
  mutable: true }` (standalone only). `exposedClosedStructFieldName` must hide it
  (`$`-prefix already does). Update `program-abi-fnctor-planning.ts:205` /
  `program-abi-fnctor-producer.ts:241` (`exactField` checks on the trailing
  compiler fields) and `carrier-bag-delete.ts:226`.
- **Init**: `src/codegen/fnctor-constructor-identity.ts` `emitFnctorFieldInitializers`
  (`:203-230`): for `$proto` emit the vivifying read of the per-name global —
  `emitFnctorProtoGet(ctx, fctx, fnctorName)` (fnctor-prototype.ts:422; it
  late-imports `__new_plain_object`, so call it BEFORE pushing the other field
  initializers and flush shifts — same discipline as `compileFnctorNewAsObject`,
  new-super.ts:2535-2548). The approved-empty-body `$Object` path
  (`compileFnctorNewAsObject`) already snapshots via `__object_create`; this makes
  the struct path agree with it.
- **Lookup**: `src/codegen/object-runtime.ts` `fillFnctorPrototypeDispatchArms`
  (`:9530-9560`): the `__fnctor_proto_start` body becomes ONE arm — `local.get 1;
  ref.test <fnctor base struct>` (any `$__fnctor_*`; use the reserved base type if
  there is one, else keep the per-type ladder but return `struct.get $proto`
  instead of `global.get`). Per-key method caches (`:9600-9640`, two
  `global.get <protoGlobalIdx>` bakes per arm, "owner ref.eq" and "props staleness")
  must compare against `struct.get $proto` of the receiver (local 0) instead of the
  global — otherwise an instance whose snapshot differs from the current global
  would hit a cache populated for the global's object. `unshiftExternGetProtoCacheArm`
  (`:9950`) and `fnctor-struct-proto-hop.ts` go through `__fnctor_proto_start` and
  need no change. `extern-get-inline-ic.ts` and `instance-props.ts` reference the
  helper by index only.
- **`Object.setPrototypeOf(inst, p)` / `__proto__` write** on a `$__fnctor_F`
  receiver: `dynamic-proto.ts` `__struct_proto_set` (`:554`) — add the `$proto`
  struct.set arm so a later re-link is observable (today it is unsupported for
  fnctor structs; keep the cycle check).
- Order: #6949 (proto materialization gate) first (every constructed fnctor
  then has a global to snapshot), then G2, then G3 (G3 changes a struct layout —
  one PR, run the `program-abi` tests).

### Acceptance criteria
1. `tests/issue-6945-nested-fnctor-identity.test.ts`: flip the 5 standalone
   `it.todo` rows to real cases (db30 `A,B,false`; ctor identity; db19/db27/db28
   `true,2,1`); add `.tmp/s2c.js` → `true,7,true` and `.tmp/s1.js` → `A,B,false`
   (standalone); gc rows unchanged.
2. `pnpm run -s benchmark:octane -- --only deltablue --lanes standalone --timeout 300`
   → `pass` (or the NEXT failure named; the verbatim gate log shows 6 `keep-static`
   sites whose instances may also need the materialization issue).
3. test262 standalone floor unchanged; `language/statements/function/13.2-*` and
   `S13.2.2_A*` (per-construction prototype) are the positive signal.
4. Ratchet gates green; new `$proto` field = +4 bytes/instance on standalone —
   measure the acorn standalone lane (`benchmarks/cross-engine`) and record it.

### Ownership (standalone part)
`closure-props.ts`, `closure-prototype-edge.ts`, `fnctor-identity-fields.ts`,
`fnctor-constructor-identity.ts`, `object-runtime.ts`, `dynamic-proto.ts`,
`program-abi-fnctor-*.ts`, `carrier-bag-delete.ts` — all Session A's area; needs
A's release. Size: L (G2 ~60 lines, G3 ~120 lines + ABI/test updates).
