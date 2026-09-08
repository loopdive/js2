# Clock and vector admission implementation plan

Astra High read-only specification, recovered 2026-09-08. Implementation remains open.

Rev2’s six-binding oracle blocker is closed. The three reviewed test blobs match the frozen manifest; declaration, demand and selected-provider assertions are independently pinned, including both complete Promise dependency sets. This approves that repair—not the currently failing full-family preparation.

The parent nullable change is also sound: explicit `nullable:false` arguments may satisfy `nullable:true` vector parameters, with exact logical element equality. Reverse widening and result widening remain rejected. The added reverse/element controls cover the intended distinction. Physical layout authentication remains a separate obligation.

## 1. Clock projection and authentication

### Actual gap

In [intrinsic-support.ts:74](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/intrinsic-support.ts:74), `projectStandaloneAsyncStateInstr` handles nested clock calls, but its production application at line952 covers only attached runtime states. `attachProviders` traverses ordinary blocks without projecting call-kind clocks.

This matters for derived regular functions: [async-linear-prepare.ts:255](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/async-linear-prepare.ts:255) creates helpers containing original instructions. The specialized main preparer instead places its four clocks in semantic states. Admission must handle either legitimate transformation—not infer placement from helper names.

### Exact owner/write map

Parent-owned production changes:

- [intrinsic-support.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/intrinsic-support.ts): extend explicit whole-program projection to ordinary and derived blocks.
- [program-runtime-validation.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-runtime-validation.ts): authenticate semantic-to-selected clock correspondence independently.

Proposed new test: `/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-native-clock-projection.test.ts`.

No source producer, async transformation, ABI implementation, physical planner or consumer changes.

### Projection contract

1. Preserve semantic `program.ir`, including symbolic clocks in blocks and `asyncPlan.states`. Run projection only after manifest selection.
2. For the explicit whole-program path, require the actual frozen manifest’s unique, canonical `async.native.clock-zero` provider and explicit standalone/WasmGC/native policy. Validate selected-row contents; do not require identity with the pre-freeze catalog row.
3. Apply the existing clock transformation across every selected function’s blocks, using canonical nested-buffer traversal and copy-on-write mapping. Keep existing state projection and attachment creation order.
4. The only replacement is the exact intrinsic binding `async.clock.snapshot`, zero arguments, non-null f64 result → exact positive-zero f64 constant. Preserve result identity, exact type and source-site presence/data. Do not silently discard allocation metadata: allocation-marked clocks must be explicitly rejected as inconsistent with this non-allocating contract.
5. Unchanged buffers/functions should retain identity. Never clone authenticated async attachments after creation or introduce another authority registry.
6. Omission of explicit whole-program demands retains historical legacy preparation behavior. Do not impose the new provider requirement on that omitted-demand compatibility path.

Clock keeps its existing semantic ABI entry with `slotPolicy:"none"`. No helper function, index or reservation is invented.

### Independent authentication

Extend `assertPreparedIrRuntimeProjection`; retain its complete `preparedIrDataMismatch` reproduction check and current-manifest/attachment checks.

Match semantic and selected occurrences by:

- exact unit ID and population order;
- block identity/order, or semantic-state/runtime-state identity/order;
- instruction index plus recursive nested-buffer position.

Use `forEachNestedBuffer`’s exhaustive ordering. A flattened preorder or aggregate clock count is insufficient: moving a clock between branches must fail.

At each semantic clock position, require the exact projected constant, `Object.is(value, 0)`, result/type/site agreement, and no surviving physical clock. Retain full reproduction comparison for all other fields and provider attachments. Semantic `asyncPlan` remains symbolic; its physical counterpart is `asyncRuntime.states`.

Required negatives: surviving call; `-0`, nonzero and NaN; changed result/type/site; missing or duplicated occurrence; branch/owner movement; missing/foreign provider; wrong policy; allocation-marked clock. Exercise these through actual prepared-program validation/replay, not solely an isolated assertion helper.

## 2. Vector callable admission: the newly exposed prerequisite

### Verified source evidence

The retained source-produced packet already contains one intrinsic `__ir_vec_elem_set_externref` in `fetchAllParallel`’s loop. It is not an invented transformation artifact. Async preparation carries that instruction into a derived helper.

The donor contract is explicit in [vec-elem-set.ts:150](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/vec-elem-set.ts:150):

`nullable vec<val externref>, val i32, val externref → void`

The native resolver at [integration.ts:7454](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/integration.ts:7454) maps the logical symbol through `ensureVecElemSetForElement` to the real grow/store helper. That helper performs null checking, capacity growth/copy, store and length update—not merely an array store.

Keep the all-call ABI check at [program-validation.ts:259](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-validation.ts:259). The observed undeclared-call exception is a real missing admission contract.

### Smallest connected implementation

Add a separate vector callable family; do not enlarge or repurpose the six-binding async catalog.

Proposed exact contract:

- Binding: intrinsic `__ir_vec_elem_set_externref`.
- Feature: `js.vector.elem-set.externref`.
- Provider ID: `native.js.vector.elem-set.externref`.
- Signature: the donor contract above; zero results.
- Implementation: symbolic `runtime-callable` targeting the existing logical resolver binding.
- Supported preparation policy: standalone/WasmGC only. No native-string requirement merely because this is used beside async calls.
- Required ABI slot: **required**, never clock-style `none`.

This records a real existing implementation obligation. It does not establish that the whole-program consumer can materialize that helper.

### Exact proposed production scope

One vector-admission owner:

- New `/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/core/vector-runtime.ts`.
- [Existing vector-runtime.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/vector-runtime.ts): compatibility forwarding.
- New `/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/runtime/vector-callables.ts`.
- [runtime/callable-declarations.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/runtime/callable-declarations.ts).
- [runtime/contracts/manifest.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/runtime/contracts/manifest.ts).
- [runtime/manifest.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/runtime/manifest.ts).
- [program-runtime-abi.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-runtime-abi.ts).
- [runtime-program-manifest.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/runtime-program-manifest.ts).
- The vector-demand join in `intrinsic-support.ts`, serialized with the parent clock change.

Move the complete small vector-identity module downward rather than importing its old mixed facade into clean runtime. Preserve its ten declarations, including five function bodies; forward all nine public exports. This retains sized/holey identities and existing f64/i32/externref parsing unchanged, without admitting those other helpers into the new callable family.

`vector-callables.ts` owns the one declaration/provider and a separately named occurrence validator. Reuse the established demand shape, but keep a separate explicit vector-demand vector so the async-six denominator remains six. Include empty owners, nested blocks and semantic states; validate exact argument/result types and structural binding kind.

Wire validation into all three existing callable collection stages. Whole-program manifest preparation must independently recompute the complete vector demands before selecting the provider. Omitted-demand legacy callers remain unchanged. Existing generic ABI construction and declaration reconciliation should consume the new canonical declaration without exceptions.

Do not add sized-vector, sparse-vector, f64 or i32 declarations merely because the symbol parser recognizes them. If the measured final population requires another helper, record its exact donor contract before extending admission.

### Required tests and census

Add `/private/tmp/js2-3518-native-callables-integration-20260908/tests/issue-3518-vector-runtime-callable-admission.test.ts` covering:

- Exact declaration, structural binding, provider and complete dependency row.
- Non-null→nullable argument admission; reverse rejection.
- Wrong element, index type, argument order/count, result presence and wrong binding kind.
- Missing, duplicate or contradictory ABI declaration/provider.
- Missing derived owner/demand, deleted nested occurrence and stale pre-transform demand.
- Unknown helper remains rejected; no prefix-based acceptance.
- Canonical/compatibility identity and exact relocated body/order receipts.

For the actual family, capture **three distinct call censuses**: source input, post-async transformation and post-optimization. Record all owners—including empty ones—and every call/closure reference, classifying each against its real unit/import/canonical declaration. Do not count only recognized builtins.

I verified the retained source packet, not an executed final transformed census. The final derived counts therefore remain a required measured receipt.

## Integration and acceptance

The vector declaration gap currently precedes complete prepared-program validation. Implement its admission and the clock projection in separate scopes, serializing their shared `intrinsic-support.ts` join. Parent retains constant forwarding and policy/test integration.

Replay the existing eight full-family axes with explicit native string/concat policy, original and decoded input, preserving all seven source units, five terminal functions, support inventory, derived provenance, allocations and source ownership. Keep the prior policy refusals and undeclared-helper throw as historical evidence. Report the next actual failure if preparation still cannot complete.

Neither checkpoint removes the async physical guard. Vector layouts/growth resources, Promise/frame delivery, timer service, numeric `3e9` conversion, strings/stdout, full-family execution, public IR-only cutover and the unresolved ABI30 witness remain explicit obligations. No tests or writes were performed here.
