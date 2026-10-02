# PR5748: current array-property dependency plan

Source-only inspection of /Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927. HEAD60fb42a20c0c71e1f273527571170e38da9e5d1e with uncommitted main7443 integration. Russell owns all integration edits/tests. No compiler, native fixture execution, tests or integration edits performed. This refines the retained September15 specification against current source, not a new migration.

## Original population, unchanged

Read all four full originals in /private/tmp/js2-test262-b363-vBCLpp/test and independently matched recorded SHA256:

- built-ins/Array/prototype/indexOf/calls-only-has-on-prototype-after-length-zeroed.js: e570b835839f9190bc1e933035848176b757f66795b2f5b177af52b7ff3a404b
- built-ins/Array/prototype/lastIndexOf/calls-only-has-on-prototype-after-length-zeroed.js: dc38ac16a4cf88eb5b4ed382532f7557a843d47421e3b683b3dd1fc25f3e2c8a
- built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js: e15dd8fd65ed8f6252513970a71115f8b3bd39db80afe187fc065e5f8e89ecff
- built-ins/TypedArrayConstructors/internals/Set/BigInt/key-is-valid-index-prototype-chain-set.js: eef01ea89aebbe41a4746a605495d3a2bc88bf0fbf2d84be5c8fbbeabdad9162

Search originals install Proxy(Array.prototype), then fromIndex.valueOf truncates the original array. Algorithms retain initial length3 and perform HasProperty in orders0,1,2 /2,1,0. Get must not run when Has is false. The source comments mention100, but actual arrays have length3; do not derive loop bounds from comments. Quiet completion alone is vacuous if prototype installation was dropped: retain originals and add separate installed-identity/throwing-has positive controls.

TypedArray originals retain all constructor loops and receiver variants: ordinary object, Proxy object (one defineProperty trap), nonextensible object (strict TypeError), ordinary array (own value identity and length1), String wrapper. Targets remain0/0n; valueOfCalls stays0. Poisoned TA.prototype[0] accessor must remain unreachable. The array subsection is not permission to delete other receiver assertions or replace TypedArray exotic Set with ordinary prototype recursion.

## What exists versus missing

A0 src/codegen/vec-own-index-export.ts is already present and hooked by vec-access-exports.ts:529. It emits allocator-owned collision-safe \_\_vec_own_index[$...] with Program ABI derived ordinal11, final descriptor/function correspondence, logical AND backing bounds, exact f64 hole bits, and instance-local externref Hole equality. 1/0/-1 means raw storage present/absent/unavailable. It is neither a descriptor nor HasProperty.

Main also supplies \_\_vec_has_own_index in vec-access-exports.ts:898 onward and runtime \_vecOverlayOwnIndex:7157. The latter honors host deletion tombstones and tri-state replies. Preserve/reuse these useful own-storage pieces where their authority is established; do not blindly alias A0 to the fixed export label. Existing main externref hole detection is not proof of supplying-instance identity.

No A0 consumption/publication appears in runtime.ts or init-marshal-helpers.ts. Existing init helper names at init-marshal-helpers.ts:59 omit it; helperFunc:111 searches internal names. A0 explicitly returns its exact allocator descriptor through vecOwnIndexExport(ctx); publication must resolve THAT allocation, not a user same-name function. Append a new registration wire ID without changing existing IDs or core six vector ordinals. Keep start-time and post-instance callable identity coherent with the supplying callback/export slot.

runtime \_decoderExportsFor:6472 delegates to cross-module-struct-owners.decoderFor:102, whose search selects a compatible decoder; unnamed vecs can miss, and canonical Wasm types can match different instances. Therefore it is not an ownership certificate for the instance-local Hole singleton. Do not use successful ref.test, helper name, latest instance, or first accepting module as supplying-instance proof. Preserve real instance provenance at the actual exported-return/import callback/linked crossing before canonical facade construction. The implementation must first identify those authoritative crossing hooks; absent provenance stays unavailable, not false/dense. This is the principal remaining owner design obligation.

## Bounded implementation order

1. **Authenticated helper publication and provenance.** Narrow init-marshal compiler/runtime twin plus actual crossing registration. Use A0 descriptor identity and supplying instance live slot; preserve collision and start-window behavior. Add same-binary-two-instance, linked foreign vector, colliding user export, init/post-init controls. Do not infer module owner from representation compatibility.
2. **One ordinary-array live facade from first exposure.** Reuse \_hostProxyCache/\_hostProxyReverse and \_wrapVecForHost (runtime:8614). \_\_make_iterable:18061 currently has a separate convertedArrays snapshot cache. Unify only ordinary-array identity with the live facade; retain distinct tuple/arguments/TypedArray owners and intentional copies. Never unwrap arbitrary user Proxy or replay a live facade as snapshot writeback.
3. **Actual prototype mutation + shared own/Get/Has.** \_\_host_set_struct_proto:17029 currently ignores non-Wasm receivers and records raw links without operating on the array target. Install the actual parent on canonical target, preserve language/raw link, validate before commit, and implement Object/Reflect failure distinctions. Getter receiver must be original facade.
   - Own descriptor: sidecar/descriptors/tombstones then authenticated raw presence, length separately. Own undefined shadows; absence traverses.
   - Get: own getter once; setter-only yields undefined; absent own property uses receiver-preserving Reflect.get(parent,key,receiver).
   - Has: no Get/gOPD on parent; use Reflect.has, preserve Proxy effects/errors.
   - Preserve exceptions; no undefined-based retry or catch-to-absence.
4. **Receiver-aware Set/Define/delete/length closure.** Current ordinary-array facade numeric get/has/gOPD use length; defineProperty mostly writes proxy target while compiled storage remains separate. Close these via existing \_vecDefineOwnProperty and sidecar/writeback owners, not a second array store. OrdinarySet with TypedArray parent and DIFFERENT receiver creates receiver's own value without coercing it or altering target; enforce array length and Proxy/nonextensible semantics.
5. **Route actual language consumers.** \_safeGet:5660+ returns raw vec value before prototype; **extern_get_idx:13407 retries reads, **extern_has_idx:13475 retries/catches. Replace only selected ordinary-array branches with shared service. Audit typed property-access/binary-ops-in and IR array-element/from-ast readers: bounds proof is not own-data proof. Keep raw storage primitives for internal consumers; route property semantics before them. No call-site exemption or global OOB constant change.
6. **Parent-only acceptance/guard change last.** javascript-semantic-safety.ts:192 ARRAY_PROTOTYPE and sparse-presence refusals remain until implemented population passes actual runtime equivalence. Keep unavailable standalone/linear/exotic populations refused. Preserve seven adversarial origins and original four files/harnesses/strict behavior.

## Reuse limits and acceptance

\_readOwnDescriptor plus \_vecOverlayOwnIndex already solve parts of ownness, not prototype dispatch. \_protoIndexHas/Get:530 consult only host Object.prototype; they cannot substitute for arbitrary installed Array/Proxy/TypedArray parents and \_protoIndexGet lacks original Receiver. \_wrapVecForHost raw numeric branches and duplicate mirror remain actual current gaps, not merely stale September15 text.

Keep originals plus separate positive controls for installed identity, inherited7, own undefined vs hole, getter receiver/exact one Get, zero getters for Has, throwing/revoked Proxy, null/replaced prototype, mutation return identity, no-coercion TypedArray Set, and reentrant truncation. Include same-instance/cross-instance export authenticity and unknown=-1. Record actual emitted IR functions, not merely IR-enabled whole-file passes. Neither raw-presence tests nor guard-filtered originals clear HOLD. No test results claimed here.
