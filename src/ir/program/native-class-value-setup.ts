// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";
import { CLASS_VALUE_ALLOCATION_DECLARATION } from "../runtime/class-value-callable.js";
import { preparedIrCallableSignature } from "./abi-signatures.js";
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "./runtime-abi-identity.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { preparedIrDataMismatch } from "./data.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { NativeInvocationAbiBinding } from "../../backend/wasmgc/program/native-invocation-abi.js";

export interface NativeClassValueSetup {
  readonly key: string;
  readonly bindings: readonly NativeInvocationAbiBinding[];
  readonly occurrences: NonNullable<NativeSourceClosureRequirements["classValues"]>;
  readonly completionScope: "class-value-allocation-only";
}
function fail(detail: string): never {
  throw new Error("native class value setup: " + detail);
}

/** Description derived from an issued closure/operand census, never from a display name. */
export function planNativeClassValueSetup(
  source: NativeSourceClosureRequirements | undefined,
  order: number,
): NativeClassValueSetup | undefined {
  if (!source) return undefined;
  assertNativeSourceClosureRequirementsCurrent(source);
  if (!source.classValues?.length) return undefined;
  const key = source.key + ":class-values",
    program = source.demands.program;
  const declaration = CLASS_VALUE_ALLOCATION_DECLARATION,
    reference = declaration.ref;
  const signature = preparedIrCallableSignature(declaration.params, declaration.results);
  const id = preparedIrRuntimeCallableBindingId(program.inventory, reference);
  let entry: ProgramAbiPlanEntry = {
    id,
    order: { sourceOrder: preparedIrRuntimeAbiAnchor(program.inventory).order, declarationOrder: order },
    displayName: reference.name,
    structuralReferenceKey: irCallableBindingKey(reference.binding),
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "intrinsic", signature },
  };
  const old = program.abi.entries.find((row) => row.plan.id === id);
  if (old) {
    if (
      preparedIrDataMismatch(old.plan, { ...entry, order: old.plan.order, displayName: old.plan.displayName }) ||
      old.contract.kind !== "callable" ||
      preparedIrDataMismatch(old.contract.ref.binding, reference.binding) ||
      preparedIrDataMismatch(preparedIrCallableSignature(old.contract.params, old.contract.results), signature)
    )
      fail("existing ABI differs from the canonical allocator signature");
    entry = old.plan;
  }
  return {
    key,
    bindings: [{ resourceKey: key + ":allocate", reference, entry }],
    occurrences: source.classValues,
    completionScope: "class-value-allocation-only",
  };
}
