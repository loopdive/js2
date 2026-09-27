// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrTypeRef } from "../core/types.js";
import { ProgramAbiInvariantError } from "../../shared/contracts/program-abi-error.js";

/** One exact consumer of the semantic dynamic payload, including its tag. */
export interface ClosureDynamicCarrierDemand {
  readonly terminalUnitId: IrUnitId;
  readonly logicalTypeKey: string;
  readonly role: "closure-dynamic-payload";
}

export type ClosureDynamicCarrier =
  | { readonly kind: "externref"; readonly carrierTypeRef: IrTypeRef }
  | { readonly kind: "reference"; readonly carrierTypeRef: IrTypeRef; readonly nullable: boolean };

/** Data is descriptive only: the owning type registry authenticates the object. */
export interface ClosureDynamicCarrierEvidence extends ClosureDynamicCarrierDemand {
  readonly carrier: ClosureDynamicCarrier;
}

/** Keep strict peer completeness while retaining older transaction receipts for authentication. */
export function closureDynamicCarrierAuthenticationPopulation(
  consumers: readonly ClosureDynamicCarrierEvidence[],
  supplied: readonly ClosureDynamicCarrierEvidence[],
  originals?: readonly ClosureDynamicCarrierEvidence[],
): readonly ClosureDynamicCarrierEvidence[] {
  if (
    consumers.length === 0 ||
    consumers.length !== supplied.length ||
    consumers.some((proof) => !supplied.includes(proof)) ||
    (originals !== undefined &&
      (originals.length === 0 ||
        originals.some(
          (proof) =>
            !consumers.some(
              (peer) =>
                peer.terminalUnitId === proof.terminalUnitId &&
                peer.logicalTypeKey === proof.logicalTypeKey &&
                peer.role === proof.role,
            ),
        )))
  ) {
    throw new ProgramAbiInvariantError("type-remap-mismatch", "missing or foreign closure dynamic evidence population");
  }
  // Refreshing a demand must not replace the receipt an earlier transaction
  // actually received. Both the old receipt and all current peers are checked.
  return [...new Set([...supplied, ...(originals ?? [])])];
}

/** Validate and freeze the complete demand vocabulary before backend allocation. */
export function canonicalClosureDynamicCarrierDemands(
  demands: readonly ClosureDynamicCarrierDemand[],
  terminalUnits: readonly { readonly id: IrUnitId }[],
): readonly ClosureDynamicCarrierDemand[] {
  const terminals = new Set(terminalUnits.map(({ id }) => id));
  const keys = new Set<string>();
  // Complete validation precedes the policy's retained AnyValue/singleton allocation.
  return Object.freeze(
    demands.map((demand) => {
      let logical: { kind?: unknown; tag?: unknown };
      try {
        logical = JSON.parse(demand.logicalTypeKey);
      } catch {
        throw new ProgramAbiInvariantError("type-remap-mismatch", "invalid closure dynamic demand key");
      }
      const key = JSON.stringify([demand.terminalUnitId, demand.logicalTypeKey, demand.role]);
      if (
        !terminals.has(demand.terminalUnitId) ||
        demand.role !== "closure-dynamic-payload" ||
        !logical ||
        logical.kind !== "dynamic" ||
        (logical.tag !== null && typeof logical.tag !== "number") ||
        JSON.stringify({ kind: "dynamic", tag: logical.tag }) !== demand.logicalTypeKey ||
        keys.has(key)
      ) {
        throw new ProgramAbiInvariantError("type-remap-mismatch", "invalid or duplicate closure dynamic demand");
      }
      keys.add(key);
      return Object.freeze({
        terminalUnitId: demand.terminalUnitId,
        logicalTypeKey: demand.logicalTypeKey,
        role: demand.role,
      });
    }),
  );
}
