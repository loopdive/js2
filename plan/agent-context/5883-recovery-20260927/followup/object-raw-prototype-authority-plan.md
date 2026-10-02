# PR5883 dependency: lossless Object prototype authority

2026-09-27. Hume, source-only architecture. Read the FULL retry audit and Huygens's FULL `5883-vector-prototype-provider-blocker-20260927.md`. Immediate retry is rejected; this document contains no retry, deferred activation, signal plumbing, new compiler failure policy, or third attempt. Parent retains activation. No production/test changes, compiler/tests, git mutations or PR actions were performed. Only this owned planning document is written.

Source anchors below use `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-vector-prototype-storage-20260927`, whose blocker records bed38fc00a plus frozen storage v1. Parent must reconcile against integration before patching. Storage v1 and all existing fixture sources/results remain evidence, not acceptance. Huygens's six mixed-authority controls are authored/unrun according to the blocker; do not invent measurements.

## Representation decision

Authorization update: parent selected this existing-slot externref direction for bounded inventory/encapsulation planning ONLY. Phase 2 below is a proposed dependency, not permission for broad atomic cutover. Default-provider ordering and native/host routing followup: `5883-object-default-provider-boundary-audit-20260927.md`. No retry work is authorized.

Choose **field 0 of the existing final $Object struct becomes mutable externref**, retaining its field index and the other five fields. Do not add a map or second raw-prototype field. Keep the existing NULL_PROTO bit as the discriminator for an omitted intrinsic default versus explicit null. Together field 0 and that bit are one tagged logical slot, not independently competing authorities.

Valid states:

- Non-null field 0: exact actual JavaScript object/function identity; NULL_PROTO clear.
- Null field 0, NULL_PROTO set: explicit null, terminal.
- Null field 0, NULL_PROTO clear: unmaterialized default, decoded using the actual owner/carrier's default provider. This is NOT apparent JS null and MUST NOT enter SameValue as null.

Raw externref can carry vector, closed instance, callable, proxy, native prototype singleton and boundary object without losing identity. Validate Object-or-null at the existing public boundary; never classify an unrepresentable object as null. Reads of the logical slot use one decoder. Setters compare decoded actual current identity with raw proposed identity before extensibility/cycle checks. A successful explicit set stores the raw proposal, including an explicit intrinsic singleton. It need not compress an explicit default back to omitted form.

Use the existing NULL_PROTO bit rather than adding another presence bit for Object. Its two null encodings already exist; widening the payload removes the lossy Object-only constraint. Vector metadata remains its existing present+raw externref pair, with a separate vector default decoder. Both decoders expose the same actual-prototype API. Neither copies the other's link nor treats a property bag as the prototype identity.

Rejected alternative: append a raw field while keeping the old proto field live. That gives two values to reconcile and lets old typed readers keep answering stale chains. A single-owner extension could be sound only if the old field is permanently retired and every reader migrates anyway; it increases Object size/constructor operands without reducing the semantic work. An out-of-line single-authority table would require identity lookup on every Object hop and migration of every old field access; no advantage is established. Changing field 0 also makes stale typed uses easier to catch structurally, though valid Wasm alone is not semantic proof.

This is a broad shared-runtime prerequisite, not a one-file vector fix. Review phases may be separate commits, but a partially migrated representation must not be integrated as a working fix.

## Existing failure and exact correction

`object-runtime.ts:1195–1204` defines proto as ref-null Object. `object-runtime-prototype.ts:484` canonicalizes a proposal through proxy-target unwrapping and callable-view conversion; setter/status then cast-or-null. `returnIfSameEncodedPrototype:505` compares the resulting encoding before cycle checking. A vector proposal and an omitted default can therefore compare as encoded null despite being different JavaScript prototypes. A better cycle loop after that comparison cannot fix the lost identity or store a valid Object->vector link.

Remove proposal canonicalization from Object.create and Object/Reflect/__proto__ setters. Specifically, do not call `__proxy_get_target_if_absent` on the prototype argument: absence of a get trap is unrelated to prototype identity or ordinary [[GetPrototypeOf]]. Do not call `__proto_from_function` on the proposal. Store the actual argument. Remove blanket `__function_from_proto` decoding on raw Object field results; those values are already identities, not encoded views.

Receiver projection is a DIFFERENT operation. A function or generator whose existing prototype slot is owned by an identity-associated Object bag may still select that owner for a write/read. This selects WHERE its slot resides; it must not transform WHAT prototype is stored. Name and type these two operations separately so a receiver-owner projection cannot accidentally be reused on a proposal.

## Authority API and invariants

Introduce a small `object-prototype-slot.ts` owned by the Object runtime lane. It defines the field/flag emitter constants and reserves these private helpers before dependent bodies are emitted:

- `__object_proto_actual(objectOwner) -> externref`: decode field+bit and actual owner default. Input is a trusted Object owner, not an arbitrary public value.
- `__object_proto_store_raw(objectOwner, prototype) -> void`: trusted validated commit; stores raw payload and updates only NULL_PROTO, preserving integrity/other flags. No allocation, getter, proxy trap, or callback between the field/bit writes.
- A default-only emitter/provider used by the decoder, never a call back into generic __getPrototypeOf on the same owner. It must know when an Object is an ordinary object, boxed primitive, callable-owned bag, generator-owned bag or intrinsic companion. Prefer initializing nonordinary bag defaults explicitly at their allocation/first-owner-association point so ordinary omitted-default decoding remains simple. Never infer an owner's brand from the bag's own properties.

Huygens's provider module exposes actual-carrier GetPrototypeOf and a distinct trap-free ordinary-step result: ordinary+actual-next, nonordinary-stop, or unsupported/unresolved. Unsupported is not null/nonordinary/success. Reserve/fill coverage for every supported carrier before executable paths can use it; an incomplete provider remains a development blocker rather than a fabricated runtime answer.

The shared setter permission builder performs raw SameValue(actualCurrent, proposed), extensibility, then the ordinary-only mixed-carrier cycle check. This builder serves Object status and writer and vector status/writer. Public Object.setPrototypeOf and inherited __proto__ preserve throw semantics; Reflect preserves false; trusted internal writer behavior stays as previously specified. A declined set writes neither payload nor flags.

Cycle checking must compare each exact cursor identity with the target, and stop at a nonordinary [[GetPrototypeOf]] without invoking its trap. Observable getPrototypeOf/instanceof/isPrototypeOf traversal is a different operation and uses applicable exotic behavior. Mixed chains require the checker in BOTH Object and vector mutation directions.

## Layout/allocation inventory and mechanical patch

Direct field-0 and Object allocation searches in the inspected tree identify these physical consumers. Implementation must repeat a type-aware inventory (including aliases/multiline instructions), not rely exclusively on the spelling objectTypeIdx:

- `object-runtime.ts:1197`: sole inspected Object layout definition. Change field type to externref, keep final struct, props/count/tombstones/flags/nextSeq at 1–5. Update header schema and exported ObjectRuntimeTypes documentation. Do not reopen Object as a Wasm subtype: its existing canonicalization warning at 1207 explains that separate hazard.
- Object constructors: `object-runtime.ts:1995` plain allocation and `3020` wrapper allocation; `object-runtime-prototype.ts:697` Object.create; `dynamic-proto.ts:602` explicit-null sentinel allocation. All now push externref payloads, not ref.null Object. Flags/default policy must be explicit at each site; the dynamic sentinel remains a private representation marker and must never escape as the JavaScript prototype.
- Direct field reads/writes: `object-runtime.ts:2142,2159,2667,3458,3569,3779,3840,4760,4828`; `object-runtime-prototype.ts:509,588,601,845,856,974,1061`; `object-runtime-enumeration.ts:605`; `dynamic-proto.ts:566`; `proto-function-value.ts:457,478`; `vec-proto-link.ts:532`. These are a starting closure of direct physical accesses, not permission to ignore indirect consumers below.
- Mechanical changes include cursor/result local types, function/block result types, removal of obsolete extern.convert_any after raw loads, and removal of Object casts before raw stores. At an OWN descriptor/hash operation, cast only after proving the cursor is an Object; never recast arbitrary next links to Object.
- `context/types.ts` around 1785/2276–2292 documents dynamic null sentinels and callable-view helpers. Update their contracts to distinguish legacy identity adapters from raw Object slots. No public metadata should list internal proto state as an own JS property.

Centralize physical slot emitters so ordinary raw field reads outside the authority file are prohibited except explicitly named allocation/own-cache internals. A source inventory should classify every remaining Object field-0 operation as allocation, raw owner access, or intentional internal check, with a reviewer owning each exception.

### Parent-integration inventory correction (Huygens, read in full)

The storage-tree handoff `plan/agent-context/5883-object-field0-parent-inventory-20260927.md` supersedes the old coordinates above for parent integration. It records **28 physical access expressions plus four allocations**, a bounded inventory, NOT semantic closure or an atomic-cutover approval. Its subject was parent 18f1bd8 plus working-tree changes, with per-file hashes; do not reattribute these receipts to recovery139fa or main2a58.

Add `wrapper-constructor-carrier.ts:401`, using `OBJECT_PROTO = 0` at :109. The plain constructor shortcut checks raw null but ignores NULL_PROTO; its comment claiming explicit null is unrepresentable is stale. Assign this file to the callable/default-carrier owner. Encapsulation must expose the omitted-default predicate, not replace this with another bare null test. Semantic followup must distinguish explicit null, ordinary omitted default, boxed brands and an explicit custom chain before returning Object's constructor; constructor inheritance cannot be inferred from raw null alone.

Parent `vec-proto-link.ts` has **seven**, not one, Object field-0 accesses: writes :168/:551/:569 and reads :352/:398/:417/:493. Storage v1 replaces six; the remaining class-root read :493 corresponds to storage-v1 :532. Retain all seven in the parent inventory until the actual integration removes them, then account explicitly for each replacement. Do not use generic GetPrototypeOf recursively inside the implicit Array-root default provider.

Parent mappings: layout object-runtime.ts:1331; allocations :2129/:3176, object-runtime-prototype.ts:697, dynamic-proto.ts:610. Reads object-runtime.ts:2276/:2293/:2801/:3614/:3725/:3935/:3996/:4916/:4984; object-runtime-prototype.ts:509/:588/:601/:845/:974/:1061 and write :856; enumeration :613; dynamic-proto :574; proto-function-value :457/:478; vec and wrapper sites above. Huygens owns the physical inventory; separate semantic, default-provider, host and ABI closure remains required.

## Semantic readers: not merely changing cursor types

### Get and Has

`object-runtime.ts:2667` is __extern_get's Object chain hop. Keep efficient Object own-descriptor probing, but decode the next actual prototype on miss. Null returns the correct miss; an Object continues the own loop; a non-Object delegates to semantic Get(target=next,key,Receiver=original). Use B's receiver entry and preserve it across nested getter/proxy calls. An inherited getter returning undefined is a hit. Do not perform Has before Get, or append the receiver's branded/default companion after exhausting an explicit custom chain.

The old `__object_terminal_allows_implicit_proto` walk at 2114–2166 assumes every explicit link is Object and defers default handling until chain exhaustion. It cannot remain the fallback authority for mixed chains. Replace its callers with per-hop actual decoding. Retain a compatibility wrapper only for genuinely documented old callers, implemented through correct semantics; do not let a failed Object cast answer permissive true. A default Object singleton/companion must be visited once, not after explicit null or again after an exotic branch.

`__extern_has` at 4619–4856 has both fnctor-start and ordinary Object walks (4760/4828). Migrate both to actual mixed-carrier HasProperty; proxy has traps run exactly once, own descriptor getters never run. The `__extern_has_with_implicit_object_proto` wrapper around 4889 must not recreate a removed default edge. B's protocol facade and vector numeric/overlay miss readers then consume this coherent chain rather than another link store.

### Set and descriptor-sensitive inheritance

`__extern_set_decide` around 3364 reads the initial prototype at 3458 and advances at 3569. Other __extern_set inherited paths at 3779/3840 also assume Object. Replace all with receiver-preserving actual-chain descriptor dispatch. A non-Object next link is NOT absence and cannot authorize a new own property automatically. Preserve inherited nonwritable data refusal, setter call with original Receiver, own data creation and proxy set semantics.

Reuse `object-runtime-ordinary-set.ts`'s existing separate target/Receiver algorithm and proxy-first dispatch; its provider at line 98 already uses __getPrototypeOf. Factor a common descriptor decision where practical, but do not route back into __extern_set in a way that recursively repeats the same inherited decision. Existing __extern_set_own remains own-only. If the shared decision helper cannot handle a supported prototype carrier, that is a migration blocker, not an allow-own default.

### Enumeration, membership, caches

`object-runtime-enumeration.ts:605` __object_keys_forin advances an Object cursor and then appends implicit companion keys. Migrate inherited traversal to actual prototype steps and existing per-carrier own-key/descriptor operations. Preserve seen-key shadowing even for nonenumerable own properties; null stops. Proxy/exotic own-key and descriptor handling follows existing semantic providers, not bag enumeration. Own Object.keys/values/entries/Reflect.ownKeys and own descriptor/delete queries do not become prototype-inclusive.

`object-runtime-prototype.ts` __isPrototypeOf and its class/fnctor seeds, `vec-proto-link.ts` linked-instanceof, dynamic-proto.ts's mixed walk, and native-user/ordinary-instanceof consumers must compare exact identities and traverse all supported links. The Object field widening alone does not update these semantics.

Prototype caches require a separate correctness check. `object-runtime.ts:2189–2203` describes cache staleness by owner.props identity; cached entry validity alone does not prove the owner is still an ancestor after relinking. Hits at 2258/2269 and method lookup sites around 10804/11177 must validate the current structural root/link path or be disabled for a path they cannot validate. Prefer restricting the fast path to its proven immediate Object owner with a current-link identity check; do not introduce another mutable prototype authority. Test reparenting after cache warmup and mutation of an ancestor between reads. Do not resurrect the retired global table generation simply to hide this proof obligation.

## Callable, generator, closed and intrinsic defaults

`proto-function-value.ts` currently registers bag<->callable/view associations and seeds the bag link with Function's COMPANION when the Object slot is null (457/478). Under the new representation:

- Keep an existing identity association only as a receiver-owner adapter/legacy encoded-value decoder. It must not contain a second mutable prototype value. Selecting a function's owner bag and reading that bag's raw slot is coherent; exposing the bag itself as f's prototype is not.
- Seed a newly associated callable owner's default with the actual Function.prototype identity (or a trusted owner-aware default), never the companion-as-identity. Require both omitted-default state and first-owner initialization; explicit null must not be overwritten by a later conversion. Generator bags keep their factory-captured/explicit prototype; do not give them Function's default.
- NativeProto companions own descriptors, not the identity of the native prototype. A raw field pointing to Array.prototype stores the actual singleton/alias identity. Semantic Get can consult the companion while preserving the target's actual identity and original Receiver.
- Keep legacy fnctor `.prototype` storage distinct from instance [[Prototype]]. `expressions/fnctor-prototype.ts:523–574` still stores canonical callable views in its existing global and preserves RHS identity. It may remain encoded for this bounded migration ONLY if every transfer into the new raw Object slot or actual-carrier provider explicitly decodes at that trusted legacy boundary. Do not indiscriminately devirtualize arbitrary raw slot values. Prefer a named `legacyFnctorPrototypeIdentity` adapter rather than implicit conversion in generic setters.

Fnctor boundary inventory: expressions/fnctor-prototype.ts, expressions/new-super.ts, closure-prototype-edge.ts, fnctor-instance-prototype.ts, fnctor-array-prototype.ts, fnctor-missing-method-dispatch.ts, function-proto-has-instance.ts, native-user-instanceof.ts, object-coercion-fnctor-prototype.ts, generators-native-protocol.ts. They consume fnctorPrototypeObject/emitFnctorProtoGet or view helpers. Review construction, readback, method lookup and instanceof together. Do not migrate that data property to a second authority as a shortcut.

Closed instances with dynamic prototype fields retain their own existing raw slots/null sentinel encoding; dynamic-proto.ts normalizes the sentinel to actual JS null at the provider boundary, not by reading the sentinel's own default Object link. Closed immutable defaults, boxed primitives, native generators, Array subclasses and intrinsic singletons each need a recognized default-only provider. Use existing identities, not synthetic bags; Object.prototype terminates at null and Array.prototype aliases must not point back to themselves. Boxed Number/String/Boolean allocations at object-runtime.ts:3020 currently use omitted proto; explicitly establish their correct brand default at construction or through a tagged owner default, rather than incorrectly turning them into ordinary Object.prototype.

## Host / linking boundary

Raw externref does not require a new host import. Existing boundary Get/Set helpers at object-runtime.ts:993–1047 retain their signatures and must see exact proposal identities. Standalone remains zero-import for these controls. Public proxy receiver traps and their invariants still precede ordinary owner access.

Host-assisted code has a different authority: runtime.ts:15045–15113 consults `_wasmStructProto`, object-create records and fnctor/default metadata; setter support around 17017 owns host-side opaque-carrier links. Do not mirror native Object raw links into `_wasmStructProto` while native readers ignore it, or write that host record while native raw fields remain stale. Establish the existing lane/receiver ownership cut: native Object receivers are serviced by their native authority; genuinely host-owned objects by host operations. If a supported mixed boundary can route the SAME native Object through both, expose/delegate to the native owner at that boundary before claiming coherence. This routing audit is a required gate; representation widening alone does not prove it.

`emit/canonical-recgroup.ts:77–93` freezes vec/string types, not $Object. Changing Object does not by itself justify bumping that fixed membership's version. Nevertheless generated module type grouping, runtime provider artifacts and any Object-bearing exported/imported signatures must be inspected: old/new structural Object layouts are not ABI-compatible merely because externref is used at the outer call. Retain the old compiler/provider as baseline; no retirement. Regenerate/version affected artifacts through their existing owner if an actual Object ABI is exposed; do not silently mix layouts or add Object to the canonical group.

## Phases and disjoint ownership

1. **Inventory/encapsulation, behavior-preserving:** Russell/Object owner creates object-prototype-slot.ts and routes direct Object slot access through named emitters, with old behavior still intact. Record constructors, owner-default kinds and every physical operation above. Parent verifies no stale alias/multiline consumers. No new accepted behavior claimed.

2. **Atomic representation + semantic cutover:** Russell owns object-runtime.ts layout/allocations and Object Get/Has/Set chains; prototype owner owns object-runtime-prototype.ts only after Russell's slot ABI is frozen. Object.create, status, writer, actual decoder and mixed-cycle provider must land coherently; no successful cast-to-null interim. Files may be serial commits for review but cannot form a partially accepted integration checkpoint.

3. **Disjoint consumers against frozen slot API:** enumeration owner owns object-runtime-enumeration.ts; callable owner owns proto-function-value.ts and targeted fnctor identity-transfer adapters; dynamic-class owner owns dynamic-proto.ts. Parent assigns each named file exactly once and reconciles Russell/Singer/B overlap. No concurrent overlapping hunks in object-runtime.ts.

4. **Huygens provider integration:** Huygens retains vec-props.ts/vec-proto-link.ts storage v1 and the default/ordinary-step/cycle provider module. Consume Object authority read-only, replace the remaining class-root Object field read at vec-proto-link.ts:532, retain class install+instanceof behavior. Object and vector status/writer use the same ordinary cycle rule.

5. **Parent lifecycle/boundary integration:** parent owns both index.ts reserve/fill hooks, B final receiver hooks, compiler/link/runtime artifact policy, frontend getPrototypeOf folds, and any demonstrated host-boundary dispatch patch. B owns only its receiver/protocol adapter adjustments. A/C/D stable aggregate/captured-next and frozen promise-combinators.ts remain untouched. Activation question stays separate.

Reservation order: reserve Object slot, actual default and ordinary-step/cycle signatures during ordinary runtime construction before their mutual callers bake instructions. Complete carrier/default identity registration before one-time fill. All allocating callable/native-prototype dependencies must be established while registration is open; no finalizer imports. Resolve stable handles by name/defined-function API; do not subtract current import count from captured indices. Fill placeholders once; splice fresh late dispatch arms rather than rebuild shifted bodies. Both pipelines finish storage/providers/readers before B's last receiver hook and optimizer/DCE. Missing providers are a development/integration blocker, never a successful null stub.

## Migration acceptance and stale-consumer closure

Parent executes tests serially; none run here. Preserve the original eight vector prototype controls, six mixed-authority controls, original twelve Promise sources and all prior failures. Add controls rather than alter bodies/expectations:

- Object.create and setPrototypeOf with exact ordinary Object, vector, callable, closed instance, proxy and native prototype identities; null/default/restoration; Object.create descriptors retain order and accessor semantics.
- Both mixed-cycle directions, multi-hop Object/vector/function/closed chains, self-cycle, same actual prototype after preventExtensions/seal/freeze, different prototype refusal, Reflect false and Object/__proto__ TypeError with unchanged links. A non-null unsupported Object representation must never compare equal to omitted default.
- Proxy as prototype: setter does not unwrap it or invoke get/getPrototypeOf traps for ordinary cycle probing; Get/Has/Set through it invoke the correct trap once with original Receiver. Revoked proxy storage itself must not inspect a trap; later semantic access throws according to existing proxy behavior. Proxy-as-target invariants remain distinct.
- Own/inherited data undefined, accessor undefined, nonwritable data, missing setter, numeric holes/NaN, live vector indices/length; mixed chain Reflect.get/Reflect.set with a different Receiver; getters/setters reenter and relink ancestors.
- Callable raw link identity and Function.prototype method inheritance; explicit null survives repeated owner-view creation; generator factory links stay generator links. F.prototype=callable/vector/proxy produces exact instance getPrototypeOf and instanceof semantics, while assignment expression returns raw RHS.
- Object.prototype terminal, Array.prototype alias parent, subclass super installation and relinking, wrappers' brand defaults, dynamic closed null sentinel normalization. No bag/sentinel/companion identity leaks through public getPrototypeOf.
- Warm ordinary/method property caches, then replace direct and ancestor links; repeated read must follow new chain. for-in shadowing/nonenumerable suppression, own keys/descriptors/delete/integrity remain own-only and never expose metadata.
- Standalone and host/boundary controls in both single/multi pipelines; zero-import standalone receipts; type/stack validation, no stale ref-null Object operands on raw loads, no wrong constructor arity, retained canonical vec/string fingerprint where required. Check both old/new compiler paths without retiring either.

Final source closure criterion: every Object field-0 read/write/allocation is classified; every old view-conversion call is classified as receiver-owner selection or trusted legacy identity decode; no raw prototype proposal is canonicalized/unwrap-copied; no Object-only chain walk truncates a supported non-Object link; no generic miss appends a phantom brand tail after explicit null/custom exhaustion; no host/native duplicate authority for the same receiver. A textual grep or valid module alone does not discharge these semantic conditions.

This plan provides a viable lossless representation and ordered migration, not an acceptance claim. The required expansion beyond vector-only storage is explicit: shared Object readers, callable/default authorities and host-boundary routing must be coherent before the held Promise behavior can be declared unblocked.

