# PR5883: original-vector acquisition and captured-next implementation plan

Date: 2026-09-27. Owner: Hume architecture/review lane.
Status: proposed implementation contract; NOT implemented or accepted.
This directory is planning-only, not a Git checkout. It is separate from the
parent preservation-repair checkout and Curie/Huygens developer checkouts.
Parent owns integration, commits/publication, acceptance, and all serial tests.

## Evidence and scope

- Parent's preserved original-source baseline/failed drive experiment is 4/12
  pass, 8/12 fail. The sources, hashes, expectations and failed patch are in
  `5883-original-vector-pair-20260927.json` and the immutable original JSONL.
  Do not repeat that experiment or rewrite its result as new evidence.
- Parent verified Curie's live-array substrate run 02: 7/9, with shrink/regrow
  and custom-prototype failures remaining. The sparse-object boundary case
  passed; it does not establish full-range numeric-vector behavior. This plan
  has NOT independently run those tests.
- Huygens owns mutation implementation. Original-carrier iteration and mutation
  correctness are separate prerequisites; neither substitutes for the other.
- Main 9be5011449 provides reflective Array values/keys/entries callables, but
  its values implementation snapshots length and elements before returning.
- Admit only the ALREADY-ADMITTED observable original-vector Promise.all/race
  source arm (externref/f64 vector carriers). Evaluate the original expression
  once, preserve its original carrier, and run the real iteration protocol.
- A user override of that vector's iterator may return an ordinary object,
  closed object, callable object, Proxy, native iterator, or generator. The
  initial vector admission must not restrict the returned iterator to arrays,
  silently select the intrinsic, or discard the captured method.
- Do not widen allSettled/any, arbitrary source-iterable admission, legacy
  combinator callers, IR migration, or source-preservation scope.
- Frozen `promise-combinators.ts` remains byte-identical. Keep its real ordinary,
  custom-settle/check, allSettled/any and IR callers alive. No archival copy,
  dummy references, exported-for-DCE helpers, acceptance changes, or grants.

## Decision

Use TWO distinct records with separate ownership.

1. Curie's existing five-field IterRec is the actual intrinsic array iterator:
   VEC kind, null legacy vec, payload in userIter, ARRAY family. Its payload
   holds original source, f64 index, exhausted flag and brand. Central normal
   next, strict next, rest and borrowed next understand this representation.
2. A new Promise-private acquisition record captures the actual iterator object,
   its once-read next method, and a done bit. It is NOT a new IterRec kind, is
   never returned to JS, and is never passed to __iterator, __iterator_next,
   __iterator_rest, bounded drain, iterator helpers, or generator delegation.
   Its only consumers are its three dedicated helpers and this opt-in drive.

This prevents a new generic iterator tag with missing rest/next consumers.
It also prevents direct use of Curie's intrinsic step from bypassing an
overridden next method. No fast intrinsic-next shortcut in the first patch.

## Concrete APIs and files

All names below are proposed additions, not claims that they already exist.

### A. Acquisition owner: new src/codegen/promise-vector-iterator.ts

Export `ensurePromiseVectorIteratorRuntime(ctx, fctx): void`.
Idempotently reserve and emit these helpers, resolved from funcMap at use:

- `__promise_vector_iterator_acquire(source: externref) -> externref`.
- `__promise_vector_iterator_step(record: externref) -> (i32 done, externref value)`.
- `__promise_vector_iterator_close_throw(record: externref, original: externref) -> externref`.

Private struct `__PromiseVectorIteratorRecord`:

- iterator: immutable externref, the EXACT object returned by the iterator call;
- nextMethod: immutable externref, the EXACT result of Get(iterator, "next");
- done: mutable i32, initially zero.

No brand needed for user-visible discrimination: the record is private and
never dispatched by structural ref.test against arbitrary JS objects. Keep it
out of generic property/carrier enumeration. Register its type before bodies
and use one creation site. Do not repurpose Curie's payload or legacy idx.

Acquire performs, in this exact runtime order:

1. Semantic Get(source, actual Symbol.iterator), once.
2. Require callable. Null/undefined/absent/noncallable are TypeError for this
   GetIterator caller, not permission to use default array iteration.
3. Call(method, source, zero arguments), using the normal closure/call bridge.
4. Require Object result, including callable objects; reject all primitives.
5. Semantic Get(actualIterator, "next"), once.
6. Construct the private record. Do NOT validate next callability yet.
   A noncallable next fails when IteratorNext invokes it; a throwing next getter
   fails acquisition. Neither case closes the iterator in Promise.all/race.

Step:

1. If record.done, return true/canonical undefined without invoking user code.
2. Invoke captured nextMethod with actualIterator as this and ZERO arguments
   (not one undefined argument). Check callable at invocation.
3. Require Object result before any done/value property access.
4. Get(result, "done") exactly once, apply ToBoolean.
5. If true, set record.done, return true/canonical undefined; never read value.
6. Otherwise Get(result, "value") exactly once, return false/value.
7. On an abrupt next/result/done/value operation, set record.done and rethrow the
   same JS exception. The caller rejects, without IteratorClose.

Use existing error/object/callability/ToBoolean and empty-argument-vector
providers. `generators-delegation-runtime.ts` is a source precedent for
iterator+next capture, not a callable implementation dependency: yield-star
step sends different arguments and has different done/value/return semantics.

CloseThrow is intentionally THROW-COMPLETION-ONLY:

1. If done, return original. Otherwise mark the private record done so the
   caller cannot close twice, and retain original in a local across user calls.
2. GetMethod(actualIterator, "return") NOW, not during acquisition.
3. Null/undefined is absence; any other noncallable is a close failure.
4. If callable, invoke with actualIterator as this and zero arguments.
5. Original abrupt completion wins over a throwing return getter, noncallable
   return, throwing call, and primitive return result. Do not inspect returned
   done/value or await a thenable. Return the saved original reason.
6. Catch JS-tagged exceptions from close, NOT arbitrary Wasm traps or compiler
   bugs. The latter remain failures, not coerced rejection-success evidence.

This helper is not a general normal-completion IteratorClose implementation.
The required precedence is cross-checked against the current
[IteratorClose algorithm](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-iteratorclose).
Keep existing native-control expectations; do not change the project's oracle.

### B. Protocol-property owner: new src/codegen/iterator-protocol-get.ts

Export `ensureIteratorProtocolGetRuntime(ctx, fctx): void` and reserve
`__iterator_protocol_get(receiver: externref, key: externref) -> externref`.
Keys use existing native strings and the genuine well-known Symbol.iterator
carrier; never the string "Symbol.iterator" or a private textual alias.

This is a semantic property facade, NOT GetIterator and NOT method dispatch.
Return arbitrary property values unchanged, including undefined and null.
Callability is the acquisition/step/close caller's decision.

Lookup requirements:

- Source vector: own descriptor/bag hit first (presence, NOT value), then its
  actual runtime prototype chain, including descriptor overrides/tombstones.
  Existing __carrier_bag_has / __carrier_bag_of and vec property providers are
  candidates; prove their carrier coverage before relying on them.
- Intrinsic IterRec: own property/bag if supported, then family prototype with
  the original IterRec retained as Receiver. A result with family ARRAY does
  not imply an immutable intrinsic next/return property.
- Plain/closed objects, callable objects, native generators and proxies:
  delegate to their semantic reader, preserving descriptor precedence,
  inherited lookup, symbol keys, getter invocation and proxy receiver.
  Prefer existing __extern_get / finalized closed accessors, not static
  __call_next or __call_@@iterator method dispatchers.
- A descriptor hit yielding undefined must NOT fall through. Deleted property
  must continue to the actual parent; do not revive a builtin at the same level.
- Throwing Get must be invoked once and propagated once.

Receiver preservation:

- Existing __reflect_get_receiver(target, key, receiver) is the reusable
  explicit-receiver seam. It already carries the original receiver for closed
  carrier bags and has proxy forwarding. For a native IterRec prototype lookup,
  use target=familyPrototype and receiver=originalIterRec.
- The current iterator-proto-next.ts prologue instead calls
  __extern_get(prototype,key), which binds inherited getters to the prototype.
  Change that exact arm, under this owner's exclusive file ownership.
- Do NOT blindly trust the one-shot global wrapper: __extern_get's original
  prologue consumes the explicit-receiver active bit, but later prepended arms
  can return or call user code BEFORE that prologue. Inventory those paths.
  Consume receiver state at the true common entry before any user-code call,
  or explicitly thread Receiver in the small affected helpers. Preserve
  normal Get(target,key)'s target-as-receiver behavior.
- __reflect_get_receiver currently restores saved state only on normal return.
  Add exception-safe restoration for its own one-shot state before rethrow,
  including reentrant getter/proxy paths. No module-global captured-next,
  source cursor, aggregate state or mutable per-call scratch.
- Existing proxy get forwarding must receive (target,key,originalReceiver).
  A getter that reenters another Get or another Promise.all must not inherit
  the outer call's receiver.

Override writer/read coherence is a prerequisite, not optional:

- expressions/proto-override.ts currently intercepts function-expression
  assignments into private globals and prevents the ordinary property write.
  Its selector treats values as a continuing alias for @@iterator. Neither
  behavior supplies a general semantic Get.
- Keep the two property identities distinct after initialization. Their
  initial callable objects are identical; assignment/deletion/defineProperty
  on "values" must not mutate @@iterator and vice versa.
- In opt-in modules, publish intercepted writes to the canonical semantic
  descriptor store as well as preserving any legacy cache still needed.
  Evaluate RHS once. Ordinary assignment, noncallable assignment,
  defineProperty getter/data descriptor, deletion, and inherited fallback
  must meet in that SAME authoritative store. Do not select "latest global"
  against an unrelated descriptor store.
- Validate source-order top-level write retention, including writes before and
  after the Promise call. A compile-time "maybe overridden" flag only enables
  runtime machinery; it is never evidence that a particular method is present.
- If preserving the historical override cache and coherent semantic property
  store cannot be achieved additively, stop with a concrete dependency blocker.
  Do not silently alter real legacy consumers or make this a broad migration.

Bounded modifications owned by B:
`iterator-proto-next.ts`, `object-runtime.ts`,
`expressions/proto-override.ts`, and the new facade. Only if source-order keeps
are demonstrably missing, parent separately authorizes the exact
`declarations.ts`/`builtin-write-keeps.ts` keep hook. Only if vector or IterRec
own/prototype metadata is missing, parent assigns the corresponding shared
property-storage writer/reader slice; that is NOT implicitly delegated here.

### C. Intrinsic producer integration (parent, after Curie's handoff)

In `array-proto-iterator-value.ts::emitArrayProtoIteratorMemberBody`, keep the
landed reflective callable identity and nullish/ToObject receiver semantics.
For VALUES only, replace eager length/copy emission with a call to
`__live_array_values(originalReceiver)`. No length/index Get at creation.
Continue using actual Call of the selected method from acquisition. Do not
replace that Call by a compiler assertion that the source is an array.

Keep keys/entries implementation and other source-lowering producers out of
this bounded patch. The array-object-proto.ts integration already exists;
touch it only for explicit prerequisite registration, not a second method body.
Changing this intrinsic body naturally improves reflective values calls, but
does not authorize retargeting legacy Promise callers or old array loops.

Curie's number-hint correction belongs in its live length dependency contract:
use an explicit number hint. If shared ToLength needs an optional hint policy,
preserve the old default for existing callers and select the exact policy only
for the new producer. No global coercion rewrite in this task.

### D. Drive integration owner

Files: `promise-combinator-drive.ts`,
`promise-combinator-observable-protocol.ts`,
`expressions/call-namespace-static.ts`.

Add an OPTIONAL final options argument to
`emitStandalonePromiseCombinatorDrive`:
`{ evaluatedVecLocal: number; iteratorProtocol: "captured-source-vector" }`.
Omission preserves all existing real callers and their provider choices.
The explicit mode is legal only for observable all/race and an admitted vec.

Namespace arm:
- Keep current shape admission, speculative rollback rules and ordinary
  fallbacks. Reuse its already-evaluated vec local, convert to externref once.
- Call the new opt-in drive. Do not recompile arg0, copy/normalize/materialize
  the vec, or route it through __iterator / __iterator_strict.
- If required providers cannot be supplied, fail compilation explicitly for
  this admitted mode; never fall back to the known-wrong snapshot observable
  loop. No half-emitted body or leaked speculative registrations.

Drive runtime order:
- All argument expression effects finish first.
- Existing capability preparation and once-only GetPromiseResolve precede
  acquisition. Capture promiseResolve once and Call with its constructor this.
- Acquire using A, allocate per-invocation drive state, then interleave:
  step -> append stable all slot -> resolve(value) -> then Get/Call -> next step.
- Do not stop synchronous iteration because race settled or because a thenable
  invoked rejection. Stop only for normal iterator exhaustion or an abrupt
  protocol operation. Synchronous user settlement is not an iteration error.
- In acquisition/step failure, reject once with the original reason; no close.
- In per-element resolve/then failure after a successful value step,
  close first, then perform rejection using the original completion.

IMPORTANT existing integration defect:
`emitObservableCombinatorElement` currently catches and rejects immediately;
the drive subsequently closes. For the new mode add an optional
`onAbrupt(errorLocal): Instr[]` instruction FACTORY (fresh instructions).
Default remains the current reject+aborted behavior for every existing caller.
The new factory only saves the original error and marks aborted. The drive
calls CloseThrow and then rejects. Do not conflate a reject-callback invocation
with this thrown-error channel. This also allows return to settle the aggregate
synchronously before the later reject attempt, as observable ordering requires.

Stable aggregate contract (reuse, do not redesign):
- All: one state object, mutable backing pointer/length/remaining, initial
  remaining=1 sentinel. Allocate each monotonically numbered slot once.
- Each resolve-element cap retains state+immutable slot, never an old backing
  array. Grow backing geometrically; callbacks reread state.resultsArr.
- Increment remaining before invoking then; decrement at most once per
  resolve-element via existing AlreadyCalled wrapper. Remove the sentinel
  only at successful exhaustion, not on aborted iteration.
- Final visible length is discovered element count, not capacity or original
  source length. Deferred/reverse-order callbacks populate original slots.
- Race retains current shared settlement state and keeps iterating after
  synchronous settlement. Empty race remains pending.
- Preserve actual undefined vs NaN in indexed values and resolved outputs.
  Source length changes are Huygens/Curie concerns; aggregate length is the
  number of values actually consumed.

## Registration and finalization order

1. Parent integrates ownership-disjoint source patches; do not invoke a compiler
   in a developer lane without a separate slot grant.
2. Register dependencies while source/type/Program-ABI population is open,
   BEFORE iterator finalization and before constructing detached instruction
   sequences: object runtime, union predicates, error ctor/tag, call bridge,
   receiver-aware Get, symbol/string keys, array intrinsic callable/prototype,
   central iterator/result-object runtime, and Curie's producer.
3. Establish the live producer before its reflective VALUES body is finalized.
   Avoid recursive first-use: acquisition ensure must not materialize a values
   body that calls back into the same half-initialized acquisition ensure.
   Producer depends on iterator substrate, never on Promise acquisition.
4. B reserves its facade and any late closed-shape reader dependencies. A
   registers its private struct and stable helper handles with
   addFuncType/mintDefinedFunc/pushDefinedFunc. Maintain explicit
   registering/reserved/emitted state for reentrant registration; do not return
   an unregistered funcMap entry or duplicate a type/function.
5. Ensure every dependency that can allocate imports/types before capturing
   numeric type indices or body call operands. Flush pending late-import
   shifts with the active fctx and its saved bodies, not null while an active
   detached caller body is invisible. Re-read funcMap names after intervening
   registration. Stable handles are not mod.functions array offsets.
6. Emit acquisition/step/close bodies ONCE. Fresh instruction object per tree
   position; no shared then/else arrays or shallow-copied nested throw trees.
   Store runtime scratch in function locals/record fields, never module globals.
7. Curie's existing iterator fill discovers live dependencies and installs
   normal/strict/rest arms. Existing object/property fills settle closed shapes,
   proxies, vector indexed readers and descriptors before execution.
   If B needs late arms, reserve first and splice arms into its emitted helper;
   do not rebuild shift-maintained bodies or allocate new imports at fill.
8. Existing finalized callable dispatch must include intrinsic values, captured
   ordinary/closed/generator/proxy callables, and native borrowed next. No
   exact-signature call_ref shortcut that only handles one closure family.
9. Parent performs reachability/source-budget/preservation checks on the REAL
   production call chain. No export roots or fabricated callers.

## Bounded disjoint ownership

- Curie: `iterator-live-array.ts`, `iterator-native.ts`,
  `tests/issue-5883-live-array-substrate.test.ts`, its handoff; narrow shared
  ToLength optional-policy change only after parent confirms ownership.
  Finish its two reported failures or document exact shared substrate needs.
- Huygens: `vec-length-set.ts`, `vec-length-hole-fill.ts`,
  `expressions/assignment.ts`, `array-length-define.ts`, assigned mutation
  tests/handoff. No iterator acquisition or Promise edits.
- Developer A: new `promise-vector-iterator.ts` and
  `tests/issue-5883-promise-vector-iterator.test.ts` only.
- Developer B: new `iterator-protocol-get.ts`, `iterator-proto-next.ts`,
  `object-runtime.ts`, `expressions/proto-override.ts`, and
  `tests/issue-5883-iterator-protocol-get.test.ts` only.
  B must NOT edit Huygens's assignment file. Any needed call-site wiring is a
  parent integration hunk after Huygens relinquishes that file.
- Developer D: the three drive files named above plus
  `tests/issue-5883-promise-vector-acquisition.test.ts` only.
  No direct edits to A/B/Curie runtime or mutation files.
- Parent: reflective VALUES integration; any small lifecycle/registration hook
  in `index.ts` if needed; shared collision resolution; issue/hand-off records;
  full graph/source-receipt gates and serial acceptance. Source-order keeps,
  array prototype metadata or new storage support require explicit assignment.
- Architect (this lane): this planning file only. No implementation/test edits.

These are write reservations proposed to the parent, not a claim that new
developers have been spawned or that shared-file permission has been granted.
Implement A and B independently against the API; D after their contracts are
stable. Parent merges Curie/Huygens, B, A, intrinsic wiring and D in dependency
order, resolving any shared hooks serially.

## Exact acceptance cases (parent-owned execution)

Keep original sources, native controls, fixed assertions, timeouts and source
hashes. No new tests are executed by this planning task.

### R: immutable original twelve

Both all and race, each with these unchanged source variants/expected numbers:

- none -> 3001233.
- grow-holes -> 5123005.
- shrink-regrow-same -> 3001003.
- shrink-regrow-next -> 5120005.
- literal-hole -> 3103.
- undefined-nan -> 3108.

Required result: 12/12 with exact source-hash receipt, real observable production
body, zero host imports under the established standalone harness, and value
equality. Keep the four controls; never count them as repaired failures.
The JSONL and `tests/issue-5197-observable-vector-original-review.test.ts`
are authoritative. This document is not a replacement fixture.

### P: acquisition/property protocol, parameterize EACH over all and race

P01. Source expression counter is 1. Trace begins argument -> resolve-get ->
iterator-get -> iterator-call -> next-get -> next-call -> done-get -> value-get
-> resolve-call -> then-get -> then-call. Method this is source; next this is
actual iterator; both arguments.length are 0. Terminal step reads no value.

P02. Throwing resolve getter E beats throwing iterator getter F; reject E,
iterator getter count 0, next count 0, return count 0.

P03. Own Symbol.iterator getter shadows prototype getter, invoked once with
source receiver. Replacing/deleting source method during its call does not
change this acquisition. Returning undefined does not fall through.

P04. Runtime prototype iterator assignment works before a call and differs
after reassignment. Top-level and function-body writes have identical effects.
Run function expression, variable-held callable, and getter/defineProperty forms.

P05. Overwrite only Array.prototype.values: default @@iterator still uses its
initial function. Overwrite only @@iterator: saved values remains callable.
Deleting either property leaves the other independent. Source @@iterator
null/undefined/noncallable each rejects TypeError, no intrinsic fallback.

P06. Override returns each supported native object shape: open object, unannotated
closed object, callable object with next, native generator, native array iterator,
Proxy iterator. Same trace/values; no shape-specific default substitution.

P07. Iterator method returns each primitive (null, undefined, number, string,
boolean, symbol): reject TypeError before any next Get, no close.

P08. next getter count is 1. Getter returns f; first call replaces iterator.next
with throwing getter g. Every remaining step calls f, never g. Mutation between
acquisition and first call is likewise invisible to the captured method.

P09. next getter throws E: reject E, no next call, no return Get. next property
is noncallable: acquisition captures it; first step rejects TypeError, no close.

P10. Inherited next and return getters observe this===actualIterator, including
native IterRec prototype. Getter performs nested ordinary Get, Reflect.get,
and nested all/race; outer and inner receiver identities remain separate.
Throwing nested read followed by another Get leaves no stale receiver state.

P11. next returns primitive: TypeError before done/value Get. next throws E,
done getter throws E, or nonterminal value getter throws E: reject identical E;
return getter count 0 for each. Get(done) happens once. Truthy done skips a
throwing value getter and future polling.

P12. Proxy iterator-method/next/return Get traps observe correct key and receiver;
trap-absent forwarding preserves receiver. Capture still reads next once.
A Proxy or closed callable returned as next is called through normal semantics.

P13. Override deliberately ignores the source vector and returns [9,8]'s iterator:
all resolves [9,8], race's first settlement is 9; original source indices are
never read. Override delegating to saved intrinsic values observes live source
growth and returns the same actual iterator object used for next/return.

P14. Returned intrinsic iterator's own next/return descriptor shadows prototype;
undefined own next is a TypeError, not default next. If existing IterRec metadata
cannot express this, report a storage dependency blocker, not a passing omission.

### C: close and precedence, parameterize EACH over all and race

C01. resolve Call throws E after first value. Trace includes return-get,
return-call, THEN rejection with E. Both return receiver and zero argument count
are exact. No second source step. Change return during resolve to prove late Get.

C02. then getter throws E, then is noncallable, and then Call throws E:
each closes once then rejects original E/TypeError. Do not close for merely
calling the supplied reject callback.

C03. For a resolve/then throw E, vary return: absent, null, undefined, noncallable,
throwing getter F, callable throwing F, callable returning primitive, callable
returning object with throwing done/value getters. E remains rejection reason;
close effects occur as applicable; returned done/value getters are never read.

C04. Normal terminal step never reads return. Synchronous rejection callback does
not close and iteration continues to terminal. Synchronous race fulfillment
does not close and later values still run resolve/then effects.

C05. return calls a previously captured fulfillment callback before the drive's
reject attempt. Race can therefore settle from close first; verify native
ordering. For all, the remaining sentinel prevents premature fulfillment while
iteration was aborted. Keep error reason object identity.

C06. Nested Promise combinator from return has its own record/reason/state.
No double close, no mutable-global original-error overwrite.

### L: substrate/mutation dependencies, parameterize protocol-facing forms

L01. Create intrinsic values iterator with throwing length getter: creation does
not read length. First next throws. Length getter/conversion runs once per
nonterminal poll; exhausted next does neither, even after regrowth.

L02. Replace future element, grow during resolve/then, shrink before next, and
shrink-then-regrow before next: exact live values, holes and inherited values;
no stale copied backing. Test numeric and externref source carriers separately.

L03. Hole with Array.prototype[index] data/getter, Object.prototype fallback,
own undefined shadowing inherited value, genuine NaN, deleted own index and
own indexed accessor. Getter receiver is original source; no value-based miss.
Keep custom-prototype case separately required, not replaced by these controls.

L04. Indexed getter reenters next, and indexed getter throws then caller resumes:
index advanced before Get. Length getter reenters/throws with index captured
before length access: no outer-step increment on a thrown length conversion;
any successful reentrant step retains its own state changes.
Separate cursors over one source do not share index/exhausted state.

L05. Hint-sensitive length object receives "number", exactly once; valueOf/
toString order, Symbol rejection, fraction/negative/NaN clamping. Preserve the
already-recorded full-range boundary test. A generic sparse-object seek is not
evidence for numeric-vector indexing above 2^31.

L06. Curie's rest consumes from current position and polls terminal to latch;
bounded materialization consumes exactly n values with no extra terminal poll;
borrowed native next and for-of resume remaining values; normal and strict
dispatch both recognize the live payload. These remain substrate tests, not
private Promise-record consumers.

### S: stable aggregate and preservation

S01. all with >initial backing capacity; callbacks retained and invoked in reverse
order after synchronous iteration. Exact source-order array, exact visible
length, no missing slots/old-backing writes.

S02. all with a mix of synchronous and deferred callbacks plus source growth
during synchronous callbacks. Settlement cannot occur before terminal poll and
all required callbacks; each original slot remains stable across growth.

S03. Invoke the same all resolve-element callback twice before/after backing
growth; value/count update once. Two nested combinators do not share callbacks,
remaining counts, captured next, or result arrays.

S04. Empty all fulfills []; empty race remains pending. Fulfillment values
undefined and NaN remain observably distinct. Promise queue/drain behavior
uses existing harness; no sleeps/timeouts changed.

S05. Parent runs unchanged preservation checks including frozen file blob
55f7951d0a64076e68cc42eb0dfb8469a320a1fa / SHA256
4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a,
original declaration/module receipts, cache-order/fallback controls, and real
legacy callers. allSettled/any/nonobservable arms remain reachable and unchanged.

S06. Production program using admitted observable vector all/race reaches
acquire/step, protocol Get and real reflective live values without helper
exports. An override close witness reaches CloseThrow. Test-only exports are
permitted solely for focused substrate tests, never the production proof.
Parent owns DCE/type/stack/zero-import checks and records actual denominators.

## Dependency blockers / no automatic scope expansion

- Custom array prototype links and IterRec own properties may require writer
  and reader storage work beyond A/D. B must report exact missing capabilities;
  parent assigns that work explicitly. Do not accept a facade that bypasses it.
- Curie's reported shrink/regrow and custom-prototype failures remain failures until fixed and
  measured. Do not infer 9/9 from source review or from passing original twelve.
- Numeric-vector length/index providers use signed conversions in places.
  An f64 cursor does not prove complete unsigned array-index semantics.
- Receiver-state restoration/prologue ordering is shared runtime work, but is
  necessary for correct inherited next/return access; isolate its exact cases.
- Preserve legacy cache behavior while making override property state coherent.
  If that requires non-additive changes to frozen/legacy paths, escalate rather
  than silently migrate them.
- Source-size/function-budget needs are parent decisions backed by exact diff.
  No allowance edits, test omissions or lowered acceptance in this plan.

## Source anchors read for this plan

Paths below refer to the parent integration checkout at
`/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927`;
line numbers are review-snapshot anchors, not immutable future offsets.

- `src/codegen/expressions/call-namespace-static.ts:3010`: original vec admission.
- `src/codegen/promise-combinator-drive.ts:292`: existing drive;
  :341 capability/resolve ordering; :373 acquisition; :407 step; :438 close;
  :493 state; :522 growing slot; :140 registration/resolve-element caps.
- `src/codegen/promise-combinator-observable-protocol.ts:220`: immediate rejection;
  :527 element protocol; :697 resolve-call pipeline; :724 then invocation.
- `src/codegen/generators-delegation-runtime.ts:174`: property-reader precedent;
  :310 iterator/next capture. Do not reuse yield-star step.
- `src/codegen/iterator-proto-next.ts:280`: native record property Get;
  :319 wrong prototype-as-receiver delegation to correct.
- `src/codegen/object-runtime.ts:2312`: explicit-receiver state/prologue;
  :2737 receiver-aware Get wrapper; :10343 presence-based carrier-bag precedence.
- `src/codegen/object-runtime-proxy.ts:1932`: explicit-receiver proxy forwarding.
- `src/codegen/expressions/proto-override.ts:89`: intercepted writes;
  :278 continuing values/@@iterator alias shortcut, not semantic acquisition.
- `src/codegen/array-proto-iterator-value.ts:79`: reflective factory;
  :133 eager length; :180 copy loop; :203 snapshot record construction.
- `src/codegen/array-object-proto.ts:968`: factory integration;
  :2633 initial function identity alias.
- `src/codegen/object-runtime-enumeration.ts:169`: null/default hint;
  `object-runtime.ts:5277`: null hint becomes observable "default".
- `src/codegen/object-runtime-prototype.ts:739`: non-$Object prototype write no-op.
- `src/codegen/object-runtime.ts:8877`: semantic vector indexed reads;
  `src/codegen/proto-index-store.ts:1189`: builtin companion-chain Get.
- Curie checkout: `src/codegen/iterator-live-array.ts:71` producer registration;
  :138 step; :176 actual iterator construction;
  `src/codegen/iterator-native.ts:5035` live next branch;
  :5924 live-aware rest drainer.
- Context: repo AGENTS, .claude/memory/MEMORY.md, shared-instruction/remapping
  and no-finalize-rebuild memories; issue5197 current vector repair section;
  original-vector pair JSON and Curie's substrate handoff.

No production or test file was modified to create this plan. No compiler,
test, gate, commit, merge, push or other Git mutation was performed.
