# Frozen source/demand/resource/consumer contract

Grounding: scanner source `cf0026db2e926bf45c57204f6324fbae5fb168f7` and published contract `31e4e232eb16804afc1577055d33d1c6530c0e22`.

## 1. Independent pure-demand writer

Exclusive proposed files:

- `src/ir/program/native-string-value-demands.ts`
- `tests/issue-3518-native-string-value-demands.test.ts`

No existing source edits, resource allocation, ABI mutation, provider selection, source/checker access or new acceptance authority.

Use canonical types from `core/nodes`, `core/async-plan`, `runtime/contracts/prepared`, `analysis/contracts/allocations`, `shared/contracts/ir-identity`, and `program/prepared-contracts`. Do not import their historical facades.

### Exact exports

```ts
export type NativeStringValuePresence<T> =
  | { readonly present: false }
  | { readonly present: true; readonly value: T };

export type NativeStringValueView = "program" | "projection";

export type NativeStringValueBufferRoot =
  | {
      readonly kind: "block";
      readonly index: number;
      readonly id: IrBlockId;
    }
  | {
      readonly kind: "async-plan";
      readonly index: number;
      readonly id: IrAsyncStateId;
    }
  | {
      readonly kind: "async-runtime";
      readonly index: number;
      readonly id: IrAsyncStateId;
    };

export interface NativeStringValueBuffer {
  readonly ownerUnitId: IrUnitId;
  readonly view: NativeStringValueView;
  readonly root: NativeStringValueBufferRoot;

  /** Nested-buffer coordinates, in canonical child-buffer order. */
  readonly path: readonly {
    readonly instructionIndex: number;
    readonly childBufferIndex: number;
  }[];

  readonly instructions: readonly IrInstr[];
}

export interface NativeStringValueOccurrence {
  /** Index into NativeStringValueDemands.buffers. */
  readonly bufferIndex: number;
  readonly instructionIndex: number;
  readonly instruction: IrInstr;
}

export interface NativeStringValueAllocationEvidence {
  readonly allocation:
    NativeStringValuePresence<AllocSiteId | undefined>;

  /** Null only when no allocation identity was supplied. */
  readonly canonicalAllocation: AllocSiteId | null;

  readonly metadataRow:
    NativeStringValuePresence<AllocRegistryMetadataSnapshot>;

  /** Existing unknown metadata payload, not an erased encoding schema. */
  readonly encoding: NativeStringValuePresence<unknown>;
}

export type NativeStringValueLiteralDemand =
  | {
      readonly kind: "string.const";
      readonly occurrence: number;
      readonly instruction: IrInstrStringConst;
      readonly allocation: NativeStringValueAllocationEvidence;
    }
  | {
      readonly kind: "extern.regex";
      readonly occurrence: number;
      readonly part: "pattern" | "flags";
      readonly value: string;
    };

export interface NativeStringValueIntrinsicDemand {
  readonly occurrence: number;
  readonly instruction: IrInstrIntrinsic;
}

export interface NativeStringValueDemands {
  /** Borrowed exact prepared objects; these are not acceptance tokens. */
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;

  readonly owners: readonly {
    readonly unitId: IrUnitId;
    readonly programFunction: PreparedIrFunction;
    readonly projectedFunction: PreparedIrFunction;
  }[];

  /** Preserve the complete snapshot, including unused namespaces/rows. */
  readonly allocations: AllocRegistrySnapshot;

  readonly buffers: readonly NativeStringValueBuffer[];
  readonly occurrences: readonly NativeStringValueOccurrence[];
  readonly literals: readonly NativeStringValueLiteralDemand[];
  readonly intrinsics: readonly NativeStringValueIntrinsicDemand[];
}

export function collectNativeStringValueDemands(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeStringValueDemands;
```

### Collection rules

- Require the selected projection to belong to this program and consistently identify standalone WasmGC.
- Require complete, unique, identically ordered owner IDs in `program.ir.functions` and `projection.prepared.functions`. Include derived owners; do not substitute exports, declarations or source-terminal subsets.
- For each owner, visit the **program view then projection view**. Within each view: blocks, semantic async states, prepared async-runtime states, each in existing array order.
- Retain empty buffers. Traverse nested buffers through canonical `forEachNestedBuffer`, preserving its order. Number occurrences by preorder.
- Do not deduplicate shared instruction, buffer, function or state objects across occurrences/views.
- Collect **every instruction** into `occurrences`, every intrinsic into `intrinsics`, and string literals into `literals`. This is not a supported-instruction whitelist.
- Preserve complete function objects so signatures, slots, spills, resume types, declarations and attachment schemas remain available to subsequent planning.
- Record regex pattern/flags because the lowerer emits them through `emitStringConst`. Their collection **does not admit regex materialization**.

For allocation evidence, reuse canonical registry restoration/resolution without mutating the input. Obtain the canonical live allocation ID, then retain the corresponding **original snapshot row** and raw encoding payload. Unknown/retired/broken allocation references on a live literal are invariant failures, not “no encoding.”

Distinguish:

- absent `alloc` from present `alloc: undefined`;
- absent metadata row from an empty row;
- absent encoding namespace from a written `undefined`;
- aliased identity from its canonical identity.

Do not validate or discard unknown encoding payloads prematurely: the later representation planner decides whether that namespace is consumed. Preserve all other unknown metadata unchanged.

Freeze newly created containers only; do not clone or re-freeze borrowed prepared objects. Full program/attachment authentication remains mandatory in the coordinator’s checked acceptance path. This collector’s local checks are not a substitute.

### Required tests

Use genuine source-produced preparation and decoded replay for positive population tests. Add focused data controls for:

- complete owner order, missing/duplicate owner and foreign projection;
- nested sibling ordering, shared-object occurrences and empty buffers;
- both async-plan and runtime-state coverage;
- alias-resolved encoding and all presence distinctions;
- unknown metadata retention without JSON normalization;
- original `site`, allocation, storage and materializer identities;
- regex pattern/flags recorded but not certified supported;
- no mutation of the input graph.

The producer may be independently tested now. Its production caller is the forthcoming `planPhysicalSetup` integration; tests alone do not establish that integration.

## 2. Source-admission writer

The requested from-ast-only start was sound. With the subsequently relayed P release, Maxwell may additionally wire the two permitted source/preparation files—without importing P’s async-ABI changes.

### Frozen lowering property

```ts
// AstToIrOptions
readonly stringNumericCoercion?: "number-boundary";

// LowerCtx
readonly stringNumericCoercion?:
  AstToIrOptions["stringNumericCoercion"];
```

Forward it in exactly these explicit context constructions:

- ordinary `lowerFunctionAstToIr`: `options.stringNumericCoercion`;
- `liftNestedFunction`: `cx.stringNumericCoercion`;
- `liftClosureBody`: `cx.stringNumericCoercion`.

Contexts created with `...cx` inherit it.

In `emitUnaryToNumber`, change only the statically string-typed arm when selected:

```ts
return cx.builder.emitIntrinsic("js.number.unbox", [
  coerceIrValueToExternref(cx.builder, rand),
]);
```

Keep the existing box-plus-`dyn.to_number` arm when omitted. Preserve boolean, numeric, object/ToPrimitive and unsupported branches. Operand evaluation happens once before conversion; unary minus retains its existing subsequent negation.

### Whole-source selection

```ts
// IrProgramSourceInput
readonly nativeStringValueProjection?: "standalone-native";
```

The whole-source wrapper validates the explicit selection against `input.policy` and the actual resolved runtime-policy list. All requested projections must be standalone WasmGC. Do not infer this option from target, fast mode or provider availability.

`program-source` forwards `"number-boundary"` only for that explicit selection. The option is frontend configuration, not a new serialized IR field or provider authorization.

Writer scope:

- `src/ir/from-ast.ts`
- `src/ir/program-source.ts`
- `src/ir/program-preparation.ts`
- `tests/issue-3518-native-string-number-source-admission.test.ts`

Tests must inspect ordinary, nested-function and lifted-closure artifacts; selected string conversion uses the intrinsic without boxing/dynamic conversion, while omission retains the historical route. Include once-only operand effects, negative operands/types, unary minus, and no rewriting of a shadowed `Number` call. Lifted-artifact tests do not imply closure physical execution.

## 3. Representation/resource interface

This lane follows Euclid’s split and consumes the demand API above.

Proposed files:

- `src/runtime/wasmgc/values/string-literal-bodies.ts`
- `src/backend/wasmgc/program/native-string-values.ts`
- `tests/issue-3518-native-string-value-planning.test.ts`
- `tests/issue-3518-native-string-value-materialization.test.ts`

### Representation selection

Extract layout-independent selection from the existing literal planner—not a second implementation:

```ts
export type NativeStringLiteralSelection =
  | {
      readonly kind: "global";
      readonly key: string;
      readonly encoding: "utf8" | "wtf16";
    }
  | {
      readonly kind: "callable";
      readonly key: string;
      readonly chunks: readonly string[];
    };

export function selectNativeStringLiteral(
  utf8Storage: boolean,
  utf8Available: boolean,
  value: string,
  encoding?: StringEncoding,
): NativeStringLiteralSelection;
```

`planNativeStringLiteral` consumes this selection and constructs its existing actual initializer/layout references. Preserve its canonical keys and thresholds:

- UTF-8 bytes versus UTF-16 code units are different limits.
- `é.repeat(5001)` can be a UTF-16 global, not a materializer.
- Preserve lone-surrogate behavior.
- Preserve explicitly UTF-16 empty storage separately from ASCII empty storage.
- Oversized chunk selection remains explicitly UTF-16.

The new planner validates consumed encoding metadata against canonical `IrStringEncoding`; it must not silently reinterpret invalid consumed evidence. Existing storage/materializer references must agree with selection or produce a located contradiction—never be overwritten.

### Materialization exports

```ts
export interface NativeStringValueOptions {
  readonly representation: "native-string";
  readonly utf8Storage: boolean;
}

export interface NativeStringValuePhysicalPlan {
  readonly key: string;
  readonly mode: "literals" | "number-boundary";
  readonly literalRequirements: NativeStringLiteralRequirements;

  /** Only executable projection demands receive physical bindings. */
  readonly literalUses: readonly {
    readonly demandIndex: number;
    readonly cacheKey: string;
  }[];
}

export type NativeStringValuePlanningOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "planned";
      readonly plan: NativeStringValuePhysicalPlan;
    }
  | PreparedIrProgramFailure;

export function planNativeStringValuePhysical(
  demands: NativeStringValueDemands,
  options: NativeStringValueOptions,
): NativeStringValuePlanningOutcome;

export interface NativeStringValueReservationInput {
  readonly demands: NativeStringValueDemands;
  readonly plan: NativeStringValuePhysicalPlan;
  /** Required exactly for number-boundary mode. Never cloned. */
  readonly valueRequirements?: NativeValueResourcePlan;
}

export type NativeStringValueResourceRow =
  | {
      readonly key: string;
      readonly space: "type";
      readonly reservation: TypeReservation;
    }
  | {
      readonly key: string;
      readonly space: "global";
      readonly reservation: GlobalReservation;
    }
  | {
      readonly key: string;
      readonly space: "function";
      readonly reservation: FunctionReservation;
    };

export interface NativeStringValueReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly number?: {
    readonly flatten: NativeStringFlattenReservations;
    readonly scanner: NativeStringNumberReservations;
    readonly values: NativeValueReservations;
  };
}

export function reserveNativeStringValueResources(
  tx: PhysicalModuleReservations,
  input: NativeStringValueReservationInput,
  types: NativeStringLiteralTypeReservations,
): NativeStringValueReservations;

export function fillNativeStringValueResources(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): void;

export function requireCompletedNativeStringValues(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): NativeStringValueReservations;

export function nativeStringValueReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
): readonly NativeStringValueResourceRow[];

export function emitPreparedNativeStringLiteral(
  tx: PhysicalModuleReservations,
  pack: NativeStringValueReservations,
  ownerUnitId: IrUnitId,
  value: string,
  alloc?: AllocSiteId,
  storage?: IrGlobalRef,
  materializer?: IrFuncRef,
): readonly Instr[];
```

Private resource provenance captures the exact input/issued packs. It supplements—not replaces—the existing ledger. Recompute/check the descriptive selection before reservation; never accept a mismatching demand/plan pair.

`literals` mode needs only strings. `number-boundary` mode requires the genuine flatten→scanner→values chain and adds flatten’s explicit UTF-16 empty demand. No-demand programs take the existing path unchanged.

The inventory uses Euclid’s complete internal literal census plus actual flatten/scanner/value tokens. Do not derive ownership from names, requested literals or counts. Interned signature types remain ledger-owned; do not reserve duplicates merely to manufacture ABI rows.

The literal emitter matches the closed owner/value/allocation/reference tuple against planned projection demands. Ambiguous tuples requiring different physical bindings fail during planning. Preserve occurrence evidence even when identical uses share storage. Regex, `.length` and other string operations remain unsupported unless their own complete provider/resource joins are implemented.

## 4. Issued-plan and ABI joins

### One necessary coordinator-owned authority extension

In existing `src/ir/program/native-value-resources.ts`:

```ts
export function assertNativeValueResourcePlanFor(
  plan: NativeValueResourcePlan,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  strings: NativeValueStringRepresentation,
): void;
```

Use the **existing** private `sources` map: require exact program/projection/representation association, then existing currentness validation. No second registry.

This prevents substituting another valid issued plan merely because its anchor and visible fields match. Scanner reservation and completion continue receiving the exact same issued plan and string pack.

### Supplemental ABI identity

Coordinator-owned `program-physical-plan.ts` constructs binding records using existing reference/identity factories:

```ts
export interface NativeStringValueAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef | IrGlobalRef | IrTypeRef;
}
```

Rules:

- Anchor to the canonical entry-source identity, never a display name or parsed encoded ID.
- Internal support roles use a versioned structural tuple, for example  
  `native-string-values:v1:` + `JSON.stringify(["literal-global", cacheKey])`.
- Use existing support-global, support-callable and source-type reference factories. Do not import their mixed facade into the clean backend module; the coordinator owns this binding construction.
- Reuse an existing compatible semantic binding and its alias structure. Reject contradictory required bindings rather than manufacturing aliases or assigning two incompatible owners.
- For actual native `js.number.unbox`, use the provider’s canonical runtime reference and existing `preparedIrRuntimeCallableBindingId` derivation. Authenticate its selected provider, exact signature and actual intrinsic demand.
- Presence of `__box_number` does **not** authorize `js.number.box`. Native unbox and `generator.number-box` remain distinct contracts.
- Internal pack helpers receive support ownership, not fabricated source callers.
- Preserve every existing ABI entry and order. Append supplemental entries using explicit entry-source declaration ordinals after existing entries; never derive IDs/orders from eventual indices.
- Plan and bind everything through the **same `ProgramAbiMap`**. Bind actual ledger indices after freeze, not stable function handles.

Internal physical reference signatures may use resource keys until reservation. They are acceptance-side planning data, not a new serialized prepared-program schema or replacement for P’s preserved ABI work.

## 5. Consumer integration and lifecycle

The native-only C release covers this work in a separate integration tree:

- `src/ir/program-physical-plan.ts`
- `src/ir/program-consumer.ts`
- the issued-plan guard above;
- `tests/issue-3518-native-string-value-consumer.test.ts`
- `tests/helpers/native-string-value-consumer-replay.mjs`
- parent-owned boundary activation/controls.

Keep the existing acceptance authority. Its private record retains:

- copied descriptive physical setup;
- exact demands/program/projection;
- the **uncloned issued** native-value plan when needed.

Do not put that issued object through `freezePreparedIrValue`.

Reservation order in the existing single transaction:

1. Existing exception/vector prerequisites, then native string types.
2. Existing imports, using the reserved string type where a logical string signature requires it.
3. Literal resources.
4. Flatten, scanner, values when required.
5. Remaining program globals/functions, vector helper and startup.
6. One freeze; final ABI binding.
7. Canonical fills in dependency order, then program lowering and existing publication/seal.

Preserve the old no-demand path exactly.

Extend signature conversion for logical string carriers. Add real `resolveString` and the closed-plan literal emitter to each owner’s resolver. Resolve provider calls through the actual owned function map. Extend exact emitted-function ownership to every authenticated internal materializer/helper object.

Do not add `CodegenContext`, frontend callbacks, partial dynamic-lowering objects or blanket callable exemptions. Acceptance must still reject unsupported instructions/resources before emission. Existing single-use and observer-failure ordering remain unchanged.

## 6. Connected acceptance—not another resource-only checkpoint

Required executable source:

```ts
function parse(s: string): number {
  return +s;
}
export function run(): number {
  return parse(" 42 ");
}
```

Prove preparation→acceptance→`program-consumer` execution reaches the owned unbox/scanner chain. A manually assembled resource module is insufficient.

Matrix: original/decoded preparation, GVN off/on, both UTF modes, repeated fresh instances and execution, source aliases/startup ordering, oversized literals, separate empty encodings and malformed exponent semantics. Reuse the existing module-completion replay pattern.

Add positive-first failures for foreign/copied/wrong-source issued plans, mismatched string/scanner packs, contradictory existing references, altered encoding evidence, missing canonical provider, missing fill, missing internal chunks, extra function ownership and post-acceptance changes. Preserve source-free loader guards and all existing historical/evidence denominators.

Existing synchronous no-demand bytes/WAT/order remain exact. New supported cases retain their old refusal as baseline evidence; do not call that historical byte parity.

Public compiler default routing, complete async-family materialization, broader string/dynamic operations, strict closure/direct retirement and ABI30’s unresolved getter witness remain open. The scoped P/C releases do not authorize changing those contracts.
