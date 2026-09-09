The authentication condition is closed: I inspected the genuine-positive/`sealed:false` negative; parent now reports **24/24 and TS7 exit0**. Resource approval remains limited to requirements and reservation—not full fill or execution.

# Native value materialization implementation plan

Source grounding: `a7fbc6eb6fa8ebcde29529d67e55408592672fee` plus the reviewed resource delta, now reported committed as `5118637e0e9b34291465230428447e511958faa1`. Getter capture is a separate prerequisite under Pauli; this plan must consume its corrected interface.

## 1. Next checkpoint and shared contract

Implement **real primitive-value and native literal/error materializers first**, with two disjoint Low lanes. Follow with callable/argument-vector and object-dispatch materialization. Do not attempt to complete the Promise pack by supplying signature-compatible placeholder functions.

The current [Promise dependency interface](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/backend/wasmgc/resources/native-promises.ts:121) requires:

- Number boxing, unboxing and classification.
- The canonical tag-1 undefined global.
- Real TypeError construction and exact native strings.
- Closure root and settlement metadata.
- Argument-vector creation/push and actual closure invocation.
- Complete object/accessor/callable classification.

Important distinction: the current pack **validates** the three number bindings but does not itself exercise their bodies. Execution proof must include actual number consumers—ultimately delay/frame await conversion—not count dependency admission as execution.

Use the existing `PhysicalModuleReservations` exclusively. New APIs should follow its existing reserve/fill model:

- `reserveNativeValueResources(tx, requirements, dependencies)`
- `fillNativeValueResources(tx, reservations, dependencies)`
- Corresponding string/error and callable resource operations.

These are proposed additions, not existing APIs. Return owned type/global/function reservations; bodies receive explicit layouts and stable function handles. No `CodegenContext`, allocator callbacks, arbitrary instruction callbacks or name-only lookup.

## 2. First parallel lane A: undefined and number bodies

**Existing write scope**

- [any-helpers.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/any-helpers.ts:28)
- [registry/imports.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/registry/imports.ts:1199)

**Proposed new files**

- `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/runtime/wasmgc/values/primitive-layouts.ts`
- `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/runtime/wasmgc/values/number-bodies.ts`
- `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/ir/program/native-value-resources.ts`
- `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/backend/wasmgc/resources/native-values.ts`
- `/private/tmp/js2-3518-native-promise-checkpoint-20260908/tests/issue-3518-native-value-resources.test.ts`

Extract executable descriptor/initializer builders from `ensureAnyValueType`, and body/locals builders for `__box_number`, `__unbox_number`, `__typeof_number` from `addUnionImportsAsNativeFuncs`. Existing adapters call these builders at their original allocation/registration points.

Preserve exactly:

- `AnyValue` fields: immutable `tag:i32`, `i32val:i32`, `f64val:f64`, `refval:eqref`, `externval:externref`.
- Undefined initializer: **tag1, 0, NaN, null-eq, null-extern**, then `struct.new`; one immutable, non-null global. Null is not its substitute.
- Number/boolean carrier layouts and identity.
- Signed-i31 fast path `[-2³⁰, 2³⁰−1]`; exclude negative zero, nonintegral values, nonfinite values and out-of-range integers.
- Boxed-f64 path for `3e9`, `-0`, NaN and infinities.
- Unbox order: null→0; i31; boxed number; boxed boolean; selected native-string scanner; opaque fallback→NaN.
- `__typeof_number` recognizes both i31 and boxed f64.

The scanner dependency must be explicit: either an actual native-string conversion binding with its exact layout, or affirmative evidence that the selected representation does not include that branch. Missing binding is not permission to omit it.

Keep legacy import-shift reconciliation, signature interning, function registration order, context caches and all unrelated union helpers—including BigInt—unchanged. Do not turn the canonical builder into another registry.

## 3. First parallel lane B: native strings and TypeError

**Existing write scope**

- [registry/types.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/registry/types.ts:765): Error and native-string layout production only.
- [native-string-literals.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/native-string-literals.ts:33)
- [registry/error-types.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/registry/error-types.ts:271)

**Proposed canonical owners**

Under `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/runtime/wasmgc/values/`:

- `string-layouts.ts`
- `string-literal-bodies.ts`
- `error-bodies.ts`

Under `/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/backend/wasmgc/resources/`:

- `native-string-literals.ts`
- `native-errors.ts`

Focused tests: `issue-3518-native-string-error-resources.test.ts` under the same checkout’s `tests/`.

Required implementation:

- Reuse the actual `AnyString`, flat, cons and hashed-string hierarchy; preserve all mutable hash/cache fields and selected UTF-8 layout.
- Move literal instruction production, hash calculation and chunking together. Preserve interning keys, allocation order, UTF-16 code-unit semantics and oversized-literal behavior.
- Materialize `"then"`, `"Chaining cycle detected for promise"` and `"TypeError"` through that owner. A text label attached to an arbitrary global is insufficient authentication.
- Reuse the six-field Error layout: tag, message, name, stack, userClassId, props.
- Build actual one-argument `__new_TypeError`: tag−11, supplied message, real name string, existing stack initialization, userClassId−1 and null props.
- Preserve Error constructor caching and name-string registration **before** body construction. No eager property-bag allocation.

Do not duplicate the builtin tag catalog. If its canonical placement is required, relocate that existing authority with compatibility exports, as a separately explicit parent-reviewed map amendment.

**Required dependent string work:** number unboxing with native strings needs the real scanner from [parse-number-native.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/parse-number-native.ts:582), including flattening, exponent helpers and power-table resources. Literal-only completion does not close this dependency. Number formatting, concat and stdout remain further full-family obligations.

## 4. Next executable slice: closure identities and argument vectors

Start after the first interfaces freeze; do not overlap Pauli’s scheduler/dispatch edits.

Existing donors:

- [closure-header-layout.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/closures/closure-header-layout.ts)
- [funcref-wrapper-types.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/closures/funcref-wrapper-types.ts:73)
- [builtin-fn-meta.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/builtin-fn-meta.ts:261)
- [object-runtime.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/object-runtime.ts:4375): `__objvec_new`/`__objvec_push` bodies and their layouts.

Canonical destinations: `runtime/wasmgc/values/closure-layouts.ts`, `argument-vector-bodies.ts`, and `backend/wasmgc/resources/native-callables.ts` under the reviewed checkout.

Required contracts:

- One canonical closure root: `[func, $arity, $bag]`.
- Lifted functions take that root as `self`, not whichever signature wrapper was allocated first.
- Settlement metadata retains `[func,$arity,$bag,bfnstate,bfnid]`; genuine `"promise:settle"` metadata, name `""`, length1, followed by the Promise capture field.
- Preserve metadata identity independently of structurally equivalent Wasm types.
- `$ObjVecArr`/`$ObjVec` remain distinct from the prepared vector’s backing/carrier. Reuse the existing vector-base identity where the donor does.
- `__objvec_new`: actual empty vector with capacity8.
- `__objvec_push`: original copy/grow/store/length-update order and existing non-vector behavior.

Legacy mutations that must remain accounted for include wrapper caches, root assignment, closure counter, minimum argument counts, allocation-mode flags, `closureInfoByTypeIdx`, builtin metadata maps and adopted early argument-array reservations.

This slice creates genuine closure values and argument storage. It does **not** complete `applyClosure`.

## 5. Then complete object lookup and callable invocation

This is the necessary connected join—not an optional convenience layer.

Serialize ownership of `object-runtime.ts` after argument-vector extraction. The dependent donor scope is:

- `reserveApplyClosure` / `fillApplyClosure` in [object-runtime.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/object-runtime.ts:7357).
- Arity/widening and actual method-call bridges in [closure-exports.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/closure-exports.ts:1940).
- [accessor-driver.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/accessor-driver.ts:338).
- [closure-classifier.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/closure-classifier.ts:43).
- [typeof-natives-finalize.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/typeof-natives-finalize.ts:57).
- [carrier-bag-visibility.ts](/private/tmp/js2-3518-native-promise-checkpoint-20260908/src/codegen/carrier-bag-visibility.ts:442).
- Pauli’s completed capture-once lookup and existing closed-method fallback.

Canonical bodies belong under `runtime/wasmgc/values/`; IR-to-resource selection belongs under `backend/wasmgc/resources/`.

Preserve:

- Real `$PropEntry`, `$PropMap`, self-referencing `$Object`, flags, tombstones, insertion ordering and getter/setter slots.
- Lookup/hash/equality/prototype behavior and relevant native-string caches.
- Nonallocating bag reads; lookup must not create a bag.
- Actual argument count before dispatcher widening; omitted arguments, extras, receiver and closure-self.
- Existing runtime receiver/argc handling and exception behavior—do not silently add restoration semantics during extraction.
- Finalization after the complete callable population exists.

The initial `__typeof_function` zero body and `__apply_closure` unreachable body are reservations, never implementations. No missing dispatcher may become an accepted zero/null/identity fallback.

Pauli’s captured ordinary `then` must travel to the queued job and invoke through real closure application; do not restore the second getter read.

## 6. Authenticate population before selecting classifier arms

The existing single-role `carriers` array is inadequate as the final classification contract: one carrier can contribute both accessor and field behavior.

Use one authenticated carrier inventory with **separate ordered projections** for methods, accessors, fields, closure roots and other callable carriers. Preserve original precedence and fallback behavior. Do not duplicate the underlying authority.

The checked parent must join three populations:

1. Complete semantic/selected prepared owners, state bodies, globals and startup—retain the original family’s **16 owners /33 calls**.
2. Allocation/type/capture records, preserving aliases, metadata and provenance losslessly.
3. Runtime-created Promise, callback, settle-capture, frame, timer, combinator, error, string and argument-vector allocations.

The third population is not recoverable merely by counting source IR allocations.

Reconcile these records with actual reserved layouts, allocation instructions and callable targets. Two copies of a caller-supplied list are not independent evidence. Unknown metadata or missing required implementation produces a located refusal; no empty-inventory inference.

## 7. Parent integration and acceptance

Parent retains `program-consumer.ts`, `program-physical-plan.ts`, Promise-pack interface joins and boundary-policy activation.

One transaction:

1. Authenticate program, projection, providers and current attachments.
2. Reserve all prerequisite resources and forward function handles.
3. Complete the carrier/dispatch population.
4. Freeze reservations; resolve physical publication indices.
5. Fill actual globals and bodies exactly once.
6. Publish refs, timer/export/start metadata; seal.

Keep recursive layout ownership and the existing shared vector identity. No late allocation, second ABI map or new completion authority.

Each slice needs:

- Live donor body/locals/initializer/order receipts; preserve existing hashes and denominators through checked reconstruction.
- Same-module, stale-layout, wrong-target, missing-fill, altered numeric initializer and omitted-carrier negatives.
- Actual legacy callers using the canonical builders, with paired bytes/WAT/resource ordering.
- Direct execution of owned implementations: i31 boundaries, `3e9`, `-0`, NaN/infinities; undefined versus null; strings and real TypeError; vector growth; closure invocation and captured-getter behavior.
- Fresh-process prepared replay forbidding frontend/legacy imports. Resource unit tests alone do not prove this route.

The confirmed getter defect remains a correctness failure even where baseline/candidate bytes match. Its corrected candidate needs independent semantic evidence.

**Dispatch recommendation:** start the two disjoint primitive and literal/error lanes; follow with closure/argument-vector and then object/invocation joins. No new user architectural choice is needed. Complete Promise fill, frames, timers, full-family strings/output, public IR-only cutover, strict closure and the unresolved ABI30 witness remain explicit obligations.

No files or tests changed. Pauli’s frozen getter revision is the next review, not assessed in this plan.
