# Native vector physical materialization

Astra High specification. Dispatch follows the logical clock/vector checkpoint freeze.

The next slice should materialize the **dense externref vector grow/store provider**, including its shared carrier types and reservation-backed consumer binding. A body extraction alone would leave the current consumer unable to reserve either logical vector signatures or the helper slot.

This is independent of Promise/frame implementation. Full-family acceptance must remain blocked by those other resources.

## Scope and prerequisites

Start after the vector/clock logical checkpoint freezes. Retain the parent’s measured populations:

- Source: **5 functions / 22 calls**.
- Post-async and post-optimization: **16 / 33** each.
- Independent validator: **16 / 33**.

Do not reduce this population to the one vector-calling helper. The physical vector plan must record its uses within that complete population.

The immediate provider is only `__ir_vec_elem_set_externref`. Do not admit f64/i32 store helpers, sized allocation or holey-array providers incidentally.

## 1. Actual donor and resource closure

Donor: [ensureVecElemSet](/private/tmp/js2-3518-native-callables-integration-20260908/src/codegen/vec-elem-set.ts:152).

Its dense externref arm requires:

- Open `__vec_base`: mutable i32 `length` field.
- Mutable externref backing array.
- Concrete vector subtype: inherited-compatible `length` at field 0, non-null backing-array reference at field 1; both mutable.
- Exception tag accepting one externref, with existing local/shared linkage.
- One defined helper:
  `(ref null vector, i32 index, externref value) → void`.
- Four locals, in order: `$data`, `$ncap`, `$ndata`, `$ocap`.

There are **no function dependencies**, Promise operations, timer imports, strings, globals, tables, memory or data segments in the dense arm. The exception tag is required even when source instructions contain no explicit throw.

Preserve the donor’s exact sequence:

1. Null receiver throws `ref.null.extern` through `__exn`.
2. Read backing array.
3. Grow when signed `index >= capacity`.
4. Compute capacity as the existing `max(index + 1, oldCapacity * 2, 4)` sequence.
5. Allocate, copy the old capacity, replace `vector.data`.
6. Store the value.
7. Update length using the existing unsigned comparison.

Do not “correct” arithmetic, negative-index behavior or overflow within this preservation slice.

### Legacy state that must remain in the adapter

The registry helpers read/write array/vector caches, `usesVecValue`, struct-name/field maps and physical type arrays. `ensureVecElemSet` additionally reads carrier branding and standalone hole policy, may mark `f64HoleMarkerEmitted`, allocates a hole singleton for the sparse arm, ensures the exception tag, interns its signature, mints/publishes the function, then updates `funcMap`.

Keep that ordering and cache-hit behavior. **This donor does not use `currentFunc`; do not introduce a restoration protocol it never had.**

## 2. Canonical executable boundary

Proposed canonical owner:

`src/runtime/wasmgc/values/vector-grow-store.ts`

Move the body/local construction into a pure builder with explicit resources:

```ts
buildVectorGrowStoreBody({
  carrierTypeIndex,
  arrayTypeIndex,
  exceptionTagIndex,
  gapFill,
}): { locals: LocalDef[]; body: Instr[] }
```

`gapFill` is a closed data choice:

- ordinary default initialization;
- existing hole-global index;
- existing f64 hole bits.

This preserves the legacy sparse/f64 branches without importing their context or accepting arbitrary callbacks/instruction generators. Only the **default** arm is admitted by the new dense-externref materializer.

Also share the three small vector type-descriptor constructors with the existing registry: base, backing array and concrete carrier. Preserve names, field order, mutability, supertype and optional-final metadata. Registration, caches and legacy bookkeeping remain in the old registry.

The legacy `ensureVecElemSet` becomes a real downward caller of this builder. Its other callers—IR integration, stdlib self-hosting, object runtime and vector overlay—remain unchanged.

## 3. Reservation-backed physical binding

Proposed backend owner:

`src/backend/wasmgc/resources/native-vectors.ts`

Use the existing [PhysicalModuleReservations](/private/tmp/js2-3518-native-callables-integration-20260908/src/wasm/physical/module-reservations.ts:193). Its constructor requires empty storage: **do not wrap or silently adopt an already populated CodegenContext module**.

Separate operations:

- Plan exact vector resources from the authenticated prepared projection and canonical vector declaration/provider.
- Reserve types/helper using the caller’s transaction.
- Fill the reserved helper after reservation freeze.

These operations must not independently freeze or seal the shared transaction.

### Identity and layout rules

- Helper key is its existing canonical ABI binding ID.
- Shared vector resource keys use the entry-source anchor and fixed layout roles, never first-use order or function display names.
- Nullable/non-null views share one carrier.
- Preserve one shared vector base. Full-family numeric and externref vectors must not acquire incompatible duplicate bases.
- Admit only the actually required f64/externref **layouts**; admitting the f64 layout does not admit another callable provider.
- Reuse the returned exact reservations when Promise.all/frame adapters later consume these vectors. No second vector registry.
- Preserve semantic IR and authenticated runtime attachments. Do not append physical indices to frozen semantic data.

The helper's physical binding must validate the complete array/carrier/tag descriptors, canonical declaration and selected provider. Name matching alone is insufficient.

### Reserve/fill order

1. Validate complete demands and retain every unrelated physical gap.
2. Reserve the shared/local exception tag at the consumer’s existing point.
3. Reserve vector base, backing arrays and carriers in fixed dependency order.
4. Reserve all imports before defined functions.
5. Reserve original unit functions in their existing order, then the demanded vector helper in canonical ABI order, then startup support.
6. `freezeReservations()`.
7. Bind ProgramAbiMap using `physicalIndex`; emitted calls use the function reservation’s **stable handle**.
8. Build and `fillFunction` on the exact reserved helper object.
9. Fill remaining bodies and publish through the existing consumer.
10. Seal once, only after all required fills and references are verified.

`TypeReservation.typeIndex` supplies real reservation-time type coordinates. No guessed indices or pre-freeze `physicalIndex` calls.

## 4. Required consumer integration

Parent-owned:

- [program-physical-plan.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-physical-plan.ts).
- [program-consumer.ts](/private/tmp/js2-3518-native-callables-integration-20260908/src/ir/program-consumer.ts).

Add a pure companion contract at:

`src/ir/program/native-vector-resources.ts`

This avoids introducing a backend type import into IR program contracts.

Necessary changes:

- Represent admitted vector signatures logically until their types are reserved; do not put placeholder reference indices in `PhysicalFunctionSlot`.
- Add only the authenticated vector helper to the required runtime-callable reservations and structural-reference resolver.
- Bind its canonical ABI entry before `finishBinding()`.
- Provide bounded, cache-only vector/type resolution from the completed reservation map. No allocating legacy resolver.
- Preserve per-use nullability in that lookup: `lowerIrTypeToValType` uses
  `resolveVecForElement(...).valueType` verbatim when provided, otherwise it
  constructs `ref`/`ref_null` from the logical vector's nullable flag. A shared
  layout lookup must therefore omit a fixed `valueType` override rather than
  silently turn both nullable and non-null uses into the same Wasm reference
  type. Test both views against the same reserved carrier. Supply `resolveVec`
  separately for already-physical references, using only reserved descriptors.
- Keep reference globals, unsupported layouts/providers and async materialization as explicit gaps.
- Count helper-owned functions separately from original/derived unit bodies. Preserve the existing exact unit ownership-order assertion.

Do not remove the async guard. A family containing unresolved frames, Promise calls or strings must still return its actual located refusal, even though its vector resources are now understood.

## 5. Disjoint implementation map

**Low runtime owner**

- New `src/runtime/wasmgc/values/vector-grow-store.ts`.
- `src/codegen/vec-elem-set.ts`.
- `src/codegen/registry/types.ts`.
- New donor-preservation/body tests.

**Low physical owner**

- New `src/backend/wasmgc/resources/native-vectors.ts`.
- New `src/ir/program/native-vector-resources.ts`.
- New reservation/materialization tests.

**Parent integration**

- `src/ir/program-physical-plan.ts`.
- `src/ir/program-consumer.ts`.
- Consumer/source-resource tests and mandatory boundary activation.

No logical-admission writer files, reservation-kernel changes, ProgramAbiMap changes or host/linear implementation are needed.

## 6. Required proof

**Donor preservation**

Pin the complete old declaration/body/local and allocation/cache-order evidence. Exercise dense, hole-global and f64-hole arms; verify unchanged public compilation bytes/order/values across the extraction. Preserve all retained functions, not just `ensureVecElemSet`.

**New physical execution**

Instantiate modules using the real reserved helper and test:

- Empty capacity → first store.
- Growth beyond capacity, preservation of prior elements.
- Store inside capacity; overwrite without length growth.
- Externref identity and null elements.
- Exact null-receiver exception payload/tag.
- Repeated stores and repeated invocation.
- Local and explicitly shared exception-tag linkage.

Test foreign/substituted tokens, wrong element/mutability/field/supertype/tag signature, duplicate reservation/fill, missing fill, post-fill mutation and late allocation. A nonzero function-import offset is a useful **physical-kernel control**, not a claimed source-produced import fixture.

**Actual source connection**

Use original and decoded full-family preparation, both GVN modes, to drive the resource plan. Preserve the complete 16/33 population, owner locations, allocation records and demand census. Physically executing the provider in an isolated resource harness is valid evidence, but must be labelled separately from executing the whole family.

No proven standalone synchronous source fixture currently establishes this new consumer’s externref-vector route. Do not manufacture one by deleting async owners or supplying fake callees. Until the remaining native resources connect, retain that execution gap explicitly.

This advances real physical implementation and binding; it does not establish full native-family acceptance, public IR-only cutover, retirement, or the missing ABI30 witness.

## 7. Reviewed authentication/dependency split

The checked `planNativeVectorResources` entry belongs in parent
`program-physical-plan.ts`. It retains the full `assertPreparedIrProgram`, exact
projection membership/backend/target checks and authenticated entry anchor.
The canonical `program/native-vector-resources.ts` exports only
`deriveNativeVectorResourcePlan({anchor, functions, abiEntries, policy, providers,
backend, target})`, using narrow canonical imports. It recomputes the complete
resource census and validates local provider/ABI contracts, but neither accepts
a whole program nor mints an acceptance token.

The consumer's existing private acceptance WeakMap remains the sole emission
authority. Tests for altered population, ABI, attachments and foreign projections
must exercise the checked entry or consumer before reservation. Pure calculation
tests must not be described as whole-program authentication.

Require exact canonical provider ID and feature before `vectorProviderMismatch`:
that helper intentionally returns no mismatch for unrelated providers, while the
candidate search also recognizes implementation symbols. Add the explicit
foreign-ID/feature-with-canonical-symbol negative alongside missing/duplicate
provider controls. No boolean validated flag or exported authentication factory.
