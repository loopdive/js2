# Constructor identity and own-property seed: prepare/emit contract

2026-09-27. Source-only review of `/private/tmp/js2-5883-main-6eac-20260927` (parent-reported main fa6b / HEAD fda4b). No source changes, compiler/tests, or git mutations. This document is in the existing planning directory, not a git worktree. Proposed interfaces below are not implemented. Parent owns assignment/integration; Curie owns the drive/observable seams already approved.

## Decision

The smallest faithful seam is **prepare the actual constructor lazy-read fragment once, retain it as owned materialized data, then transfer it once during emission**. Preparation performs registration, frame-local allocation and nested speculative seed construction in the existing order. Emission adds no providers, locals, strings or globals and does not rebuild any subtree. Nothing is generated merely to warm a cache and thrown away.

This is a materialized constructor suboperation for a subsequently detached whole-drive renderer, not a callback recipe. It removes constructor registration from that renderer while preserving the constructor owner's existing behavior. It is not metadata-only pending preparation, is not canonical provider readiness, and cannot run for provisional module-wide demand. Whole-drive detached rendering, selected-occurrence ownership, provider closure and complete IR equivalence remain separate required work.

Do **not** begin by implementing a parallel semantic descriptor interpreter for all builtin seed cases. That would duplicate the current property-order, decline, string and singleton decisions across two mutable implementations. First extract single construction and transfer; a later symbolic/binding-aware representation can preserve this same owner contract once the shared staging adapter exists.

## Actual source and closure

`builtin-static-globals.ts:181–253` reserves `ctor:<Name>` in `builtinObjectGlobals`, allocates an externref object local, and builds a lazy init. Its first four instructions allocate, save the local, and publish the object to the global **before** seeding. It swaps `fctx.body` to init and places both outer and init arrays in `ctx.liveBodies`. After seed construction it restores the outer body, then emits `global.get; ref.is_null; if(init, []); global.get`.

`builtin-ctor-own-props.ts:212–403` owns this exact seed order:

1. Standalone/arity eligibility; callable/constructible branding.
2. Read data-descriptor provider; ensure numeric boxing, flush; early returns keep any already-emitted brand.
3. `length` then `name`, flags 4. Register/materialize each key/value string at its existing use point.
4. Number constants in current enumeration order, flags 0; Symbol well-known own properties in the explicit current list, flags 0.
5. Prepare native brand **outside** the following speculative region; inside that region build the prototype property and lazy native prototype value, flags 0, or decline/rollback.
6. Int8Array BYTES_PER_ELEMENT, flags 0.
7. Each static method in the current `Object.keys(BUILTIN_STATIC_METHOD_ARITY[name])` order: its own speculative closure/seed attempt, flags 5.
8. Species getter in its own speculative attempt; ensure Symbol and accessor provider, flags 52, setter undefined.

`builtin-callable-brand.ts:101–153` is also effectful: it allocates a ref-null Object scratch local and records the context in a private WeakSet used by finalized predicates. A split must retain both effects, not just the flag-setting instructions.

`native-proto.ts:338–455` registers proto type/global, member CSV/name strings, recursive parent singleton, companion seeder and possibly companion-init call while constructing the lazy prototype expression. `builtin-fn-meta.ts:339–369` reserves a method singleton global while producing its lazy read. Its closure payload also depends on current metadata/closure arity (`:280–307`). Species preparation (`:386–437`) registers function, subtype and receiver-aware metadata. These are transitive preparation work, not read-only emission helpers.

`native-string-literals.ts:30–48` registers a native literal global even for short strings; oversized strings can register a helper and chunk globals. The previous intuition that fixed short string emission is necessarily read-only is therefore incorrect in this tree. All actual string materializations belong in preparation, in lexical order, and their real instructions must survive into the emitted fragment.

## Minimal owner APIs

Proposed names; no new public registry of constructors or seed values.

### `prepareBuiltinConstructorIdentityRead(ctx, fctx, builtinName)`

Returns an opaque `PreparedConstructorIdentityRead` token. Internally it owns:

- exact context, function/frame identity and construction/use identity;
- builtin key and existing constructor global owner, not a second cached identity;
- complete materialized lazy-read root (including init/seed children), with normal result externref and zero ambient stack inputs;
- frame allocation interval/roles, including the constructor local, callable-brand scratch and any nested seed locals;
- live-root retention ownership and state `prepared | attached | abandoned`;
- any relocation/body-version evidence required by its supported lifetime.

Preparation calls the existing object/global/local/seed work once. It does **not** call the old whole emitter into a disposable body and call it again later. Extract the old implementation's actual construction into this owner. No public raw mutable instruction array or callable thunk is returned. An internal record may hold ordinary Instr data; do not deep-freeze numeric operands while existing shifters must update them.

### `appendPreparedBuiltinConstructorIdentityRead(ctx, fctx, token)`

Authenticates context/frame/use, transfers the retained fragment to the designated current destination once, and marks attached. Returns externref type. No registration, field/classification discovery, locals, globals, strings, compile callbacks or preparation replay. It must not take builtinName as an independent argument that can disagree with the token.

The old `emitBuiltinConstructorIdentity` becomes the immediate prepare+append wrapper, preserving its signature and call-site order. For the first integration, a captured-only new call can be used before migrating shared wrapper consumers, but there must still be one construction implementation, not a copied Promise-only seeder.

### `abandonPreparedBuiltinConstructorIdentityRead(ctx, fctx, token)`

Revokes a not-yet-attached fragment and releases only retention it owns. It does not claim to undo module registration or rewind locals by itself; enclosing speculative/frame ownership does that according to existing semantics. Attached or already-abandoned tokens cannot be transferred. This is compiler lifecycle cleanup, not a runtime fallback.

### Own-property seed seam

Keep one seed construction implementation in `builtin-ctor-own-props.ts`. Its internal preparation entry receives the existing constructor-init cursor, builtin and object-local binding and appends the actual retained seed exactly once. The cursor is the same init construction root, with the four-instruction publish prefix already present, so body-length checkpoints and nested rollback positions do not move.

It may return a closed audit record of included/declined seed segments and frame bindings; it returns no callbacks. The complete seed subtree is already owned by the constructor token. There is no need for a second exported `emitSeed` that would reconstruct it. Its emission is the constructor token's one transfer. Preserve the current `pushBuiltinCtorOwnPropSeed` wrapper for the namespace caller; do not change that caller's publish protocol incidentally.

This is a genuine prepare/emit boundary with materialized data. If a proposed review insists that preparation return **only semantic records and zero executable nodes**, that is a larger request: native-prototype, callable-brand, singleton and string owners each need symbolic prepare/render contracts, plus shared binding relocation. Do not disguise that broader implementation as this bounded extraction.

## Runtime semantics are fixed

The transferred expression remains exactly the original lazy guard and final read. In its init branch: allocate one object; publish its exact reference; brand and install properties in the same order. Reentrant constructor reads during prototype/companion seeding see the published partial object and do not allocate another constructor. Reentrant identity is not achieved by setting a separate compiler flag.

Do not move seed calls outside the guard, replace the guard with compile-time cache presence, or defer publication until seed success. If runtime seeding throws, preserve the currently published partial carrier and subsequent-read behavior; no automatic clear/retry transaction is introduced. A compile-time-warm slot may still be runtime-null, and runtime-warm objects must preserve mutations/deletions across later reads without reseeding.

`emitBuiltinNamespaceObject` also invokes the seed builder (`builtin-static-globals.ts:560`), but its surrounding publication structure differs. This proposal does not silently normalize that route. Promise captured reads continue using the existing `ctor:Promise` route; namespace, wrapper, proto-constructor, global-object, identifier, Function/String intrinsic and reflective dispatch callers remain explicit legacy controls.

## Allocation timing and Curie interface

Curie's approved frame preparation should replace the current constructor call at the **same point**: after allocating observable result/ctor/resolve/aborted/reason/callability/(race fulfill)/reject locals and emitting capability/settle-closure prefix. Run constructor preparation there; keep the existing second captured flush after the completed observable prologue. Do not move constructor/string/global registration ahead of the first drive registration sequence.

For the eventual detached drive, Curie's frame preparer supplies one prepared constructor token as a closed frame resource. The detached prologue renderer consumes it at the old constructor-read instruction position, then emits `local.set ctor` and the resolve Get/check continuation. Runtime sequence is unchanged even though the fragment was physically constructed earlier during frame preparation.

All other prologue/element strings must similarly be prepared by their owner and retained or represented by authenticated materialization handles; constructor extraction alone does not make their current emitters read-only. Preserve callable-classification timing after constructor preparation, because seed registration can introduce closure types. Do not cache the closure ladder before that phase.

Maintain the exact local sequence and names. Constructor prep allocates the object local and then callable-brand scratch where currently allocated; native prototype/static/species preparation may add further locals. Do not assume two is the entire nested count. Do not cache a frame-bound token module-wide. Same constructor read at a second source site requires a fresh physical fragment and local bindings, even though all canonical globals/providers may already exist.

## Shift-root ownership and transfer

Build the actual init prefix before seed preparation, as today, and track it throughout all allocating calls. Keep the enclosing body reachable while `fctx.body` points at init. After returning a prepared token, its full fragment must remain in the normal function/global shift-root traversal until ownership is transferred to an already-tracked destination.

Use an explicit retention lease for the fragment, not a blind add/delete on a shared Set. If an outer caller already registered its body, nested cleanup must not remove that caller's registration. Membership-before-add can preserve an outer root during synchronous construction; an escaping prepared token needs owner-scoped lifetime/release, not a local finally that drops the only root. Attach destination first, then release token retention without an intervening allocating call. Existing walkers must deduplicate any brief alias overlap by physical identity.

All numeric materialization created after a shift uses current authoritative bindings; previously materialized instructions are shifted once by the ordinary walker. Do not rebuild them at append. Do not copy stale closure/global/function numbers into the packet and increment them independently.

**Concrete audit concern:** the reviewed `registry/imports.ts:638–679` shift-map list includes nativeProtoGlobals, nativeStrLiteralGlobals and builtinFnSingletonGlobalByTypeIdx, but searches of that file and `expressions/late-imports.ts` found no `builtinObjectGlobals` update. Constructor code also keeps `globalIdx`/`newObjectIdx` locals across seed work, and the seed keeps `defineIdx` across boxing/registration. This does not establish a failing captured standalone case, but it prevents an unconditional arbitrary-shift guarantee. Parent must resolve the actual global-map owner and inject shifts in controls before approving extended token lifetimes. If repair is needed, report it separately and obtain the targeted registry/provider-owner hunk; do not claim a behavior change as hash-neutral extraction.

Minimal immediate prepare+append can preserve the existing lifetime. Delaying across arbitrary registration/local remap, inlining, body completion or global/type compaction is **not** allowed until its binding adapter proves all relevant roots/maps are covered. This is an integration prerequisite, not a new rejection of valid source. A same-function pointer alone is insufficient after rollback/local-number reuse.

## Speculative registration and rollback

Preserve the seed's existing per-prototype, per-method and per-species speculative scopes at the same cursor offsets. `tryEnsureNativeProtoBrand` stays outside its property-write scope. A declined segment leaves no partial stack pushes or locals from that segment; later segments still run in existing order. A thrown compiler error follows current rollback then rethrow, not successful empty preparation.

Current `snapshotSpeculative`/`rollbackSpeculative` do not revert all module state: types, global imports and some caches remain, and already-flushed function imports may remain. Branding's private WeakSet is not part of that snapshot. The new seam must preserve these existing effects for correspondence; do not advertise complete transactional module rollback or introduce new metadata survival based on those caches.

For the immediate wrapper, never let an unattached token outlive an enclosing speculative operation. For a later delayed-use adapter, the actual body transaction must journal token revocation/physical ownership with local rollback. Inner success remains cancellable by outer failure. Retained completed body reuse requires the existing selected-body/epoch contract and new adoption; it cannot reuse a token from a failed frame just because a global/provider survived.

This means the fragment seam can be implemented before staging activation, but durable pending-token use needs the real owner adapter. Do not add a third rollback mechanism pretending to replace the existing source transaction or emission-ownership arena.

## Bounded source partition

- Constructor/seed owner (parent assigns): targeted `builtin-static-globals.ts` constructor construction/wrapper; `builtin-ctor-own-props.ts` preparation cursor/segment contract; proposed small `builtin-constructor-prepared.ts` for opaque token and transfer lifecycle if needed. Preserve other builtin branches and namespace behavior.
- Body/relocation owner (parent): root-retention lease in `context/bodies.ts` or the existing root owner, and any independently approved missing global-map correspondence. No private shadow shift cache in the constructor file.
- Curie: targeted observable frame/prologue seam consumes the prepared constructor token; no direct edits to constructor/seed/registry modules under current assignment. Agree the same-frame one-use token and lifetime before switching the call.
- Native-proto, builtin-fn-meta, callable-brand and native-string modules remain transitive preparation owners with no required broad rewrites for the materialized-fragment approach. A semantic-only recipe approach would require new contracts there and is not this minimal partition.

## Exact parent tests and poison controls (not run)

1. **No registration in append:** after real preparation, replace registration/local/string/global allocators with throwing spies. Append must still transfer the prepared constructor once and produce externref, with zero calls to those APIs. This control must fail if old `emitBuiltinConstructorIdentity` is substituted for append.
2. **No discarded warm:** count object-runtime, seed, prototype, method/species and string-preparation invocations. Compare the full ordered trace with the old emitter, not merely final counts. Every successful segment's actual instructions must reach the output; no second construction at append.
3. **Cold/warm compile matrix:** constructor slot absent, reserved-null slot present, providers cold/warm, repeated same-function reads, different-function reads, recursive provider construction. Compare ordered types/functions/globals/maps/locals/string materializations and full caller/helper instructions, not only Wasm hashes.
4. **Runtime laziness/identity:** control-flow skips first read; two reads; prototype/companion reentry during seed; mutations/deletions after first read; injected seed throw followed by reread. Assert the same identity, one allocation on actual first access, unchanged property order and partial-initialization behavior. Use runtime indirection to avoid constant folding.
5. **Nested decline/throw:** force prototype decline, each static closure decline, species missing boxing/accessor, and injected compiler throw after a local/import. Compare cursor, stack, locals/temp state, errors (including sticky), imports/shift latch and persistent caches against the original. Later successful siblings remain. Missing data provider/boxing must retain the original preceding brand segment.
6. **Function/global shift poison:** inject a real shift after allocation prefix, within prototype/static/species prep, between completed preparation and append, and after append; require intended target identity/signature and singleton global identity, not numeric-range validity. Exercise constructor map, method singleton map, native prototype map, string materialization globals and saved/live aliases. Deliberately omit fragment retention and require this control to detect stale indices.
7. **Lease poison:** forged/cross-context/cross-frame token, double append, append after abandon/rollback, local-index reuse, outer pre-existing live-root membership and nested cleanup. Verify no root leak and no removal of another owner's root. Do not test by adding new source failures; these are internal API misuse controls.
8. **String timing:** exact short-key intern order and member CSV/native literal behavior; host-mode pending/global strings where the legacy wrapper supports them; oversized-materializer owner unit control. Missing prepared strings must not be accepted as null by the new emission contract. Supported captured input population remains unchanged.
9. **Legacy controls:** namespace callers and representative Number, Symbol, Int8Array, Array/Object, Error, Function/String and ordinary Promise reads. Their special descriptor/order routes remain unchanged. Both all/race and previous failed controls stay in the parent comparison; no acceptance exclusions.

## Approval boundary

Implementable now as retained single construction plus allocation-free transfer, with an immediate same-frame lifetime and explicit body-root ownership. General delayed staging use still requires binding/rollback coverage and canonical provider proof. This seam neither replaces the required fully detached whole-drive renderer nor authorizes activation or old-compiler retirement.
