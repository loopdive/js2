// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrSourceRecord } from "../../shared/contracts/ir-unit-inventory.js";
import { irCallableBindingKey, irImportFuncRef } from "../core/callable-bindings.js";
import { irVal } from "../core/types.js";
import type { ValType } from "../../wasm/model/instructions.js";
import {
  assertCanonicalRuntimeHostCapabilityRecord,
  type RuntimeHostCapabilityFuncRecord,
} from "../runtime/host-capabilities.js";
import { preparedIrCallableSignature } from "./abi-signatures.js";
import type { ProgramAbiPlanEntry } from "./abi.js";

export interface PreparedHostImportPlan {
  readonly reference: IrFuncRef;
  readonly referenceKey: string;
  readonly bindingId: IrBindingId;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
  readonly entry: ProgramAbiPlanEntry;
  readonly capability: RuntimeHostCapabilityFuncRecord["capability"];
  readonly module: RuntimeHostCapabilityFuncRecord["module"];
  readonly field: string;
}

/** One ABI declaration for a canonical host capability, shared across semantic families. */
export function planPreparedHostImport(
  anchor: IrSourceRecord,
  declarationOrder: number,
  record: RuntimeHostCapabilityFuncRecord,
): PreparedHostImportPlan {
  assertCanonicalRuntimeHostCapabilityRecord(record);
  if (anchor.kind !== "entry" || !Number.isSafeInteger(declarationOrder) || declarationOrder < 0)
    throw new Error("host import requires an entry-source anchor and declaration order");
  const value = (kind: RuntimeHostCapabilityFuncRecord["params"][number]): ValType => {
    if (kind === "ref_extern") throw new Error("host import requires an implemented nullable scalar carrier");
    return { kind };
  };
  const reference = irImportFuncRef(record.module, record.field);
  const referenceKey = irCallableBindingKey(reference.binding);
  const bindingId = createIrBindingId({ ownerId: anchor.id, domain: "callable", role: referenceKey });
  const params = record.params.map(value);
  const results = record.results.map(value);
  const entry: ProgramAbiPlanEntry = {
    id: bindingId,
    order: { sourceOrder: anchor.order, declarationOrder },
    displayName: reference.name,
    structuralReferenceKey: referenceKey,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "import",
      signature: preparedIrCallableSignature(params.map(irVal), results.map(irVal)),
    },
  };
  return {
    reference,
    referenceKey,
    bindingId,
    params,
    results,
    entry,
    capability: record.capability,
    module: record.module,
    field: record.field,
  };
}
