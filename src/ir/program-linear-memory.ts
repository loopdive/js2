// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedLinearMemoryInput } from "./program/linear-allocation-facts.js";
import { addPreparedLinearAllocationGap } from "./program/linear-allocation-outcome.js";
import type { PreparedLinearMemoryPlan } from "../backend/linear/program/contracts.js";
import type { PreparedIrBackendOptions } from "./program.js";
import type { PreparedIrProgram } from "./program/prepared-contracts.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";

/** The consumer owns issued resources; descriptive planning retains genuine missing-owner gaps. */
export function resolvePhysicalLinearMemory(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  gaps: { add(detail: string, unitId?: IrUnitId): void },
  linearMemory?: PreparedLinearMemoryPlan,
  checkedInput?: PreparedLinearMemoryInput,
): PreparedLinearMemoryPlan | undefined {
  if (!linearMemory) addPreparedLinearAllocationGap(program, options, checkedInput, gaps);
  return linearMemory;
}
