# Object field-0 inventory against parent integration

Source-only, bounded verification of Hume's FULL
`5883-object-raw-prototype-authority-plan-20260927.md` from acquisition-plan tree.
Read-only subject: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927`,
branch `codex/5883-preservation-repair-20260927`, HEAD
`18f1bd831312b3f5805f1e176388aac449c2d389` **plus working-tree changes**.
HEAD alone is not the inspected source revision: scoped diff showed
object-runtime.ts +164/-8 and dynamic-proto.ts +31/-18 at inspection.
Only this inventory is written in the storage owner's tree. No cutover,
production/test edits, compiler, test, typecheck, commits, push or parent writes.

## Verdict and corrections to the plan

The representation hazard and the listed physical access families are confirmed.
The plan is a useful starting inventory, NOT yet the complete integration list:

1. **Add wrapper-constructor-carrier.ts:401**, missed by literal `fieldIdx: 0`
   search. `OBJECT_PROTO = 0` at line 109 is used by `wrapperConstructorArmInstrs`
   (line 281), ordinary-object constructor shortcut. The plain arm tests only
   primitive-slot absence and raw proto null, then returns Object's constructor.
   It neither decodes the actual prototype nor checks NULL_PROTO. Its nearby
   comment claims explicit null is unrepresentable, but parent Object already
   has NULL_PROTO (object-runtime.ts:352). Changing field type alone leaves this
   shortcut valid Wasm but does not establish correct explicit-null/custom-chain
   semantics. Assign this file an owner before cutover.
2. **Parent vec-proto-link is not storage v1.** Parent has seven Object field-0
   operations. Hume's single `:532` reference is the frozen storage-v1 class-root
   consumer, not a full description of parent. Do not drop the six additional
   parent operations from inventory before the actual v1 integration replaces
   them. Class-root read parent:493 corresponds to storage-v1:532.
3. Parent line offsets differ, especially object-runtime.ts and dynamic-proto.ts.
   Use the helper/site mapping below, not the plan's original line coordinates.

## Physical layout and allocation operands

Sole directly identified Object layout: object-runtime.ts:1329–1341, proto field
at **1331**, mutable `(ref null $Object)`, final struct retained. Props/count/
tombstones/flags/nextSeq remain fields 1–5. Header schema at line 23 and
ObjectRuntimeTypes at 359 also need contract review. Field widening does not
change constructor arity, but DOES change operand and downstream cursor types.

Four direct Object allocations identified across src (same families as plan):

- object-runtime.ts:2129, `__new_plain_object`; proto operand at 2122 is typed
  ref.null Object, flags zero. New ordinary omitted default must be explicit.
- object-runtime.ts:3176, `emitWrapperBuildTail`; proto at 3169 is typed null,
  flags zero, shared by boxed primitive wrappers. Brand default cannot be
  inferred as ordinary Object.prototype merely because the physical slot is null.
- object-runtime-prototype.ts:697, `__object_create`; preceding if block returns
  objRefNull after canonicalization/cast-or-null. Both block type and proposal
  conversion must migrate, not just struct.new's definition.
- dynamic-proto.ts:610, private explicit-null sentinel allocation; proto at 602
  typed null, flags zero. Sentinel remains private and its identity normalizer
  must remain the boundary, not its ordinary Object default.

No additional direct Object `struct.new_default` allocation was found in the
bounded search. This is a direct-emitter inventory, not proof about arbitrary
generated/generic constructors or externally supplied modules.

## Direct field-0 read/write closure found

**28 physical get/set expressions**: 27 literal-index expressions and one
constant-index expression, across seven files. Counts are source expressions,
not emitted runtime calls. The four allocations above are counted separately.

- **object-runtime.ts — nine reads:**
  - 2276,2293: `__object_terminal_allows_implicit_proto` terminal test and advance.
  - 2801: Object `__extern_get` chain advance (old plan 2667).
  - 3614,3725: `__extern_set_decide` initial inherited cursor and next hop
    (old plan 3458,3569).
  - 3935,3996: other inherited-set initial/advance paths (old 3779,3840).
  - 4916,4984: fnctor-start and ordinary Object `__extern_has` walks
    (old 4760,4828). `__extern_has_with_implicit_object_proto` now at 5045.
  None can assume raw next is Object, or treat an unsupported cast as no link.
- **object-runtime-prototype.ts — six reads, one write:**
  509 encoded SameValue; 588 raw/devirtualized answer; 601 omitted-vs-explicit
  null branch; 845 writer cycle advance; 856 successful store; 974 status cycle
  advance; 1061 isPrototypeOf advance. Plan coordinates still match this file.
  Writer/status must compare actual identities before encoded conversions;
  observable traversal and trap-free ordinary cycle traversal remain distinct.
- **object-runtime-enumeration.ts — one read:** 613, `__object_keys_forin`
  prototype advance (old 605). Preserve seen-key/nonenumerable shadowing; do not
  append an intrinsic companion after explicit null or custom-chain exhaustion.
- **dynamic-proto.ts — one read:** 574, `stepCurFrom5` inside struct-set cycle
  logic (old 566). Next instruction is extern.convert_any; obsolete for a raw
  externref slot. Closed-root dynamic field operations are a separate authority,
  not additional Object field-0 operations.
- **proto-function-value.ts — one read, one write:** 457/478,
  `bagFunctionProtoLinkInstrs`; tests null then seeds Function COMPANION as an
  Object link. Needs owner-default association semantics, actual identity and
  explicit-null preservation, not a mechanical cast removal.
- **vec-proto-link.ts — four reads, three writes in PARENT:**
  - 168 class-install bag.$proto write.
  - 352 `loadVecLink` bag.$proto read.
  - 398 Object branch seed for linked instanceof; 417 Object-only cursor advance.
  - 493 implicit Array-root class parent gate, with flag-4 NULL_PROTO check.
  - 551 linked Object proposal write; 569 unsupported-proposal clear.
  Storage v1 migrates all except the class-root read to metadata/semantic helpers;
  the class-root read still must use the eventual Object authority/default API.
  Do not replace this gate with generic actual GetPrototypeOf recursively: it is
  itself an implicit-default edge. Preserve explicit null and explicit relinks.
- **wrapper-constructor-carrier.ts — one constant-index read:** 401 via
  OBJECT_PROTO=0, as described above. Add to Hume's physical and semantic lists.

## Alias/multiline search and bounded exclusions

Used rg multiline instruction searches, then a read-only Node text scan over
`rg --files src` to match complete flat instruction literals across newlines and
independent property order, extracting typeIdx/fieldIdx. No TypeScript compiler
or project runtime was loaded. A second search covered reversed field/op order,
hex zero spellings, symbolic field names and Object index aliases. The initial
verbose JSON search truncated and was discarded as closure evidence; subsequent
plain matches and filtered scans were untruncated.

Checked Object-index aliases from `.objectTypeIdx`, including objTypeIdx,
objTypeIdxForIter/ForLazy, open, object and anyObjectCarrierTypeIdx, and member
expressions runtime/types/deps/rt.objectTypeIdx. No additional field-0 physical
access was identified through these aliases. Known nonzero aliases
OBJ_FLAGS_FIELD resolve to 4 (native-object-family-instanceof and
object-proto-proto-accessor), not prototype links.

False-positive field-0 examples inspected: iterator-protocol-get.ts:161 uses
protoType for NativeProto brand; generators-delegation-runtime.ts:437 uses
typeIdx from resultTypes(ctx) for result extraction. Object runtime method-cache
objStructDef/objTypes aliases at 10924 inspect **field 1** for props-array type,
not a hidden field-0 load. They still require the separate ancestry/cache proof
in Hume's plan. Object casts alone are not field-0 consumers.

Limit: this scan is not a TypeScript binding/dataflow proof. Computed indices,
spread-assembled Instr objects, generic constructors taking arbitrary typeIdx,
generated/provider artifacts and host opaque-carrier access can require separate
audits. A 28-expression match list does NOT discharge Hume's semantic closure or
ABI/host routing gate. Repeat against the final integrated source after edits.

## Source receipts

SHA-256 of parent files inspected (working-tree content, not HEAD blobs):

- object-runtime.ts: `d07b344269ba735b595b697034b8d3dfa05975b66260d5c071934c2a0ff738bf`
- object-runtime-prototype.ts: `ba25bde72b0f54e2e346dc3c12fe92b8bea8f02db73b62ee99a4d5ecdca6e820`
- object-runtime-enumeration.ts: `87625f31469967d49d4ccd9202ef814d712c433e499b881ca4d699f9644d0327`
- dynamic-proto.ts: `97f0087fc174075324eaea586630863de8752836a3bc4ff0d0e7207a392d3e56`
- proto-function-value.ts: `32e239248baa5a65d9824e909e0ab703713e71184c0eea14c42481594dba9f75`
- vec-proto-link.ts: `d3c02f7dcd5b5ee9bf97ce6fb4be84760325ba2649b36a01a44e4a6ec462bc2f`
- wrapper-constructor-carrier.ts: `61e13eaec2bc6f06d52d118bcac3dffe7fddf7a426fcb0a4e358efd265413759`

Storage v1 and six unrun mixed-authority controls remain frozen. No compiler
handle or slot taken. This handoff is inventory only, not migration acceptance.

