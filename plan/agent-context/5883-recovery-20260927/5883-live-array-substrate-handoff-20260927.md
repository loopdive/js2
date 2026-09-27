# Live array iterator substrate — source-only handoff

## FROZEN for parent integration

Current source frozen at the four SHA256 values in the final Hume-follow-up
section below. No further source edits without parent steering. Parent can
integrate the two tracked-file diffs (`iterator-native.ts`,
`object-runtime-enumeration.ts`) and the complete new `iterator-live-array.ts`
and focused test file from this worktree. Apply diffs to existing files rather
than replacing files that other lanes may have edited.

The concrete hint fix is the optional third argument on
`buildArrayLikeToLengthFromExternref`, defaulting to `"default"`, and the new
live helper's explicit `"number"` call. The number branch builds a native string
hint; default retains the old null externref sequence. The only additional
production file beyond original ownership is this authorized conversion helper.

Parent C owns `array-proto-iterator-value.ts` activation. Its proposed VALUES
call sequence (ensure producer, nullish guard, runtime producer) matches this
API: registration is compile-time; runtime creation allocates a payload/record
and performs no source length/index Get. KEYS/ENTRIES and full GetIterator /
next capture remain outside this patch. No factory activation in this tree.

Russell owns `iterator-proto-next.ts` and object-runtime explicit-receiver work;
neither is edited here. `object-runtime-enumeration.ts`'s narrow ToLength option
is the sole authorized shared conversion-file change, so coordinate its two
hunks if that file overlaps Russell's lane. Huygens holds the compiler slot;
this lane has no active process or new test run.

Measured pre-hint patch: run 02 = 7/9 passed, 2/9 failed. Frozen hint patch plus
three added cases = 12 focused cases, UNRUN. Preserve these distinct claims.

---

Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-live-vector-20260927`
Branch: `codex/5883-live-vector-20260927`
Base: `3dc8bc710fef7ec666cf24a5f8f8c757b72add6a`

Parent owns integration, the upstream-main merge, publication, and the compiler
slot. Initial handoff was source-only; see the authorized run and harness fix
below for the current validation status. No typecheck or ratchet gate was run. No commit, push,
merge, or changes to another worktree. Formatting and targeted `git diff
--check` only. These are unvalidated source changes, not a completed IR claim
or grounds to remove the held Promise PR's hold.

## Files and cause

- `src/codegen/iterator-live-array.ts`: opt-in native producer, payload
  discriminator, live step and length helper.
- `src/codegen/iterator-native.ts`: central normal/strict next recognition,
  live-aware fill guards, and step-driven rest draining for the new payload.
- `tests/issue-5883-live-array-substrate.test.ts`: nine unrun focused cases
  using real helper exports in a test-only registration harness.
- This handoff.

Legacy array producers can normalize numeric vectors to a boxed copy. The new
producer retains the original source, so every step reads its current length
and index through the existing semantic property providers. It does not modify
or activate legacy producers.

## Integration contract

Call `ensureNativeLiveArrayValues(ctx)` during dependency registration/codegen,
before `fillNativeIteratorLateArms`. It returns the current function handle for
`__live_array_values(externref source) -> externref IterRec`. After any intervening
registration phase, resolve that name from `ctx.funcMap` again rather than
caching a numeric index outside the emitted instruction graph.

The caller must already have resolved intrinsic `Array.prototype.values`.
Receiver validation, observable GetIterator, `@@iterator` overrides, method
invocation/identity, and next-method capture are the parent's responsibility.
This API does not prove or perform those operations. No source-lowering site
calls it yet. No test-only production exports or dead-export annotations added.

The existing five-field IterRec ABI remains unchanged: kind=VEC, vec=null,
legacy idx=0, userIter=payload, family=ARRAY. The payload carries immutable
source, mutable f64 nextIndex, mutable i32 exhausted, and immutable brand value.
Dispatch checks VEC kind, payload RTT, and the brand value; RTT alone is not
treated as nominal identity because WasmGC canonicalizes structural types.

The f64 cursor represents the complete unsigned array-index range and avoids
an INT32_MAX exhaustion sentinel. The exhausted flag is tested before any
source Get. NextIndex is captured before live Get(length)+ToLength, then
advanced before indexed Get; indexed throws/reentrancy retain that advancement.
Terminal results use canonical undefined. Indexed values are returned unchanged
from `__extern_get_idx`, leaving hole/inherited Get, own undefined, and genuine
NaN discrimination to that semantic reader.

Object/coercion/undefined dependencies are established during opt-in producer
registration. Fill-time live dependency resolution only reads maps. New helper
bodies are emitted once, and individual instruction objects are fresh. No
context/types changes were needed.

## Central consumer audit

- Normal `__iterator_next`: live payload recognition precedes the old vec step.
- `__iterator_next_strict`: independently built recognition uses the same live
  step; both functions receive fresh instruction graphs.
- Vector-only fill guards: live dependencies independently enable next/rest
  rebuilding, even without USER/OBJ/generator dependencies.
- `__iterator_rest`: a live payload enters the existing growing-buffer drain,
  polling next through its terminal result and therefore advancing/latching.
  Unconnected modules retain the old drain predicate and old producer behavior.
- `__array_from_iter_n`: eager registration already admits IterRec as a drain
  candidate, and late rebuilds preserve that admission. GetIterator adopts the
  record by identity; bounded calls do not perform an extra terminal step.
- Borrowed ArrayIteratorPrototype.next in `iterator-proto-next.ts`: family
  validation delegates to `__iter_next_result`, which calls central next.
- `__any_iter_next` and Map/Set's generic IterRec `.next()` bridge delegate to
  central next; no live payload is exposed as an independent iterator kind.
- `iter-hof-native.ts`: IterRec admission keeps the record as handle and helper
  steppers delegate to central next. Lazy-helper ladders are filled later.
- Return/close retains VEC's existing no-return behavior. Family/prototype/tag
  consumers continue to see ARRAY/VEC, not an unrecognized new kind.

## Unrun verification and remaining boundaries

The focused tests require successful compilation, zero Wasm imports, successful
instantiation, and exact values. They cover normal and strict growth/replacement,
independent cursors, terminal regrowth, rest draining, bounded materialization,
borrowed next, for-of consumption, inherited holes/own undefined/NaN, throwing
and reentrant indexed Get, and no further length Get after exhaustion. A
test-only seek wrapper checks indices around 2^31 and 2^32 without billions of
steps. Shrink/regrow coverage depends on the parent's array mutation repairs.

Suggested first run after an explicit slot grant:
`pnpm exec vitest run tests/issue-5883-live-array-substrate.test.ts`.
The harness itself is unrun; failures must be attributed before treating any
case as substrate evidence. Getter/prototype cases also exercise existing
semantic Get providers and may reveal separate substrate limitations. Large
index coverage uses a generic sparse array-like receiver, not an enormous
physical array allocation. Allocation limits for full drains are unchanged.

Source-size/function-budget gates were not run; existing large iterator
functions grow in this patch and may need a scoped integration decision. No
allowance or fabricated production reference was added. Hume's `send_input`
tool was not available in this session, so no fresh Hume review is claimed.

Preserved untouched: `promise-combinators.ts`, the original 12 Promise review
inputs and `5883-original-vector-pair-20260927.json` (recorded 4 pass / 8 fail),
and parent-owned `vec-length-set.ts`, `vec-length-hole-fill.ts`,
`expressions/assignment.ts`, and `array-length-define.ts`. The failed shared-drive
experiment remains preserved. Parent reported merging upstream main `9be5011449`
into its integration branch; this worktree remains on its assigned base.

## Authorized run 01 and source-only harness fix (for parent / Hume)

On the explicit compiler-slot grant, ran only the focused nine cases, serially:
`VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 pnpm exec vitest run tests/issue-5883-live-array-substrate.test.ts`.
The process finished without intervention: exit 1, 0/9 passed, 9/9 failed,
16.55 seconds. All nine stop at Wasm validation of `testSeek`; no iterator value
assertions or native-control comparisons were reached. Full log and initial
source SHA256 values are preserved unchanged under
`.tmp/5883-live-array-slot-20260927/run-01.log` and `run-01-provenance.md`.
Slot explicitly released for the parent's corrective fork push; no new runs.

Source trace of the validation failure:

- `getOrRegisterIterRecType` declares field 3 (`userIter`) as mutable externref.
  Therefore `struct.get IterRec 3; any.convert_extern; ref.cast Payload` is
  correctly typed. Neither conversion should be blindly removed.
- `testSeek` originally immediately followed that chain with the f64 value
  and `struct.set Payload 1`.
- `fixups.ts::repairBody`'s struct-set backward walk sums net stack deltas.
  Both casts/conversions and struct.get have delta zero; it reaches param 0
  as the putative receiver producer. Param 0 is externref. The existing
  exact-cast guard compares the immediate IterRec cast against the target
  Payload type, fails, and inserts `any.convert_extern; ref.cast_null Payload`
  immediately after param 0. The original any.convert_extern then receives a
  GC ref, matching the observed validation error. This is source-traced, not
  confirmed by a second compiler run or a retained emitted-instruction dump.
- Source-only fix in the test harness: store the decoded payload in a declared
  `(ref null Payload)` local 2, then load that local and the f64 value for
  struct.set. This makes the receiver explicit and correctly typed before the
  repair pass. Added a registration-time assertion of all five IterRec field
  types. No blind cast, no stack-repair changes, no expectation changes.
- Production `__live_array_next` already casts once into typed payload local 1
  and uses that typed local for both writes. `liveArrayPayloadTest` only reads;
  the producer only allocates. The specific struct-set backward-walk mechanism
  does not apply to those sites by source inspection. Hume should still review
  their emitted instructions when a compiler slot is granted; this is not a
  production validation claim.

All nine original semantic expectations and native controls are unchanged.
The harness correction is UNRUN and awaits a renewed explicit grant. The first
failed log/hash record remains immutable; no production source changed in this
correction.

## Authorized focused rerun 02 — current measured status

Parent renewed the slot only for the focused rerun after testSeek correction.
Same serial/memory settings, same nine expectations: **7/9 pass, 2/9 fail**,
terminal exit 1, duration 17.80 seconds. Slot explicitly released immediately
after terminal. Full log and source hashes: `.tmp/5883-live-array-slot-20260927/run-02.log`
and `run-02-provenance.md`. First failed receipt remains unchanged.

All nine now compile, assert zero host imports, and instantiate. Passed normal
and strict growth/replacement/latch, independent cursors, terminal rest drain,
unsigned-index boundary via test-only seek, bounded materialization plus
borrowed next/for-of continuation, throwing/reentrant indexed Get, and no length
Get/conversion after exhaustion.

Actual failures on this lane's unchanged base:

- Shrink/regrow: stale `2` returned, native expected undefined (`-1000` encoding).
  Initial native step matched; first post-regrowth comparison failed.
- Inherited hole: undefined returned, native expected inherited `41`. This is
  the first comparison, so own undefined, NaN, and terminal expectations in
  that case were not reached. Do not claim those subcases pass.

The two growth cases and both failing cases execute native control comparisons.
Other cases assert their original exact constants. Large-index coverage uses a
generic sparse array-like with a test-only seek, not a huge physical allocation.
The parent mutation repairs/upstream merge are not in this worktree. No paired
run establishes the failures' ownership yet. Original Promise 12 not rerun,
expectations not weakened, no production changes from run 01 to run 02.

## Hume follow-up — source only, after run 02

Terminal handle `98090` exited 1 and was released explicitly for parent's
generator validation. No further compiler/tests run.

Hume identified that the shared ToLength builder supplies a null ToPrimitive
hint, which the runtime presents to @@toPrimitive as `default`. This differs
observably from ToNumber's required `number`. Narrow additional authorized
production ownership: `src/codegen/object-runtime-enumeration.ts` now accepts
an optional `"default" | "number"` third argument, defaulting to the unchanged
legacy sequence. Only the new live-array caller passes `"number"`; it emits
the native string hint during initial registration, with no fill-time ensure.
Existing callers were not migrated or otherwise changed.

Added three unrun focused cases (suite now 12 cases, previously measured 9):

- Hint-sensitive `length[Symbol.toPrimitive]`: returns 2 only for `number`,
  checks native value sequence and exact hint trace 111, including terminal
  latch suppressing a fourth conversion.
- Array.prototype inherited data: hole resolves to 41, own undefined masks 42,
  own NaN masks 43, followed by canonical undefined terminal result.
- Array.prototype inherited getter: same values plus exactly one getter read.
  Native prototype changes are synchronous and restored before assertions or
  Wasm calls. Native expected rows are also pinned to exact constants.

All original nine test bodies/semantic expectations and native controls remain.
The custom `Object.setPrototypeOf(array, proto)` case remains failing in run 02;
Hume identifies its existing writer as unsupported. That source review is
separate from the measured result; no reader fix or passing custom-prototype
claim follows from it. Shrink/regrow remains the other failure on this base.
The sparse-object high-index case PASSED; no boundary repair was made, and its
test-only seek/generic-object scope caveat remains.

Current source SHA256 (UNRUN after hint change/additional tests):
- iterator-native.ts: 4b34fcc0841a6a68a00d111100835c51a3d7ea182cd7edd19328d37145954c5b
- iterator-live-array.ts: de04572d428e1e27304e2461d7362117414ce8744f9e22b5705020a343cabda5
- object-runtime-enumeration.ts: 87625f31469967d49d4ccd9202ef814d712c433e499b881ca4d699f9644d0327
- issue-5883-live-array-substrate.test.ts: 3173d59fc8255e3ca688bec60f16334c84db3140f0c129d8676d5c0ec2b8068e

Preserved complete nine-case receipts:
- run-01.log SHA256: 54ea2cdba2e6ea4e1b6d7339883e97ca12157814ef591ef68f4e07105715ec76 (0/9 pass, harness validation)
- run-02.log SHA256: 74d3d0092747ca40369750dae4178e8ca99438ab7c565817160a2a8894080450 (7/9 pass, two value failures)
- Each matching run-NN-provenance.md retains its exact source hashes and scope.

Original Promise review artifact remains SHA256
5e556bd4708766e506b2917883e84dbb84ffb4bcab9e112a34d90a3705a4cf28.
No parent mutation files, production activation, commits or pushes.
