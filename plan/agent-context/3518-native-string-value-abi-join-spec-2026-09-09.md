# Native string/value ABI join — High implementation specification

Use the following recipe against the current consumer tree, HEAD `ea0f05c36267939d5731e3d5e927ada071ae1780`. This supplements acceptance-side planning; it does not change serialized `PreparedIrProgram.abi`.

### 1. Match existing literal bindings by reference, then contract

Start from each executable `literalUses` row and its original `storage` or `materializer` reference—not the text, display name or encoded ID.

Resolve the existing entry and alias chain using the existing ABI machinery. Preserve every existing entry, intent, order and alias. Reuse is allowed only when all of these agree:

- The reference’s structural key matches the declared contract and plan.
- The chain terminates at one required entry in the correct index space.
- Its origin remains native `support`, consistent with the aggregate’s current admission.
- Its contract and intent agree under the existing `preparedIrTypeKey` / `preparedIrCallableSignature` rules.
- The complete selected literal tuple and canonical recipe agree with that entry’s physical realization.

The two permitted realizations are:

- **Literal global:** global contract, immutable in both contract and intent, semantic string value. The recipe must select the exact non-null flat-string or UTF8-string reference for that cache key. This is an immutable concrete string representation, not permission to reuse arbitrary reference globals.
- **Oversized materializer:** callable contract with zero parameters, one semantic string result, no Promise contract, and the exact selected callable materializer. Its recipe result is the canonical non-null AnyString reference.

Do **not** compare a logical `string` ABI key directly with a symbolic physical `ref(typeKey)` key. Validate the logical contract independently, then validate its selected physical realization.

If a semantic string carries `carrierRef`, require an explicit structural join to the accepted AnyString type declaration. Likewise, an index-bearing `val` contract is not admissible from its number: it needs an authenticated symbolic type-reference join. Never discard such attachments or parse their keys to manufacture one.

An existing reference with a missing, slotless or contradictory entry is a failure—not an invitation to invent its declaration. Multiple existing aliases may share their existing canonical root; two independent required roots cannot be assigned one interned literal token.

Relevant existing checks: [program-validation.ts:90](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/program-validation.ts:90), [ABI alias compatibility](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/program/abi.ts:271).

### 2. Authenticate native unbox through the selected projection

For actual executable `js.number.unbox` occurrences:

1. Retain full prepared-program/projection authentication.
2. Get `projection.prepared.providers.get("js.number.unbox")`.
3. Require the unique corresponding manifest provider, with complete contents matching the canonical `native.js.number.unbox` row in `NUMBER_BOUNDARY_RUNTIME_PROVIDERS`. Require the selected native-unbox policy.
4. Compare its signature with `INTRINSIC_DEFINITIONS["js.number.unbox"].signature`; retain ordinary instruction/SSA verification.
5. Require each occurrence’s attachment to be `kind:"callable"` with the exact structural target produced by `irRuntimeFuncRef(canonical.implementation.symbol)`.
6. Derive parameters/results from that canonical signature—not operands or a new signature table.
7. Compare those carriers with the producer declaration whose structural role is `["values","unbox-number"]`.

Then derive:

```ts
const ref = irRuntimeFuncRef(canonical.implementation.symbol);
const id = preparedIrRuntimeCallableBindingId(program.inventory, ref);
const signature = preparedIrCallableSignature(
  canonical.signature.params,
  [canonical.signature.result],
);
```

Reuse a compatible existing canonical runtime entry; otherwise append this acceptance-side entry at the unbox declaration’s ordinal:

- `slotPolicy:"required"`, `slotSpace:"function"`
- `structuralReferenceKey: irCallableBindingKey(ref.binding)`
- `intent:{kind:"callable", origin:"runtime", signature}`

Do not add `sourceId`, `providerId` or capability fields to that runtime intent: current `ProgramAbiMap` reserves those provenance fields for different origins.

**Important current-tree distinction:** `irRuntimeCallableDeclaration()` does not declare native unbox. Do not extend it merely for this join or use its absence as an exemption. Here the authenticated intrinsic provider supplies the contract. Native box remains internal support; it does not authorize host-only `js.number.box` or substitute for `generator.number-box`.

Sources: [canonical number providers](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/runtime/manifest.ts:496), [runtime identity factory](/private/tmp/js2-3518-native-string-value-consumer-20260909/src/ir/program-runtime-abi.ts:25).

### 3. Create remaining support entries directly from declarations

Use:

```ts
const anchor = preparedIrRuntimeAbiAnchor(program.inventory);
const role = "native-string-values:v1:" + JSON.stringify(declaration.role);
```

Current factories:

- Global: `irSupportGlobalRef(anchor.id, role, diagnosticName)`
- Callable: `irSupportFuncRef(anchor.id, role, diagnosticName)`
- Type: `irSourceTypeRef(anchor.id, role, diagnosticName)`

Use the returned `bindingId` and the corresponding `irGlobalBindingKey`, `irCallableBindingKey` or `irTypeBindingKey`. Names remain diagnostic; symbolic array names require no guessed index.

Required entries use **global/type/callable intents**, not `intent.kind:"support"`—the latter is necessarily slotless.

For new internal entries, derive opaque symbolic value/signature/shape keys from the complete producer declarations using one versioned encoding. `preparedIrDataKey` can provide canonical spelling, but the retained full declaration and exact descriptor comparison remain authoritative; that string is not lossless authentication by itself. Preserve brands, nullability, parent/final/field metadata and optional-property presence in the full comparison.

No duplicate signature declarations: implicit interned function types remain ledger-owned.

### 4. Preserve ABI order and bind each canonical owner once

There is no exported supplemental-order factory. Existing `prepareIrProgramAbiEntries` uses a local per-source ordinal allocator.

For supplemental declaration index `j`:

```ts
baseOrder =
  1 + maxExistingDeclarationOrderFor(anchor.order); // empty => 0

order = {
  sourceOrder: anchor.order,
  declarationOrder: baseOrder + j,
};
```

Retain the original declaration index even where reuse leaves a hole. Do not use resource indices, names, insertion order or `entries.length`. Reject unsafe ordinal arithmetic.

In the native path, plan existing entries followed by new entries into the **one emission `ProgramAbiMap`**, and seal planning before allocation. The current consumer’s ABI construction is after reservation freeze; move that planning portion earlier for this path.

After reservation:

- Authenticate the aggregate’s complete captured inventory.
- Join declarations and tokens by exact key **and space**, with no missing/extra rows.
- Compare actual descriptors/signatures, reading function signatures through `indexPhysicalTypes(module.types)`.
- After `freezeReservations()`, bind each canonical required ID once using `reservations.physicalIndex(token)`.
- Never bind a function handle as a final index; never bind aliases separately.
- Finish with `abi.finishBinding()`.

Extend `resourcesByBinding` to include type reservations. Populate resolver maps from the authenticated reference joins, and include every internal helper/materializer object in exact emitted-function ownership.

### 5. Focused integration controls

Keep these in the actual consumer lane:

- Genuine compatible literal global/materializer reuse, including an existing alias chain.
- Wrong mutability, arity/result, carrier, encoding selection, alias target, and two-required-owners/one-token rejection.
- Genuine native unbox; independently substitute policy, manifest provider, provider-map row, attachment target and signature.
- Full internal census, including oversized chunks and distinct empty encodings.
- Existing ABI entries/orders unchanged; supplemental ordinals independent of physical indices.
- Nonzero import offsets proving final function indices differ from stable handles.
- Original/decoded real consumer execution; no-demand synchronous parity unchanged.

No writes or tests performed. These joins do not complete public cutover, async materialization, strict retirement proof or ABI30’s outstanding witness.
