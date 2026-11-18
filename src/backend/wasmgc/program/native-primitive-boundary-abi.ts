// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irRuntimeFuncRef } from "../../../ir/core/callable-bindings.js";
import { INTRINSIC_DEFINITIONS } from "../../../ir/core/intrinsics.js";
import type { IrType } from "../../../ir/core/types.js";
import { NUMBER_BOUNDARY_RUNTIME_PROVIDERS, RUNTIME_PROVIDERS } from "../../../ir/runtime/manifest.js";
import type { RuntimeProviderDefinition } from "../../../ir/runtime/contracts/manifest.js";
import type {
  BooleanBoundaryIntrinsicId,
  DynamicValueIntrinsicId,
  IntrinsicId,
} from "../../../ir/core/intrinsic-vocabulary.js";
import { preparedIrCallableSignature } from "../../../ir/program/abi-signatures.js";
import type { ProgramAbiMap, ProgramAbiPlanEntry } from "../../../ir/program/abi.js";
import {
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "../../../ir/program/runtime-abi-identity.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../../../ir/program/errors.js";
import type { NativeStringValueDemands } from "../../../ir/program/native-string-value-demands.js";
import {
  assertNativeInvocationRequirementsCurrent,
  type NativeInvocationRequirements,
} from "../../../ir/program/native-invocation-requirements.js";
import { objectResultIsBoolean } from "../../../ir/program/native-object-result-values.js";
import type { NativeStringValueReservationInput } from "./native-string-values.js";
import { nativeStringTypeKeys } from "../resources/native-string-literals.js";

export interface NativeBooleanSelection {
  /** A resolved consumer recipe, independent of permission to use native boxing. */
  readonly boxMode?: "interned";
  /** Reserve the Boolean predicate and payload reader (`__typeof_boolean`, `__unbox_boolean`). */
  readonly unbox: boolean;
}
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native intrinsic ABI: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
function intrinsicDemands(demands: NativeStringValueDemands, id: IntrinsicId) {
  return demands.intrinsics.filter(
    (row) =>
      row.instruction.id === id &&
      demands.buffers[demands.occurrences[row.occurrence]!.bufferIndex]!.view === "projection",
  );
}

/** Actual keyed Get proof is required before the permissive payload reader is selected. */
export function selectNativeBooleans(
  demands: NativeStringValueDemands,
  invocation: NativeInvocationRequirements | undefined,
): { readonly selection?: NativeBooleanSelection; readonly gap?: { occurrence: number; detail: string } } {
  if (invocation) {
    assertNativeInvocationRequirementsCurrent(invocation);
    if (
      invocation.source.demands.program !== demands.program ||
      invocation.source.demands.projection !== demands.projection
    )
      fail("different invocation/string demand owner");
  }
  const unboxes = intrinsicDemands(demands, "js.boolean.unbox");
  for (const row of unboxes) {
    const proof = invocation?.objectResults;
    if (
      !invocation ||
      !proof ||
      proof.gaps.length ||
      invocation.source.demands.occurrences[row.occurrence]?.instruction !== row.instruction ||
      !proof.uses.some((use) => use.occurrence === row.occurrence && objectResultIsBoolean(use.resultType))
    )
      return {
        gap: { occurrence: row.occurrence, detail: "native Boolean extraction needs its exact keyed Get result proof" },
      };
  }
  const getterBox = invocation?.getterUses.find((use) =>
    objectResultIsBoolean(
      invocation.source.demands.owners.find((row) => row.unitId === use.liftedUnitId)?.projectedFunction.closureSubtype
        ?.signature.returnType,
    ),
  );
  if (getterBox && demands.projection.prepared.manifest.policy.booleanBoundary.box !== "native")
    return {
      gap: {
        occurrence: getterBox.getOccurrence,
        detail: "selected Boolean getter result requires explicit native Boolean boxing policy",
      },
    };
  const box =
    getterBox ||
    (demands.projection.prepared.manifest.policy.booleanBoundary.box === "native" &&
      intrinsicDemands(demands, "js.boolean.box").length > 0);
  // (#7354 D1) Dynamic strict equality calls the same predicate and payload
  // reader a proven extraction does; (#7354 Ty) the Boolean `typeof` test is
  // that predicate.
  const readers =
    unboxes.length > 0 ||
    intrinsicDemands(demands, "js.value.strict_eq").length > 0 ||
    intrinsicDemands(demands, "js.value.is_boolean").length > 0;
  return box || readers
    ? { selection: Object.freeze({ ...(box ? { boxMode: "interned" as const } : {}), unbox: readers }) }
    : {};
}

/**
 * Called only after exact canonical signature authentication; a Boolean param is plain i32, and (#7354 Str2) a
 * string is the native string owner's AnyString, named by its type key.
 */
function physicalCarrier(type: IrType, stringKey: string) {
  if (type.kind === "val" && !Object.hasOwn(type, "typeRef") && type.val.kind === "i32")
    return { kind: "i32" as const };
  if (type.kind === "val" && !Object.hasOwn(type, "typeRef") && type.val.kind === "externref") return type.val;
  if (type.kind === "string") return { kind: "ref" as const, typeKey: nativeStringTypeKeys(stringKey).any };
  return fail("canonical intrinsic contract has an unexpected carrier");
}

/** The canonical native provider, physical role and policy admission of one bound intrinsic. */
interface NativeIntrinsicRow {
  readonly feature: BooleanBoundaryIntrinsicId | DynamicValueIntrinsicId | "js.extern.is_undefined";
  readonly provider: RuntimeProviderDefinition;
  readonly role: readonly [string, string];
  readonly admitted: boolean;
}

function canonicalRow(feature: NativeIntrinsicRow["feature"], role: string, admitted: boolean): NativeIntrinsicRow {
  const canonical = RUNTIME_PROVIDERS.filter((row) => row.id === `native.${feature}`);
  if (canonical.length !== 1) fail("nonunique canonical " + feature);
  return { feature, provider: canonical[0]!, role: ["values", role], admitted };
}

/**
 * The Boolean carrier pair, plus the dynamic value's operations (#7354 D1):
 * every one is a runtime callable answered by a declared native resource.
 */
function nativeIntrinsicRows(input: NativeStringValueReservationInput): readonly NativeIntrinsicRow[] {
  const policy = input.demands.projection.prepared.manifest.policy;
  return [
    ...(["box", "unbox"] as const).map((direction) =>
      canonicalRow(`js.boolean.${direction}`, direction + "-boolean", policy.booleanBoundary[direction] === "native"),
    ),
    canonicalRow("js.extern.is_undefined", "is-undefined", policy.externIsUndefined.probe === "native"),
    canonicalRow("js.value.as_string", "as-string", true),
    canonicalRow("js.value.is_boolean", "typeof-boolean", true),
    canonicalRow("js.value.is_number", "typeof-number", true),
    canonicalRow("js.value.is_string", "typeof-string", true),
    canonicalRow("js.value.strict_eq", "strict-eq", true),
    canonicalRow("js.value.to_boolean", "to-boolean", true),
    canonicalRow("js.value.undefined", "undefined-value", true),
  ];
}

/** Bind only actual native attachments to the declared, canonical resource. */
export function nativeIntrinsicAbiBindings(input: NativeStringValueReservationInput, baseOrder: number) {
  const { program, projection } = input.demands;
  const manifest = projection.prepared.manifest;
  return nativeIntrinsicRows(input).flatMap(({ feature, provider, role, admitted }) => {
    const uses = intrinsicDemands(input.demands, feature);
    // A policy that does not admit the native arm selected another authority
    // (the host import), which is not a native resource binding.
    if (!uses.length || !admitted) return [];
    if (provider.implementation.kind !== "runtime-callable" || !provider.signature) fail("noncallable " + feature);
    const selected = manifest.providers.filter((row) => row.id === provider.id || row.feature === feature);
    if (input.plan.mode !== "number-boundary" || selected.length !== 1)
      fail("missing unique native policy/provider for " + feature);
    same(selected[0], provider, "manifest provider differs");
    same(projection.prepared.providers.get(feature), provider, "provider map differs");
    same(provider.signature, INTRINSIC_DEFINITIONS[feature].signature, "canonical intrinsic signature differs");
    const reference = irRuntimeFuncRef(provider.implementation.symbol);
    for (const { instruction } of uses) {
      if (instruction.provider?.kind !== "callable") fail("noncallable attachment");
      same(instruction.provider.target.binding, reference.binding, "attachment target differs");
      same(instruction.resultType, provider.signature.result, "attachment logical result differs");
    }
    const matches = input.plan.declarations.filter((row) => preparedIrDataMismatch(row.role, role) === undefined);
    if (matches.length !== 1) fail("nonunique actual " + feature + " declaration");
    const index = input.plan.declarations.indexOf(matches[0]!);
    const declaration = input.plan.declarations[index];
    if (!declaration || declaration.space !== "function") fail("missing actual " + feature + " declaration");
    same(
      declaration.signature,
      {
        params: provider.signature.params.map((type) => physicalCarrier(type, input.plan.key)),
        results: [physicalCarrier(provider.signature.result, input.plan.key)],
      },
      "recipe differs from canonical physical carriers",
    );
    const signature = preparedIrCallableSignature(provider.signature.params, [provider.signature.result]);
    const id = preparedIrRuntimeCallableBindingId(program.inventory, reference);
    const entry: ProgramAbiPlanEntry = {
      id,
      order: { sourceOrder: preparedIrRuntimeAbiAnchor(program.inventory).order, declarationOrder: baseOrder + index },
      displayName: reference.name,
      structuralReferenceKey: irCallableBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "runtime", signature },
    };
    const previous = program.abi.entries.find((row) => row.plan.id === id);
    if (previous) {
      same(
        previous.plan,
        { ...entry, order: previous.plan.order, displayName: previous.plan.displayName },
        "existing ABI entry differs",
      );
      if (previous.contract.kind !== "callable" || Object.hasOwn(previous.contract, "promise"))
        fail("existing ABI is not synchronous callable");
      same(previous.contract.ref.binding, reference.binding, "existing reference differs");
      same(
        preparedIrCallableSignature(previous.contract.params, previous.contract.results),
        signature,
        "existing logical signature differs",
      );
    }
    return [{ resourceKey: declaration.key, reference, entry: previous?.plan ?? entry }];
  });
}

// Existing number boundary recipe; moving its coordinator does not change admission.
import type { PreparedIrProgram, PreparedIrAbiEntry } from "../../../ir/program/prepared-contracts.js";
import type { IrBindingId } from "../../../shared/contracts/ir-identity.js";
import type {
  NativeResourceRecipe,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { IrFuncRef } from "../../../ir/core/value-references.js";
interface NativeAbiContext {
  readonly program: PreparedIrProgram;
  readonly resources: NativeResourceRecipe;
  readonly entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>;
  readonly abi: ProgramAbiMap;
}
interface NativeStringValueAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef;
}
function nativeInvalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native string ABI: ${detail}`);
}
function nativeSame(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) nativeInvalid(detail);
}
function declarationForRole(resources: NativeResourceRecipe, role: readonly string[]): NativeStringValueDeclaration {
  const rows = resources.declarations.filter((row) => preparedIrDataMismatch(row.role, role) === undefined);
  if (rows.length !== 1) nativeInvalid(`missing/duplicate declaration role ${JSON.stringify(role)}`);
  return rows[0]!;
}
export function nativeNumberBinding(
  context: NativeAbiContext,
  input: NativeStringValueReservationInput,
  declarationOrder: number,
  direction: "box" | "unbox",
): NativeStringValueAbiBinding | undefined {
  const { projection } = input.demands;
  if (direction === "box" && projection.prepared.manifest.policy.numberBoundary.box !== "native") return undefined;
  const feature = direction === "box" ? "js.number.box" : "js.number.unbox";
  const demands = input.demands.intrinsics.filter(
    (row) =>
      row.instruction.id === feature &&
      input.demands.buffers[input.demands.occurrences[row.occurrence]!.bufferIndex]!.view === "projection",
  );
  if (!demands.length) return undefined;
  const canonical = NUMBER_BOUNDARY_RUNTIME_PROVIDERS.filter((row) => row.id === `native.${feature}`);
  if (canonical.length !== 1) nativeInvalid(`canonical ${direction} provider is not unique`);
  const provider = canonical[0]!;
  if (provider.implementation.kind !== "runtime-callable" || !provider.signature)
    nativeInvalid(`canonical ${direction} contract is not callable`);
  const manifest = projection.prepared.manifest;
  const selected = manifest.providers.filter((row) => row.id === provider.id || row.feature === provider.feature);
  if (
    input.plan.mode !== "number-boundary" ||
    manifest.policy.numberBoundary[direction] !== "native" ||
    selected.length !== 1
  )
    nativeInvalid(`${direction} requires the unique selected native number-boundary policy/provider`);
  nativeSame(selected[0], provider, `manifest ${direction} provider differs from complete canonical definition`);
  nativeSame(
    projection.prepared.providers.get(feature),
    provider,
    `selected ${direction} lookup differs from canonical provider`,
  );
  nativeSame(
    provider.signature,
    INTRINSIC_DEFINITIONS[feature].signature,
    `canonical intrinsic/${direction} signatures differ`,
  );
  const reference = irRuntimeFuncRef(provider.implementation.symbol);
  for (const { instruction } of demands) {
    if (instruction.provider?.kind !== "callable") nativeInvalid(`${direction} attachment is not callable`);
    nativeSame(
      instruction.provider.target.binding,
      reference.binding,
      `${direction} attachment target is not the selected runtime binding`,
    );
  }
  const declaration = declarationForRole(context.resources, ["values", `${direction}-number`]);
  if (declaration.space !== "function") nativeInvalid(`${direction} declaration is not a function`);
  const physical = (type: IrType): ValType => {
    if (type.kind !== "val" || Object.hasOwn(type, "typeRef"))
      nativeInvalid("canonical number-boundary signature has a non-scalar carrier");
    return type.val;
  };
  nativeSame(
    declaration.signature,
    { params: provider.signature.params.map(physical), results: [physical(provider.signature.result)] },
    `${direction} recipe disagrees with canonical carriers`,
  );
  const signature = preparedIrCallableSignature(provider.signature.params, [provider.signature.result]);
  const id = preparedIrRuntimeCallableBindingId(context.program.inventory, reference);
  const entry: ProgramAbiPlanEntry = {
    id,
    order: { sourceOrder: preparedIrRuntimeAbiAnchor(context.program.inventory).order, declarationOrder },
    displayName: reference.name,
    structuralReferenceKey: irCallableBindingKey(reference.binding),
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "runtime", signature },
  };
  const previous = context.entries.get(id);
  if (previous) {
    nativeSame(
      previous.plan,
      { ...entry, order: previous.plan.order, displayName: previous.plan.displayName },
      `existing runtime ${direction} ABI entry contradicts its canonical contract`,
    );
    if (previous.contract.kind !== "callable" || Object.hasOwn(previous.contract, "promise"))
      nativeInvalid(`existing ${direction} semantic contract is not synchronous callable`);
    nativeSame(previous.contract.ref.binding, reference.binding, `existing ${direction} reference differs`);
    nativeSame(
      preparedIrCallableSignature(previous.contract.params, previous.contract.results),
      signature,
      `existing ${direction} semantic signature differs`,
    );
  }
  return { resourceKey: declaration.key, entry: previous?.plan ?? entry, reference };
}
