// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5262) R2 body-emission accounting evidence that rode ALONGSIDE a row's
 * root cause instead of replacing it.
 *
 * Before this existed, `reconcileIrOverlayOutcomes` overwrote the outcome with
 * whatever the accounting check returned, so a unit that failed for a real,
 * already-classified reason and then legitimately fell back to the direct route
 * was reported as `body-emission-evidence` — the diagnosis the typed-outcome
 * ledger (#3519) exists to preserve was lost to its own bookkeeping.
 *
 * The precedence is now asymmetric ON PURPOSE, and the asymmetry is what makes
 * this safe: a row that is ALREADY an invariant keeps its root-cause `code` and
 * merely carries the accounting note here, while a row that is `emitted` or
 * `unsupported` is still REPLACED — those arms are the only detector for a unit
 * that took neither body route or both, and demoting them to a note would turn
 * a real red into silence.
 *
 * Deliberately NOT in `src/ir/outcomes.ts`: that file is #3520's and its row
 * type stays byte-identical. This follows the `IrObservedOutcomeWithR2Withdrawal`
 * precedent (#3521 R2-T1) exactly — a widened type plus a single reader, with
 * the field attached by spread so no emitter reads it and no policy consumes it.
 */
import type { IrObservedOutcome, IrPreparationFailure } from "./outcomes.js";

/** An observed row that may carry accounting evidence beside its root cause. */
export type IrObservedOutcomeWithBodyAccountingNote = IrObservedOutcome & {
  readonly bodyAccountingFailure?: IrPreparationFailure;
};

/** The single reader of the attached field. */
export function bodyAccountingFailureOf(outcome: IrObservedOutcome): IrPreparationFailure | undefined {
  return (outcome as IrObservedOutcomeWithBodyAccountingNote).bodyAccountingFailure;
}
