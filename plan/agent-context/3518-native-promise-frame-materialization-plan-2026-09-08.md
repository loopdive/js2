# Native Promise/frame materialization

Astra High specification; implementation remains pending.

## Recommended next checkpoint

Implement the **shared native Promise/scheduler resource pack**, then bind prepared frames to it. Do not extract the already-canonical frame, queue, settlement, delay or combinator bodies again.

Grounding: current callable integration HEAD `2b9cb408c18446361fcf9837045067d1fd97c642` plus composed logical admission changes. The separate, untested vector consumer is a prerequisite integration—not reviewed here.

The complete source-family obligation remains **16 prepared functions / 33 call occurrences**, including derived bodies. Runtime helpers and frame machinery are additional physical resources, not replacements for that denominator.

## 1. Resource order and the critical dependency

The existing donor order is concrete:

1. Shared vector backing-array identity; native value carriers and exception tag.
2. Microtask queue storage and grow/enqueue/drain functions.
3. Promise carrier, callback list and continuation-capture types.
4. Fulfill/reject, identity reactions and **resolve-value** reservations.
5. Resolve-value’s adoption/thenable dependencies and final classifier bodies.
6. Delay callback/provider and Promise.all resources.
7. Per-owner frame type, resume function, fulfillment step and rejection step.
8. Timer callback publication, native strings/formatting/stdout, exports/start; final completion.

The important blocker is step 5. In [async-scheduler.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/async-scheduler.ts:971), resolve-value is not merely “fulfill unless already settled.” It handles self-resolution, native Promise adoption, captured `then`, poisoned getters and queued thenable jobs. Its dependencies include TypeError construction, `"then"` and self-resolution strings, closure wrappers, object/closure inventories and closed dispatch.

**Neither the legacy `thenable === null` fallback nor the temporary zero/identity classifier bodies are valid completed native implementations.**

## 2. Shared contract before Low implementation

Use the existing `PhysicalModuleReservations` instance. No second allocator, type registry, module completion authority or ABI map.

Proposed backend operations:

- `reserveNativePromiseResources(...)`: reserves exact types, globals and function objects; returns owned reservation tokens.
- `fillNativePromiseResources(...)`: supplies locals, bodies and initializers exactly once.
- `reservePreparedNativeFrame(...)` / `fillPreparedNativeFrame(...)`: owner-specific frame resources using that same pack.

These are proposed APIs, not existing helpers. Their inputs must contain:

- Authenticated selected providers and current prepared attachments.
- The vector prerequisite’s **actual shared externref-array reservation** and vector-layout bindings.
- Exception-tag reservation.
- Native number-box/unbox/classification bindings, canonical undefined global and relevant carrier types.
- Complete resolve-value dependency bindings and finalized ordered object/closure classification data.
- Explicit hook/unhandled-rejection configuration derived from the selected runtime—not inferred defaults.

No `CodegenContext`, allocator callback, arbitrary instruction-producing callback, or name-only function lookup.

Resource keys use existing canonical binding identities for callable providers and owner-plus-role identities for machinery. Frame roles remain owner-relative; names are diagnostic labels, not ownership.

Functions embedded in instructions use stable handles. `ProgramAbiMap`, exports, elements and startup publication use the ledger’s resolved physical indices.

## 3. Disjoint implementation lanes

### Low A — complete resolve-value/body dependency interface

This is the necessary executable prerequisite to materializing a complete Promise pack.

Owned existing donors:

- [async-scheduler.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/async-scheduler.ts): `buildPromiseResolveValueLocals`, `buildPromiseResolveValueBody`, thenable-job construction and settle-closure body construction.
- [closed-method-dispatch.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/closed-method-dispatch.ts:2001): body production inside `fillPromiseThenableHelpers`.

Proposed canonical files:

- `/private/tmp/js2-3518-native-callables-integration-20260908/src/runtime/wasmgc/promise/resolution-bodies.ts`
- `/private/tmp/js2-3518-native-callables-integration-20260908/src/runtime/wasmgc/promise/thenable-bodies.ts`

The legacy allocating adapters remain and call these builders at their existing points. They retain caches, registration order, late-import handling and finalization timing.

The new builder interfaces must explicitly carry:

- Promise/callback/continuation/capture types and field positions.
- Fulfill, reject, resolve-value, enqueue and identity-reaction handles.
- TypeError constructor, exception tag and exact string operands.
- Object getter, callable classifier, apply-closure and argument-vector bindings.
- Ordered method, accessor, field, open-object and closure-wrapper arms.
- AnyValue peel layout and builtin settle-function metadata/capture layout.

Preserve classifier precedence: closed methods, applicable accessors **before fields**, then open-object handling. Getter invocation and captured-`then` timing must remain unchanged.

The actual legacy collectors supply these inventories. For the source-free backend, an empty inventory requires affirmative accounting from the complete prepared/resource population; absence of an inventory is not emptiness.

Tests owned by A: focused resolution-body preservation and inventory/finalization controls. Preserve donor statements, bodies, locals, metadata, initialization order and original receipt denominators.

### Low B — physical Promise/scheduler pack

Proposed files:

- `/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program/native-promise-resources.ts`
- `/private/tmp/js2-3518-native-callables-integration-20260908/src/backend/wasmgc/resources/native-promises.ts`
- `/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-native-promise-resources.test.ts`

The program file owns logical requirements and owner provenance; physical tokens and allocation stay in the backend file.

Reuse the existing canonical queue and settlement builders. Preserve:

- Queue globals in order: head, tail, capacity, functions, captures, arguments.
- Initial capacity 8192 and lazy storage allocation.
- Queue grow → enqueue → drain ordering.
- Promise fields: state, value, callbacks, closure bag.
- Callback fields: fulfill function/captures, reject function/captures, next.
- Continuation captures: callback then chained Promise.
- Separate fulfill, reject, identity-fulfill, identity-reject and resolve-value reservations.

Resolve-value must be reserved before recursive consumers are filled. Identity fulfillment must target it, not direct fulfillment.

B can implement reservation/layout validation while A develops builders. **Completion of the full pack waits for A’s frozen interface and actual native value/object/string dependencies.** No fabricated bindings may make B’s tests or parent acceptance green.

### Parent integration

Parent alone owns:

- [program-physical-plan.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-physical-plan.ts)
- [program-consumer.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-consumer.ts)
- Shared vector integration, boundary activation and source-produced execution tests.

Keep the current async refusal until every required resource has a supported materializer. Replace it with exact resource admission, not a blanket removal.

## 4. Ordered dependent implementation

### Prepared frames

After the Promise resource interface freezes, implement a source-free frame adapter under:

`/private/tmp/js2-3518-native-callables-integration-20260908/src/backend/wasmgc/prepared-async-frame.ts`

Use [ir-async-frame.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/ir-async-frame.ts:61) as the translation donor and the existing canonical `frame-engine.ts` / `native-await.ts` as executable owners.

Preserve:

- Frame fields: state, sent, mode, abrupt, error; parameters; ordered spills; result Promise.
- Parameter versus spill mutability and exact vector layout identity.
- Resume → fulfill-step → reject-step reservation order.
- Selected **runtime-state bodies**, updates and terminators—not stale semantic bodies.
- Entry allocation: pending result Promise, initialized frame, one initial resume call, returned Promise.
- Always-asynchronous await, including already-settled and ordinary values.
- Exact number unboxing and sealed vector `fromExtern` conversion.
- Full handler data and rejection behavior. Unsupported handlers remain explicit failures; never turn them into an empty handler list.

The legacy adapter’s `currentFunc` restoration remains in `finally`. The canonical adapter owns explicit locals/body arrays and never installs a legacy context.

### Delay and Promise.all

Reuse existing canonical body owners; add resource materialization, not duplicate algorithms.

Delay requires the real timer import, canonical zero-argument wrapper/capture layout, callback, box-number, resolve-value, reject and tag. Its logical `(f64, f64) → Promise` contract must not be confused with the timer import’s externref ABI.

Promise.all requires the shared vector array/carrier, combinator state/captures and real subscription/settlement functions. Preserve logical-length iteration, input order, result ordering and empty-input behavior.

Timer publication is also executable work: [publishStandaloneTimerCallbackDispatch](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/closure-exports.ts:388) retains an exact dispatcher, binding/marker tables, element, manifest global and collision-safe exports. A callback body alone does not implement this boundary.

### Values and strings remain mandatory

Native number support must retain the i31 fast path **and** boxed f64 path, including `3e9`, negative zero and nonfinite values. Canonical undefined is the tag-1 singleton, not null.

The full family additionally needs the actual native string carrier, formatter, concat and stdout accumulator/materializers. Existing donors are `number-format-native.ts` and `native-strings.ts`; clock-zero adds no callable slot. These cannot be replaced by host imports or acceptance of provider names.

## 5. Completion and acceptance

One transaction:

1. Authenticate complete population and resource requirements.
2. Reserve imports, types, globals and functions in explicit order.
3. Finalize required inventories; freeze reservations.
4. Bind ABI indices; fill every reserved body/global.
5. Publish required refs, timer metadata, exports and startup.
6. Seal and emit. Preserve acceptance-token single use, including failure paths.

Required controls:

- Wrong-module tokens, duplicate/shared-array identities, missing fills, stale layouts, changed inventories, missing resolve-value, altered callback/field order and omitted timer publication fail closed.
- Run original source and decoded preparation across existing GVN/source axes; retain **16/33** and every owner.
- Exercise the established native family scenarios: `70`, `3e9`, sequential suspension, reverse parallel completion, empty timing, both rejection paths, and main’s exact logging/undefined behavior.
- Pair legacy/public output before and after donor rewiring: full bytes/WAT and ordered resources, callback/timer traces, repeated execution and stdout.
- Separately execute the **new prepared-program consumer**. Existing public-family passes do not substitute for that proof.

This is a connected route to native execution, not another declaration move. Queue/settlement materialization is the first usable substrate; complete resolution, frames, timer publication and string resources remain required before whole-family physical acceptance. Public IR-only cutover, strict closure and the unresolved ABI30 witness remain separate outstanding obligations.

No tests, writes or mutations performed.
