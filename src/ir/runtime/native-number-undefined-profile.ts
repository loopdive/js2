// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrModule } from "../core/nodes.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import type { AllocationEvidenceCheck } from "../analysis/allocation-evidence/contracts.js";
import {
  hasNativeNumberUndefinedPopulation,
  assertNativeNumberUndefinedModulePrelude,
  assertNativeNumberUndefinedFunctionShape,
  nativeNumberUndefinedTags,
} from "../analysis/allocation-evidence/native-number-undefined-body.js";
import { inspectNativeNumberUndefinedNamespaces } from "../analysis/allocation-evidence/native-number-undefined-profile.js";
import { verifyIrFunction } from "./verify.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";

/** Only this runtime conjunction authenticates ECMAScript partitions and full IR validity. */
export function verifyNativeNumberUndefinedEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): AllocationEvidenceCheck | undefined {
  try {
    if (!hasNativeNumberUndefinedPopulation(module)) return undefined;
    assertNativeNumberUndefinedModulePrelude(module, registry);
    const units = new Set<string>();
    for (const fn of module.functions) {
      if (units.has(fn.unitId)) throw new PreparedIrProgramInvariantError("invalid-prepared-data", "duplicate unit");
      units.add(fn.unitId);
      assertNativeNumberUndefinedFunctionShape(fn);
      const errors = verifyIrFunction(fn);
      if (errors.length)
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          errors.map((error) => error.message).join("; "),
        );
    }
    const tags = nativeNumberUndefinedTags(module);
    if (tags.numeric !== JS_TAG_IDS.NumberF64 || tags.singleton !== JS_TAG_IDS.Undefined)
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "build",
        "native Number/Undefined canonical partitions",
      );
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return { kind: "not-covered", reason: "reference-carrier", at: { kind: "module" } };
    if (error instanceof PreparedIrProgramInvariantError)
      return { kind: "invalid", code: "lexical-definition", at: { kind: "module" } };
    throw error;
  }
  const check = inspectNativeNumberUndefinedNamespaces(module, registry);
  if (!check || check.kind !== "representable") return check;
  return { ...check, kind: "verified", profile: "native-number-undefined-v1" };
}
