// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  assertNativeInvocationRequirementsCurrent,
  planNativeInvocationRequirements,
  type NativeInvocationRequirements,
} from "../../../ir/program/native-invocation-requirements.js";
import type { NativeSourceClosureRequirements } from "../../../ir/program/native-source-closure-requirements.js";
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

export interface NativeInvocationAbiBinding {
  readonly resourceKey: string;
  readonly reference: IrFuncRef;
  readonly entry: ProgramAbiPlanEntry;
}

export interface NativeInvocationPhysicalSetup {
  readonly key: string;
  readonly bindings: readonly NativeInvocationAbiBinding[];
  readonly methodArities: readonly number[];
  readonly applyVector: boolean;
  readonly sourceUseCount: number;
  readonly completionScope: "selected-source-invocation";
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
  const requirements = source && planNativeInvocationRequirements(source, { utf8Storage });
  const gaps: { detail: string; unitId: IrUnitId | undefined }[] = [];
  if (requirements) {
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
        completionScope: requirements.completionScope,
      }
    : undefined;
}

/** No name grants: every route comes from a current, authenticated source occurrence. */
export function nativeInvocationAbiBindings(
  requirements: NativeInvocationRequirements,
  declarationOrder: number,
): readonly NativeInvocationAbiBinding[] {
  assertNativeInvocationRequirementsCurrent(requirements);
  const { demands } = requirements.source;
  const anchor = preparedIrRuntimeAbiAnchor(demands.program.inventory);
  const bindings = new Map<string, NativeInvocationAbiBinding>();
  for (const use of requirements.uses) {
    const call = demands.occurrences[use.occurrence]!.instruction;
    if (call.kind !== "call") throw new Error("native invocation ABI: lost selected call");
    const fn = demands.projection.prepared.functions.find((row) => row.unitId === use.ownerUnitId)!;
    const types = nativeAsyncCallableValueTypes(fn);
    const signature = preparedIrCallableSignature(
      call.args.map((id) => types.get(id)!),
      [call.resultType!],
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
        throw new Error("native invocation ABI: existing callable differs from selected source signature");
      entry = old.plan;
    }
    if (retained) {
      if (preparedIrDataMismatch(retained.entry.intent, entry.intent))
        throw new Error("native invocation ABI: inconsistent call signatures");
      continue;
    }
    bindings.set(
      route,
      Object.freeze({
        reference,
        entry,
        resourceKey: `${requirements.key}:${use.kind === "method" ? `method:${use.arity}` : use.kind}`,
      }),
    );
  }
  return Object.freeze([...bindings.values()]);
}
