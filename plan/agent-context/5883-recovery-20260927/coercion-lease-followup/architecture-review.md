# PR5883: prepared coercion engine boundary

Source-only architecture decision, 2026-09-27. Reviewed `/private/tmp/js2-5883-main-688-20260927`; no compiler, tests, gate execution, production edits or git mutations. Proposed changes below are not implemented or runtime-verified. Parent owns implementation/integration and validation. Frozen Promise legacy source remains untouched.

## Decision and bounded ownership

Use the existing engine raw-runtime ToNumber bridge. Add two read-only, operation-specific engine instruction factories and one narrowly allocating truthiness-provider preparation entrypoint. Four production files only: `src/codegen/coercion-engine.ts` and the three consumers `iterator-receiver-to-object.ts`, `iterator-live-array.ts`, `promise-vector-iterator.ts`. Parent can own all four as one small atomic change; no other agent needs a source assignment. No registry, finalizer, admission, deferred-activation, IR layout or physical carrier policy changes.

This is a real engine boundary: the engine owns the canonical operation, stack ABI and provider selection. Do not introduce a generic provider-name lookup wrapper, move vocabulary to caller constants, use token concatenation, add allowances, or update baselines. Existing historical coercion sites outside these consumers remain outside scope.

## Exact engine API contract

1. Reuse `runtimeToNumberInstrs(ctx): Instr[] | null`, currently lines 99–104. It reads the canonical numeric unbox provider and returns one fresh call, or null when absent. It is not a full object ToNumber implementation: callers must already establish the appropriate operand domain. Do not change its behavior.

2. Add `runtimeToBooleanInstrs(ctx): Instr[] | null`. Input stack: an externref JavaScript value. Output stack: i32 JavaScript truthiness. Resolve the current canonical `__is_truthy` entry and return one fresh call, or null. No registration, globals, locals, imports, flushing, fallback, sink mutation or cached indices/instruction trees. In particular, absence must not become a non-null test.

3. Add `runtimeNumberToStringInstrs(ctx): Instr[] | null`. Input stack: an actual unbranded f64 Number, not an encoded undefined/hole or a boxed value. Output stack: externref string using the existing `number_toString` provider, in its existing mode-dependent representation. Resolve the canonical provider and return exactly one fresh call, or null. No integer conversion, boxing, sentinel handling, native-ref adaptation, allocation or registration. This is the Number-to-string primitive, not arbitrary-value ToString.

4. Add `ensureRuntimeToBooleanProvider(ctx): number | undefined`, the allocating counterpart for registration phase only. It performs exactly the existing `ensureLateImport` request for externref-to-i32 truthiness. It does not call `addUnionImports`, flush, construct instructions, or provide fallback semantics. Extract that precise request from the externref branch of `emitToBoolean` (currently line 735) into this entrypoint and reuse it there. Keep the branch's existing preceding `addUnionImports`, canonical-map reread/provisional-index behavior, and existing missing-provider fallback unchanged. The returned index is not a handle to retain across later preparation.

The distinction between (2) and (4) must be documented: preparation can mutate function space; raw detached-body emission cannot. Do not make (2) silently ensure its provider. These APIs require no new mutable state. Consumers are live production references, not dummy references to satisfy dead-export checks.

## Consumer edits, instruction and registration correspondence

### ToObject receiver wrapper

`iterator-receiver-to-object.ts:24–58`: preserve all existing ensures and nullish-error construction before numeric provider lookup. Obtain `runtimeToNumberInstrs` after preparation; null is a missing-registration error, never an empty instruction list. Insert its one call exactly where the direct numeric-unbox call currently appears in `primitiveArm`.

Runtime execution remains guarded by `__typeof_number`. Thus it unwraps only the proven numeric primitive before `__new_Number`; it does not invoke ToPrimitive, user conversion methods or constructors. Preserve every other primitive/object branch and evaluation count. Allocation of the TypeScript instruction array before the branch does not execute the conversion.

### Live array length/index

`iterator-live-array.ts:74–91`: replace only the direct numeric-unbox readiness test with `runtimeToNumberInstrs(ctx) === null`; replace the Number-to-string readiness test with `runtimeNumberToStringInstrs(ctx) === null`. Discard these readiness instruction arrays. Preserve all other prerequisites and the existing error, so the historical ToLength builder cannot select its degraded missing-provider path for this caller.

At line 176, request a fresh `runtimeNumberToStringInstrs` after existing preparation, and spread its one call into the same position between `local.get 2` and indexed Get. Null is a registration failure. Do not retain a call captured by the earlier readiness check across preparation. Preserve source stack value, local indices, length Get ordering, advance-before-indexed-Get ordering, exhaustion latch and result shape.

`coercion-engine.ts:284–310` does **not** classify an unbranded f64 as a sentinel: sentinel handling requires `undefSentinel === true` and JS-host mode. The actual reason not to use general `emitToString` is its different contract: lines 352–375 permit missing-provider decline and, in native mode, append conversion/cast from externref to native string ref. This site needs the existing externref result for `__extern_get`. `getExternrefToStringProvider` also has the wrong operand ABI. Do not fix that mismatch by adding boxing/adapters.

Keep `object-runtime-enumeration.ts:120–215` unchanged. Its existing ToLength body includes ToPrimitive(number), string conversion, Symbol rejection, truncation and clamping. A readiness use of `runtimeToNumberInstrs` is not permission to replace this body with unboxing. The builder itself captures providers around existing error/string preparation; this review does not claim to establish a new global absence-of-shifts proof for that historical builder. The proposed replacement adds no mutation there.

### Promise iterator truthiness

`promise-vector-iterator.ts:61–76` has a significant exact order:

1. Ensure object predicate, function predicate, callable predicate.
2. Ensure truthiness.
3. Ensure undefined predicate.
4. Warm `emitToBoolean(ctx, ER, [])`.
5. Prepare undefined/error/tag/key providers and perform the existing shift flush.

Split the first loop after the three initial predicates; call engine `ensureRuntimeToBooleanProvider` at the old truthiness slot; then ensure the undefined predicate. Keep the existing `emitToBoolean` warm-up exactly where it was. The extracted ensure must not move its `addUnionImports` ahead of the undefined predicate. Merely deleting truthiness from the loop and relying on the later warm-up does not establish registration-order preservation.

At the subsequent readiness loop (lines 77–89), remove only the truthiness name and check `runtimeToBooleanInstrs` at the corresponding point between callable and undefined checks. Missing provider throws; no fallback. This preserves prerequisite checking order without retaining the readiness call.

At the detached STEP body (line 208), replace the direct truthiness call with a fresh engine read-only call. Its input remains the once-read `done` property. Preserve the exact if branches, terminal latch, exception handling and value getter suppression. Do not call allocating `emitToBoolean` here, even if registration is believed idempotent. Do not introduce a second preparation/flush after detached bodies exist.

## Why this is sufficient and what it does not claim

Every changed runtime site remains a single call to the same provider at the same stack location. The preparation extraction preserves the existing sequence of allocating operations and their arguments, not just eventual provider presence. Read-only factories resolve the current canonical map each time and produce fresh instruction objects. They do not solve unrelated late-index shifting; the current registration/flush/attachment lifecycle still applies unchanged.

This is independent of PR5883's pending activation design: no new demand registry, staged body, retry, finalizer rebuild, module-wide dirty flag or deferred publication is needed. It does not broaden admission or claim full IR equivalence, fix retained behavioral failures, or authorize old-compiler retirement.

## Required parent validation (not run)

- Read-only factory checks: absent provider returns null without mutation; present provider returns exactly one call with expected ABI/provider; index zero is valid; a later canonical-map index change is observed; separate requests share no instruction object. Inspect module functions/types/imports/globals, locals where applicable, and registration state for accidental mutation.
- Preparation correspondence: provider-missing and provider-already-present cases preserve the original ordered registration requests, including truthiness before undefined predicate and union warming afterward. Detached STEP construction must not call any new allocating coercion API.
- Compare the affected helper instruction trees/provider registration order against the prior source, allowing only the engine delegation in TypeScript, not extra Wasm conversions, locals, branches or calls. Keep existing no-opt-in behavior and registration demand unchanged.
- Existing behavioral controls plus numeric wrapper inputs `+0`, `-0`, NaN and infinities; unchanged rejection of nullish receivers and identity of objects; index keys across integer formatting boundaries; length object conversion/throwing conversion, strings and Symbol abruptness; `done` values false, zero, NaN, empty string, null/undefined and truthy objects. Getter counts/order, captured-next semantics, exhaustion and close behavior remain required, not relaxed.
- Run normal source coercion/dead-export/size gates without allowance/baseline edits when parent has the slot. Keep all retained failures and compare exact status; these checks are not a replacement for broader equivalence work.

Source anchors above refer to the reviewed parent tree, not a proposed patch. Decision is implementation-ready at this narrow boundary; validation remains parent-owned.
