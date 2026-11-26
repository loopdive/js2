// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The native call ABI: the physical plan's rows for the native functions that serve source calls, built by one row
 * builder (`nativeCallAbiBindings`) for both families:
 *   - native invocation (source closures, their methods and getters);
 *   - (#7354 O1) source objects: each `js.object.*` call route binds the realm function that serves its contract
 *     (`native-source-objects.ts`).
 * The module keeps its first family's name: it is an entry of the backend-wasmgc layer, which the boundaries gate
 * does not let a change remove, and a separate source-object module would be a new ir->backend import edge.
 */
import {
  assertNativeInvocationRequirementsIssued,
  planNativeInvocationRequirements,
  type NativeInvocationRequirements,
} from "../../../ir/program/native-invocation-requirements.js";
import {
  planNativeSourceClosureRequirements,
  type NativeSourceClosureRequirements,
} from "../../../ir/program/native-source-closure-requirements.js";
import type { NativeStringValueDemands } from "../../../ir/program/native-string-value-demands.js";
import type { NativeStringValueReservationInput } from "./native-string-values.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { nativeAsyncCallableValueTypes } from "../../../ir/runtime/native-async-callables.js";
import { preparedIrCallableSignature } from "../../../ir/program/abi-signatures.js";
import {
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "../../../ir/program/runtime-abi-identity.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { irCallableBindingKey } from "../../../ir/core/callable-bindings.js";
import type { IrFuncRef } from "../../../ir/core/value-references.js";
import type { ProgramAbiPlanEntry } from "../../../ir/program/abi.js";
import type { NativeRealmRequirements } from "../../../ir/program/native-realm-requirements.js";
import { nativeSourceObjectResourceKey } from "../resources/native-source-objects.js";

/** One call route's ABI row and the key of the reserved function that serves it. */
export interface NativeCallAbiBinding {
  readonly resourceKey: string;
  readonly reference: IrFuncRef;
  readonly entry: ProgramAbiPlanEntry;
}

export interface NativeInvocationPhysicalSetup {
  readonly key: string;
  readonly bindings: readonly NativeCallAbiBinding[];
  readonly methodArities: readonly number[];
  readonly applyVector: boolean;
  readonly sourceUseCount: number;
  readonly getterUseCount: number;
  readonly completionScope: "selected-source-invocation";
}

/** Select from actual source/Get occurrences, retaining the issued C1/C2 graph. */
export function nativeStringInvocationRequirements(
  demands: NativeStringValueDemands,
  utf8Storage: boolean,
  expected?: NativeInvocationRequirements,
): NativeInvocationRequirements | undefined {
  if (expected) {
    assertNativeInvocationRequirementsIssued(expected);
    if (
      expected.source.demands.program !== demands.program ||
      expected.source.demands.projection !== demands.projection ||
      expected.runtimeCreated.options.utf8Storage !== utf8Storage
    )
      throw new Error("native invocation ABI: foreign string/value demand owner");
    return expected;
  }
  const source = planNativeSourceClosureRequirements(demands.program, demands.projection);
  return source && planNativeInvocationRequirements(source, { utf8Storage });
}

/** Retain requirement and resource gaps before computing supplemental ABI order. */
export function planNativeInvocationInput(
  source: NativeSourceClosureRequirements | undefined,
  utf8Storage: boolean,
  native: NativeStringValueReservationInput | undefined,
): {
  readonly requirements: NativeInvocationRequirements | undefined;
  readonly gaps: readonly { readonly detail: string; readonly unitId: IrUnitId | undefined }[];
} {
  const requirements =
    native?.invocationRequirements ?? (source && planNativeInvocationRequirements(source, { utf8Storage }));
  const gaps: { detail: string; unitId: IrUnitId | undefined }[] = [];
  if (requirements) {
    assertNativeInvocationRequirementsIssued(requirements);
    if (requirements.source !== source) throw new Error("native invocation ABI: different source resource owner");
    for (const gap of requirements.gaps) gaps.push({ detail: gap.detail, unitId: gap.unitId });
    if (native?.plan.mode !== "number-boundary" || !native.valueRequirements)
      gaps.push({
        detail: "selected native invocation needs its actual value/string resource owner",
        unitId: undefined,
      });
  }
  return { requirements, gaps };
}

/** Description only; actual issued requirements stay private to consumer acceptance. */
export function nativeInvocationSetup(
  requirements: NativeInvocationRequirements | undefined,
  declarationOrder: number,
): NativeInvocationPhysicalSetup | undefined {
  return requirements
    ? {
        key: requirements.key,
        bindings: nativeInvocationAbiBindings(requirements, declarationOrder),
        methodArities: requirements.methodArities,
        applyVector: requirements.applyVector,
        sourceUseCount: requirements.uses.length,
        getterUseCount: requirements.getterUses.length,
        completionScope: requirements.completionScope,
      }
    : undefined;
}

/** No name grants: every route comes from a current, authenticated source occurrence. */
export function nativeInvocationAbiBindings(
  requirements: NativeInvocationRequirements,
  declarationOrder: number,
): readonly NativeCallAbiBinding[] {
  assertNativeInvocationRequirementsIssued(requirements);
  return nativeCallAbiBindings(
    requirements.source.demands,
    requirements.uses.map((use) => ({
      occurrence: use.occurrence,
      ownerUnitId: use.ownerUnitId,
      resourceKey: `${requirements.key}:${use.kind === "method" ? `method:${use.arity}` : use.kind}`,
    })),
    declarationOrder,
    "native invocation ABI",
  );
}

/** One selected call occurrence and the reserved native function that serves its route. */
export interface NativeCallUse {
  readonly occurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly resourceKey: string;
}

/**
 * The ABI rows of native functions that serve source calls, one per distinct call route, in first-use order: each
 * row's signature is its calls' actual one, and an entry the program already plans must agree with it. `label`
 * names the family in the invariant messages.
 */
export function nativeCallAbiBindings(
  demands: NativeStringValueDemands,
  uses: readonly NativeCallUse[],
  declarationOrder: number,
  label: string,
): readonly NativeCallAbiBinding[] {
  const anchor = preparedIrRuntimeAbiAnchor(demands.program.inventory);
  const bindings = new Map<string, NativeCallAbiBinding>();
  for (const use of uses) {
    const call = demands.occurrences[use.occurrence]!.instruction;
    if (call.kind !== "call") throw new Error(`${label}: lost selected call`);
    const fn = demands.projection.prepared.functions.find((row) => row.unitId === use.ownerUnitId)!;
    const types = nativeAsyncCallableValueTypes(fn);
    const signature = preparedIrCallableSignature(
      call.args.map((id) => types.get(id)!),
      call.resultType ? [call.resultType] : [],
    );
    const reference = call.target;
    const route = irCallableBindingKey(reference.binding);
    const retained = bindings.get(route);
    const id = preparedIrRuntimeCallableBindingId(demands.program.inventory, reference);
    let entry: ProgramAbiPlanEntry = {
      id,
      order: { sourceOrder: anchor.order, declarationOrder: declarationOrder + bindings.size },
      displayName: reference.name,
      structuralReferenceKey: route,
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic", signature },
    };
    const old = demands.program.abi.entries.find((row) => row.plan.id === id);
    if (old) {
      if (
        preparedIrDataMismatch(old.plan, { ...entry, order: old.plan.order, displayName: old.plan.displayName }) ||
        old.contract.kind !== "callable" ||
        preparedIrDataMismatch(old.contract.ref.binding, reference.binding) ||
        preparedIrDataMismatch(preparedIrCallableSignature(old.contract.params, old.contract.results), signature)
      )
        throw new Error(`${label}: existing callable differs from selected source signature`);
      entry = old.plan;
    }
    if (retained) {
      if (preparedIrDataMismatch(retained.entry.intent, entry.intent) || retained.resourceKey !== use.resourceKey)
        throw new Error(`${label}: inconsistent call signatures`);
      continue;
    }
    bindings.set(route, Object.freeze({ reference, entry, resourceKey: use.resourceKey }));
  }
  return Object.freeze([...bindings.values()]);
}

/**
 * (#7354 O1) The physical plan's binding of a program's `js.object.*` calls: each call route binds the realm function
 * that serves its contract (`native-source-objects.ts`), through the same row builder as native invocation.
 */
export interface NativeSourceObjectPhysicalSetup {
  readonly key: string;
  readonly bindings: readonly NativeCallAbiBinding[];
}

/** The rows for every object use the realm selected, or a gap per contract with no native source provider. */
export function planNativeSourceObjectSetup(
  realm: NativeRealmRequirements | undefined,
  declarationOrder: number,
): {
  readonly setup: NativeSourceObjectPhysicalSetup | undefined;
  readonly gaps: readonly { readonly detail: string; readonly unitId: IrUnitId }[];
} {
  const uses = realm?.description.objectUses ?? [];
  if (!realm || uses.length === 0) return { setup: undefined, gaps: [] };
  const gaps: { detail: string; unitId: IrUnitId }[] = [];
  const served = uses.flatMap((use) => {
    const resourceKey = nativeSourceObjectResourceKey(realm.description.key, use.feature);
    if (resourceKey === undefined) {
      gaps.push({ detail: `${use.feature} has no native source provider`, unitId: use.ownerUnitId });
      return [];
    }
    return [{ occurrence: use.occurrence, ownerUnitId: use.ownerUnitId, resourceKey }];
  });
  const bindings = nativeCallAbiBindings(realm.access.demands, served, declarationOrder, "native source object ABI");
  return { setup: { key: realm.description.key, bindings }, gaps };
}
