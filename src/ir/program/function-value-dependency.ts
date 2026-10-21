// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Read-only recognition of the exact source-owned cached function-value accessor.
import { irCallableBindingKey, irSupportFuncRef } from "../core/callable-bindings.js";
import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrFuncRef } from "../core/value-references.js";
import { canonicalAbiEntry, type PreparedComponentAbiLookup } from "./abi-lookup.js";

export function functionValueAccessorOwner(
  ref: IrFuncRef,
  abi: PreparedComponentAbiLookup,
):
  | { readonly kind: "owner"; readonly unitId: IrUnitId }
  | { readonly kind: "contract-mismatch"; readonly bindingId: IrBindingId }
  | undefined {
  if (ref.binding.kind !== "support") return;
  const resolution = canonicalAbiEntry(abi, ref.binding.bindingId);
  if (resolution.kind !== "resolved") return;
  const { requested, canonical } = resolution.entry;
  const intent = canonical.intent;
  if (intent.kind !== "callable" || intent.origin !== "support" || !intent.unitId) return;
  const expected = irSupportFuncRef(intent.unitId, "function-value-accessor", ref.name);
  if (
    expected.binding.kind !== "support" ||
    requested.id !== expected.binding.bindingId ||
    canonical.id !== expected.binding.bindingId
  )
    return;
  if (
    requested.structuralReferenceKey !== irCallableBindingKey(ref.binding) ||
    intent.signature.params.length !== 0 ||
    intent.signature.results.length !== 1 ||
    intent.signature.results[0] !== '{"kind":"externref"}'
  ) {
    return { kind: "contract-mismatch", bindingId: ref.binding.bindingId };
  }
  return { kind: "owner", unitId: intent.unitId };
}
