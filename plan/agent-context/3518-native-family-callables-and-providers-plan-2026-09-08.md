# Native async-family callable/provider checkpoint

## Scope and inspected baseline

Inspected `/private/tmp/js2-3518-delay-admission-integration-20260908`, HEAD `9505d0860529cf6bedf887d68c2670130d8422b3`, with the approved source-admission changes. No tests or mutations performed.

The next checkpoint should connect the complete family’s logical calls to canonical declarations, frozen provider demands, and reusable native implementation bodies. It must retain physical refusal until the complete resources are available.

Full-source vector/main preparation is an ordered prerequisite. Its forthcoming frozen output—not function names or this source census—must establish the final call and allocation population.

## 1. Exact logical call contracts

The approved full-family source plan names six bindings:

- runtime `__ir_promise_delay_native`: `f64, f64 → extern<Promise>`. Existing implementation: Native delay provider: physical `f64,f64 → externref`.
- runtime `__ir_async_promise_all_native`: nullable `vec<externref> → externref`. Existing implementation: Native combinator wrapper over the canonical externref vector.
- intrinsic `async.clock.snapshot`: `() → f64`. Existing implementation: Standalone runtime projection to `f64.const 0`.
- intrinsic `async.number.to-string`: `f64 → string`. Existing implementation: Native formatter plus its existing carrier adapter.
- intrinsic `async.console.log-string`: `string → void`. Existing implementation: Native stdout sink, with exact line construction preserved.
- intrinsic `async.string.concat$arity5`: five `string` operands → `string`. Existing implementation: Existing `js.string.concat.many` provider, arity five.

Important distinctions:

- Delay’s logical Promise result is **not** raw `val externref`.
- Promise.all returns a Promise carrier; the awaited `number[]` is its fulfillment type, not its call result.
- Native strings are not physically interchangeable with externref.
- The formatter’s physical adapter spelling is `__ir_number_toString_native`; do not confuse it with the different semantic runtime spelling `__ir_number_to_string_native`.
- Console append does not itself append a newline. Preserve the source producer’s complete line construction; do not compensate with an extra newline in the provider.
- Concat must reuse the existing bounded family and canonical arity authority. No second concat catalog.

These contracts are grounded in `promise-delay-lowering.ts`, `async-from-ast.ts`, `async-semantic-runtime.ts`, and the existing resolver branches at [integration.ts:7423](/private/tmp/js2-3518-delay-admission-integration-20260908/src/ir/integration.ts:7423).

## 2. Canonical declarations and ABI admission

Currently [callable-declarations.ts](/private/tmp/js2-3518-delay-admission-integration-20260908/src/ir/runtime/callable-declarations.ts) recognizes only ReferenceError. `prepareIrProgramRuntimeCallables` additionally filters out every intrinsic binding.

Implement a closed whole-program builtin declaration resolver covering the six bindings above plus the existing ReferenceError declaration. Preserve the existing ReferenceError object and contract.

Requirements:

- Match the complete structural binding: kind and symbol. Display names never select declarations.
- Derive signatures from canonical declarations, never observed operands.
- Validate actual argument/result types against those signatures, including nullability and Promise/string distinctions.
- Collect before async preparation, after transformation, and after optimization—the three existing collection points remain.
- Scan original blocks, nested buffers and semantic async states; separately reconcile selected runtime-state bodies after attachment.
- Preserve entry-source ABI anchoring, structural binding IDs, deterministic ordering, aliases and complete declaration-population validation.
- Update `program-validation.ts`: its current runtime-only filter would otherwise omit the four intrinsic declarations.
- Unrecognized runtime references retain their located failure. This checkpoint does not certify unrelated intrinsic families.

### Clock must not acquire a fabricated function slot

Clock remains symbolic in semantic IR. Give its canonical semantic ABI entry the existing `slotPolicy: "none"`; no function index or synthetic helper.

This is narrowly justified only by the authenticated standalone projection. Validate that every selected physical occurrence was replaced with the exact zero constant, preserving result ID/type/site. Inspect ordinary derived bodies as well as `asyncRuntime.states`: today `projectStandaloneAsyncStateInstr` is applied only to attached state bodies.

Any surviving clock call remains a physical-plan failure. Other five declarations require actual callable resources. No ProgramAbiMap implementation/getter change is needed.

## 3. Provider selection and lifecycle

Add a closed native-family provider group for delay, Promise.all, clock, number formatting and console. Reuse the existing concat family.

Do **not** put these features into `AsyncRuntimeFeature` or append them to every plan’s runtime intents. That vocabulary describes frame operations; attachment validation requires exactly its corresponding native-managed providers.

Instead:

- The whole-program producer supplies a complete, validated builtin-demand vector to manifest preparation.
- Ordinary delay bodies contribute demands even without an async attachment.
- New native-only main demands must not alter historical host preparation merely because the legacy scanner encounters the same intrinsic spelling. Preserve the old automatic legacy demand behavior; consume the new explicit vector in whole-program preparation.
- Select standalone/WasmGC providers and the required native-string policy explicitly. No inference from `fast`, defaults, or display names.
- Delay/all depend on the existing native Promise/queue/number-bridge providers actually used by their implementations.
- Clock needs a narrowly named non-callable projection implementation, such as `standalone-clock-zero`; do not mislabel it as a function or Promise-managed service.
- Console’s void signature must remain void. Do not force it into the single-result `IntrinsicSignature` shape.
- Consume the complete frozen manifest in backend resource planning. Scanning only `fn.asyncRuntime.backendRequirements` misses ordinary delay and main helper demands.

Keep the existing attachment authority, exact provider objects/order, layout identity, post-authentication freeze, and rollback behavior. No additional WeakMap authority.

### Timer service is a separate physical obligation

The real timer import is:

`env.__timer_set_timeout(externref, externref) → externref`

The arguments are the native callback bridge carrier and boxed delay. This is explicit scheduling I/O, not host Promise implementation.

Its contract and requested availability belong under `runtime/contracts` and `runtime/platform/standalone`. Do not claim that `hostCapabilities: []` proves the complete module has no imports. The backend resource plan must retain the timer service requirement and authenticate its actual import and callback-dispatch provision.

## 4. Executable movement required in the same development sequence

The providers below are still mixed legacy implementations. Catalog rows alone do not make them canonical native runtime code.

### Delay

Donor: [ir-native-promise-delay.ts:85](/private/tmp/js2-3518-delay-admission-integration-20260908/src/codegen/ir-native-promise-delay.ts:85).

Extract timer-callback and delay-provider locals/bodies into proposed:

`src/runtime/wasmgc/promise/delay-bodies.ts`

Inputs must explicitly bind:

- Promise and callback-capture types;
- callback wrapper layout, arity/bag initialization;
- timer callback, timer import, box-number and resolve-value handles;
- rejection handle and exception tag.

Retain the legacy registration adapter as a real downward caller. Preserve Promise creation before timer registration, callback capture field order, tagged/foreign exception handling, one-shot settlement and publication/cache timing.

### Promise.all

Donors: `ir-native-async-runtime.ts` and `promise-combinators.ts`.

Proposed canonical owner:

`src/runtime/wasmgc/promise/combinator-bodies.ts`

Move the eight existing subscribe/fulfill/settlement body-and-local builders together, plus a detached version of the runtime-vector construction loop. Retain shared race use; do not duplicate its shared settlement builders.

The inspected eight-builder resource reads are:

- Types: array, element-capture, Promise, combinator-state, vector and callback.
- Functions: enqueue, fulfill, reject, optional rejection-handled notification, resolve-value.
- The runtime-vector loop additionally needs subscribe/reaction handles and explicit local indices.

Legacy adapters retain allocation and exact `currentFunc` restoration. Canonical builders accept no context, AST, allocating callback, or name lookup.

The new whole-program path must require real resolve-value support. It cannot adopt the donor’s legacy `-1` fallback as proof of complete PromiseResolve semantics.

### Formatting, concat and stdout

Reuse these exact donors:

- `number-format-native.ts`: `ensureIrNativeNumberToString`, its raw formatter and carrier conversion.
- `native-batched-concat.ts`: helper body, including null-carrier `"undefined"` substitution and flat/rope ordering.
- `native-strings.ts`: stdout append and readout bodies, globals, initialization and export timing.

Their complete string storage/formatter dependencies are prerequisites to physical admission—not licenses to import those mixed modules into the clean backend.

## 5. Physical binding and completion order

Reuse `PhysicalModuleReservations`; no parallel allocator or identity registry.

The connected backend adapter belongs at proposed:

`src/backend/wasmgc/resources/native-async-callables.ts`

Its plan contains canonical declaration/provider references, exact semantic-to-physical signatures, resource keys and original use owners. Its bound result contains authenticated reservations and explicit carrier adaptations—not raw guessed indices.

Required order:

1. Validate the selected program, manifest, call declarations and async attachments.
2. Enumerate the complete resources: platform imports, Promise/queue/closure/value/vector/string types, globals, tags, helper functions, frame support and publication requirements.
3. Reserve dependencies and callable slots in explicit order. Retain single canonical recursive-group ownership.
4. Freeze reservations; bind ProgramAbiMap final indices through `physicalIndex`. Never put stable handles into final-index slots.
5. Fill actual bodies. Function instructions use stable handles; module/export/start metadata uses the appropriate resolved index space.
6. Complete late-filled thenable/object/closure helpers and stdout readouts.
7. Authenticate bindings, signatures, complete fills and unchanged snapshots before publication/seal.

Preserve synchronous reservation order and bytes when none of these demands exists.

Blindly removing [program-physical-plan.ts:173](/private/tmp/js2-3518-delay-admission-integration-20260908/src/ir/program-physical-plan.ts:173) remains unsafe: the current consumer lacks async materialization, logical-vector/string layouts, and the required resolver facilities.

Promise.all adds a particularly important join: its native result is an externref vector of boxed values, while the awaited semantic result is `number[]`. Frame delivery must perform the existing numeric conversion correctly, including `3e9`; a cast to an f64-backed vector is not sufficient.

## 6. Disjoint implementation scopes

After the active vector/main writer freezes:

**Low A — declarations, manifest and pure preparation**

- New `src/ir/core/async-callables.ts`: canonical binding constants; old constant owners forward without duplication.
- New `src/ir/runtime/native-async-callables.ts`: six declarations and closed logical validation.
- `src/ir/runtime/callable-declarations.ts`
- `src/ir/runtime/contracts/manifest.ts`
- `src/ir/runtime/manifest.ts`
- `src/ir/program-runtime-abi.ts`
- `src/ir/program-abi-contracts.ts`
- `src/ir/program-validation.ts`
- `src/ir/runtime-program-manifest.ts`
- `src/ir/intrinsic-support.ts`
- Focused declaration/provider/typed-replay tests.

Parent serializes compatibility imports in `promise-delay-lowering.ts` and `async-semantic-runtime.ts`. No overlap with active `program-source.ts` or `from-ast.ts` implementation.

**Low B — real delay/combinator body extraction**

- New `src/runtime/wasmgc/promise/delay-bodies.ts`
- New `src/runtime/wasmgc/promise/combinator-bodies.ts`
- `src/codegen/ir-native-promise-delay.ts`
- `src/codegen/ir-native-async-runtime.ts`
- `src/codegen/promise-combinators.ts`
- Focused body, lifecycle and source-preservation tests.

A/B can work concurrently after the logical signatures and explicit resource interfaces freeze.

**Parent-owned ordered integration**

- Backend resource adapter and `program-physical-plan.ts` / `program-consumer.ts`.
- Standalone timer-service contract/binding.
- Boundary activation, historical receipts and replay integration.

Do not dispatch physical admission until its complete provider prerequisites are assigned. Native formatter/string materialization and the prepared frame/vector adapter remain explicit dependent work, not silently absorbed into either bounded lane.

## 7. Required evidence and stopping conditions

Preserve existing receipt hashes and denominators; reconstruct moved bodies from live canonical implementations, including initialization/order evidence.

Add controls for:

- Wrong binding kind, renamed display label, malformed signatures, missing/duplicate declarations and removed demand owners.
- Ordinary delay-only demand; nested and async-state calls; original/decoded transport.
- Incorrect native policy, missing timer service, wrong timer ABI, stale provider/layout objects and post-freeze changes.
- Clock calls surviving in any selected body; no phantom clock slot.
- Missing resolve-value/thenable support, unfilled helpers, wrong vector carrier, foreign reservations, late imports and reused acceptance tokens.
- Concat arity/policy, newline construction, formatter conversion, stdout initialization and repeated-delivery output.

Use the unchanged five-function source family, all eight established family scenarios, and existing native regressions. Preserve 70, `3e9`, sequential/reverse-parallel completion, empty timing, rejection, and undefined/main stdout. Original and decoded whole-program inputs must reach the new preparation entry; eventual acceptance requires actual prepared-path instantiation and execution.

Until then, report the exact remaining located physical refusal—not execution success. Public IR-only dispatch, complete allocation/provider materialization, strict closure, full-family cutover and ABI30’s unresolved witness remain open.
