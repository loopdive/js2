---
id: 5204
title: Builtin-derived methods with arguments, rest params, and getters never bridge to the host — supportsHostClassBridgeParam rejects f64
status: done
assignee: ttraenkler/opus-dev-5203
completed: 2026-08-29
sprint: current
# (#5204, 2026-08-29) The externref-backed class bridge gained three shapes —
# f64 parameter coercion, a class-qualified vararg bridge, and a
# class-qualified getter bridge — plus the accessor receiver-type fix that made
# a getter bridgeable at all. Restated here (not only in the #5193/#5202 issue
# files this branch stacks on) so the grant is not stranded when CI diffs the
# merge preview.
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/runtime.ts
# The +1 is ONE `ctx.funcMap.get("__unbox_number")` lookup in
# `hostClassBridgeParamCoercion`, passed straight into `callArgCoercionInstrs`
# — the single coercion engine (#1917/#2108). No new ToNumber matrix is
# hand-rolled; the helper index is what the engine needs as an argument, and
# the two sibling bridge sites in the same file already do exactly this.
coercion-sites-allow:
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::resolveImport
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5204 — host class bridge rejects f64 parameters (NOT a timing issue)

## Problem

On a builtin-derived class (`class D extends Array`), instance members
beyond zero-arg methods never work through the host dispatch path — at init
time AND after init (measured by dev-5202 with after-init-only controls on
base, so this is pre-existing and NOT the #5193/#5202/#5203 timing window):

- a method taking arguments (`add(x: number, y: number)`) →
  `add is not a function`;
- a rest-param method (`sum(...xs: number[])`) → `sum is not a function`;
- a getter (`get g()`) → reads `NaN`.

## Mechanism (located by dev-5202)

`emitExternrefClassMethodDispatch` publishes the class-qualified bridge only
when every parameter passes `supportsHostClassBridgeParam`, and an `f64`
parameter does not pass. jsbi's `__clzmsd()` is zero-arg, which is why the
Temporal harness got past it — but the next jsbi instance method with
arguments will hit this, so it sits directly on the #4628 critical path
behind #5203.

## Direction

Teach the host class bridge to marshal `f64` (and the rest-param vec)
parameters — the generic host-call marshalling for free functions already
handles numbers, so the gap is likely the bridge's parameter-type allowlist
plus the call-site coercion, not new marshalling machinery. Getters need
the `__call_get_*` surface to accept the same widening. Decide with
evidence; measure the allowlist's other rejections while there and record
which remain (don't widen speculatively beyond f64/rest/getter).

## Acceptance criteria

1. New tests/issue-5204-*.test.ts: `add(x,y)`, `sum(...xs)`, `get g()` on
   `class D extends Array`, host lane, at-init AND after-init, failing on
   base, passing with fix.
2. Temporal harness measured before/after on the full stack
   (#5252+#5256+#5258+#5203-fix+this) — record where init stops.
3. No regressions in the issue-5191/5201/5202 test files + scoped class
   method runs (name them). Gates green.

## Notes

- Blocker chain context: #5191 → #5193 → #5201 → #5202 → #5203 (timing) →
  this (capability). Both #5203 and this are expected to be needed before
  `moduleInitRuns` flips true.
- Id #5204 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. Note: PR #5204 (the selfhost
  PR) shares the number — unrelated; ids and PR numbers share one sequence.
  `check:issue-ids:against-main` arbitrates.

## Implementation notes (2026-08-29, opus-dev-5203)

### The issue named one defect; there were three

The mechanism section was right about `supportsHostClassBridgeParam` and
right that it is not a timing bug — measured with an after-init-only probe
(no top-level call at all) on the #5203 base: `add(x,y)` and `inc(x)` throw
`not a function`, `sum(...xs)` throws, `get g()` reads NaN, while a
`tag(s: string)` method returns normally. That last row is the whole
diagnosis in one line: a `string` formal is already externref, so **f64 was
the entire gap** between "a zero-arg method bridges" and "a method with
arguments does".

But the rest-param and getter symptoms turned out to have their own causes,
not the allowlist:

| symptom | actual cause |
| --- | --- |
| `add(x,y)` / `inc(x)` | `supportsHostClassBridgeParam` rejects f64 — suppresses the ENTIRE per-key surface (not even `__member_kind_inc` was emitted) |
| `sum(...xs)` | only the STRUCT-path `__class_call_sum_vararg` was emitted; a host-object receiver can only use a class-qualified bridge, and none existed for rest |
| `get g()` | (a) accessor bodies compiled with a WasmGC-struct receiver while METHODS of the same class compiled with externref; (b) `_safeGet` consulted `_resolveClassMember` only inside its `_isWasmStruct(obj)` block |

The unifying fact is that `class D extends Array` is **externref-backed** —
its instance is a real host object, so the generic `__member_kind_<key>`
`ref.test` cascade over WasmGC struct types can never match it and ONLY the
class-qualified bridge can serve it. That is also why methods worked and
property reads did not: a method call reaches `__extern_method_call`'s
not-a-function tail, which consults the class resolver on its own, while a
plain read goes through `_safeGet`, which did not.

### Why the getter needed a codegen change, not just a bridge

`compileClassBodiesInner` selects an externref receiver for METHOD bodies of
an externref-backed class (#4534) but hardcoded `{ kind: "ref", typeIdx:
structTypeIdx }` for accessor bodies. Measured directly:
`D_get_g` had `params: [{kind:"ref",typeIdx:28}]` while `D_z` had
`params: [{kind:"externref"}]` — same class, same declaration. So no getter
bridge was even *emittable*: the signature could not be called with the real
receiver. Fixed for getters and setters from the same rule.
(The DECLARATION pass already had the right rule; it runs before the
heritage analysis populates `classExternrefBackedSet`, and the body pass
re-resolves the type — which is why methods came out right and accessors did
not.)

### Downstream effects considered

- **`supportsHostClassBridgeParam` is shared by 6 call sites.** Widening it
  is safe because the struct-path bridge already had the matching
  `callArgCoercionInstrs` arm AND an `unsupportedNumeric` guard for a module
  without `__unbox_number` — the predicate was the only thing stopping such a
  signature from reaching machinery built for it. The RECEIVER check in
  `emitExternrefClassMethodDispatch` was reusing the same predicate, so it is
  now spelled out separately: widening arguments must not widen receivers.
- **Helper scheduling.** `classBridgeNeedsNumberBox` gained a parameter scan.
  `addUnionImports` must run BEFORE the bridge loop captures any `funcIdx`;
  without this the newly-admitted f64 params would find no unboxer and every
  arm would fall back to its stub — the allowlist would widen and nothing
  would bridge.
- **Emission gate widened to `classExternrefBackedSet.size > 0`.** A module
  whose only host-side access is a getter READ registers no dynamic method
  name at all, so `emitIteratorMethodExport` used to bail before emitting
  anything. The extra keys feed ONLY the class-qualified emitters; the
  generic struct-path bridges and `emitClassMemberKindExports` still see the
  original demand-driven `keys` set, so no unrelated module's bytes move.
- **`_safeGet`'s new resolver consultation sits AFTER the native read and the
  sidecar**, so nothing that already resolved changes precedence, and the
  resolver answers only for registered compiled instances. It reads the
  #5193/#5202/#5203 start-export channel so the same read works during init.

### Allowlist rejections that REMAIN (recorded, not widened)

`i32`, `i64`, `f32` parameters (the native-annotation lane) and
`ref`/`ref_null` struct/vec parameters. Each needs its own representation
contract at the host boundary; none of them is on the Temporal path.

### Test results

- `tests/issue-5204-host-class-bridge-f64-params.test.ts` — 9 cases, each
  measured at init AND after init. **6 fail on base** (f64 args, single f64
  arg, rest, rest-after-fixed, getter, receiver-state-through-f64-method);
  the 3 that pass on base are controls (zero-arg, string-arg, plain
  non-builtin class) and still pass.
- `tests/issue-5191/5193/5202/5203` — 53/53 unchanged.
- `classes`, `class-methods`, `class-method-calls`, `class-expression`,
  `class-expressions`, `getters-setters`, `accessor-side-effects`,
  `abstract-classes` — 68/68.
- `issue-2992-accessor-merge` / `-widening` — 6 failures, **identical on base
  and here** (verified by an A/B revert). Pre-existing, not caused by this.
- Equivalence gate, all 8 shards, exit 0 — 0 new regressions.

### Temporal harness (acceptance criterion 2)

Measured here on 2026-08-29, all three rows executed (not inherited):

| probe tree | `moduleInitError` |
| --- | --- |
| #5252 + #5256 + #5258 | `TypeError: __clz30 is not a function` |
| + #5203 | `object is not iterable (cannot read property Symbol(Symbol.iterator))` |
| + #5203 + #5204 | same as the row above |

`moduleInitRuns` is **still false**. #5204 does not move the harness by
itself — the next blocker fires first — but it is on the path: jsbi's
instance methods with arguments are exactly the shape it unblocks, and they
are unreachable the moment the `Object.fromEntries` blocker clears.

Next blocker (same one #5203 recorded, stack
`Object.fromEntries → src/runtime.ts:14436 → __module_init`):
`__object_fromEntries` passes the compiled value straight to the host
`Object.fromEntries`, which needs `Symbol.iterator`; an opaque WasmGC vec has
none. Its neighbour `__object_assign` marshals via `_wrapForHost`. Reported
to the coordinator for id allocation.
