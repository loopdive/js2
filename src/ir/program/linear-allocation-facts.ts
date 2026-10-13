// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import type { PreparedLinearMemoryInput } from "./linear-allocation-validation.js";
import { unsupportedPreparedLinearAllocationEvidence } from "./linear-allocation-validation.js";
import { assertPreparedIrProgramLinearAllocationEvidence } from "./validation.js";

export type { PreparedLinearMemoryInput } from "./linear-allocation-validation.js";

/** Complete current acquisition for B; this pairing is neither a token nor serialized trust. */
export function requirePreparedLinearMemoryInput(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): PreparedLinearMemoryInput {
  const input = assertPreparedIrProgramLinearAllocationEvidence(program, projection);
  if (input === undefined)
    unsupportedPreparedLinearAllocationEvidence(program, "native Linear memory planning requires checked final facts");
  return input;
}
