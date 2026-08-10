// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../ts-api.js";
import type { IrUnitId } from "../ir/identity.js";
import type {
  IrIntegrationCompiledArtifactEvidence,
  IrIntegrationError,
  IrIntegrationReport,
  IrIntegrationTerminalEvidence,
} from "../ir/integration.js";
import type { IrObservedOutcome, IrPreparationFailure } from "../ir/outcomes.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSelection } from "../ir/select.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";
import { buildIrIntegrationOwnerProjection, collectIrPreparedSelectionUnitIds } from "./ir-overlay-identity.js";

interface ObservedIrUnit {
  readonly key: string;
  readonly sourceId: IrObservedOutcome["sourceId"] & string;
  readonly unitId: IrUnitId;
  readonly matchName: string;
  readonly unitKind: IrObservedOutcome["unitKind"];
  readonly displayName: string;
  readonly ordinal: number;
  readonly line: number;
  readonly column: number;
  readonly staticClassMember: boolean;
  readonly legacyBodyAvailable: boolean;
  readonly directFailure?: IrPreparationFailure;
}

export interface IrIntegrationEvidenceAudit {
  readonly evidenceByUnitId: ReadonlyMap<IrUnitId, IrIntegrationTerminalEvidence>;
  readonly invariantByUnitId: ReadonlyMap<IrUnitId, IrPreparationFailure>;
  readonly sourceInvariant?: IrPreparationFailure;
}

export interface ReconcileIrOverlayOutcomesInput {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly initialSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly preparationFailuresByUnitId: ReadonlyMap<IrUnitId, IrPreparationFailure>;
  readonly skippedBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly report: IrIntegrationReport;
  readonly existingOutcomes: readonly IrObservedOutcome[];
  readonly target: IrObservedOutcome["target"];
}

export interface ReconciledIrOverlayOutcomes {
  readonly outcomes: readonly IrObservedOutcome[];
  readonly diagnostics: readonly string[];
}

export interface IrSkippedBodySlotViolation {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly failure: IrPreparationFailure;
}

export type IrSkippedFunctionSlotViolation = IrSkippedBodySlotViolation;

function invariant(
  code: "duplicate-unit-outcome" | "selection-preparation-mismatch",
  detail: string,
): IrPreparationFailure {
  return { kind: "invariant", code, stage: code === "duplicate-unit-outcome" ? "patch" : "resolve", detail };
}

function collectObservedIrUnits(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
): ObservedIrUnit[] {
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (!sourceId || identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    throw new Error(`IR outcome source ${sourceFile.fileName} is outside the authoritative planning context`);
  }
  return identityContext.inventory.terminalUnits
    .filter((unit) => unit.sourceId === sourceId)
    .map((unit) => ({
      key: unit.legacyKey,
      sourceId: unit.sourceId,
      unitId: unit.id,
      matchName: unit.legacyMatchName,
      unitKind: unit.observedKind,
      displayName: unit.displayName,
      ordinal: unit.legacyOrdinal,
      line: unit.line,
      column: unit.column,
      staticClassMember: unit.staticClassMember,
      legacyBodyAvailable: unit.legacyBodyAvailable,
      ...(unit.directFailure ? { directFailure: unit.directFailure } : {}),
    }));
}

/** Audit the complete integration sidecar before outcome precedence can hide corruption. */
export function auditIrIntegrationTerminalEvidence(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityContext: IrPlanningIdentityContext;
  readonly activeOwners: IrLegacyUnitProjection;
  readonly evidence: readonly IrIntegrationTerminalEvidence[];
  readonly compiled?: readonly string[];
  readonly compiledArtifactEvidence?: readonly IrIntegrationCompiledArtifactEvidence[];
  readonly errors?: readonly IrIntegrationError[];
  readonly terminalCompiledOwners?: readonly string[];
  readonly syntheticCompiledArtifacts?: readonly string[];
}): IrIntegrationEvidenceAudit {
  const localUnits = new Map(
    collectObservedIrUnits(input.sourceFile, input.identityContext).map((unit) => [unit.unitId, unit]),
  );
  const evidenceBuckets = new Map<IrUnitId, IrIntegrationTerminalEvidence[]>();
  const invariantByUnitId = new Map<IrUnitId, IrPreparationFailure>();
  let sourceInvariant: IrPreparationFailure | undefined;

  const recordMismatch = (unitId: IrUnitId | undefined, detail: string): void => {
    const failure = invariant("selection-preparation-mismatch", detail);
    if (unitId === undefined) sourceInvariant ??= failure;
    else invariantByUnitId.set(unitId, failure);
  };
  const countOccurrences = <T>(values: readonly T[]): Map<T, number> => {
    const counts = new Map<T, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  };
  const publicErrors =
    input.errors ?? input.evidence.flatMap((event) => (event.kind === "failed" ? (event.errors ?? [event.error]) : []));
  const publicErrorCounts = countOccurrences(publicErrors);
  const coveredErrorCounts = new Map<IrIntegrationError, number>();
  const publicCompiled =
    input.compiled ?? input.evidence.flatMap((event) => (event.kind === "patched" ? [event.legacyName] : []));
  const hasCompiledClassification =
    input.terminalCompiledOwners !== undefined || input.syntheticCompiledArtifacts !== undefined;
  const terminalCompiledOwners = input.terminalCompiledOwners ?? [];
  const syntheticCompiledArtifacts = input.syntheticCompiledArtifacts ?? [];
  if (hasCompiledClassification) {
    const publicCounts = countOccurrences(publicCompiled);
    // Terminal-owner sidecars intentionally retain the collision-safe legacy
    // diagnostic label, while the public artifact name is the exact observed
    // Program ABI callable (and can differ for nested/anonymous classes). The
    // exact artifact evidence is therefore the classification authority when
    // present; never infer a physical callable from the owner label.
    const classifiedPublicNames = input.compiledArtifactEvidence?.map((artifact) => artifact.name) ?? [
      ...terminalCompiledOwners,
      ...syntheticCompiledArtifacts,
    ];
    const classifiedCounts = countOccurrences(classifiedPublicNames);
    if (
      publicCounts.size !== classifiedCounts.size ||
      [...publicCounts].some(([name, count]) => classifiedCounts.get(name) !== count)
    ) {
      recordMismatch(undefined, "integration compiled telemetry is not completely classified by its sidecar");
    }
    if (input.compiledArtifactEvidence) {
      for (let index = 0; index < input.compiledArtifactEvidence.length; index++) {
        const artifact = input.compiledArtifactEvidence[index]!;
        if (artifact.name !== publicCompiled[index]) {
          recordMismatch(
            artifact.terminalOwnerUnitId,
            `compiled artifact ${artifact.artifactUnitId} does not match public callable ${JSON.stringify(publicCompiled[index])}`,
          );
        }
        if (!input.activeOwners.getByUnitId(artifact.terminalOwnerUnitId)) {
          recordMismatch(
            artifact.terminalOwnerUnitId,
            `compiled artifact ${artifact.artifactUnitId} has inactive terminal owner ${artifact.terminalOwnerUnitId}`,
          );
        }
      }
    }
    for (const legacyName of terminalCompiledOwners) {
      const owner = input.activeOwners.getByLegacyName(legacyName);
      if (!owner) recordMismatch(undefined, `terminal compiled owner ${JSON.stringify(legacyName)} is not active`);
    }
  }
  const patchedOwnerCounts = new Map<string, number>();

  for (const evidence of input.evidence) {
    const localUnit = localUnits.get(evidence.unitId);
    const projectedById = input.activeOwners.getByUnitId(evidence.unitId);
    const projectedByName = input.activeOwners.getByLegacyName(evidence.legacyName);
    if (evidence.kind === "patched") {
      patchedOwnerCounts.set(evidence.legacyName, (patchedOwnerCounts.get(evidence.legacyName) ?? 0) + 1);
    } else {
      const eventErrors = evidence.errors ?? [evidence.error];
      const mismatchOwnerId = localUnit?.unitId ?? projectedByName?.unitId;
      if (eventErrors[0] !== evidence.error) {
        recordMismatch(
          mismatchOwnerId,
          `failed integration event ${evidence.unitId} does not retain its representative public error first`,
        );
      }
      for (const error of eventErrors) {
        if (error.func !== evidence.legacyName) {
          recordMismatch(
            mismatchOwnerId,
            `failed integration event ${evidence.unitId} / ${JSON.stringify(evidence.legacyName)} covers error owner ${JSON.stringify(error.func)}`,
          );
        }
        const covered = (coveredErrorCounts.get(error) ?? 0) + 1;
        coveredErrorCounts.set(error, covered);
        if (covered > (publicErrorCounts.get(error) ?? 0)) {
          recordMismatch(
            mismatchOwnerId,
            `failed integration event ${evidence.unitId} covers a foreign or duplicate public error object`,
          );
        }
      }
    }
    if (!localUnit) {
      if (projectedByName) {
        invariantByUnitId.set(
          projectedByName.unitId,
          invariant(
            "selection-preparation-mismatch",
            `integration evidence for ${evidence.unitId} reused active label ${JSON.stringify(evidence.legacyName)}`,
          ),
        );
      } else {
        sourceInvariant ??= invariant(
          "selection-preparation-mismatch",
          `integration evidence ${evidence.unitId} / ${JSON.stringify(evidence.legacyName)} belongs to another source`,
        );
      }
      continue;
    }
    if (!projectedById || projectedById !== projectedByName) {
      invariantByUnitId.set(
        localUnit.unitId,
        invariant(
          "selection-preparation-mismatch",
          `integration evidence ${evidence.unitId} / ${JSON.stringify(evidence.legacyName)} is outside the active owner projection`,
        ),
      );
      continue;
    }
    const bucket = evidenceBuckets.get(evidence.unitId) ?? [];
    bucket.push(evidence);
    evidenceBuckets.set(evidence.unitId, bucket);
  }

  for (const [error, count] of publicErrorCounts) {
    if ((coveredErrorCounts.get(error) ?? 0) === count) continue;
    recordMismatch(
      input.activeOwners.getByLegacyName(error.func)?.unitId,
      `public integration error for ${JSON.stringify(error.func)} is not covered exactly once by terminal evidence`,
    );
  }
  if (hasCompiledClassification) {
    const terminalCompiledCounts = countOccurrences(terminalCompiledOwners);
    const compiledOwnerNames = new Set([...terminalCompiledCounts.keys(), ...patchedOwnerCounts.keys()]);
    for (const legacyName of compiledOwnerNames) {
      if ((terminalCompiledCounts.get(legacyName) ?? 0) === (patchedOwnerCounts.get(legacyName) ?? 0)) continue;
      recordMismatch(
        input.activeOwners.getByLegacyName(legacyName)?.unitId,
        `compiled terminal owner ${JSON.stringify(legacyName)} is not covered exactly once by patched evidence`,
      );
    }
  }

  const evidenceByUnitId = new Map<IrUnitId, IrIntegrationTerminalEvidence>();
  for (const [unitId, events] of evidenceBuckets) {
    if (events.length !== 1) {
      invariantByUnitId.set(
        unitId,
        invariant("duplicate-unit-outcome", `IR unit ${unitId} received ${events.length} integration events`),
      );
      continue;
    }
    evidenceByUnitId.set(unitId, events[0]!);
  }
  return {
    evidenceByUnitId,
    invariantByUnitId,
    ...(sourceInvariant ? { sourceInvariant } : {}),
  };
}

function auditIrSkippedBodySlots(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly skippedBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly expectedKind: "function" | "class-member" | "module-init";
  readonly label: "function" | "class member" | "module initializer";
  readonly report: IrIntegrationReport;
}): readonly IrSkippedBodySlotViolation[] {
  if (input.skippedBodyUnitIds.size === 0) return [];

  const localUnits = new Map(
    collectObservedIrUnits(input.sourceFile, input.identityPlan.identityContext).map((unit) => [unit.unitId, unit]),
  );
  const activeOwners = buildIrIntegrationOwnerProjection(input.identityPlan, input.preparedSelection);
  const audit = auditIrIntegrationTerminalEvidence({
    sourceFile: input.sourceFile,
    identityContext: input.identityPlan.identityContext,
    activeOwners,
    evidence: input.report.terminalEvidence ?? [],
    compiled: input.report.compiled,
    compiledArtifactEvidence: input.report.compiledArtifactEvidence,
    errors: input.report.errors,
    terminalCompiledOwners: input.report.terminalCompiledOwners,
    syntheticCompiledArtifacts: input.report.syntheticCompiledArtifacts,
  });
  const violations: IrSkippedBodySlotViolation[] = [];

  for (const unitId of input.skippedBodyUnitIds) {
    const unit = localUnits.get(unitId);
    const projected = activeOwners.getByUnitId(unitId);
    const legacyName = projected?.legacyName ?? unit?.matchName ?? String(unitId);
    if (!unit || unit.unitKind !== input.expectedKind || !projected) {
      violations.push({
        unitId,
        legacyName,
        failure: invariant(
          "selection-preparation-mismatch",
          `skipped IR ${input.label} ${unitId} / ${JSON.stringify(legacyName)} is outside the exact active source population`,
        ),
      });
      continue;
    }

    const auditFailure = audit.invariantByUnitId.get(unitId) ?? audit.sourceInvariant;
    if (auditFailure) {
      violations.push({ unitId, legacyName, failure: auditFailure });
      continue;
    }

    const evidence = audit.evidenceByUnitId.get(unitId);
    if (evidence?.kind === "patched") continue;
    if (evidence?.kind === "failed" && evidence.error.outcome.kind === "invariant") {
      violations.push({ unitId, legacyName, failure: evidence.error.outcome });
      continue;
    }
    violations.push({
      unitId,
      legacyName,
      failure: {
        kind: "invariant",
        code: "unpatched-slot",
        stage: "patch",
        detail:
          evidence?.kind === "failed"
            ? `${legacyName} failed after its legacy body was skipped: ${evidence.error.message}`
            : `${legacyName} has no exact terminal integration evidence after its legacy body was skipped`,
      },
    });
  }

  return violations;
}

/**
 * Prove that every exact function whose legacy body was skipped reached one
 * terminal integration result. This safety check is deliberately independent
 * of optional outcome telemetry and never treats raw name arrays as evidence.
 */
export function auditIrSkippedFunctionSlots(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly skippedFunctionUnitIds: ReadonlySet<IrUnitId>;
  readonly report: IrIntegrationReport;
}): readonly IrSkippedBodySlotViolation[] {
  return auditIrSkippedBodySlots({
    ...input,
    skippedBodyUnitIds: input.skippedFunctionUnitIds,
    expectedKind: "function",
    label: "function",
  });
}

/** Prove every skipped static class slot reached one exact terminal result. */
export function auditIrSkippedClassMemberSlots(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
  readonly skippedClassMemberUnitIds: ReadonlySet<IrUnitId>;
  readonly report: IrIntegrationReport;
}): readonly IrSkippedBodySlotViolation[] {
  return auditIrSkippedBodySlots({
    ...input,
    skippedBodyUnitIds: input.skippedClassMemberUnitIds,
    expectedKind: "class-member",
    label: "class member",
  });
}

/** Prove the skipped source initializer reached one exact terminal result. */
export function auditIrSkippedModuleInitSlot(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "moduleInit">;
  readonly skippedModuleInitUnitIds: ReadonlySet<IrUnitId>;
  readonly report: IrIntegrationReport;
}): readonly IrSkippedBodySlotViolation[] {
  return auditIrSkippedBodySlots({
    ...input,
    skippedBodyUnitIds: input.skippedModuleInitUnitIds,
    expectedKind: "module-init",
    label: "module initializer",
  });
}

function observedFailure(
  base: Omit<IrObservedOutcome, "kind" | "code" | "stage" | "detail" | "cause">,
  failure: IrPreparationFailure,
): IrObservedOutcome {
  return {
    ...base,
    kind: failure.kind,
    code: failure.code,
    stage: failure.stage,
    detail: failure.detail,
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  } as IrObservedOutcome;
}

export function buildWholeSourceFailureOutcomes(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityContext: IrPlanningIdentityContext;
  readonly failure: IrPreparationFailure;
  readonly target: IrObservedOutcome["target"];
}): readonly IrObservedOutcome[] {
  return collectObservedIrUnits(input.sourceFile, input.identityContext).map((unit) =>
    observedFailure(
      {
        key: unit.key,
        sourceId: unit.sourceId,
        unitId: unit.unitId,
        file: input.sourceFile.fileName,
        unitKind: unit.unitKind,
        displayName: unit.displayName,
        ordinal: unit.ordinal,
        line: unit.line,
        column: unit.column,
        backend: "wasmgc",
        target: input.target,
        legacyBodyEmitted: false,
        irBodyEmitted: false,
      },
      input.failure,
    ),
  );
}

function selectionFailure(
  input: ReconcileIrOverlayOutcomesInput,
  unit: ObservedIrUnit,
): IrPreparationFailure | undefined {
  const structural = input.identityPlan.identitySelection;
  if (unit.unitKind === "module-init") {
    const moduleInit = structural.moduleInit;
    if (moduleInit?.unitId === unit.unitId && moduleInit.reason) {
      return {
        kind: "unsupported",
        code: moduleInit.reason,
        stage: "select",
        detail: moduleInit.detail ?? `${unit.matchName} rejected by IR selection (${moduleInit.reason})`,
      };
    }
    return undefined;
  }
  const fallback = structural.fallbacks?.get(unit.unitId);
  if (fallback) {
    return {
      kind: "unsupported",
      code: fallback.reason,
      stage: "select",
      detail: fallback.detail ?? `${unit.matchName} rejected by IR selection (${fallback.reason})`,
    };
  }
  if (input.identityPlan.selectionProjection.omittedUnitIds.has(unit.unitId)) {
    const code = unit.unitKind === "class-member" ? "class-member-unsupported" : "call-resolution-unsupported";
    return {
      kind: "unsupported",
      code,
      stage: "select",
      detail: `${unit.matchName} has no unambiguous legacy compatibility projection`,
    };
  }
  return undefined;
}

/** Reconcile structural planning, preparation, and terminal patch evidence in inventory order. */
export function reconcileIrOverlayOutcomes(input: ReconcileIrOverlayOutcomesInput): ReconciledIrOverlayOutcomes {
  const initialUnitIds = collectIrPreparedSelectionUnitIds(input.identityPlan, input.initialSelection);
  const preparedUnitIds = collectIrPreparedSelectionUnitIds(input.identityPlan, input.preparedSelection);
  const activeOwners = buildIrIntegrationOwnerProjection(input.identityPlan, input.preparedSelection);
  const audit = auditIrIntegrationTerminalEvidence({
    sourceFile: input.sourceFile,
    identityContext: input.identityPlan.identityContext,
    activeOwners,
    evidence: input.report.terminalEvidence ?? [],
    compiled: input.report.compiled,
    compiledArtifactEvidence: input.report.compiledArtifactEvidence,
    errors: input.report.errors,
    terminalCompiledOwners: input.report.terminalCompiledOwners,
    syntheticCompiledArtifacts: input.report.syntheticCompiledArtifacts,
  });
  const existingUnitIds = new Set(
    input.existingOutcomes.flatMap((outcome) => (outcome.unitId ? [outcome.unitId] : [])),
  );
  const existingKeys = new Set(input.existingOutcomes.map((outcome) => outcome.key));
  const outcomes: IrObservedOutcome[] = [];
  const diagnostics: string[] = [];

  for (const unit of collectObservedIrUnits(input.sourceFile, input.identityPlan.identityContext)) {
    const legacyBodyEmitted = unit.legacyBodyAvailable && !input.skippedBodyUnitIds.has(unit.unitId);
    const base = {
      key: unit.key,
      sourceId: unit.sourceId,
      unitId: unit.unitId,
      file: input.sourceFile.fileName,
      unitKind: unit.unitKind,
      displayName: unit.displayName,
      ordinal: unit.ordinal,
      line: unit.line,
      column: unit.column,
      backend: "wasmgc" as const,
      target: input.target,
      legacyBodyEmitted,
      irBodyEmitted: false,
    };
    const evidence = audit.evidenceByUnitId.get(unit.unitId);
    const auditFailure = audit.invariantByUnitId.get(unit.unitId) ?? audit.sourceInvariant;
    let outcome: IrObservedOutcome;
    if (existingUnitIds.has(unit.unitId) || existingKeys.has(unit.key)) {
      outcome = observedFailure(base, invariant("duplicate-unit-outcome", `duplicate terminal outcome ${unit.unitId}`));
    } else if (auditFailure) {
      outcome = observedFailure(base, auditFailure);
    } else if (unit.directFailure) {
      outcome = observedFailure(base, unit.directFailure);
    } else if (!initialUnitIds.has(unit.unitId)) {
      outcome = observedFailure(
        base,
        selectionFailure(input, unit) ??
          invariant(
            "selection-preparation-mismatch",
            `${unit.unitId} / ${unit.matchName} was not selected and has no typed rejection`,
          ),
      );
    } else if (input.preparationFailuresByUnitId.has(unit.unitId)) {
      outcome = observedFailure(base, input.preparationFailuresByUnitId.get(unit.unitId)!);
    } else if (!preparedUnitIds.has(unit.unitId)) {
      outcome = observedFailure(base, {
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        detail: `${unit.matchName} failed final-context IR preparation`,
      });
    } else if (evidence?.kind === "failed") {
      outcome =
        legacyBodyEmitted || evidence.error.outcome.kind === "invariant"
          ? observedFailure(base, evidence.error.outcome)
          : observedFailure(base, {
              kind: "invariant",
              code: "unpatched-slot",
              stage: "patch",
              detail: `${unit.matchName} was unsupported after its legacy slot was skipped: ${evidence.error.message}`,
            });
    } else if (evidence?.kind === "patched") {
      outcome = {
        ...base,
        kind: "emitted",
        stage: "patch",
        irBodyEmitted: true,
        ...(evidence.preparedComponentId === undefined ? {} : { preparedComponentId: evidence.preparedComponentId }),
      };
    } else {
      outcome = observedFailure(base, {
        kind: "invariant",
        code: legacyBodyEmitted ? "missing-terminal-outcome" : "unpatched-slot",
        stage: "patch",
        detail: `${unit.matchName} was prepared but integration neither patched it nor reported a failure`,
      });
    }

    outcomes.push(outcome);
    if (outcome.kind === "invariant" && evidence?.kind !== "failed") {
      diagnostics.push(`IR outcome invariant [${outcome.code}] for ${unit.matchName}: ${outcome.detail}`);
    }
  }
  return { outcomes, diagnostics };
}
