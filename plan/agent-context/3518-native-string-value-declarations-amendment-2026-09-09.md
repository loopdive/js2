# Acceptance-time native resource declarations — High amendment

Choose the **acceptance-time symbolic declaration plan**. Do not defer supplemental ABI planning until after reservation.

The gap is real: current numeric-layout constructors cannot supply symbolic shapes by being called with invented indices. A bounded shared-recipe refactor is required.

## Pre-freeze authority clarification (High, 2026-09-09)

Producer authentication precedes descriptor comparison. The helper exports
`compareNativeResourceDeclarationShape(tx, declaration, actual, types): void`:
it compares observations only and returns no ownership or completion receipt.
Observations contain key/space and either the actual type definition, the
global name/type/mutability header, or the function name and mandatory actual
physical signature. Keep symbolic reference instantiation and type-token checks.

The aggregate inventory authenticates its existing private issued pack and
transaction, retained program/projection/issued-plan association and producer
dependencies. Only exact tokens captured directly from canonical producer
calls, including private literal chunks, may enter that inventory. Authenticate
type prerequisites with `assertTypeReservation`; its full layout verification
also checks registered global/function headers and interned types. It does not
authenticate arbitrary caller-supplied global/function tokens. Ownership of
those tokens comes from the aggregate's private captured inventory.

The consumer constructs actual observations from its own module and those
authenticated rows. Resolve a function's typeIdx through `indexPhysicalTypes`,
not the outer type-record array. Never present an expected recipe signature as
the actual signature. Compare complete populations, keys, spaces and ownership
before shape equality. After freeze, retain every `physicalIndex` authentication
and fill/completion check. No new registry, ledger API, early freeze or later ABI
expansion is authorized.

Negative controls belong at the authenticated aggregate/consumer entry: reject
copied/foreign packs, same-shaped foreign global/function tokens, another issued
plan, missing/extra rows, altered headers/type indices/interned signatures and a
supplied matching signature that differs from the module's real one. Positive
pre-freeze reconciliation must leave state, populations and reservation order
unchanged. Align symbolic scalar validation exactly with canonical ValType,
including ref_extern and brands; reject unsupported kinds explicitly.

## Frozen interface amendment

Add these fields to `NativeStringValuePhysicalPlan`; retain all existing fields:

```ts
readonly declarations: readonly NativeStringValueDeclaration[];
readonly reservationSteps: readonly NativeStringValueReservationStep[];
```

Use resource-key references—not physical indices—in the declarations:

```ts
type NativeDeclaredValType =
  | Exclude<ValType, { kind: "ref" | "ref_null" }>
  | {
      readonly kind: "ref" | "ref_null";
      readonly typeKey: string;
    };

interface NativeDeclaredSignature {
  readonly params: readonly NativeDeclaredValType[];
  readonly results: readonly NativeDeclaredValType[];
}

type NativeDeclaredName =
  | string
  | {
      readonly kind: "array-ref-index";
      readonly typeKey: string;
    };

type NativeDeclaredType =
  | {
      readonly kind: "struct";
      readonly name: string;
      readonly fields: readonly (
        Omit<FieldDef, "type"> & { readonly type: NativeDeclaredValType }
      )[];
      /** Absent, explicit root, and declared parent remain distinct. */
      readonly parent?:
        | { readonly kind: "root" }
        | { readonly kind: "resource"; readonly typeKey: string };
      readonly final?: boolean;
    }
  | {
      readonly kind: "array";
      readonly name: NativeDeclaredName;
      readonly element: NativeDeclaredValType;
      readonly mutable: boolean;
    };

type NativeStringValueDeclaration = {
  readonly key: string;
  /** Producer-authored structural identity, not a display-name parse. */
  readonly role: readonly string[];
} & (
  | { readonly space: "type"; readonly shape: NativeDeclaredType }
  | {
      readonly space: "global";
      readonly name: string;
      readonly valueType: NativeDeclaredValType;
      readonly mutable: boolean;
    }
  | {
      readonly space: "function";
      readonly name: string;
      readonly signature: NativeDeclaredSignature;
    }
);

type NativeStringValueReservationStep = {
  readonly phase: "string-types" | "resources";
} & (
  | { readonly kind: "reserve"; readonly resourceKey: string }
  | {
      readonly kind: "intern-signature";
      readonly signature: NativeDeclaredSignature;
    }
);
```

These are **descriptive physical contracts**, not new acceptance tokens or serialized prepared-program fields. Preserve scalar brands, field metadata and optional-property presence. Unsupported descriptor kinds fail explicitly.

`array-ref-index` represents the existing worklist name `__arr_ref_${actualAnyStringIndex}`. Its structural identity and shape key must not depend on that eventual index.

## One declaration authority

Each canonical producer must expose a pure declaration recipe, and its existing reservation function must consume that **same recipe**:

- Strings: type descriptors, complete deduplicated literal/chunk globals, materializer signatures and reservation order.
- Flatten: worklist, copy-tree, optional decoder and flatten signatures.
- Scanner: scanner signature, power-array descriptor and power-global type.
- Values: carrier descriptors, undefined-global type, three helper signatures and explicit signature-intern steps.

The coordinator concatenates these recipes; it must not maintain a second signature/layout table.

For the numeric-dependent string constructors, extract a narrowly reference-parameterized descriptor implementation shared by numeric compatibility constructors and symbolic declarations. Keep this local to string layout declarations: **no global Wasm-model generic rewrite, backend import into runtime, scratch module, sentinel indices or arbitrary declaration callback**. Existing numeric-free primitive and power-array constructors can be reused directly.

Reservation substitutes each symbolic type key with its authenticated, same-transaction type token. Initializers and executable body builders remain existing canonical implementations.

The layout-independent literal selector remains shared with the actual literal planner. It must enumerate private oversized chunks and repeated chunk links—not just requested literals. Preserve UTF-8 byte overflow versus UTF-16 length, lone surrogates and distinct UTF-16 empty storage.

## Preserve actual ordering

Recipes must retain these current sequences:

- String types before imports; literal resources afterward.
- Chunk globals before their materializer; original cache sharing and interleaving.
- Flatten: worklist → copy-tree → optional decoder → flatten.
- Scanner: **scanner function → power-array type → power global**.
- Values: AnyValue → undefined global → number type → boolean type → three explicit signature interns → box/unbox/is-number functions.

Interned function types remain ledger-owned and may already exist. Do not manufacture separate ABI type reservations or require an erroneous “one new type per signature” count.

## Acceptance and materialization

1. Acceptance authenticates the program, selected projection and issued value plan as already specified.
2. `planNativeStringValuePhysical` builds the complete symbolic recipe without allocation.
3. The coordinator constructs **all** supplemental ABI entries from these declarations before emission:
   - Existing entry-source anchor.
   - Versioned structural role tuple.
   - Signature/shape keys encoding symbolic type-resource references, never eventual indices.
   - Existing semantic bindings and aliases preserved.
4. Native `js.number.unbox` still requires the actual selected provider and demand. A helper declaration named `__box_number` grants no provider authorization.
5. Reservation executes the canonical recipe in the existing single ledger.
6. Before freeze/fill, reconcile every declared resource against the authenticated actual inventory: exact key, space, owned object, signature/shape and order; reject missing, extra or substituted resources. Include private chunk globals and materializers.
7. Freeze once, bind actual final indices through the same ABI map, then fill and publish through existing lifecycle rules.

For type comparison, instantiate the accepted symbolic descriptor using the actual owned type-token map and compare the complete resulting descriptor. For function comparison, check the actual interned signature—not just its numeric type index or name.

**No post-reservation addition of ABI entries.** Reservation may discover a contradiction and fail; it may not expand accepted scope.

## Ownership amendment and controls

Please relay this bounded prerequisite to Euclid; I have not dispatched or written anything.

- Euclid’s producer amendment: shared declaration recipes for the four existing resource owners; the shared string-layout/selection implementation where needed; focused declaration/reservation parity controls.
- Parent’s existing lane: aggregate `native-string-values` plan, supplemental ABI construction, actual-inventory reconciliation and consumer wiring.
- Source and demand lanes remain unchanged. No P/C draft, ledger-authority or body-algorithm changes.

Required positive-first controls:

- Delete/add/reorder a declaration; change field mutability, parent/root presence, nullable reference, function result or referenced type key.
- Omit a private chunk, substitute a same-shaped foreign token, or change repeated-chunk sharing.
- Verify explicit intern order without requiring fresh interned types.
- UTF-8/UTF-16, oversized and separate empty-literal cases.
- Actual original/decoded consumer execution and emitted-resource ordering; no-demand historical byte parity.
- Reject unsupported declaration shapes before dependent reservation.

This is the missing producer prerequisite—not permission to defer ABI planning or certify full cutover.

## Repaired demand review

**Approved within the descriptive-demand scope.** I read both repaired files and verified SHA-256:

- Source: `6e9b08cd6240796e21560a38483130c33251b3c2760913cab38915997ac2eda3`
- Test: `8ac9d5655b1f9fbf17e5f11cfc1679d008b569cd44e78130f4403bd810493133`

All three findings are closed: explicit schema/sealed/reconciliation guards; independently enumerated complete occurrence evidence including genuine recursive source and decoded replay; and non-number intrinsic/provider identity preservation. Original metadata, shared-buffer and async-state coverage remain present.

The reported 40/40 and TS7 results are parent evidence; I ran no tests. This does not confer program acceptance, physical execution or retirement proof.
