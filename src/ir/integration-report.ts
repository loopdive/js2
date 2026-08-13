// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import {
  classifyIrFailure,
  type IrInvariantCode,
  type IrPreparationFailure,
  type IrPreparationStage,
} from "./outcomes.js";
import type { IrLegacyUnitProjection, IrLegacyUnitProjectionEntry } from "./planning-identity.js";

export interface IrIntegrationReport {
  readonly compiled: readonly string[];
  readonly errors: readonly IrIntegrationError[];
  /** Exact emitted artifacts retained for component-local report routing. */
  readonly compiledArtifactEvidence?: readonly IrIntegrationCompiledArtifactEvidence[];
  /** Exact terminal-owner evidence retained beside the public name lists. */
  readonly terminalEvidence?: readonly IrIntegrationTerminalEvidence[];
  /** Public compiled entries that are exact terminal owners. */
  readonly terminalCompiledOwners?: readonly string[];
  /**
   * Historical compatibility field for every non-terminal compiled artifact.
   * This includes pass-created units and inventoried nested source bodies;
   * exact source/synthetic classification lives in compiledArtifactEvidence.
   */
  readonly syntheticCompiledArtifacts?: readonly string[];
}

export type IrIntegrationTerminalEvidence =
  | {
      readonly kind: "patched";
      readonly unitId: IrUnitId;
      readonly legacyName: string;
      /** R2 component whose ABI was dependency-derived and sealed before lowering. */
      readonly preparedComponentId?: string;
    }
  | {
      readonly kind: "failed";
      readonly unitId: IrUnitId;
      readonly legacyName: string;
      /** Representative failure retained for compatibility and outcome choice. */
      readonly error: IrIntegrationError;
      /** Every public diagnostic object covered by this one logical event. */
      readonly errors?: readonly IrIntegrationError[];
    };

export interface IrIntegrationTerminalFailureEvent {
  /** Exact terminal owner. The legacy label is diagnostic metadata only. */
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly error: IrIntegrationError;
  readonly errors: readonly IrIntegrationError[];
}

export interface IrIntegrationCompiledArtifactEvidence {
  /** Exact emitted artifact identity, including lifted functions and clones. */
  readonly artifactUnitId: IrUnitId;
  /** Exact R0 terminal owner for this emitted artifact. */
  readonly terminalOwnerUnitId: IrUnitId;
  /** Public compiled-artifact label retained for compatibility telemetry. */
  readonly name: string;
  /** R2 component whose ABI was dependency-derived and sealed before lowering. */
  readonly preparedComponentId?: string;
}

export interface IrIntegrationError {
  readonly func: string;
  readonly message: string;
  readonly kind: "verify" | "build" | "lower" | "backend-legality";
  readonly outcome: IrPreparationFailure;
}

interface IrVerifierDetail {
  readonly message: string;
  readonly demote?: boolean;
}

function legacyIntegrationKind(stage: IrPreparationStage): IrIntegrationError["kind"] {
  if (stage === "verify") return "verify";
  if (stage === "backend-legality") return "backend-legality";
  if (stage === "lower" || stage === "patch") return "lower";
  return "build";
}

export function integrationFailure(func: string, outcome: IrPreparationFailure): IrIntegrationError {
  return {
    func,
    message: outcome.detail,
    kind: legacyIntegrationKind(outcome.stage),
    outcome,
  };
}

export function invariantIntegrationFailure(
  func: string,
  code: IrInvariantCode,
  stage: Exclude<IrPreparationStage, "select">,
  detail: string,
): IrIntegrationError {
  return integrationFailure(func, { kind: "invariant", code, stage, detail });
}

/**
 * Preserve the verifier's designed return-shape demotion while treating every
 * other malformed IR artifact as an invariant.
 */
export function verifyIntegrationFailure(
  func: string,
  detail: IrVerifierDetail,
  detailPrefix = "",
): IrIntegrationError {
  const message = `${detailPrefix}${detail.message}`;
  if (detail.demote) {
    return integrationFailure(func, {
      kind: "unsupported",
      code: "return-type-legacy-coupling",
      stage: "verify",
      detail: message,
    });
  }
  return invariantIntegrationFailure(func, "verifier-failure", "verify", message);
}

export function caughtIntegrationFailure(
  func: string,
  error: unknown,
  stage: Exclude<IrPreparationStage, "select">,
): IrIntegrationError {
  return integrationFailure(func, classifyIrFailure(error, stage));
}

/** Public diagnostics plus the logical failures they describe. */
export class IrIntegrationFailureLog {
  readonly errors: IrIntegrationError[] = [];
  readonly terminalFailureEvents: IrIntegrationTerminalFailureEvent[] = [];

  record(owner: IrLegacyUnitProjectionEntry, error: IrIntegrationError): void {
    if (error.func !== owner.legacyName) {
      throw new TypeError(
        `integration failure owner ${owner.unitId} / ${JSON.stringify(owner.legacyName)} ` +
          `does not match diagnostic label ${JSON.stringify(error.func)}`,
      );
    }
    this.errors.push(error);
    this.terminalFailureEvents.push({
      unitId: owner.unitId,
      legacyName: owner.legacyName,
      error,
      errors: [error],
    });
  }

  /** Preserve every verifier detail while emitting one logical failure event. */
  recordVerifierDetails(
    owner: IrLegacyUnitProjectionEntry,
    details: readonly IrVerifierDetail[],
    detailPrefix = "",
  ): void {
    this.recordVerifierGroups(owner, [{ details, detailPrefix }]);
  }

  /** Aggregate verifier details from every artifact in one owner build. */
  recordVerifierGroups(
    owner: IrLegacyUnitProjectionEntry,
    groups: Iterable<{
      readonly details: readonly IrVerifierDetail[];
      readonly detailPrefix: string;
    }>,
  ): boolean {
    const eventErrors: IrIntegrationError[] = [];
    for (const group of groups) {
      for (const detail of group.details) {
        const error = verifyIntegrationFailure(owner.legacyName, detail, group.detailPrefix);
        this.errors.push(error);
        eventErrors.push(error);
      }
    }
    const representativeIndex = eventErrors.findIndex((candidate) => candidate.outcome.kind === "invariant");
    const terminalErrors =
      representativeIndex <= 0
        ? eventErrors
        : [
            eventErrors[representativeIndex]!,
            ...eventErrors.slice(0, representativeIndex),
            ...eventErrors.slice(representativeIndex + 1),
          ];
    const error = terminalErrors[0];
    if (error) {
      this.terminalFailureEvents.push({
        unitId: owner.unitId,
        legacyName: owner.legacyName,
        error,
        errors: terminalErrors,
      });
    }
    return error !== undefined;
  }
}

/**
 * Attach exact terminal evidence without changing the legacy public telemetry.
 *
 * `terminalFailureEvents` carries the producer's logical event boundaries.
 * When it is omitted, each public error is conservatively one event; this pure
 * constructor never guesses that same-owner errors are duplicate details.
 * Patched and failed evidence use independent passes deliberately, so
 * observing both remains two events for the terminal-evidence audit.
 */
export function buildIrIntegrationReport(
  compiled: readonly string[],
  errors: readonly IrIntegrationError[],
  ownerProjection?: IrLegacyUnitProjection,
  compiledOwners?: readonly string[],
  terminalFailureEvents: readonly (IrIntegrationTerminalFailureEvent | IrIntegrationError)[] = errors,
  compiledArtifactEvidence?: readonly IrIntegrationCompiledArtifactEvidence[],
): IrIntegrationReport {
  if (!ownerProjection) return { compiled, errors };
  if (!compiledArtifactEvidence) {
    throw new TypeError("exact compiled-artifact evidence is required when an owner projection is supplied");
  }
  if (compiledArtifactEvidence.length !== compiled.length) {
    throw new RangeError(
      `compiled-artifact evidence count ${compiledArtifactEvidence.length} does not match public compiled count ${compiled.length}`,
    );
  }

  const terminalEvidence: IrIntegrationTerminalEvidence[] = [];
  const structuralCompiledOwners: string[] = [];
  const structuralSyntheticArtifacts: string[] = [];
  const observedArtifactUnitIds = new Set<IrUnitId>();
  for (let index = 0; index < compiledArtifactEvidence.length; index++) {
    const artifact = compiledArtifactEvidence[index]!;
    const publicName = compiled[index]!;
    if (artifact.name !== publicName) {
      throw new TypeError(
        `compiled artifact ${artifact.artifactUnitId} label ${JSON.stringify(artifact.name)} ` +
          `does not match public label ${JSON.stringify(publicName)}`,
      );
    }
    if (observedArtifactUnitIds.has(artifact.artifactUnitId)) {
      throw new TypeError(`compiled artifact ${artifact.artifactUnitId} was reported more than once`);
    }
    observedArtifactUnitIds.add(artifact.artifactUnitId);
    const owner = ownerProjection.requireUnit(artifact.terminalOwnerUnitId);
    const projectedArtifact = ownerProjection.getByUnitId(artifact.artifactUnitId);
    if (projectedArtifact && projectedArtifact.unitId !== owner.unitId) {
      throw new TypeError(
        `compiled terminal artifact ${artifact.artifactUnitId} is assigned to foreign owner ${owner.unitId}`,
      );
    }
    if (artifact.artifactUnitId === artifact.terminalOwnerUnitId) {
      structuralCompiledOwners.push(owner.legacyName);
      terminalEvidence.push({
        kind: "patched",
        unitId: owner.unitId,
        legacyName: owner.legacyName,
        ...(artifact.preparedComponentId === undefined ? {} : { preparedComponentId: artifact.preparedComponentId }),
      });
    } else {
      structuralSyntheticArtifacts.push(artifact.name);
    }
  }
  if (
    compiledOwners &&
    (compiledOwners.length !== structuralCompiledOwners.length ||
      compiledOwners.some((legacyName, index) => legacyName !== structuralCompiledOwners[index]))
  ) {
    throw new TypeError("public compiled-owner labels do not match exact compiled-artifact evidence");
  }

  for (const failureEvent of terminalFailureEvents) {
    const event =
      "errors" in failureEvent
        ? failureEvent
        : {
            ...ownerProjection.requireLegacyName(failureEvent.func),
            error: failureEvent,
            errors: [failureEvent],
          };
    const owner = ownerProjection.requirePair({
      unitId: event.unitId,
      legacyName: event.legacyName,
    });
    ownerProjection.requirePair({ unitId: event.unitId, legacyName: event.error.func });
    for (const error of event.errors) {
      ownerProjection.requirePair({ unitId: event.unitId, legacyName: error.func });
    }
    terminalEvidence.push({
      kind: "failed",
      unitId: owner.unitId,
      legacyName: owner.legacyName,
      error: event.error,
      errors: event.errors,
    });
  }
  return {
    compiled,
    errors,
    compiledArtifactEvidence,
    terminalEvidence,
    terminalCompiledOwners: structuralCompiledOwners,
    syntheticCompiledArtifacts: structuralSyntheticArtifacts,
  };
}
