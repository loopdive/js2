// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type PreparedIrProgramInvariantCode =
  | "abi-not-sealed"
  | "program-sealed"
  | "program-seal-failed"
  | "duplicate-unit"
  | "missing-unit"
  | "unknown-unit"
  | "duplicate-component-candidate"
  | "empty-component-candidate"
  | "duplicate-support-intent-candidate"
  | "late-support-intent"
  | "unknown-support-owner"
  | "unknown-support-binding"
  | "duplicate-allocation-candidate"
  | "allocation-not-ir-candidate-owned"
  | "duplicate-provenance-candidate"
  | "provenance-not-ir-candidate-owned"
  | "invalid-prepared-data"
  | "program-has-invariant-candidate"
  | "invalid-transaction-capability"
  | "emission-already-started"
  | "transaction-closed"
  | "wrong-emitter"
  | "duplicate-emission"
  | "unknown-emission-unit"
  | "partial-publication"
  | "emission-failed";

export class PreparedIrProgramInvariantError extends Error {
  constructor(
    readonly code: PreparedIrProgramInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "PreparedIrProgramInvariantError";
  }
}
