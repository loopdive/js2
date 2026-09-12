// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { IrInvariantError } from "../ir/outcomes.js";
import type { EmittedPreparedIrProgram, PreparedIrProgram, PreparedIrProgramFailure } from "../ir/program.js";

/** Internal emission evidence, deliberately not a public CompileResult. */
export type IrProgramDriverResult =
  | {
      readonly kind: "emitted";
      readonly program: PreparedIrProgram;
      readonly emission: EmittedPreparedIrProgram;
    }
  | {
      readonly kind: "unsupported";
      readonly phase: "preparation" | "acceptance";
      readonly failure: Extract<PreparedIrProgramFailure, { kind: "unsupported" }>;
    };

/** A returned invariant is fatal too; retain its original located evidence. */
export class IrProgramDriverInvariantError extends IrInvariantError {
  constructor(readonly failure: Extract<PreparedIrProgramFailure, { kind: "invariant" }>) {
    super(failure.code, failure.stage, failure.detail, failure.cause);
    this.name = "IrProgramDriverInvariantError";
  }
}
