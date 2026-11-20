// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// How a Prepared stage validator runs (#7380). The validators check the invariants of the data at a stage boundary
// (prepared program, physical module). They run in tests and CI and under
// `JS2WASM_VALIDATE_PREPARED=1`, never in a production compile, so no program may depend on one for its refusal.

import { preparedValidationEnabled } from "../../shared/contracts/prepared-validation.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/**
 * A stage invariant failed: a compiler bug, not a refusal of the program. It propagates out of `compile()`
 * deliberately: a refusal probe that only checks `success === false` must not absorb it.
 */
export class PreparedValidatorError extends PreparedIrProgramInvariantError {
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    super("invalid-prepared-data", `prepared validator (${stage}): ${cause instanceof Error ? cause.message : cause}`);
    this.name = "PreparedValidatorError";
  }
}

/** Run one stage's validator when validation is switched on; a violation names the stage. */
export function validatePreparedStage(stage: string, check: () => void): void {
  if (!preparedValidationEnabled()) return;
  try {
    check();
  } catch (error) {
    throw new PreparedValidatorError(stage, error);
  }
}
