---
id: 6951
title: "Standalone: a dynamic `ctor.prototype = v` write lands in the closure's property bag, and `[[Prototype]]` is resolved live through the per-name global instead of snapshotted at construction (Octane deltablue; standalone half of #6945)"
status: in-progress
assignee: ttraenkler/senior-dev
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
loc-budget-allow:
  # 2026-10-11 (+26): the per-fnctor method-cache arm in
  # `fillFnctorPrototypeDispatchArms` must compare its cache owner against the
  # RECEIVER's snapshot link (a new local + an `$Object` test before the casts),
  # and `__fnctor_proto_start` gains its snapshot read. The link builder and the
  # reservation predicate live in fnctor-identity-fields.ts; only the call
  # sites and the arm rewiring stay in object-runtime.ts.
  - src/codegen/object-runtime.ts
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

## Implementation notes (2026-10-11, branch `claude/standalone-dynamic-proto-write`, stacked on #6949)

**G2** (`closure-prototype-edge.ts`, `closure-props.ts`). New reserve-then-fill
`__closure_proto_set(target, value) -> i32`, the write twin of
`__closure_proto_of`: an `ref.eq` identity match against each FNCTOR prototype
edge stores `__proto_from_function(value)` into that fnctor's global (the same
store `tryCompileFnctorPrototypeAssign` performs) and answers 1. The
closure-props `prototype` write arm calls it before the bag write; 0 keeps the
bag write. Class edges are excluded (a class `prototype` is non-writable).
Non-object values are stored as-is, matching the static path.

**G3** (`fnctor-identity-fields.ts`, `fnctor-constructor-identity.ts`,
`object-runtime.ts`, `program-abi-fnctor-{planning,producer}.ts`).
- Layout: standalone fnctor structs gain `$__fnctorProto` (mutable externref)
  right after `$constructor`. Not named `$proto`: a user `this.$proto` field
  would collide by name. `exposedClosedStructFieldName` hides it (`$` prefix);
  `carrier-bag-delete.ts` needs no change (not source-recorded ⇒ no physical
  name). The program-ABI Parser layout is now input/`$constructor`/
  `$__fnctorProto`/`$bag`.
- Init: `emitFnctorFieldInitializers` resolves the ctor's fnctor name from
  `fctx.newTargetValueNode` (no signature change at the new-super.ts call
  site), builds `emitFnctorProtoGet` into a detached body that only runs while
  the global is null, and snapshots `global.get` (canonical storage form) into a
  local BEFORE any `struct.new` operand is pushed.
- Lookup: `fnctorProtoLinkInstrs` reads the snapshot, falling back to the live
  global when the slot is null — the split-layout path
  (`emitLayoutSelectingStructNew`, not in this issue's file list) default-inits
  the slot to null and therefore keeps the pre-#6951 live answer.
  `__fnctor_proto_start` and the per-fnctor inline method cache in
  `__extern_method_call` both use it; the cache now also `ref.test`s the link as
  `$Object` before its two casts.
- **Widening that the plan did not name:** `__fnctor_proto_start` was reserved
  only when the escape gate APPROVED some fnctor. Since #6949 every constructed
  ordinary fnctor has a global, so a module whose `new F()` sites are all
  keep-static (db30's `return new Inheriter()`) had no ladder at all — reads
  missed and `Object.getPrototypeOf` answered null. It is now reserved when the
  gate has any constructed fnctor (`fnctorProtoStartNeeded`). Four existing
  tests pinned the old wrong answers and were tightened to node's
  (es5-standalone-instanceof residual → 1, #2660 S3 struct-binding guard → 7,
  #4155 two `it.fails` → `it`, #5162 standalone XFAILs → 10).

**Measured** (base = this branch's #6949 commit, head = G2+G3, file-copy A/B):
- `tests/issue-6951-dynamic-proto-write-snapshot.test.ts`: base 4/10, head 10/10.
- Related tests (374 top-level files grepping fnctor/program-abi/closure-prop/
  setPrototypeOf/`.prototype =`, plus 5 under tests/ir and tests/equivalence):
  pass→fail 0 after the test updates above; fail→pass: the 4 pinned files plus
  #5162's four former XFAILs. `issue-3518-native-mixed-object-access` fails
  identically on base (timeouts).
- `node scripts/equivalence-gate.mjs`: no new regressions (22 known failures).

**Octane** (`--only deltablue,raytrace --lanes node,standalone --timeout 300`,
on a throwaway `c-octane-integ` (f8d43b197f) + these two commits; only conflict
was the `__fnctor_proto_start` reservation next to #6944's
`reserveFnctorStructProtoHelpers`, kept both):
- deltablue standalone: before `TypeError: called value is not a function`
  (the `inheritsFrom` chain); after, the chain is built (db19/db27 `true,2,1`)
  and it fails LATER, `Cannot access property on null or undefined at 506:29`
  (`Strength.weaker`). Root cause is NOT prototype linkage and predates this
  issue (reproduces on integ without these commits, no inheritance needed):
  a prototype method's `this.input()` — `return (this.direction == 1) ? this.v1
  : this.v2` — returns `NaN` (a number) instead of the `Variable` object
  (`.tmp/db42.js` shape: node `object:a>b`, standalone `number:undefined>undefined`).
- raytrace standalone: unchanged, `opaque wasm exception thrown by the module's
  top-level code`. Its first lines are the guarded namespace init
  `if (typeof Flog.RT == "undefined") Flog.RT = {};` — with that guard, a later
  `Flog.RT.Color.prototype` read throws `Cannot access property on null or
  undefined`; without the guard it works. Separately, an object-literal
  prototype written onto a member-held `Class.create()` closure (no edge, so G2
  keeps the bag write) is dropped by the construct driver (`new P()` gets
  `Object.prototype`; `Object.create(...)`-built prototypes work). Neither is in
  this issue's file list.

### Remaining
- `Object.setPrototypeOf(inst, p)` / `__proto__ =` on a `$__fnctor_F` receiver
  (plan item for `dynamic-proto.ts`) is NOT implemented: the slot is mutable,
  but an explicit null link needs a sentinel distinct from "no snapshot".
- A CLOSED object-literal prototype installed dynamically (`var p = {t:7};
  setp(D, p)`) is linked correctly (`getPrototypeOf(d) === p`) but `d.t` reads
  undefined on this branch: the `__extern_get` walk only continues through an
  `$Object` link. #6944 (`fnctor-struct-proto-hop.ts`, not on main) re-enters
  the walker on struct links; db19/db27 (deltablue `inheritsFrom`) likewise
  need #6944.
- The array-prototype helpers (`fnctor-array-prototype.ts`) and
  `fnctor-missing-method-dispatch.ts` still read the live global.
- The acorn +4 bytes/instance measurement (acceptance 4) was not taken.
