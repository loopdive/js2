// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irTypeBindingKey } from "../ir/abi-bindings.js";
import type { IrSourceId } from "../ir/identity.js";
import type { IrTypeRef } from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { TypeDef } from "../ir/types.js";
import type { PreparedProgramAbiProvisionalBinding } from "./program-abi-prepared-transaction.js";
import type { ProgramAbiSession, ProgramAbiTypeCell } from "./program-abi-session.js";
import { canonicalProgramAbiTypeDef } from "./program-abi-signatures.js";

/** Describe one allocated support type without publishing required ownership. */
export function describeProgramAbiSupportType(input: {
  readonly session: ProgramAbiSession;
  readonly entrySourceId: IrSourceId;
  readonly ref: IrTypeRef;
  readonly type: TypeDef;
  readonly cell: ProgramAbiTypeCell;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
}): PreparedProgramAbiProvisionalBinding {
  const { session, ref, type, cell } = input;
  if (cell.current !== type || session.typeCellFor(type) !== cell) {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      "support type description requires its exact session-owned cell",
    );
  }
  const structuralReferenceKey = irTypeBindingKey(ref.binding);
  return {
    draft: {
      id: ref.binding.bindingId,
      structuralOrder: session.structuralOrder.forSource(input.entrySourceId, {
        domain: "type",
        roleOrdinal: input.roleOrdinal,
        derivedOrdinal: input.derivedOrdinal,
      }),
      structuralReferenceKey,
      displayName: ref.name,
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "type", shapeKey: canonicalProgramAbiTypeDef(type) },
    },
    structuralReferenceKey,
    locator: { kind: "type-cell", cell },
  };
}
