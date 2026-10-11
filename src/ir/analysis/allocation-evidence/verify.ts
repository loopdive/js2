// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrModule } from "../../core/nodes.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type { AllocationEvidenceCheck } from "./contracts.js";
import { captureAllocationEvidenceCensus } from "./census.js";
import { compareRegistryEvidence, indexRegistryEvidence } from "./metadata.js";

/**
 * Verify finite body-derived allocation annotations on a complete original view.
 *
 * Precondition: the adapter has screened descriptors and retained canonical
 * contextual SSA/type, snapshot and final allocation-provenance validation.
 * This endpoint neither authenticates that context nor grants native admission.
 * Legacy rule sharing and prepared-program joins remain separate work.
 */
export function verifyAllocationEvidence(module: IrModule, registry: AllocRegistrySnapshot): AllocationEvidenceCheck {
  const index = indexRegistryEvidence(registry);
  const captured = captureAllocationEvidenceCensus(module, registry);
  if (captured.kind !== "captured") return captured;
  if (!Object.values(captured.census).every((count) => Number.isSafeInteger(count) && count >= 0))
    return { kind: "not-covered", reason: "resource-limit", at: { kind: "module" } };
  const failure = compareRegistryEvidence(index, captured);
  if (failure) return failure;
  return {
    kind: "verified",
    profile: "single-block-numeric-vector-if-v1",
    namespaces: index.mode,
    census: captured.census,
  };
}
