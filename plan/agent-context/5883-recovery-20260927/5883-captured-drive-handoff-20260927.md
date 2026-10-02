# Lane D: captured-vector drive source handoff

2026-09-27. Implemented in the isolated A worktree on
`codex/5883-captured-iterator-20260927`, HEAD/base
`608be80f6beef338665fdcdb834e7d9b9f20b925`. Parent reported its integration
head as `18f1bd8`; this lane did not merge/rebase or validate against that head.
The complete acquisition/captured-next plan was reread before D work.

## Freeze / parent hookup update

D source is now frozen for parent integration/review. Latest parent-reported
main is `2a58b9fe`; Singer owns the compiler/test slot. No compiler or tests
were started during the final source review. Huygens's
`object-runtime-prototype.ts` and new default/cycle provider ownership is
untouched. This worktree remains on its original base; no merge is requested
or performed by this lane.

Exact hookup required from parent/B/C:

1. Integrate B's `iterator-protocol-get.ts` with
   `ensureIteratorProtocolGetRuntime(ctx, fctx)` and
   `__iterator_protocol_get(externref, externref) -> externref`. This import is
   required even to load the compiler graph now that D imports frozen A.
2. In the parent-owned early opt-in lifecycle/pre-scan, arm
   `ctx.protoMemberDirty` for modules eligible for this captured-vector path
   BEFORE the first `ensureObjectRuntime(ctx)`. At that existing entry,
   `object-runtime.ts` calls `reserveProtoIndexStore(ctx)`; its later
   `protoIndexRecvGetMissInstrs` call decides whether the receiver-aware
   prototype read is emitted. Setting the flag only inside B's ensure is too
   late if A or earlier source emission already ensured the object runtime.
   No new unconditional global activation is requested for unrelated modules.
3. Retain the existing `fillProtoIndexStore(ctx)` finalization. D already calls
   `ensurePromiseNativeProtoGlue(ctx)` and
   `ensureNativeProtoCompanionSeeder(ctx, promiseBrand)` before building its
   loop. Parent must verify that the early hook makes their semantic store
   available; D must not substitute the old native subscription on failure.
4. C must establish the live producer before finalizing reflective VALUES,
   then make that body call `__live_array_values(originalReceiver)`.
5. D's namespace hookup is already written: admitted observable vectors are
   converted once to an externref local and passed via the optional final
   `{ evaluatedVecLocal, iteratorProtocol: "captured-source-vector" }` argument.
   No additional namespace or generic-iterator hookup is needed. Keep the
   `onAbrupt` factory and close-before-reject branch together when integrating.

Source anchors are this worktree's review snapshot, not upstream line promises:
`object-runtime.ts:1391` (store reservation), `object-runtime.ts:2365`
(receiver-aware miss construction), `proto-index-store.ts:203` (early gate),
`native-proto.ts:688` (seeder demand gate). These were read only.

D freeze SHA-256 receipts:

- `src/codegen/promise-combinator-drive.ts`:
  `76c601c3c77d00924bec66fc6b722338664299fff5bdfeafc0a0ae2dbb0f49b4`
- `src/codegen/promise-combinator-observable-protocol.ts`:
  `cd9f65ea77c9418874bdd69f9666e27c25259ed93f35656b41f2ad3357afa8ac`
- `src/codegen/expressions/call-namespace-static.ts`:
  `f6d2d16618c747c5a9346d776a813ff074b4041a833618ea974875a8428d29af`
- `tests/issue-5883-promise-vector-acquisition.test.ts`:
  `0b9449c77a0af25fd307ff219167c80ff0e81566c3f4fc2470f1c1f7c3adfedb`

## Exact implementation paths

All paths relative to
`/Users/thomas/Code/js2/.codex-worktrees/codex-5883-captured-iterator-20260927/`:

- `src/codegen/promise-combinator-drive.ts`
- `src/codegen/promise-combinator-observable-protocol.ts`
- `src/codegen/expressions/call-namespace-static.ts`
- `tests/issue-5883-promise-vector-acquisition.test.ts` (new)
- `plan/agent-context/5883-captured-drive-handoff-20260927.md` (this handoff)

A's runtime, tests, and handoff remain frozen. No B, shared runtime, mutation,
frozen legacy Promise, fixture, or gate edits. Existing unrelated modified
`website/public/acorn/acorn.wasm` was preserved. No commits/push/merge.

## Implementation

The drive accepts an optional final
`{ evaluatedVecLocal: number; iteratorProtocol: "captured-source-vector" }`.
This local is externref containing the exact original admitted vector carrier.
The namespace arm keeps its original externref/f64 shape admission, commits
the already-compiled argument, converts its carrier once, and passes the local.
The new drive does not compile arg0 again, snapshot/drain it, or call generic
iterator helpers. Omitted-option callers retain their prior providers and
argument-compilation path; allSettled/any and ordinary/literal paths remain.

The opted-in runtime sequence is argument effects -> capability/resolve Get ->
A acquire -> drive state -> repeat A step / append all slot / resolve Call /
then Get+Call. Acquire/step exceptions reject without close. Element failures
save the original reason and mark aborted through the optional fresh-instruction
`onAbrupt(errorLocal)` factory. The drive calls A closeThrow, then rejects.
The noncallable-then TypeError uses that same saved-error channel. Legacy
callers with no factory retain immediate rejection and existing native shortcut.

The new mode performs semantic then Get/Call even for native Promise results,
using the existing `__extern_get`, `__is_callable`, and normal call bridge.
Thus inherited then overrides are not bypassed by the old native subscription
shortcut. No mutable state was added to module globals. The existing growing
all state, immutable callback slots, AlreadyCalled wrapper and completion
sentinel are reused. Supplied fulfillment/rejection callbacks do not set the
abort flag, so iteration continues after synchronous settlement. All completion
still removes the sentinel only when no abrupt protocol operation occurred.

## Dependencies / concrete source uncertainty

B's `iterator-protocol-get.ts` is still absent in this checkout; because the
production drive now imports frozen A, B must be integrated before loading the
compiler graph. C must wire reflective VALUES to Curie's live producer, and
Huygens/Curie's mutation corrections remain independent prerequisites.

Additional D provider dependency: semantic inherited `then` on `$Promise`
requires Promise.prototype's descriptor store to be seeded. D calls the existing
`ensurePromiseNativeProtoGlue` and `ensureNativeProtoCompanionSeeder` during
registration. The latter refuses ordinary brands unless `ctx.protoMemberDirty`
was armed. The store/readers must be enabled EARLY (before object-runtime
registration), through B's opt-in setup or a parent-owned lifecycle hook. D does
not mutate that module flag late or edit shared runtime files. If the seeder
cannot be provided, D explicitly fails compilation with:

`captured-source-vector Promise drive requires an early-armed semantic Promise prototype store`

Concrete source witness for why the dependency matters (not executed):

```js
const a = [1];
Promise.resolve = function (v) { return new Promise(ok => ok(v)); };
Promise.all(a); // must fulfill [1], not reject because inherited then is absent
```

This source need not explicitly name Promise.prototype. Requiring only the
direct source-call `.then` dispatcher would not establish semantic Get.
The inherited-then test additionally checks an observable getter on the prototype.
Parent must review whether B already arms this provider early; this is not a
claim that B has implemented or accepted the extra prerequisite.

Missing captured providers are fatal, never an undefined-return snapshot
fallback. The unadmitted probe rollback remains unchanged. Once admitted,
runtime registration is committed and errors propagate to compilation failure.
Do NOT add `rollbackSpeculative` around this phase: that helper explicitly
forbids rollback across a late-import flush and does not undo runtime caches.
The compiler's fatal-diagnostic path returns failed output rather than emitting
a partially constructed successful module. Parent should fault-inject provider
failure to verify that public result contract serially.

## Verification and remaining work

SOURCE ONLY: **0/28 new D cases executed**; no compiler/typecheck/Vitest/test262
or runtime processes. Singer now retains the serialized test slot. Prettier parsed
and formatted only D's four TypeScript files; scoped `git diff --check` passed.
An initial unscoped diff check hit the existing Acorn LFS sandbox error and
was replaced by the scoped read-only check.

The 28 tests comprise 12 cases each for all/race and four all-state cases:
P01 ordering/one evaluation; P02 resolve-get precedence; C01/C02/C05 resolve,
then-get, noncallable-then and then-call failures with close-time fulfillment;
C04 iteration after synchronous rejection/fulfillment; C06 nested close reasons;
inherited native then; empty behavior; omitted-mode ordinary controls; reverse
deferred callbacks across capacity growth for externref/f64 vectors; synchronous
duplicates with live growth and delayed completion; undefined versus NaN.
Tests use real source all/race, zero-import instantiation and no helper exports.
Name-presence WAT checks are supplementary, not a full reachability proof.

Parent still owns full P/C/S, immutable R twelve, L substrate/mutation,
source-order top-level writes, source receipts/budgets, DCE/stack/type checks,
fault-injection and preservation testing against merged integration. Native
Promise prototype seeding and finalized native callable dispatch are unmeasured.
No gates were changed and no passing/acceptance claim is made.

Read-only SHA-256 receipts after D edits:

- Frozen A `src/codegen/promise-vector-iterator.ts`:
  `a451fef1f581f40e8f8977b022c6e4fd9d9d65567e6a08c2b3643c7d5d56673e`.
- Frozen A `tests/issue-5883-promise-vector-iterator.test.ts`:
  `6c8a06dd1120159948ab794d66f0d97c5cdc00e4ff5e81b4cff811da59981e87`.
- `src/codegen/promise-combinators.ts`:
  `4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a`,
  matching the exact plan's frozen-file receipt.
