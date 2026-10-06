# PR5883 dependency: vector prototype storage and semantic readers

Owner: Hume (architecture only). Date: 2026-09-27. Status: implementation plan, not implemented or accepted.

This is a bounded dependency of the original-source vector Promise.all/race work, not a replacement Promise migration. Parent owns source integration, source ownership reconciliation, serial compiler/tests, and publication. No source/test edits, compiler execution, tests, or git mutations were performed to produce this document. The adjacent acquisition/captured-next plan remains active. Its run02 history must not be silently rewritten as the current result.

## Evidence and acceptance boundary

Parent reports integration run59264: mutation 10/10; live substrate 10/12, shrink/regrow now passing, custom-prototype failure retained, Node hint canary 1111/111. The first eight prototype controls did not execute: their runner read `result.wasm` instead of `result.binary`. That attempt is instrument-invalid, not eight compiler failures.

Parent reports corrected run25114, terminal1: native 8/8 returning 1; compiled 0/8, zero imports; actual -1 except preventExtensions -2. Bodies and native expectations were unchanged. Receipt: parent `.tmp/5883-vector-prototype-controls-corrected-runner.log`; fixture `tests/issue-5883-vector-prototype-storage.test.ts`. These are runtime-observation failures, not a claim that compilation failed. Parent is extracting the passing seven-file mutation implementation and ten tests into a standalone PR. Neither that extraction nor this plan retires the remaining failures.

B handoff read: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-protocol-get-20260927/plan/agent-context/5883-protocol-get-handoff-20260927.md`. Source citations below are parent-tree paths relative to `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927`, inspected against the integration state described by parent as 18f1bd8 plus mutation work. Line numbers are navigation anchors, not immutable diff coordinates. B-specific changes refer to B's isolated tree; integration must resolve their final locations.

## Decision: extend the existing identity entry, not another side cache

`src/codegen/vec-props.ts:218` reserves `$VecPropEntry`; its fields at 226 are next, key, bag. The existing global head is reserved at 239, and the sole entry allocation is in `__vec_bag_ensure` around 395. Repository references to the entry type/head are localized to this implementation and context documentation. Reuse that identity owner.

Append two mutable fields at initial type reservation:

- Field 3: `protoPresent: i32`, initialized to 0.
- Field 4: `protoValue: externref`, initialized to null.

`protoPresent=0` means the existing intrinsic/default prototype for that actual carrier. `protoPresent=1` means `protoValue` is the exact actual prototype, including explicit null. Do not clear presence when setting null. Restoring Array.prototype stores that exact identity; no special clearing optimization is needed. Preserve fields 0–2 and existing bag helper ABIs.

The bag remains the authority for own properties/descriptors and integrity flags. It is not the authority for vector [[Prototype]]. Migrate all vector-link reads/writes away from bag.$proto together. Do not retain compatibility dual reads/writes, add an independently mutable global map, or encode this state as a user-visible property/symbol. Existing class-name and alias compile-time maps are not additional mutable prototype authorities.

Store raw JavaScript prototype identity, not the prototype's bag, callable proto-view, closed-struct view, or a copied/coerced vector. Those views may be used by dispatch internally but must not replace the stored identity or the identity returned by Object.getPrototypeOf. Proxy identities stay proxies. The public null/object validation remains at existing Object/Reflect/accessor boundaries; functions and supported closed carriers are objects for this purpose.

Do not equate `__is_vec_prop_carrier` with Array: it accepts vec_base families broader than source arrays. First ship the complete source-array family (all backing specializations and linked Array subclasses); preserve existing default behavior of other carriers. Metadata storage can be shared, but Array.prototype defaults require the actual array classifier. Typed arrays/buffers must not acquire Array semantics merely by matching vec_base.

## Concrete private runtime API

Implement storage primitives in `vec-props.ts`, exported emitter constants/reservation functions rather than callers spelling field offsets:

- `__vec_proto_lookup(value) -> (i32 present, externref prototype)`: read-only existing-entry lookup; no allocation; absence is distinct from stored null.
- `__vec_proto_store(value, prototype) -> void`: private trusted commit to the same existing entry. Reuse/factor the existing entry ensure so only one allocation implementation owns all five field initializers. This is not a public unchecked setter.
- `__vec_prop_get_r(target, key, receiver) -> externref`: explicit-receiver core, with existing `__vec_prop_get(target,key)` preserved as a wrapper passing target as receiver.

Implement semantic prototype helpers in `vec-proto-link.ts`, using ordinary-object/default dispatch support from `object-runtime-prototype.ts`:

- `__vec_actual_proto(value) -> externref`: lookup; present returns exact value; absent executes a default-only provider. Never recursively call the full __getPrototypeOf vector arm to obtain a default.
- `__vec_proto_status(value, prototype) -> i32`: compare actual identities first; if different, consult existing bag integrity flags and the ordinary cycle checker. No write or proxy trap.
- `__vec_proto_try_set(value, prototype) -> i32`: same validation/permission rule, commit only on success. Existing lenient internal writer returns its receiver on refusal; public Object/Reflect/accessor behavior continues to use the separate status result.
- `__vec_proto_get_miss(target,key,receiver) -> externref`: get actual prototype; null yields undefined; otherwise delegate once to the semantic receiver-preserving property Get.
- `__vec_proto_has_miss(target,key) -> i32`: null yields false; otherwise semantic HasProperty on the actual prototype, without calling getters.

Reserve names/signatures first and resolve stable handles through existing registration machinery. The multi-result lookup can be replaced by an internal nullable-entry return if that better matches the existing emitter, but presence and payload must still be read atomically from that same entry; no global scratch communication. Receiver/cursor/key locals are invocation-local and survive reentrant getters/proxy traps.

Default-only provider must preserve current lazy singleton identity and the Array.prototype alias special case: Array.prototype's own parent is not itself. Preserve the existing `wrapArrayProtoVecAlias` identity bridge, but never use it to normalize an arbitrary stored prototype. A non-recursive default provider factored from existing arms is a prerequisite, not a license to manufacture another Array singleton.

## Writer/status/cycle integration

`object-runtime-prototype.ts:880` has a separate `__object_setPrototypeOf_status`. Non-Object receivers currently return permissive true. Installing only a vector writer arm is insufficient. Add vector status and writer dispatch before their non-Object exits, with identical permission rules. Preserve proxy-target dispatch order and existing lenient internal writer behavior; public callers retain their own throw/false policy.

OrdinarySetPrototypeOf compares current identity before extensibility, rejects a different prototype on a nonextensible target, then checks ordinary prototype links before committing. During cycle checking it stops at a prototype with non-ordinary [[GetPrototypeOf]]; it must not invoke a proxy trap. See [ECMA-262 OrdinarySetPrototypeOf](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetprototypeof).

Factor a private `ordinaryPrototypeStep(value) -> (isOrdinary, actualPrototype)` dispatch in `object-runtime-prototype.ts`. It is not the observable generic GetPrototypeOf operation. It reads existing ordinary carrier authorities, including the new vector metadata, existing Object null-bit/default encoding, callable identity/view mapping, and supported closed ordinary instances. For proxies it reports nonordinary without invoking any trap. Unknown supported ordinary carriers must be implemented explicitly, not treated as null or silently called exotic. Unsupported representation coverage is a blocker to an unqualified complete-support claim.

Use the same cycle-walk builder in both status and writer validation, for both vector targets and existing ordinary Object targets. Otherwise a vector->Object->vector cycle can still be installed by mutating the Object endpoint. Compare exact identities before stepping each cursor. Do not call generic __getPrototypeOf in this validation loop. The checked path contains no user callbacks between permission check and commit; repeating the pure check protects direct internal writer callers without observable double traps. Existing public proxy setter/invariant machinery remains responsible for proxy targets.

Integrity flags remain in the existing bag resolved by `object-integrity-carrier.ts:99`; lookup without a bag means extensible. preventExtensions/seal/freeze may ensure a bag, but must not replace the entry or clear prototype fields. Same-value sets succeed after nonextensibility; changing to null is not same-value unless already explicitly null.

Public writer/read inventory:

- `expressions/call-builtin-static.ts:2146–2278`: Object.setPrototypeOf status, validation, proxy split, writer. Preserve raw proto expression identity through compileProtoArg; evaluate target/proto once in source order.
- `expressions/call-namespace-static.ts:1849–1891`: Reflect.setPrototypeOf status and writer, false rather than Object's throw on refusal.
- `object-proto-proto-accessor.ts:109–117`: inherited __proto__ setter status/writer; retain primitive receiver/prototype conventions.
- `expressions/assignment.ts` __proto__ lowering: check it reaches the same public policy and storage. Parent owns any overlapping mutation hunks.
- `object-runtime-proxy.ts`: retain proxy traps, target forwarding and nonextensible invariants; no direct metadata write before traps. Proxy-as-prototype and proxy-as-target are different cases.
- `vec-proto-link.ts:130` / `class-bodies.ts:638`: post-super Array-subclass installation uses the same raw metadata commit with the exact lazily created class prototype. This trusted construction path replaces bag.$proto writes, not public validation.

## Reader and consumer inventory: required changes

1. `vec-proto-link.ts:305–337`: remove linked-class gating from generic vector Get/Set support. Keep linked-class tracking only for legacy class-specific edges. Replace loadVecLink's Object cast/null-as-unset interpretation. `prependGetPrototypeOfArm` at 451 returns explicit null as final. `prependSetPrototypeOfArm` at 534 must not clear non-Object prototypes.

2. `vec-proto-link.ts:366` linked-instanceof traversal currently walks Object-only links. Use exact actual prototype traversal across supported carrier families; unlike setter cycle validation, observable instanceof/isPrototypeOf traversal must respect exotic prototype behavior. Preserve existing Symbol.hasInstance dispatch outside this helper. `object-runtime-prototype.ts:316` class-instance seed and __isPrototypeOf around 1000 also stop at Object-only links and need the corresponding target-neutral traversal. Audit `native-user-instanceof.ts`, `native-ordinary-instanceof.ts`, and `native-dynamic-instanceof.ts` callers for premature brand conclusions. Keep the synthetic Array-subclass root -> Array.prototype edge only where the existing ordinary default encoding legitimately applies, not after explicit relinking/null.

3. `vec-props.ts:94–117` receives explicitReceiverLocal but drops it in the vector branch. Pass it to the new receiver core. Own bag Get must use `__reflect_get_receiver(bag,key,receiver)`, not target unconditionally. Own-present undefined stops lookup. Only an actual own miss calls the new prototype miss helper. Apply the same rule to method-call property extraction: lookup receiver and subsequent call-this are distinct, neither is the bag.

4. `proto-index-store.ts:1653` __protoidx_get_r and __protoidx_has_r choose brand companions and ignore custom links. Interpose vector actual-prototype semantics before brand fallback. Crucially, `protoIndexRecvGetMissInstrs` at 332 has an explicit-receiver branch that directly calls GET_K; patch that branch too. Keep companion GET_K/HAS_K as intrinsic-tail readers, not a second authority for arbitrary custom chains.

5. Numeric miss APIs: `protoIndexGetIdxMissInstrs` at 586 already receives the target; retain it through actual-chain lookup and receiver-sensitive Get. `protoIndexHasIdxInstrs` at 568 currently receives only index and consultArray: it cannot discover a runtime prototype. Add a new receiver-taking vector miss builder and migrate the actual-array call sites; preserve old intrinsic/nonvector helper contracts where appropriate. Do not pretend changing __has_r repairs callers that never pass a receiver.

6. Numeric/miss call-site sweep (each must either use the new path or have a documented own-only contract): `object-runtime.ts` around 2365, 4630, 8938, 9194, 9349, 11479; `vec-externref-hole-presence.ts:64,163`; `vec-f64-hole-presence.ts:196`; `vec-overlay.ts:2736,3052`; `object-runtime-enumeration.ts:1031`; and `builtin-proto-member-override.ts:227,289`. Preserve nonvector closure/primitive readers and closed-struct consultArray=0 branches around object-runtime 12298. The inventory is by helper/call site, not line-number patching against moving source.

7. Explicit receiver through indexed dispatch: B's common __extern_get receiver entry is necessary but not sufficient if a numeric branch calls a two-argument __extern_get_idx that resets receiver to target. Add/factor `__extern_get_idx_r(target,index,receiver)` for semantic vector indexed reads, preserving the old two-argument entry as a wrapper. Thread receiver to overlay descriptors, own accessors and inherited misses. B's reflected Get of a vector used as another object's prototype must not accidentally invoke its accessor with that intermediate vector as this.

8. `proto-index-store.ts:1297` SET_R and `vec-props.ts:483` inherited write decisions need the same actual-chain selection when consulted. They must not consult Array.prototype after an explicit null/custom link. Preserve existing own-property mutation machinery; this is not a redesign of all assignment lowering. Likewise audit `protoIndexForInPushInstrs`: inherited enumeration cannot use a phantom default chain, while metadata remains absent from own enumeration.

9. `expressions/object-get-prototype-of.ts`: static Array/ReadonlyArray branch at 462 and array literal/initializer branches at 469/484 can return the intrinsic without consulting actual storage. The integrity fold at 283 precedes the dynamic runtime-read gate at 294. Route actual vector receivers through runtime GetPrototypeOf, evaluating the expression once. Do not trust receiver-name prescan/alias-blind syntactic absence of setPrototypeOf as immutability proof. Narrow these changes to array-shaped receivers; retain unrelated primitive/immutable-brand folds. Audit the class-root fold against the same explicit-link rule.

10. `property-access.ts` typed/raw numeric reads (including hole conversion around 4601 and indexed fallback around 5875/6007) must retain semantic hole/OOB misses. Dense own data may remain fast only after existing descriptor/overlay checks; undefined and NaN are values, not absence markers. `builtin-proto-member-override.ts` direct-method shortcuts and `vec-own-to-primitive.ts` must not resurrect a removed intrinsic prototype. Check direct typed named/indexed lowering, not merely dynamic protocol Get. If those emitters cannot express the receiver-preserving miss, route the affected vector read through the semantic helper rather than claim full support.

11. B's `iterator-protocol-get.ts` should consume the corrected existing property dispatch, not add its own prototype map or bypass source overrides. Its own-overlay presence, native companion tombstones, callable/closed method values, and original Receiver rules remain. Acquisition/captured-next order does not change: Get @@iterator once, Call with source, validate iterator, Get next once, retain captured method and iterator. The live intrinsic values carrier uses semantic length/index on the original source; it must not snapshot or bypass custom prototypes.

## Inventory that must remain own-only or otherwise unchanged

`carrier-bag-visibility.ts`, `carrier-bag-delete.ts`, `carrier-bag-define.ts`, `vec-bag-seed.ts`, and `vec-props-key-source.ts` own-property identity/descriptor/key operations continue to use the original bag. Metadata fields do not become keys, descriptors, or deletable properties. `vec-access-exports.ts` __vec_has_own_index remains OWN presence: do not change it into inherited HasProperty. Its raw marshalling helpers are not a substitute for source-level semantic Get. `protoIndexBrandCompanionHasInstrs` is a companion-specific query, not automatically a generic HasProperty operation.

Audit all calls of the old indexed miss builders at implementation review; the missing receiver API makes an unchecked global search-and-replace unsound. Own-key collection and inherited for-in traversal require different treatment. Keep closure-only readers, primitive methods and non-array brands on their existing providers unless this dependency explicitly reaches them.

## Reservation, fill, hooks, function/type index safety

1. Extend `$VecPropEntry` during reserveVecPropHelpers, before type finalization and before any struct.new body is built. Update `context/types.ts:2306` shape documentation. Do not append fields after type indices have escaped or reserve a shadow type late.

2. Reserve storage, vector semantic, default-provider, ordinary-cycle, and receiver-aware helper signatures before recursive dependency construction. Use stable defined-function handles/name lookup. Install reservation state before recursive ensure calls; a construction failure must not leave a falsely initialized usable helper. Temporary unreach placeholders must all be filled before serialization.

3. Fill existing entry allocation with all five fields and fill storage bodies once. Then fill default/cycle and vector semantic helpers after required Object/proxy/callable/closed/default providers are known. Calls may target reserved bodies, so recursive dependency edges do not justify rebuilding emitted helpers later.

4. Register generic vector GetPrototypeOf/status/writer support independent of linked Array classes and protoIndexDirty/protoNamedDirty. Otherwise the eight plain-source controls remain unreachable. Default/no-link programs allocate no new entry merely to read. DCE can remove unused helpers, but any source set/get and semantic miss must produce a genuine call path; no dummy references or keepalive probes.

5. Update both standalone/module entry pipelines around `index.ts:6830,11489`. The generic vector finalizer must run even when `linked.size===0`. Apply receiver-sensitive prependers before B's final `finalizeExternGetReceiverEntry` in BOTH pipelines; that finalizer remains after all relevant reader/overlay prependers and before optimizer/DCE. Parent owns these shared integration hunks.

6. Never compute a defined body index by subtracting the current import count. Use mintDefinedFunc/definedFuncAt or the established stable funcMap machinery. No late imports as a convenience. Every emitted Instr tree is fresh; do not share nested instruction objects across functions/branches. Fill reserved bodies once and splice late dispatch arms using existing stable handles, rather than regenerate bodies with stale captures after index remapping.

7. Get/Has may invoke arbitrary code. Keep target, original Receiver, key, cursor, presence, and returned value in locals. If B's explicit-receiver context uses globals, retain its exception-safe save/restore common entry for nested calls and throws; never borrow those globals as prototype-storage scratch. Iterator state, Promise aggregate state and captured-next state remain in their existing owners.

## Bounded disjoint implementation ownership

Parent should assign one prototype-storage implementer only when mutation/intrinsic work is solid; no new B agent is requested by this plan.

- Storage owner: `vec-props.ts`, `vec-proto-link.ts`, `context/types.ts` shape documentation, new private helper exports in these files. Own all metadata reads/writes and class-install replacement; do not add a new side-table module.
- Semantic-miss owner, after storage API freezes: `proto-index-store.ts`, `vec-externref-hole-presence.ts`, `vec-f64-hole-presence.ts`, `builtin-proto-member-override.ts`, and narrow own/inherited enumeration adapter changes in `object-runtime-enumeration.ts`. Parent can assign this to the same developer serially; no concurrent edits with storage owner in vec-props.
- Parent-reserved integration hunks: `object-runtime-prototype.ts` ordinary cycle/status/default support; `object-runtime.ts` receiver-aware indexed entry and dispatch; `index.ts` both pipelines; `vec-overlay.ts` after mutation lane lands; `expressions/object-get-prototype-of.ts`, `property-access.ts`, and any demonstrated direct-call/frontend bypass. These are enumerated source dependencies, not permission for speculative unrelated cleanup. Reconcile Singer's class-lane object-runtime hunks and B receiver-entry changes explicitly.
- B retains `iterator-protocol-get.ts`, `iterator-proto-next.ts`, `proto-override.ts`, and its explicit-receiver entry work, adapting only agreed calls. A retains acquisition/captured-next; C/Curie retains live iterator substrate; D retains stable aggregate/drive. Huygens's mutation extraction must remain independently reviewable. If parent hands off one shared file, transfer ownership explicitly rather than simultaneous patching.

This cannot credibly be shipped as a one-file vec-proto-link fix. Minimum coherent patch comprises storage plus status/default/cycle plus all semantic miss entrypoints and affected static bypasses. A smaller storage-only commit may be an intermediate review unit, but is not the completed dependency and must keep all failing acceptance cases recorded.

## Exact acceptance, run only by parent

Retain the eight fixture bodies and native expected 1 unchanged:

1. Plain-object prototype: setter returns source; getPrototypeOf returns the exact p.
2. Explicit null is returned as null.
3. Null then Array.prototype restoration preserves that exact singleton identity.
4. Callable prototype identity is preserved.
5. Vector prototype identity is preserved.
6. a->p then p->a rejects with TypeError and leaves both prior prototypes unchanged.
7. Same prototype after preventExtensions succeeds; a different null prototype throws and leaves p installed.
8. Sparse source [,undefined,NaN] using intrinsic values with custom p inherits index 0 as 41 with this===source; subsequent own undefined and NaN remain distinct, all three not done.

Additional required focused controls, same native/compiled source and exact event log/value comparison:

- Reflect.setPrototypeOf refusal returns false; Object and inherited __proto__ setter throw according to their existing boundary policy. Primitive/null argument validation remains correct.
- Mixed vector/plain-object/callable ordinary cycles reject in both mutation directions, self-cycle rejects, unchanged link succeeds under preventExtensions/seal/freeze. Explicit null does not reveal Array/Object methods or indices; restoration re-enables only the restored chain.
- Closed ordinary prototype identity and inherited access; proxy prototype identity, exactly-once get/has trap behavior, and receiver passed unchanged. Setting a proxy as prototype does not run its getPrototypeOf trap for cycle validation. Proxy-as-target preserves existing traps and invariant failures.
- Get and Reflect.get on a vector prototype with a different receiver preserve that receiver for own and inherited accessors. Has invokes no getter. Own-present undefined shadows inherited values; deleted/hole/OOB indices inherit; numeric NaN is never a hole. Repeat for each actual supported array backing family, including numeric boundary representations rather than assuming a full-range proof.
- Named strings, integer keys and Symbol.iterator observe custom links; null/custom links suppress intrinsic method shortcuts. Own override wins, deletion reveals current actual chain, accessor throws propagate once. No implicit Has-before-Get proxy probe.
- Array subclass post-super install, exact getPrototypeOf, inherited methods/accessors, instanceof/isPrototypeOf through vector and callable links, null/replaced links, and Array.prototype parent identity. Existing controls include issue-2917-array-subclass-proto-identity, array-subclass-methods, array-subclass-toprimitive-this, linked-provider-to-primitive, standalone-extends-builtin and issue-5373-array-subclass-tostring. Retain their actual existing assertions.
- Own keys/descriptors/delete/hasOwn and integrity remain unaffected by metadata; inherited enumeration follows actual chain without exposing entry fields. Aliased relink before getPrototypeOf and a statically typed array read defeat stale frontend folds.
- Repeat original exact12 all/race bodies; retain custom-prototype and Node-hint failures until measured fixes. Live growth/shrink/regrow/exhaustion, synchronous/deferred settlement, stable aggregate slot capture, override/GetIterator/captured-next ordering and iterator.return close precedence remain acceptance from the adjacent acquisition plan. Prototype repair does not weaken or replace them.
- Compiler structure audit: each reserved helper filled once, correct type/function indices after imports/DCE, no imports in the standalone controls, both entry pipelines, nested/reentrant getter and proxy calls, exception restoration. No dummyrefs to force reachability.

## Blocking decisions and explicit non-goals

The representation above is concrete and reuses the existing owner, but implementation must demonstrate a complete default provider and ordinaryPrototypeStep for every supported prototype carrier. If callable/closed/proxy round-trip or mixed ordinary-chain inspection cannot be represented using existing authorities, report that as a broader runtime dependency; do not coerce identity away or quietly limit prototypes to Object.

B's separate IterRec own-property carrier gap and dynamic-proto __struct_proto_get receiver gap remain separate prerequisites from its handoff; this metadata patch does not solve them. Indexed receiver plumbing and alias-blind frontend constant folding are additional actionable blockers, not optional follow-ups after claiming semantic Get support.

Keep promise-combinators.ts byte-frozen and real legacy callers unchanged. No new iterator tag, snapshot vector, fixed-length promise, bypass of user overrides, acceptance downgrade, main/PR retirement, or test fixture rewrite is authorized. Parent decides integration and publication only after the measured evidence meets the retained gates.
