---
id: 5239
title: "Member reads on an Object.create(proto)-built host object never reach the compiled prototype's accessors — module-independent, the true cause of Temporal .from() results answering undefined/[object Object]"
status: done
sprint: current
priority: high
horizon: l
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
completed: 2026-08-31
# Intentional growth, 2026-08-31 (#5239):
#   * src/codegen/object-create-class-instance.ts — NEW: the one export that
#     answers "is this prototype one of my classes, and if so give me a fresh
#     instance". It is deliberately its own file rather than another arm in
#     index.ts, which is already over its consolidation target.
#   * src/codegen/index.ts — two 3-line call sites (single- and multi-source
#     finalize), placed next to `emitIteratorMethodExport` for the same reason
#     it is: the dispatch exports must already exist.
#   * src/codegen/init-class-dispatch-helpers.ts — the new export joins the
#     start-section registration channel; a polyfill builds instances DURING
#     module init, when `getExports()` is still undefined.
#   * src/runtime.ts — the `__object_create` consult, the getPrototypeOf
#     record, and the ToPrimitive class-member arm.
loc-budget-allow:
  - src/codegen/object-create-class-instance.ts
  - src/codegen/index.ts
  - src/codegen/init-class-dispatch-helpers.ts
  - src/runtime.ts
# `generateMultiModule` grew by the 3 lines of the multi-source call site
# (comment + call). Splitting that function is #3399's job, not this fix's.
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::resolveImport
---

# #5239 — `Object.create(proto)` host objects bypass compiled prototype accessors

## Problem

`Temporal.PlainDate.from("2020-03-04")` still answers `.toString()` →
`"[object Object]"` and `.year` → `undefined` after #5237 (PR #5343), and
dev-5237's control DISPROVES the cross-module theory: the same polyfill +
consumer compiled into ONE module with `compileMulti` (no linker,
`linkedModules === 0`) answers identically. The polyfill's
`CreateTemporalDate` builds its instance as `Object.create(PlainDate.prototype)`
and keeps ISO fields in slots keyed by that HOST object; a host object whose
prototype is a WasmGC struct never reaches the prototype's accessors on a
member read.

Reduced non-Temporal (in `tests/issue-5237-cross-module-class-members.test.ts`
base pins): `Object.create(C.prototype)` built INSIDE the class's own module
dispatches correctly after #5237; the same expression in a consumer against a
`C.prototype` read through the ctor-mirror facade answers `Pnull:null` where
the single-module control answers `P1:2`. And explicit-proto method calls work
(`prototype.toString.call(inst)` → `"2020-03-04"` after #5237) — it is the
implicit member-read path on the host object that never walks its
proto chain into the compiled dispatch surface.

Direct successor to #5223's "Not fixed" item 1 and #5237's kept `staticFrom`
knownGap; harness rows: `staticFrom` in
`tests/dogfood/temporal-global-harness.mjs`.

## Direction

The host-lane property read on a plain host object with a mirror/struct
prototype (`_safeGet` / `__extern_get` tail) must, on an own-property miss,
walk `Object.getPrototypeOf` and route a hit on a compiled prototype through
the same `__call_get_*` / `__member_kind_*` dispatch #5223 wired — with the
receiver bound to the ORIGINAL host object (its slots carry the state), which
#5237's `selectBridgeReceiver` now supports. Watch the #3903 hot path.

## Acceptance criteria

1. Non-Temporal: `Object.create(C.prototype)` in the consumer answers getter
   and method reads correctly (flip the pinned base rows in issue-5237 tests).
2. `Temporal.PlainDate.from("2020-03-04").toString()` → `"2020-03-04"`,
   `.year` → `2020`, single-module AND provider lanes; flip the harness
   `staticFrom` knownGap. This unblocks wiring the test262 runner to the
   provider (#4628 criterion 2) together with #5225/#5226.
3. No regressions: issue-5221/5222/5223/5237/4628 + linker family; equivalence
   gate at baseline. Gates green.

## Notes

- Found by dev-5237 (PR #5343) with the 37.9 s single-module control run.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Implementation notes (2026-08-31)

### The cause is a SYNTACTIC GATE, not a member-resolution hole

`tryCompileObjectCreateStaticPrototype`
(`src/codegen/expressions/call-object-builtins.ts`) has lowered
`Object.create(Foo.prototype)` to `struct.new $Foo` with defaulted fields since
long before this issue: the created object IS a compiled instance, so every
later read dispatches through the ordinary struct surface. The gate is the
SPELLING `<identifier>.prototype`. A minified bundle reaches the same class
through a variable, and the @js-temporal/polyfill does exactly that —
`const n = ce("%Temporal.PlainDate%"); const r = Object.create(n.prototype);`.
That call falls through to the `__object_create` host import and gets a plain
JS object.

Reduced to twelve lines of plain user code, ONE module, no linker
(`tests/issue-5239-object-create-class-prototype.test.ts`): with the class
written as an identifier every probe passes on base; with the identical class
read out of a registry object every probe fails. Same file, same class, same
members.

### Why the issue's stated direction cannot work

The Direction above asks the runtime's host-object read tail to walk
`Object.getPrototypeOf` and dispatch a compiled-prototype hit with the original
host object as receiver. That is impossible for this shape, and measuring it is
what redirected the fix:

* a compiled class method takes its receiver as a concrete `(ref $Class)`, and
  the generated `__member_kind_*` / `__class_call_*` bridges select their arm
  with `ref.test`. A host object fails every arm — there is no representation
  in which it could pass one;
* `selectBridgeReceiver` (#5237) therefore falls back to the BOUND carrier, i.e.
  the prototype struct, which is precisely the `"Pnull:null"` failure #5237
  measured. For a polyfill whose state is a WeakMap keyed by the created
  object it throws "Missing slots" instead — measured here as
  `PlainDate.prototype.toString.call(from(…))` THROWING on base;
* even a perfect dispatch would not help: the state is keyed by the object the
  program created. So the object the program created must BE the instance.

Hence the fix generalises the existing fast path to the dynamic case instead of
adding a second, weaker one.

### What landed

1. **`src/codegen/object-create-class-instance.ts` (new)** — one export,
   `__object_create_class_instance(proto) -> externref`. It matches `proto` by
   REFERENCE IDENTITY against each class's lazily-initialised prototype global
   (`ref.test` for type, then `ref.eq` on the casts, with both sides guarded so
   neither cast can see a null) and returns a freshly defaulted struct with the
   class `__tag` set exactly as a `new`-built instance has it. Identity, not
   `ref.test` alone: an INSTANCE passes the same `ref.test` as its prototype, and
   `Object.create(someInstance)` must keep meaning "a plain object inheriting
   from that instance". Returns null for everything else.
2. **`src/codegen/index.ts`** — emitted next to `emitIteratorMethodExport` in
   both the single- and multi-source finalize sequences (the dispatch exports it
   sits beside must already exist), gated on the module actually importing
   `__object_create`, so a module that never calls it emits identical bytes.
3. **`src/codegen/init-class-dispatch-helpers.ts`** — the new export joins the
   #5202 start-section registration channel. A polyfill builds instances DURING
   module init, when `getExports()` is still undefined.
4. **`src/runtime.ts` `__object_create`** — consults the export before doing the
   ordinary `Object.create`. Hot-path discipline: the probe is skipped unless
   `proto` is a compiled carrier (`_isWasmStruct`), so `Object.create(null)` and
   every plain-object prototype pay one WeakSet-free type test and nothing else.
5. **`src/runtime.ts` `_objectCreateClassInstanceProto`** — a record read ONLY by
   `__getPrototypeOf`, so `Object.getPrototypeOf(created) === C.prototype` keeps
   answering true. Deliberately NOT `_wasmStructProto`: that map also drives the
   for-in and read walks, and routing them through the prototype would enumerate
   class methods that are spec-non-enumerable.
6. **`src/runtime.ts` `_toPrimitive`** — a `_resolveClassMember` arm, last, after
   the sidecar and struct-field arms so nothing that already resolved changes
   precedence. Without it `String(instance)` still answered "[object Object]":
   the nearest existing arm, `exports["__call_toString"]`, is the ToPrimitive
   finalizer's ZERO-ARGUMENT dispatcher, and a method declared with a parameter
   — `toString(options)`, which is what EVERY Temporal class uses — has no arm in
   it and traps. `_resolveClassMember` reads `__member_arity_*` and pads.

### Measured (single-module control, no linker — `linkedModules === 0`)

| probe | base | after |
| --- | --- | --- |
| `PlainDate.from("2020-03-04").toString()` | `"[object Object]"` | `"2020-03-04"` |
| `.year` | `undefined` | `2020` |
| `.month`/`.day` | `undefined/undefined` | `3/4` |
| `.toJSON()` | `undefined` | `"2020-03-04"` |
| `typeof inst.toString` | `"undefined"` | `"function"` |
| `PlainDate.prototype.toString.call(from(…))` | THREW | `"2020-03-04"` |
| `PlainDate.compare(from,from)` | `-1` | `-1` |

Provider lane (`tests/issue-4628-temporal-global.test.ts`, fresh
`JS2WASM_TEMPORAL_CACHE`): `staticFrom` → `"2026-08-30"`, `staticFromField` →
`"2026"`, `staticCompare` → `-1`. Promoted out of `knownGaps`.

### Reported, NOT fixed

* **`Temporal.Now.plainDateISO()` still throws** `RuntimeError: dereferencing a
  null pointer`, in BOTH lanes, re-measured after this fix. The harness note
  attributed it to this Object.create family; that attribution is now
  disproved — the family is fixed and the row did not move. Corrected in the
  harness note; stays with #5221. `Temporal.Now.timeZoneId()` likewise.
* **A method with a DECLARED PARAMETER reached through the host bridge answers
  `undefined`** — `from("2020-03-04").add({days: 1})` is `undefined` before and
  after. Control: the identical call on the pre-existing SYNTACTIC
  `Object.create(C.prototype)` path (`makeStatic(…).add(1)` in a plain
  single-module program) is `undefined` too, so it predates this change and is
  not on the path it touches. Separate defect in the arity-selected
  `__class_call_<key>_<n>` surface.
* **`const f = inst.toString; f.call(inst)`** answers `"false"` before and
  after — the detached-then-reattached bridge shape, unchanged.
* **Cross-module prototype identity**: in the LINKED lane
  `Object.getPrototypeOf(created) === C.prototype` is false (true in the
  single-module control), because the consumer's `C.prototype` read answers the
  ctor-mirror facade's prototype rather than the provider's own prototype
  global. Base behaviour, pinned in the new test rather than asserted away;
  belongs to the #5237 identity family. Every MEMBER answer is identical in
  both lanes.
