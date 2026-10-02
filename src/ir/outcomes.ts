// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Typed terminal outcomes for the AST -> IR preparation boundary.
 *
 * Diagnostic text is deliberately not policy-bearing. Callers decide whether
 * a unit may retain its legacy body from the discriminant and stable code; the
 * detail remains available only to make failures actionable.
 */

import type { IrSourceId, IrUnitId } from "./identity.js";
import type { IrModuleBindingRefusal } from "./module-bindings.js";
import type { IrPreparationStage, IrPreparationFailure } from "../shared/contracts/ir-preparation-failure.js";
export type {
  IrPreparationStage,
  IrUnsupportedCode,
  IrInvariantCode,
  IrPreparationFailure,
} from "../shared/contracts/ir-preparation-failure.js";

export {
  IrUnsupportedError,
  IrInvariantError,
  demoteToLegacy,
  classifyIrFailure,
} from "../shared/contracts/ir-preparation-errors.js";

/** Fatal marker for a prepared ABI commit that threw after publication began. */
export class PreparedProgramAbiCommitError extends Error {
  constructor(
    readonly scopeId: string,
    cause: unknown,
  ) {
    super(`prepared ABI scope ${scopeId} failed after atomic commit began`, { cause });
    this.name = "PreparedProgramAbiCommitError";
  }
}

export type IrObservedUnitKind = "function" | "class-member" | "module-init";
export type IrObservedBackend = "wasmgc" | "linear";
export type IrObservedTarget = "gc" | "linear" | "standalone" | "wasi";

interface IrObservedOutcomeBase {
  /** Observational label only. R1 replaces this with source-qualified identity. */
  readonly key: string;
  /** R1 structural source identity. Compiler-produced rows always populate it. */
  readonly sourceId?: IrSourceId;
  /** R1 structural terminal-unit identity. Compiler-produced rows always populate it. */
  readonly unitId?: IrUnitId;
  readonly file: string;
  readonly unitKind: IrObservedUnitKind;
  readonly displayName: string;
  readonly ordinal: number;
  readonly line: number;
  readonly column: number;
  readonly backend: IrObservedBackend;
  readonly target: IrObservedTarget;
  /**
   * R2 production body-emission evidence for a terminal whose direct and IR
   * dispatchers both have exact receipts. These remain optional while class
   * and module-init owners retain their separately scoped body dispatchers.
   * When present, the compatibility booleans below are derived from and
   * validated against these counters.
   */
  readonly prepareAttempts?: number;
  readonly directBodyEmissions?: number;
  readonly irBodyEmissions?: number;
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
  /** R2 component whose ABI was dependency-derived and sealed before lowering. */
  readonly preparedComponentId?: string;
  /**
   * (#5285) On a `<module-init>` row: EVERY top-level declaration whose storage
   * the module-binding resolver refuses, in source order — the per-file category
   * multiset, which no fail-fast path can report. Populated only under
   * `JS2WASM_IR_SHAPE_DIAG=1`; `undefined` on every production compile, so the
   * ledger and the gates are byte-unchanged with the flag off.
   */
  readonly moduleBindingRefusals?: readonly IrModuleBindingRefusal[];
}

export type IrObservedOutcome =
  | (IrObservedOutcomeBase & {
      readonly kind: "emitted";
      readonly stage: "patch";
    })
  /**
   * (#3523 R4 gap 4) A source whose module-init plan is `executable: false`
   * has nothing to compile — no live seeds, no evaluations. Before this arm
   * the ledger recorded NO row for such a source, so AC 7 ("counters reconcile
   * for executable and empty modules") could not be met and every census
   * denominator under-counted by omission.
   *
   * This is an OBSERVATIONAL row, not an ownership claim. It fabricates no
   * prepared evidence and no terminal identity: the identity inventory mints
   * no module-init unit for an empty population (measured 2026-08-31), so the
   * row carries `sourceId` and deliberately NO `unitId`. `nonExecutableOutcomeDefect`
   * enforces every one of these restrictions as a validator rather than a comment.
   */
  | (IrObservedOutcomeBase & {
      readonly kind: "non-executable";
      readonly stage: "select";
    })
  | (IrObservedOutcomeBase & IrPreparationFailure);

/**
 * (#3523 R4 gap 4) Reject a `non-executable` row that is not restricted by
 * construction. Returns the defect, or `undefined` when the row is well-formed.
 *
 * A malformed row is a blocker under BOTH policies: the arm exists to state
 * "nothing to do" truthfully, so a row carrying body evidence, emission
 * counters, a borrowed terminal identity, or a non-module-init unit kind is
 * lying in exactly the way the arm was added to prevent.
 */
export function nonExecutableOutcomeDefect(outcome: IrObservedOutcome): string | undefined {
  if (outcome.kind !== "non-executable") return undefined;
  // The arm's literal `stage` narrows to `never` under a static comparison, but
  // rows also arrive from the ledger and from tests that construct them by
  // assertion. Read the discriminant through the widened base so the check is a
  // real runtime validation rather than a type-level tautology.
  const observed: { readonly stage: IrPreparationStage } = outcome;
  if (observed.stage !== "select") return `stage ${observed.stage} is not select`;
  if (outcome.unitKind !== "module-init") return `unit kind ${outcome.unitKind} is not module-init`;
  if (outcome.unitId !== undefined) return `carries terminal unit identity ${outcome.unitId}`;
  if (outcome.legacyBodyEmitted || outcome.irBodyEmitted) return "claims body emission evidence";
  if (
    outcome.prepareAttempts !== undefined ||
    outcome.directBodyEmissions !== undefined ||
    outcome.irBodyEmissions !== undefined
  ) {
    return "carries body-emission counters";
  }
  if (outcome.preparedComponentId !== undefined) return "claims a prepared component";
  return undefined;
}

export type IrOutcomePolicy = "hybrid" | "ir-only";

export interface IrOutcomePolicyVerdict {
  readonly policy: IrOutcomePolicy;
  readonly ready: boolean;
  readonly blockers: readonly IrObservedOutcome[];
}

/**
 * Reject partial, impossible, or boolean-inconsistent exact body accounting.
 *
 * (#5299) Exported so a producer can reject a malformed triple at the point it
 * builds the row, instead of publishing it and letting the policy pass report
 * it as a blocker one whole compile later. An absent triple is deliberately
 * still well-formed here: a row whose emitter cannot measure the counters
 * states nothing rather than guessing, and the R9 denominator work tracks that
 * omission separately.
 */
export function hasMalformedBodyEmissionAccounting(outcome: IrObservedOutcome): boolean {
  const values = [outcome.prepareAttempts, outcome.directBodyEmissions, outcome.irBodyEmissions];
  if (values.every((value) => value === undefined)) return false;
  if (values.some((value) => value === undefined)) return true;
  const [prepareAttempts, directBodyEmissions, irBodyEmissions] = values as [number, number, number];
  if (
    prepareAttempts !== 1 ||
    !Number.isSafeInteger(directBodyEmissions) ||
    !Number.isSafeInteger(irBodyEmissions) ||
    directBodyEmissions < 0 ||
    irBodyEmissions < 0 ||
    directBodyEmissions > 1 ||
    irBodyEmissions > 1
  ) {
    return true;
  }
  return outcome.legacyBodyEmitted !== (directBodyEmissions === 1) || outcome.irBodyEmitted !== (irBodyEmissions === 1);
}

/** Evaluate policy over the exact observed ledger; never re-run selection. */
export function evaluateIrOutcomePolicy(
  outcomes: readonly IrObservedOutcome[],
  policy: IrOutcomePolicy,
): IrOutcomePolicyVerdict {
  const blockers = outcomes.filter((outcome) => {
    if (hasMalformedBodyEmissionAccounting(outcome)) return true;
    if (outcome.kind === "invariant") return true;
    // The discriminant and body evidence are one contract. Hybrid may retain
    // a typed Unsupported unit only when its direct body actually exists; an
    // unsupported skipped slot has no executable implementation to fall back
    // to. Likewise, an emitted row without an IR body (or a non-emitted row
    // claiming one) is malformed evidence and must fail both policies.
    if (outcome.kind === "emitted" && !outcome.irBodyEmitted) return true;
    if (outcome.kind !== "emitted" && outcome.irBodyEmitted) return true;
    if (outcome.kind === "unsupported" && !outcome.legacyBodyEmitted) return true;
    // (#3523 R4 gap 4) A non-executable module-init is policy-NEUTRAL, but only
    // when it is well-formed. A malformed one is malformed evidence and blocks
    // under both policies, like every other lying row above. This arm is stated
    // explicitly BEFORE the ir-only fallthrough below, which would otherwise
    // reject the row for the one property that is true of it by construction —
    // having no IR body, because there was no body to emit.
    if (outcome.kind === "non-executable") return nonExecutableOutcomeDefect(outcome) !== undefined;
    if (policy === "hybrid") return false;
    return outcome.kind === "unsupported" || outcome.legacyBodyEmitted || !outcome.irBodyEmitted;
  });
  return { policy, ready: blockers.length === 0, blockers };
}
