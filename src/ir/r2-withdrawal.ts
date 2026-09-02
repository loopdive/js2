// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3521 R2-T1) Why a terminal that emitted BOTH bodies was never prepared.
 *
 * A `(prepareAttempts, directBodyEmissions, irBodyEmissions) === (1, 1, 1)`
 * function row is the compile-twice shape R2 exists to retire, and until this
 * existed the ledger recorded that it happened without recording WHY. The
 * reason is a closed vocabulary, not free text: R2-F1/E1/S1 each ratchet a
 * NAMED bucket to zero, which a `string` detail cannot express.
 *
 * Deliberately NOT in `src/ir/outcomes.ts`: that file is #3520's, and the row
 * type there stays byte-identical. `IrObservedOutcomeBase` never learns the
 * field — `reconcileIrOverlayOutcomes` attaches it by spread, so it is
 * `(1,1,1)`-only metadata that no emitter reads and no policy consumes.
 */
import type { IrObservedOutcome } from "./outcomes.js";

/** Which stage of the R2 route withdrew the unit. */
export type IrR2WithdrawalStage = "not-attempted" | "admission" | "fixed-point" | "deferred";

/**
 * The closed reason vocabulary. `not-attempted` (3) names a route the R2
 * selector never ran on; `admission` (10) mirrors, in order, the predicate
 * chain of `selectR2PreparedOwnerComponents`; `fixed-point` (6) the ownership
 * closure's five crossing edges plus the #3522-F4 class atom; `deferred` (1)
 * the unsealed-component deferral inside `prepareIrBodies`.
 */
export type IrR2WithdrawalReason =
  // not-attempted
  | "multi-source-driver"
  | "ir-first-disabled"
  | "late-feature-preparation"
  // admission, in predicate order
  | "fast-signature-unproven"
  | "async-declaration"
  | "generator-lane"
  | "nested-executable-syntax"
  | "poison-pill-read"
  | "direct-caller-activation-target"
  | "function-value-reference"
  | "param-signature-unstable"
  | "return-signature-unstable"
  | "allocated-slot-mismatch"
  // fixed-point, in edge order
  | "callee-of-unowned-caller"
  | "callee-outside-component"
  | "construction-callee-outside"
  | "storage-terminal-unprepared"
  | "outside-caller-uncertified"
  | "class-atom"
  // deferred
  | "unsealed-component";

/** Every member of {@link IrR2WithdrawalReason}, for closed-set validation. */
export const IR_R2_WITHDRAWAL_REASONS: readonly IrR2WithdrawalReason[] = Object.freeze([
  "multi-source-driver",
  "ir-first-disabled",
  "late-feature-preparation",
  "fast-signature-unproven",
  "async-declaration",
  "generator-lane",
  "nested-executable-syntax",
  "poison-pill-read",
  "direct-caller-activation-target",
  "function-value-reference",
  "param-signature-unstable",
  "return-signature-unstable",
  "allocated-slot-mismatch",
  "callee-of-unowned-caller",
  "callee-outside-component",
  "construction-callee-outside",
  "storage-terminal-unprepared",
  "outside-caller-uncertified",
  "class-atom",
  "unsealed-component",
] as const);

/**
 * One recorded withdrawal. `detail` carries the deferral's own diagnostic and
 * is admissible ONLY on `unsealed-component`: every other reason is fully
 * named by its literal, and a free-text tail on a ratcheted bucket is exactly
 * the un-pinnable evidence this vocabulary replaces.
 */
export interface IrR2Withdrawal {
  readonly stage: IrR2WithdrawalStage;
  readonly reason: IrR2WithdrawalReason;
  readonly detail?: string;
}

/** An observed row that may carry the R2 withdrawal reason. */
export type IrObservedOutcomeWithR2Withdrawal = IrObservedOutcome & {
  readonly r2Withdrawal?: IrR2Withdrawal;
};

/** The single reader of the attached field. */
export function r2WithdrawalOf(outcome: IrObservedOutcome): IrR2Withdrawal | undefined {
  return (outcome as IrObservedOutcomeWithR2Withdrawal).r2Withdrawal;
}

/** True when the row is the compile-twice shape that must carry a reason. */
function isCompileTwiceFunctionRow(outcome: IrObservedOutcome): boolean {
  return outcome.unitKind === "function" && outcome.directBodyEmissions === 1 && outcome.irBodyEmissions === 1;
}

/**
 * (#3521 R2-T1) Reject malformed withdrawal evidence, in the shape of
 * `nonExecutableOutcomeDefect`. Returns the defect, or `undefined` when the
 * row is well-formed.
 *
 * Fails closed in both directions: a compile-twice function row without a
 * reason is the un-attributed row this telemetry exists to eliminate, and a
 * reason on any other row — a different triple, no triple, a non-function
 * unit, or a row that DID seal a prepared component — is an invented cause.
 */
export function r2WithdrawalDefect(outcome: IrObservedOutcome): string | undefined {
  const withdrawal = r2WithdrawalOf(outcome);
  if (withdrawal === undefined) {
    return isCompileTwiceFunctionRow(outcome)
      ? "compile-twice function row carries no R2 withdrawal reason"
      : undefined;
  }
  if (!isCompileTwiceFunctionRow(outcome)) {
    return `R2 withdrawal reason ${withdrawal.reason} on a row that is not a compile-twice function`;
  }
  if (outcome.preparedComponentId !== undefined) {
    return `R2 withdrawal reason ${withdrawal.reason} beside prepared component ${outcome.preparedComponentId}`;
  }
  if (!IR_R2_WITHDRAWAL_REASONS.includes(withdrawal.reason)) {
    return `unknown R2 withdrawal reason ${withdrawal.reason}`;
  }
  if (withdrawal.detail !== undefined && withdrawal.reason !== "unsealed-component") {
    return `R2 withdrawal reason ${withdrawal.reason} carries a free-text detail`;
  }
  return undefined;
}
