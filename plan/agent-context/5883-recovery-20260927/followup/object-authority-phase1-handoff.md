# Object prototype authority phase 1 — typed-slot encapsulation only

2026-09-27. Isolated tree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-protocol-get-20260927`.
Read FULL Hume raw-prototype authority plan, FULL Huygens parent field-0
inventory, and FULL Hume default-provider/boundary audit in the assigned trees.

## Status and exact increment

Source-only precursor, NOT a semantic fix, IR equivalence result or acceptance.
Mendel owns execution. No compiler/tests/typecheck, parent edits, commits, push,
merge, retry or activation changes. Existing B tests and receipts are unchanged.

Apply only `5883-object-authority-phase1-increment-20260927.patch` from this
directory to a tree with the prior B bytes; it contains the new helper and two
owned file increments, NOT the original B receiver/Get changes. Ordinary
`git diff` against this tree's HEAD also includes frozen B and is NOT the
increment to transfer. Exact pre-phase snapshots are retained locally under
`.tmp/object-authority-phase1-before/`; the patch itself needs no snapshot files.

Patch SHA-256: `7f621c429cb14e38048fd562ef8249fc70ecba7d8d635f344a0bd5ebb035a12e`.

Before:

- object-runtime.ts: `d07b344269ba735b595b697034b8d3dfa05975b66260d5c071934c2a0ff738bf`
- object-runtime-prototype.ts: `ba25bde72b0f54e2e346dc3c12fe92b8bea8f02db73b62ee99a4d5ecdca6e820`

After:

- object-prototype-slot.ts: `62b910d253ca1e987cfed6e9ef1046ce5840ea0764884fa40891ecb605d15aef`
- object-runtime.ts: `ac6adadd97854b39a999a5a63eb67fa33ad627a6e8fdc05d1e363637e3bda7f0`
- object-runtime-prototype.ts: `7e0a26b5bb8d69cd08ea8a5623bd98cc2b0ef0b95bac2a4b46534f25bfc12efd`

Existing-file increment: runtime +19/-13; prototype +12/-11. New helper is
51 lines. Formatting and targeted textual diff checks completed. Reverse patch
applicability checked without applying. A read-only text expansion of the new
factory calls/import/constant relocation recovers BOTH exact pre-phase source
files byte-for-byte. That is source correspondence, NOT compiled IR validation.

## Trusted physical emitter contract

`object-prototype-slot.ts` owns field index 0 and NULL_PROTO value 0x80.
`objectPrototypeSlotType` returns the current nullable Object payload type;
`objectPrototypeSlotField` returns the unchanged mutable field definition.
`objectPrototypeSlotGet`, `objectPrototypeSlotSet`, and
`objectPrototypeSlotNull` return fresh single instructions. Get/Set require a
trusted typed Object owner already on stack. Set consumes an already-encoded
nullable Object payload; it does NOT accept arbitrary JavaScript prototypes or
update flags. Null supplies an allocation/legacy cast-or-null operand, not an
actual-default answer. Factories reserve no Wasm functions, globals or imports.

Every invocation allocates a fresh instruction/type object for in-place
remapping. No shared Instr singleton, helper body reconstruction, cache, second
storage, runtime/default stub, or extra emitted operation was introduced.
The Object remains a final six-field struct with mutable `(ref null Object)`
field zero. NULL_PROTO flag tests/updates, descriptor order, proposal
canonicalization, proxy unwrapping, callable views and all current failure
behavior are intentionally preserved. In particular this does NOT repair
semantic null, encoded SameValue or default identity.

## Covered operations and remaining physical inventory

Original 28 get/set expressions: **16 routed here, 12 remain in other files**.
The helper contains two factory definitions; those are not two extra runtime
accesses. Four Object allocations remain, with unchanged arity and flags.
Coordinates below for remaining files are in this B tree, not parent main.

Routed in object-runtime.ts: nine reads in terminal-default test/advance,
Object Get advance, set-decision initial/next cursors, inherited-set initial/
next cursors, and the fnctor/ordinary Has walks. Plain allocation and boxed
primitive allocation now use the null factory; the layout uses the field
factory. Existing non-slot Object cursor/miss nulls are deliberately unchanged.

Routed in object-runtime-prototype.ts: six reads (encoded SameValue, raw Get,
null test, writer cycle step, status cycle step, isPrototypeOf step), one
successful store, Object.create allocation null, and the three existing
cast-or-null fallbacks for writer/status/isPrototypeOf. The existing payload
store remains immediately before the existing NULL_PROTO update.

Remaining consumers requiring named owners at atomic cutover:

- object-runtime-enumeration.ts:605: one `__object_keys_forin` chain read;
  migrate to actual mixed-carrier steps, preserving seen/nonenumerable shadowing.
- dynamic-proto.ts:574: one Object read in cycle stepping; :602/:610: private
  sentinel null/allocation. Keep the sentinel private and normalize only at
  the existing closed-instance provider boundary. Frozen B third-Receiver
  changes in this file remain byte-identical.
- proto-function-value.ts:457/478: one read and one write in callable-bag
  default seeding. Require first-owner association and omitted-vs-explicit-null
  handling; never overwrite a prior null/relink or expose the companion.
- vec-proto-link.ts:168,352,398,417,493,551,569: four reads, three writes in this
  unchanged base. Huygens storage v1 is NOT integrated here. Its removal of six
  operations must be verified at integration; the class-root default gate
  remains, requiring an explicit default-only API, not recursive generic Get.
- wrapper-constructor-carrier.ts:401 (`OBJECT_PROTO=0` at :109): one read.
  Its current constructor shortcut ignores NULL_PROTO. Inventory only; no fix.

Allocations: runtime plain and boxed wrapper (now :2135/:3182), prototype
Object.create (:698), dynamic sentinel (:610). Own field/descriptor operations
on PropEntry, NativeProto, ObjVec and generator result fields are not Object
prototype slots. The source scan covers flat multiline instructions and named
Object aliases; it is not a binding/dataflow proof for computed instructions,
generic constructors, generated artifacts or foreign modules. Repeat Huygens's
closure audit against the final integrated tree, including constant-index uses.

## Required subsequent atomic APIs — not supplied or activated here

1. `__object_proto_actual(trustedOwner) -> externref`: one tagged field+flag
   decoder with real owner defaults. Explicit null bypasses defaults; omitted
   default is not actual null. Ordinary Object, boxed primitives, callable bag,
   generator bag, intrinsic companion, Object.prototype terminal and Array/
   class-root defaults require separate identity-aware preparation.
2. `__object_proto_store_raw(trustedOwner, validatedPrototype) -> void`: commit
   exact externref payload and only NULL_PROTO without intervening callbacks.
   Keep receiver-owner projection separate from raw proposal identity. Current
   typed Set factory is explicitly NOT this future API.
3. Actual-carrier prototype provider plus trap-free ordinary step with distinct
   ordinary-next/nonordinary-stop/unsupported outcomes; shared permission
   builder checks actual SameValue, extensibility, then mixed-carrier cycles.
   No unsupported/null/success conflation and no cycle-time proxy trap.
4. Migrate Object Get/Has/Set, enumeration, instanceof/isPrototypeOf, callable/
   fnctor legacy transfers, caches and all remaining physical consumers in the
   same semantic cutover. Preserve B Receiver propagation through non-Object
   hops. Widening only the factory/layout is NOT a viable intermediate fix.

Hume boundary audit adds two separate integration blockers, unchanged here:

- Parent lifecycle owner must prepare the finite default/seeder/callable
  dependency closure before callable-view and proto-index consumers snapshot
  it. Singleton fills must then be emission-only. Native-first JS, native-regime,
  standalone and WASI gates differ; no global gate or protoMemberDirty widening.
- Parent/runtime owner must design the native-owner bridge for host-view
  prototype AND integrity operations, plus legacy host import routing.
  `_wasmStructProto` and host backing-object prototype cannot become competing
  authorities for native Objects. Same-owner reverse identity, foreign views,
  default singleton mapping and proxy invariant-compatible commit policy remain
  unresolved integration work. No boundary export/import changes in this phase.

Old compiler/provider retirement remains blocked until full IR equivalence.
All existing failures/controls are retained; no passing behavior is claimed.

