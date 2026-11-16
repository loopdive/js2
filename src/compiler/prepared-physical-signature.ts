// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Physical-signature joins of a completed Prepared emission: does the function slot a binding resolved to carry
 * the signature a physical plan row declares? Shared by the presentation's async checks and its provider census.
 */

import type { EmittedPreparedIrProgram } from "../ir/program.js";
import { emittedProgramBindingIndex } from "../ir/program-consumer.js";
import type { PhysicalSignatureType } from "../ir/program-physical-plan.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import type { ValType } from "../ir/types.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";

export interface PhysicalCallableRow {
  readonly params: readonly PhysicalSignatureType[];
  readonly results: readonly PhysicalSignatureType[];
}

function physicalTypes(
  emission: EmittedPreparedIrProgram,
  types: readonly PhysicalSignatureType[],
): readonly ValType[] | undefined {
  const result: ValType[] = [];
  for (const type of types) {
    if (type.kind === "support-ref") {
      const slot = emittedProgramBindingIndex(emission, type.ref.binding.bindingId);
      if (slot?.space !== "type") return undefined;
      result.push({ kind: type.nullable ? "ref_null" : "ref", typeIdx: slot.index });
    } else if (
      type.kind === "vec" ||
      type.kind === "string" ||
      type.kind === "closure" ||
      type.kind === "callable" ||
      type.kind === "boxed"
    )
      return undefined;
    else result.push(type);
  }
  return result;
}
/** The completed function slot `id` resolved to, with its function type. */
export function completedFunctionSlot(
  emission: EmittedPreparedIrProgram,
  id: IrBindingId,
): { readonly index: number; readonly params: readonly ValType[]; readonly results: readonly ValType[] } | undefined {
  const slot = emittedProgramBindingIndex(emission, id);
  if (slot?.space !== "function") return undefined;
  const mod = emission.module;
  const imports = mod.imports.filter((entry) => entry.desc.kind === "func");
  const desc = slot.index < imports.length ? imports[slot.index]!.desc : mod.functions[slot.index - imports.length];
  const signature = desc && "typeIdx" in desc ? mod.types[desc.typeIdx] : undefined;
  return signature?.kind === "func"
    ? { index: slot.index, params: signature.params, results: signature.results }
    : undefined;
}
/** A completed function slot whose physical signature is `row`'s. */
export function physicalCallableMatches(
  emission: EmittedPreparedIrProgram,
  id: IrBindingId,
  row: PhysicalCallableRow,
): boolean {
  const slot = completedFunctionSlot(emission, id);
  const params = physicalTypes(emission, row.params),
    results = physicalTypes(emission, row.results);
  return Boolean(
    slot &&
    params &&
    results &&
    preparedIrDataMismatch(params, slot.params) === undefined &&
    preparedIrDataMismatch(results, slot.results) === undefined,
  );
}
