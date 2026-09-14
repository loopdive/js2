# Frozen: same-owner staged native closure reservation

Status: implementation contract, not a claim, dispatch, test receipt, or full native-async acceptance. Parent must acquire the bounded write scope before implementation. No held source tree is changed by this document.

## 1. Grounding and decision

This resolves section 7.2 of `3518-native-async-lane-b-api-handoff-2026-09-09.md`. Its old statement that declaration APIs are missing is superseded by the published declaration producer at `5d7b6e831ac0140e866cf39834a3aa876fb99749` and parent composition of that dependency.

Read source at `/private/tmp/js2-3518-native-async-resource-declarations-20260909`:

- `src/backend/wasmgc/resources/native-closures.ts`: SHA256 `e76ff3a42cb04f1b60e3320f019e15af640f857c2fc1d8d80eb5a77d328c1830`.
- `src/backend/wasmgc/resources/native-promises.ts`: SHA256 `6ed23305d64b18890910954afaee436af0944371da6c0c8c7799250ec2fc15c7`.
- `codegen/ir-native-promise-delay.ts` reserves/reuses the zero-argument host-one-shot wrapper after `ensureAsyncDriveRuntime`.
- `codegen/async-scheduler.ts#ensurePromiseExecutorClosures` requests the ordinary `[externref] -> []` wrapper and anonymous `promise:settle` metadata of public length 1. It does not supply minimumArgumentCount 1.

Hilbert's later diff-free audit confirms the same staging hazard and donor order. Implementation must revalidate these two producer deltas against the dispatch base, retaining any subsequently composed changes.

Decision: retain one fully prevalidated request owner and one issued pack across prefix, Promise reservations, and signature suffix. Preserve the existing atomic API as a complete run of this same engine.

**Every metadata request must finish before the first externally visible pause.** The remaining suffix may contain only signature requests, including cache hits and their real minimum/allocation observations. This includes metadata cache-hit requests: do not add a special exception. A requested partial cut leaving any metadata request pending is rejected before the first reservation.

This directly resolves the stale `nextTypeIndex` problem without a ledger change. The current metadata name contains its own physical type index; the local append frontier is valid only inside the uninterrupted atomic prefix. Promise can append or intern other types during a pause. A later new signature happens to refresh the local frontier, but a cache hit does not. The contract never relies on either case: no metadata operation is permitted after a pause.

The actual delay suffix is `params: [], results: [], allocationMode: "host-one-shot"`, with no metadata or invented minimum. Thus the restriction implements the known B join. It does not authorize moving a genuinely later metadata request into the prefix. If a complete future closure schedule needs that, retain the refusal and return for a separately scoped authenticated coordinate API; no guessed index, dummy reservation, descriptor renaming, scratch module, or second allocator.

## 2. Frozen exported API

All additions belong to the existing `native-closures.ts`; existing exported data types and generic declaration schemas remain unchanged.

```ts
/** Pure: canonical operation boundary for this exact request-prefix cut. */
export function nativeClosureReservationStepEnd(
  plan: NativeClosureDeclarationPlan,
  endRequestExclusive: number,
): number;

/** Prevalidate the FULL population, reserve the permitted prefix, issue one pack. */
export function reserveNativeClosureResourcesPrefix(
  tx: PhysicalModuleReservations,
  requirements: NativeClosureRequirements,
  expectedPlan: NativeClosureDeclarationPlan,
  endRequestExclusive: number,
): NativeClosureReservations;

/** Use only the original private owner; no replacement requirements/plan/deps. */
export function resumeNativeClosureResources(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
  endRequestExclusive: number,
): NativeClosureReservations;

/** Request-local authority, explicitly NOT a complete-inventory certificate. */
export function requireNativeClosureReservationPrefix(
  tx: PhysicalModuleReservations,
  pack: NativeClosureReservations,
  requestId: string,
): NativeClosureReservations;
```

Existing APIs retain their signatures:

```ts
reserveNativeClosureResources(tx, requirements, expectedPlan?): NativeClosureReservations;
requireNativeClosureReservations(tx, pack): NativeClosureReservations;
nativeClosureReservationInventory(tx, pack, expectedPlan): readonly NativeDeclaredReservation[];
```

Rules:

- `endRequestExclusive` is a finite safe integer in `1..requests.length`; a resume must strictly advance the current request cursor. Equal/decreasing/out-of-range cuts reject without allocating. The complete cut is always permitted for a valid population. A partial cut must leave no metadata request pending.
- A valid first prefix necessarily creates the root because full validation requires metadata to reference an earlier signature. No rootless prefix, callback, dynamic request append, or replacement starting counter.
- Prefix creation and resume return the **same object**. A complete first cut returns an ordinary completed pack. Resuming an already completed pack rejects; it is not a second reservation or an idempotent replay.
- Request-specific authentication proves that the requested ID belongs to the original validated sequence and that its entire request has completed. It must not infer this solely from a caller-visible array or matching name. Missing, future, or partially processed requests reject.
- An incomplete pack is usable only while its exact transaction remains `reserving`. Complete authentication and full closure inventory reject it even in that phase. After completion, prefix authentication delegates to ordinary complete authentication and still checks the requested occurrence.
- Full inventory retains exact `owner.plan === expectedPlan` identity and includes every original declaration once, in its original plan order. Prefix authentication is not a partial-inventory export.

`nativeClosureReservationStepEnd` must use the same canonical declaration walk that creates `declareNativeClosureResources`, not a second schedule reconstructed by counting names, physical indices, or guessed intern calls. Refactor that walk privately to retain request-end operation offsets; the public declaration-plan shape need not change. The helper revalidates the supplied plan and cut, then returns the offset. Creation/resume assert their actual operation cursor reaches that same canonical offset. No allocation, token lookup, or private issuance registry is needed for this pure helper.

## 3. Single owner, state, identity, and freezing

Extend the existing `owners` WeakMap. Do not add a parallel pack/session authority. One private owner retains:

- exact transaction, original borrowed requirements, complete immutable request-data snapshot, exact external type-token list, and the chosen declaration-plan object;
- full canonical request/operation offsets, current request and operation cursors, completion/failed state;
- root, current counter, type bindings, signature cache, request-ID map, metadata cache;
- the original issued wrapper/metadata bindings, info objects, registration history, minima map, and lazy `minimumObserverInfos` set;
- independent current prefix evidence sufficient to detect changed exposed rows, identities, scalar values, or optional-field presence before another operation.

Full request validation, complete declaration equality, exact prerequisite tokens, counter bounds, and cut validation happen before the first allocation. Every concrete external reference used anywhere in the full sequence must already be a genuine same-ledger reservation at that point. The actual B requests need no future Promise/frame type in their parameter lists. Do not accept a symbolic name instead of a not-yet-issued physical prerequisite; such a future scheduling need remains outside this amendment.

At every resume or prefix authentication, recheck original input currentness, owner/transaction identity, phase, external token identity and ledger descriptor integrity, and the entire issued prefix against private evidence. A shallow copied pack, equal reconstructed rows, substituted binding/info object, reordered/removed registration, changed parameter/result reference, changed metadata record, altered minimum, or altered `hostOneShotOnly` must not become authority merely because the TypeScript surface is readonly.

The in-progress pack is a borrowed readonly **view**, not a completed frozen value. Do not freeze info objects at a pause. Do not rebuild/reissue them at resume. Retain the same pack, arrays, rows already published, bindings, info objects, metadata records, and root/token identities. Appending new request rows and applying donor-authorized observations are the only private engine mutations. `resultingClosureCounter` reports the consumed prefix counter, not the predicted final counter.

Immutable constituent leaves may retain their existing freeze points; final pack, arrays, registration records, bindings and all infos must attain the existing complete frozen shape when the last request finishes. Keep the existing atomic caller's externally visible result and descriptors unchanged. Do not introduce getters, public progress fields, mutable authority maps, or replacement facade objects.

Preserve the existing observer semantics literally:

- first wrapper determines the root; actual request order, not a hardcoded settle root, determines it;
- cache-hit requests keep the same binding and do not increment the counter or allocate;
- ordinary observation sets `hostOneShotOnly` false; host-one-shot sets true only when previously undefined; support does not manufacture either value;
- the first minimum observation snapshots the infos existing **then**, later observations add the current wrapper, not every subsequently created metadata copy;
- metadata copies the signature info at its actual prefix allocation time, and public metadata length 1 is not minimum arity 1;
- resume carries the same lazy set and minima map, so a later suffix observation can update an earlier metadata copy exactly when the donor would.

Validate before mutation where possible. If a reservation has actually begun and throws, mark this private owner failed and prohibit retry/completion or a misleading full inventory. Preserve the original thrown object. Do not claim rollback of previously reserved closure or Promise resources, invent a transaction reset, or replace the ledger's failure behavior. A rejected query/cut that has not started work must not silently advance cursors.

The ledger cannot know an unrelated producer has an unfinished private request population. Therefore `freezeTypeSpace` itself is not amended. Parent must complete and authenticate full closure inventory before its one freeze; if it freezes prematurely, subsequent resume, prefix admission, full inventory and Promise fill must fail closed. This is not a new global completion ledger.

## 4. Exact Promise change; capture/body ownership stays put

No new `NativePromiseReservationDependencies` field is necessary. Keep the exact existing `closures` pack reference and `settleMetadataRequestId` association.

Make the existing private `requireSettleMetadata` accept an explicit internal `allowPrefix = false` argument:

- `reserveNativePromiseResources` passes `true` and authenticates the exact settle request through `requireNativeClosureReservationPrefix` before its first reservation.
- `nativePromiseReservationInventory` may pass `tx.state === "reserving"`. It still validates the entire Promise pack, expected Promise declaration identity, all borrowed associations and every existing snapshot. This does not certify the closure suffix.
- `fillNativePromiseResources` retains complete-only authentication (`allowPrefix` false). It must reject incomplete closures even if called prematurely while the ledger is still reserving. The eventual filling phase is not the only protection.

All existing structural checks remain: exactly one metadata occurrence for that request, `promise:settle`, empty name, public length 1, actual metadata type index, signature binding present by identity, `[externref] -> []`, and lifted self equal to the same root. Do not add a minimum-arity requirement.

Do not move/clone capture or runtime authority. Settle capture still redeclares five inherited metadata fields with shallow field copies retaining the exact nested field-type identities, and appends Promise at field 5. Resolve/reject trampolines, queue, resolution, classifier, object/closure invocation and fill dependencies stay with their existing owners. Existing foreign/stale token, field identity, source-plan and descriptor checks are preserved.

After suffix completion, the Promise owner's stored closure pack and settle binding must be identical to the prefix objects. No association repair/rebinding is permitted.

## 5. Parent preallocation schedule and first dependent caller

Parent derives one complete ordered closure declaration/request population, including prior source/compiler-created wrappers and all repeated observations. The B-specific suffix occurrence is grounded in the real delay request; do not invent a separate root or cache for it.

Before module creation and ABI sealing, use the canonical pure step boundary to compose:

1. prior authenticated prerequisites and closure steps `[0, prefixStepEnd)`;
2. the existing complete Promise declaration/reservation recipe and other already-planned intervening resources;
3. the remaining closure steps `[prefixStepEnd, allSteps.length)`;
4. the actual delay capture, callback and provider recipe.

Use existing declaration keys and operation order to place supplemental ABI rows; preserve intern operations even when a signature is shared. Derive first-reservation order from canonical steps, not from the eventual pack arrays. Do not concatenate all closure rows ahead of Promise simply because one closure plan contains them, nor discover rows using a scratch allocator.

Materialization follows that exact schedule with one ledger:

```ts
const closures = reserveNativeClosureResourcesPrefix(tx, fullRequests, closurePlan, prefixEnd);
const promises = reserveNativePromiseResources(tx, promisePlan, {
  vectors, exceptionTag, closures, settleMetadataRequestId,
}, promiseDeclarations);
// Other already planned intervening reservations, if present, keep their order.
resumeNativeClosureResources(tx, closures, fullRequests.requests.length);
requireNativeClosureReservationPrefix(tx, closures, delaySignatureRequestId);
nativeClosureReservationInventory(tx, closures, closurePlan);
// Reserve the real delay resources using that exact issued signature binding.
// Reconcile all other inventories, then the one existing freeze and real fills.
```

The variable IDs above are supplied by the parent-owned closed schedule, not hardcoded production request names. The atomic API also runs this engine through its complete cut, preserving real existing callers. The changed Promise reserve path is the first real dependent producer integration; the new staged test must call that actual producer, not insert a dummy type to mimic it.

This amendment does not claim complete donor-wide allocation parity for the already consolidated Promise recipe. In the legacy scheduler, some Promise allocation precedes settle-wrapper creation. Preserve the published Promise producer's established recipe and prove the specifically required relation: delay wrapper request follows Promise reservations, not precedes them. Do not use that limited preservation statement to certify the entire native module's historical order.

Parent's B reservation caller is a separately claimed integration responsibility. No `program-consumer.ts`, P/C transport/frame code, delay/combinator body or timer-publication file is transferred to this producer worker. The B writer consumes the final API after it freezes, and still owes real consumer wiring and full-family execution.

## 6. Bounded write set and preservation accounting

Producer worker, after fresh claim checks, owns exactly:

1. `src/backend/wasmgc/resources/native-closures.ts` — canonical request-step derivation, one resumable engine, existing owner and four additive APIs.
2. `src/backend/wasmgc/resources/native-promises.ts` — the narrowly selected prefix authentication above only.
3. `tests/issue-3518-native-closure-staged-reservations.test.ts` — new staged/interleaving/authority controls.
4. `tests/issue-3518-native-closure-resources.test.ts` — preserve existing donor/observer controls; add only needed atomic compatibility and live mutation checks.
5. `tests/issue-3518-native-promise-resources.test.ts` — genuine source-produced Promise reserve with prefix, complete-only fill negatives and captured identities.
6. `tests/issue-3518-native-async-resource-declarations.test.ts` — pure cut offsets, interleaved declaration order and malformed suffix preflight.

No donor fixture, generic declaration schema/executor, runtime layout/body, ledger, ABI, timer catalog, frontend, policy or historical denominator change. Use private helpers to respect normal budgets, not an allowance. Existing fixed donor hashes and original declaration/member populations are retained; any source reconstruction adaptation must authenticate the complete added factoring and preserve the original receipt, not reseed it.

Parent owns integration source/policy/tests under its separate active scope. Pure declaration and test preparation can occur in parallel after the APIs above are frozen; no second closure writer or duplicate state implementation.

## 7. Required positive-first proof

Retain all existing tests and failures; report actual measured counts, not a count inferred from this list. No heavy execution was performed for this specification.

### Atomic and donor preservation

- Existing atomic requests retain complete descriptor/name/order/registration/counter/alias receipts, including explicit named signature interning and optional field presence. Existing independent legacy observer and factory inverses remain required.
- Test ordinary-first and host-one-shot-first roots, cache hits, all existing allocation-mode sequences, and minimum observation before metadata, after metadata, and after an unrelated signature's first observation. Preserve metadata-copy timing, not just final wrapper values.
- Verify atomic completion returns the same final frozen shape as before; no staging getter, public status field, omitted registration or hidden extra declaration.

### Actual staged join

- Prepare the unchanged actual async source through the current genuine source/typed support capture helper, original and decoded as already required by the composed fixture. Reuse its real Promise/vector plan. Do not weaken mandatory runtime-support admission to resurrect an obsolete fixture.
- Reserve real vectors/tag prerequisites; reserve the closure prefix including genuine settle metadata; call actual `reserveNativePromiseResources`; resume the delay signature; compare the complete planned and actual interleaving. Require the root, metadata, wrapper bindings, nested field types and Promise's borrowed associations to retain identity.
- Test a fresh delay signature and a genuine earlier cached zero-argument signature. Fresh suffix type coordinates must follow the real intervening Promise population; a cache hit allocates nothing and updates only the donor-authorized observation.
- Test a suffix minimum observation against an info/metadata object retained before the pause. Assert both object identity and independently expected donor values; assert the lazy observer is neither rebuilt nor broadened.
- Match the full eventual declaration inventory with the full original closure plan. Check exact order, keyed intern operations, and first-reservation placement, not counts alone.

### Refusals and live countermodels

- A valid full population with a partial cut before later metadata (both fresh and cache-hit metadata forms) rejects **before any reservation**. The same population succeeds atomically. Include the dangerous signature-cache-hit then metadata suffix explicitly.
- Invalid late request, malformed cut, substituted plan, missing/foreign/copied prerequisite and counter overflow do not consume prefix ordinals. Compare against a pristine twin's actual subsequent type/function reservations, not just current lengths.
- Wrong transaction, copied pack, copied equal binding/info, removed/reordered prefix rows or registrations, stale request/plan data, replaced external token, mutated descriptor and changed optional allocation/minimum fields reject. Test each after a genuine valid prefix; do not let an earlier invalid fixture satisfy a later assertion.
- A future request ID does not authenticate. Equal/decreasing resume cuts and resume after completion reject without replay. A missing suffix cannot pass full require or full inventory. A ledger frozen prematurely cannot admit the unfinished pack or Promise fill.
- Independent live mutants must demonstrate rejection of early freezing, replacement pack/binding, reset cache/minimum observer, prefix-only validation, metadata-after-pause admission, consumed-step mismatch, accepting incomplete full inventory, and complete-fill authentication changed to prefix-only.
- Test final freezing of every relevant object and retention of the same references acquired before resume. No fake completion by creating empty bodies or skipping real Promise fill dependencies.

## 8. Limits and dispatch disposition

No architectural user choice is needed for this bounded cut: it preserves the actual known B suffix and existing atomic behavior, without a generic ledger/schema expansion. The remaining conditional is factual: the parent must verify its complete scheduled metadata population fits before the cut. A later real metadata requirement or future unissued parameter type is a fail-closed scheduling blocker, not permission to reorder or erase it.

Producer-checkpoint acceptance is not B completion. Timer import/publication/drain, complete classifier/accessor/applyClosure and carrier population, native values/strings/formatter, actual frame/spill paths, selected async traversal, final 16-function/33-call population, and original/decoded 70/3e9/undefined/reverse-all/rejection/stdout execution remain explicit dependent obligations. Do not remove the physical async refusal until the complete accepted path exists. Public cutover/retirement, ABI30's missing planningSealed witness, and existing closure unknowns are unchanged.
