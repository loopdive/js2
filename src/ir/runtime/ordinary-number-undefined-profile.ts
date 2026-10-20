// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrModule } from "../core/nodes.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import type { AllocationEvidenceCheck } from "../analysis/allocation-evidence/contracts.js";
import { inspectOrdinaryNumberUndefinedNamespaces } from "../analysis/allocation-evidence/ordinary-number-undefined-profile.js";
import { verifyIrFunction } from "./verify.js";

/** Full runtime IR validity is mandatory in addition to independent portable equations. */
export function verifyOrdinaryNumberUndefinedEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): AllocationEvidenceCheck | undefined {
  const report = inspectOrdinaryNumberUndefinedNamespaces(module, registry);
  if (report?.kind !== "representable") return report;
  if (report.census.allocations === 0)
    return { kind: "not-covered", reason: "reference-carrier", at: { kind: "module" } };
  for (const fn of module.functions)
    if (verifyIrFunction(fn, undefined, module).length)
      return { kind: "invalid", code: "lexical-definition", at: { kind: "function", unitId: fn.unitId } };
  return { ...report, kind: "verified", profile: "native-ordinary-number-undefined-v1" };
}
