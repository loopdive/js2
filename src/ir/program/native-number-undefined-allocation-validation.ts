// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { assertPreparedIrData } from "../../shared/contracts/prepared-ir-data.js";
import { ALLOC_NAMESPACES } from "../analysis/contracts/allocations.js";
import { createVerifiedAllocationSnapshot } from "../analysis/allocations/snapshot.js";
import { assertFinalAllocProvenance } from "../analysis/alloc-verification.js";
import { assertPreparedIrFunctionAllocationTypesAndStates } from "./allocation-body-validation.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";
import { verifyNativeNumberUndefinedEvidence } from "../runtime/native-number-undefined-profile.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";

export type NativeNumberUndefinedAllocationContext = Pick<PreparedIrProgram, "ir" | "allocations" | "runtimeSupport"> &
  Partial<Pick<PreparedIrProgram, "runtime">>;

/** Logical allocations only; canonical provider/runtime reproducibility remains a later full-program check. */
export function assertNativeNumberUndefinedGcAllocations(program: NativeNumberUndefinedAllocationContext): boolean {
  if (!program.runtime?.length || program.runtime.some((view) => view.backend !== "wasmgc")) return false;
  const support = irRuntimeSupportFunctions(program.runtimeSupport);
  const views = [
    { ...program.ir, functions: [...program.ir.functions, ...support] },
    ...program.runtime.map((view) => ({ ...program.ir, functions: [...view.prepared.functions, ...support] })),
  ];
  assertPreparedIrData(program.allocations);
  const lookup = createVerifiedAllocationSnapshot(program.allocations);
  for (const module of views)
    for (const fn of module.functions) {
      assertFinalAllocProvenance(fn, lookup);
      assertPreparedIrFunctionAllocationTypesAndStates(fn, lookup);
    }
  const reports = views.map((module) => verifyNativeNumberUndefinedEvidence(module, program.allocations));
  if (reports.every((report) => report === undefined)) return false;
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `native GC Number/Undefined allocations: ${detail}`,
    );
  };
  // Complete invalid-view inspection precedes every coverage/namespace decision.
  for (const report of reports)
    if (report?.kind === "invalid") invalid(`${report.code} at ${JSON.stringify(report.at)}`);
  const namespaces = new Set<string>([ALLOC_NAMESPACES.ownership, ALLOC_NAMESPACES.escape, ALLOC_NAMESPACES.encoding]);
  for (const row of program.allocations.metadata)
    for (const [namespace] of row.entries)
      if (!namespaces.has(namespace)) invalid(`unverifiable namespace ${namespace}`);
  for (const report of reports)
    if (report?.kind !== "verified" || report.namespaces !== "ownership-and-escape")
      invalid("every original and selected GC body requires canonical complete ownership-and-escape evidence");
  return true;
}
