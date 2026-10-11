# Shared native async resource declarations — frozen implementation contract

Freeze **one shared producer-declaration lane**. It keeps the existing closure, argument-vector and Promise reservation callers live, makes them consume preallocation declarations, and preserves their existing fills. This is the prerequisite for aggregate ABI sealing—not a replacement for frame implementation.

## 1. Exclusive write scope

Paths below are relative to `/private/tmp/js2-3518-native-async-integration-20260909`; implementation goes into a separately claimed worktree after composition validation.

Production:

1. `src/runtime/wasmgc/values/native-resource-declaration-types.ts`
2. `src/backend/wasmgc/resources/native-resource-declarations.ts`
3. `src/runtime/wasmgc/values/closure-layouts.ts`
4. `src/runtime/wasmgc/values/argument-vector-bodies.ts`
5. `src/backend/wasmgc/resources/native-closures.ts`
6. `src/backend/wasmgc/resources/native-argument-vectors.ts`
7. `src/backend/wasmgc/resources/native-promises.ts`

Tests:

8. New `tests/issue-3518-native-async-resource-declarations.test.ts`
9. `tests/issue-3518-native-resource-declarations.test.ts`
10. `tests/issue-3518-native-closure-resources.test.ts`
11. `tests/issue-3518-native-argument-vector-resources.test.ts`
12. `tests/issue-3518-native-promise-resources.test.ts`

No ledger, program-consumer, physical-plan, ABI catalog, codegen adapter, P/C, object-access or frame files. Parent owns boundary activation and later aggregate integration.

## 2. Shared declaration extensions

Keep `NativeResourceRecipe` and the current structural reference representation:

```ts
{ kind: "ref" | "ref_null"; typeKey: string }
```

Do not substitute provisional numeric indices.

Add only:

```ts
// Extend NativeDeclaredName.
{
  readonly kind: "builtin-function-metadata-index";
  readonly typeKey: string;
}

// Extend the existing intern-signature reservation step.
{
  readonly kind: "intern-signature";
  readonly signature: NativeDeclaredSignature;
  readonly key?: string;
  readonly name?: string;
}
```

Permit `NativeDeclaredName` for struct names as well as array names. The new metadata-name form resolves **only** to:

```text
__builtinfn_meta_<actual type index>_struct
```

It is not an arbitrary formatting callback.

`key` on an interning step identifies that symbolic signature observation. It does not create a function reservation, another type allocator or an ABI callable slot.

Shared helper changes:

- Extract the existing complete recipe validation into `preflightNativeResourceRecipe(recipe, prerequisiteKeys)`.
- Existing execution must still invoke that validation.
- Preserve the existing executor return type/API.
- Add `executeNativeResourceRecipeWithSignatures(...)`, using the **same execution loop**, returning:

```ts
{
  readonly reservations: ReadonlyMap<string, NativeDeclaredReservation>;
  readonly signatures: ReadonlyMap<string, number>;
}
```

The old executor returns `.reservations`. The new result captures the actual interning result at its original operation—no second interning call merely to discover it.

For index-derived metadata names, extend type instantiation with a narrowly scoped self-coordinate argument. Closure reservation supplies its existing, checked `nextTypeIndex` immediately before reservation and retains the existing assertion that the returned token has that index. Comparison uses the authenticated returned token’s actual coordinate.

**No ledger change is necessary.** Do not add a speculative “next index” API, temporary module, dummy type or descriptor mutation after reservation.

All new steps use the existing `"resources"` phase.

## 3. Closure declaration API

In `native-closures.ts`:

```ts
export type NativeClosureDeclaredSignatureRequest =
  Omit<NativeClosureSignatureRequest, "params" | "results"> & {
    readonly params: readonly NativeDeclaredValType[];
    readonly results: readonly NativeDeclaredValType[];
  };

export interface NativeClosureDeclarationRequirements {
  readonly key: string;
  readonly startingClosureCounter: number;
  readonly requests: readonly (
    | NativeClosureDeclaredSignatureRequest
    | NativeClosureMetadataRequest
  )[];
  readonly referenceTypeKeys: readonly string[];
}

export interface NativeClosureDeclarationPlan extends NativeResourceRecipe {
  readonly requirements: NativeClosureDeclarationRequirements;
  readonly rootKey: string;
  readonly signatures: readonly {
    readonly requestId: string;
    readonly wrapperKey: string;
    readonly liftedSignatureKey: string;
  }[];
  readonly metadata: readonly {
    readonly requestId: string;
    readonly signatureRequestId: string;
    readonly typeKey: string;
  }[];
  readonly resultingClosureCounter: number;
}

export function declareNativeClosureResources(
  requirements: NativeClosureDeclarationRequirements,
): NativeClosureDeclarationPlan;

export function instantiateNativeClosureRequirements(
  tx: PhysicalModuleReservations,
  plan: NativeClosureDeclarationPlan,
  types: NativeDeclaredTypeTokens,
): NativeClosureRequirements;
```

Instantiation authenticates every required token with the ledger, resolves symbolic references and reconstructs the existing physical requirements. Preserve the existing prohibition on missing or unused reference prerequisites.

Extend the existing reservation function with an optional expected plan:

```ts
reserveNativeClosureResources(tx, requirements, expectedPlan?)
```

- Existing callers remain source-compatible.
- They derive the declaration plan internally **before their first allocation**.
- The future aggregate always passes its pre-ABI-seal plan.
- Reconstruct symbolic requirements from authenticated physical inputs and compare with the expected plan before mutation.
- Retain the supplied plan association in the existing private owner record.

### Shared factories

Following the existing reference-parameterized string-layout pattern, add:

```ts
createSignatureWrapperShape<P>(name: string, parent: P)
createBuiltinFunctionMetadataShape<N, P>(name: N, parent: P)
```

The existing numeric constructors remain exported and call these factories. There must be one field/mutability definition, still using `closureArityField()` and `closureBagField()`.

Preserve the exact request-driven schedule:

1. On a new signature: increment counter, reserve wrapper, establish first root.
2. Intern its lifted signature with the original name.
3. Perform the existing observation before publication.
4. Publish info/cache registrations.
5. On metadata cache miss: reserve the subtype, copy metadata info and publish metadata/cache registrations.
6. Cache hits retain the same binding objects and existing observation timing.

Do not replace this loop with a generic executor that loses the interleaved observer mutations. It must consume the recipe’s ordered operations through a private checked cursor, using the shared instantiation helpers. Require complete cursor exhaustion.

The declaration contains one physical wrapper per signature-cache miss and one metadata subtype per metadata-cache miss. Every request still appears in the request-to-resource mappings.

## 4. Argument-vector declaration API

```ts
export interface NativeArgumentVectorDeclarationDependencies {
  readonly vectorBaseKey: string;
  readonly earlyArgumentArrayKey?: string;
}

export interface NativeArgumentVectorDeclarationPlan
  extends NativeResourceRecipe {
  readonly key: string;
  readonly dependencies: NativeArgumentVectorDeclarationDependencies;
  readonly arrayKey: string;
  readonly carrierKey: string;
  readonly newVectorKey: string;
  readonly pushKey: string;
}

export function declareNativeArgumentVectorResources(
  requirements: { readonly key: string },
  dependencies: NativeArgumentVectorDeclarationDependencies,
): NativeArgumentVectorDeclarationPlan;
```

Extend `reserveNativeArgumentVectorResources` with an optional expected declaration plan. Authenticate its actual `vectorBase` and optional early array **before any reservation**, then compare their keys and canonical shapes with the declaration.

Add a reference-parameterized `createArgumentVectorShape(data, parent)` in the existing body owner. The numeric `createArgumentVectorType` delegates to it.

Fixed resource order:

- Without an early array: array → carrier → new → push.
- With an early array: carrier → new → push, retaining the exact adopted array token.

The existing seven push locals, capacity eight, copy/store/length ordering and noncarrier return are unchanged. The fill implementation is not rewritten.

## 5. Promise declaration API

```ts
export interface NativePromiseDeclarationDependencies {
  readonly argumentArrayKey: string;
  readonly closureRootKey: string;
  readonly settleMetadataKey: string;
}

export interface NativePromiseDeclarationPlan extends NativeResourceRecipe {
  readonly dependencies: NativePromiseDeclarationDependencies;
  readonly callbackSignatureKey: string;
}

export function declareNativePromiseResources(
  plan: NativePromiseResourcePlan,
  dependencies: NativePromiseDeclarationDependencies,
): NativePromiseDeclarationPlan;
```

Extend the existing `reserveNativePromiseResources` with an optional expected declaration plan.

Its actual dependency type remains unchanged:

- issued vectors;
- actual exception-tag reservation;
- issued closures;
- `settleMetadataRequestId`.

The reservation wrapper resolves those issued dependencies first, then derives their symbolic keys and reconciles the expected declaration plan **before allocating**.

The exception tag remains a parent prerequisite; this recipe must not reserve another one.

### Exact current population and order

The current producer owns **25 declarations**: five types, six globals and fourteen functions. The shared argument array is borrowed, not a sixth owned type.

Preserve this operation order:

1. Queue function-array type.
2. Named callback-signature interning.
3. Globals: head, tail, capacity, functions, captures, arguments.
4. Functions: grow, enqueue, drain.
5. Types: Promise, callback, then-captures.
6. Functions: fulfill, reject, identity-fulfill, identity-reject, resolve-value.
7. Settle-capture type.
8. Functions: resolve-closure, reject-closure, peel, classifier, lookup-then, thenable-job.

The recipe therefore has 25 reserve steps plus the explicit callback-signature interning step. Function reservation retains its existing implicit signature-interning behavior.

Keep the existing role/key derivation colocated with these declarations; do not create a second signature table in the aggregate. A recipe’s compatibility-name/key selection is **descriptive, not provider authorization**. Parent must still reconcile actual canonical references, intents, signatures and selected providers before assigning/reusing ABI entries.

### Settle-capture identity

Do not normalize the inherited metadata fields into unrelated objects.

The actual reservation must retain the existing operation:

```ts
metadataFields.map(field => ({ ...field }))
```

Thus field records are fresh, while their `type` objects retain the authenticated metadata prefix’s identities. Append `cap_promise` at field five; keep the actual metadata subtype as parent.

The declaration uses the canonical metadata shape. The physical descriptor uses the authenticated issued metadata prefix, with full structural comparison against that declaration. No independent capture or closure-root allocation is introduced.

All Promise fill algorithms, lookup/getter capture, queue capacity, hook/tracking behavior and complete invocation/classifier requirements remain unchanged.

## 6. Authenticated inventory API

Add one inventory accessor in each producer:

```ts
nativeClosureReservationInventory(tx, pack, expectedPlan)
nativeArgumentVectorReservationInventory(tx, pack, expectedPlan)
nativePromiseReservationInventory(tx, pack, expectedPlan)
```

Return the exact owned `NativeDeclaredReservation[]` in declaration order.

Requirements:

- Authenticate through each producer’s **existing private owner record**.
- Require the expected preallocation-plan association; reject copied packs and substituted plans.
- Recheck requirements/dependencies/currentness.
- While reserving, use existing owned type assertions, which also verify transaction layout.
- After freeze, verify actual physical coordinates.
- Exclude adopted external tokens from owned rows.
- Preserve request aliases separately; aliases do not inflate the owned denominator.
- Parent reads actual module signatures for comparison. Recorded intended signatures alone are insufficient.
- These accessors attest reservation ownership/currentness—not completed bodies or successful execution.

The parent lifecycle is then unambiguous:

**derive declarations → reconcile supplemental ABI → seal one ABI plan → reserve using those declarations → compare authenticated actual inventory → freeze once → bind actual indices → fill → seal module.**

## 7. Required acceptance

The lane must demonstrate both declaration usefulness and unchanged real reservation behavior:

- Derive all three plans without constructing a module or ledger.
- Feed those plans to the existing real reservation APIs.
- Exercise fresh/adopted argument arrays, reference-bearing closure signatures, wrapper/metadata cache hits, interleaved minimum-arity observations and Promise settlement metadata.
- Compare old/new actual descriptors, optional-property presence, names, operation order, signatures, registrations and alias identities.
- Compare unchanged filled argument-vector/Promise bodies and locals.
- Preserve existing execution controls; do not label still-unfilled Promise fixtures runtime success.

Positive-first negatives must include:

- Numeric references in symbolic declarations; missing/extra dependency keys.
- Foreign or copied same-index tokens.
- Wrong metadata request/root/signature; metadata length versus observed minimum-arity distinction.
- Reordered requests, interning steps or declarations.
- Deleted internal global/function/type declarations.
- Changed indexed-name rule or signature-intern name.
- Altered inherited metadata fields or lost retained type identity.
- Substituted expected plan, pack, resource key or actual module signature.
- Late malformed requests failing before reservation population changes.

Retain all original donor hashes and denominators. Any receipt reconstruction needed for factory factoring must validate the exact inverse and have live mutation controls; no hash reseeding.

This lane is ready for scoped dispatch after parent’s composition boundary is frozen. It does not depend on C1’s incomplete getter partition, and it does not authorize shrinking that population. The newly supplied C1 donor map needs a separate scope amendment before its implementation.

One correction to the Lane A handoff: construct the entry with `irUnitFuncRef({ unitId: owner.unitId, name: owner.name })`; the actual factory does not accept a bare unit ID.
