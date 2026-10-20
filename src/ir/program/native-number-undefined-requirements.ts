// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { inspectOrdinaryNumberUndefinedBodies } from "../analysis/allocation-evidence/ordinary-number-undefined-body.js";
import type { IrModule } from "../core/nodes.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import {
  inspectNativeNumberUndefinedBodies,
  type NativeNumberUndefinedRequirements,
} from "../analysis/allocation-evidence/native-number-undefined-body.js";
export type {
  NativeNumberUndefinedOccurrence,
  NativeNumberUndefinedRequirements,
} from "../analysis/allocation-evidence/native-number-undefined-body.js";
import { verifyNativeNumberUndefinedEvidence } from "../runtime/native-number-undefined-profile.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { copyIrPreparationData } from "../analysis/alloc-registry.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

const issued = new WeakMap<NativeNumberUndefinedRequirements, { module: IrModule; registry: AllocRegistrySnapshot }>();

/** Detached body census, reconstructed on every preparation/consumption attempt. */
export function collectNativeNumberUndefinedRequirements(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): NativeNumberUndefinedRequirements | undefined {
  const report = verifyNativeNumberUndefinedEvidence(module, registry);
  if (report?.kind === "invalid")
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native Number/Undefined runtime validation");
  if (report?.kind === "not-covered")
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      "native Number/Undefined runtime validation",
    );
  const requirements =
    report?.kind === "verified" && report.profile === "native-ordinary-number-undefined-v1"
      ? inspectOrdinaryNumberUndefinedBodies(module, registry)?.requirements
      : report
        ? inspectNativeNumberUndefinedBodies(module, registry)
        : undefined;
  if (requirements) issued.set(requirements, copyIrPreparationData({ module, registry }));
  return requirements;
}

/** Object identity alone is insufficient: replay mutated bodies and the current registry. */
export function assertNativeNumberUndefinedRequirementsCurrent(
  requirements: NativeNumberUndefinedRequirements,
  module: IrModule,
  registry: AllocRegistrySnapshot,
): void {
  const seal = issued.get(requirements);
  if (!seal || preparedIrDataMismatch(seal, { module, registry }) !== undefined)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "unissued or changed native Number/Undefined requirements",
    );
  const current = collectNativeNumberUndefinedRequirements(module, registry);
  const fail = () => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "stale native Number/Undefined requirements");
  };
  if (
    !current ||
    current.units.length !== requirements.units.length ||
    current.units.some((unit, i) => unit !== requirements.units[i]) ||
    current.occurrences.length !== requirements.occurrences.length ||
    current.boxes.length !== requirements.boxes.length
  )
    fail();
  for (let i = 0; i < requirements.occurrences.length; i++) {
    const a = requirements.occurrences[i]!,
      b = current!.occurrences[i]!;
    if (
      a.instr !== b.instr ||
      a.unitId !== b.unitId ||
      a.blockId !== b.blockId ||
      a.root !== b.root ||
      a.arms.length !== b.arms.length ||
      a.arms.some((arm, j) => arm.arm !== b.arms[j]!.arm || arm.index !== b.arms[j]!.index)
    )
      fail();
  }
  for (let i = 0; i < requirements.boxes.length; i++) {
    const a = requirements.boxes[i]!,
      b = current!.boxes[i]!;
    if (a.instr !== b.instr || a.unitId !== b.unitId || a.allocationId !== b.allocationId) fail();
  }
}
