// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type {
  IrIntegrationCompiledArtifactEvidence,
  IrIntegrationError,
  IrIntegrationReport,
  IrIntegrationTerminalEvidence,
} from "../ir/integration.js";
import { collectModuleInitPopulation, MODULE_INIT_UNIT_NAME } from "../ir/module-init.js";
import type { IrObservedOutcome, IrPreparationFailure } from "../ir/outcomes.js";
import { nonExecutableOutcomeDefect } from "../ir/outcomes.js";
import type { IrObservedOutcomeWithBodyAccountingNote } from "../ir/body-accounting-note.js";
import type { IrR2Withdrawal } from "../ir/r2-withdrawal.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSelection } from "../ir/select.js";
import type { IrDirectFunctionBodyReceiptAudit } from "./legacy-body-audit.js";
import { hasDeclareModifier, hasExportModifier } from "./ast-modifiers.js";
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
  /**
   * Exact direct-AST body receipts for the public production route. Omitted
   * only for internal callers that did not opt into the physical route audit.
   */
  readonly directFunctionBodyReceiptAudit?: IrDirectFunctionBodyReceiptAudit;
  /**
   * (#3521 R2-T1) Per-unit reason the R2 selector withdrew a terminal. Attached
   * only to compile-twice function rows; absent on every lane that does not
   * track outcomes.
   */
  readonly r2WithdrawalsByUnitId?: ReadonlyMap<IrUnitId, IrR2Withdrawal>;
  /**
   * (#3521 R2-T1) Source-level fallback for the routes the selector never ran
   * on at all, used only where no per-unit record exists.
   */
  readonly r2NotAttemptedReason?: "multi-source-driver" | "ir-first-disabled";
  /**
   * (#5263) Terminals whose ledger row is minted by the prepared-callable
   * publication path, not here. Reconcile must produce NEITHER a row nor a
   * diagnostic for them: it cannot see the cross-source preparation, so every
   * conclusion it reaches about them is stale by construction.
   */
  readonly ownedElsewhereUnitIds?: ReadonlySet<IrUnitId>;
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
  code: "body-emission-evidence" | "duplicate-unit-outcome" | "selection-preparation-mismatch",
  detail: string,
): IrPreparationFailure {
  return {
    kind: "invariant",
    code,
    stage: code === "selection-preparation-mismatch" ? "resolve" : "patch",
    detail,
  };
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

interface IrFunctionBodyEmissionAccounting {
  readonly prepareAttempts: 1;
  readonly directBodyEmissions: number;
  readonly irBodyEmissions: number;
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
  /** (#5308) See `IrBodyAccountingPopulation`. */
  readonly unsupportedRequiresDirectBody: boolean;
  readonly receiptFailure?: IrPreparationFailure;
}

/**
 * (#5308) One physically-emitted body population and its exact direct receipts.
 *
 * R2 (top-level free functions), R3 (class members) and R4 (module init) are
 * disjoint by construction and share one reconciler; they differ only in which
 * receipt map answers "how many direct bodies", and in whether a row that fell
 * back to the direct route is REQUIRED to have emitted one.
 */
interface IrBodyAccountingPopulation {
  readonly label: "R2 top-level free-function" | "R3 class-member" | "R4 module-init";
  readonly sourceId: ObservedIrUnit["sourceId"];
  readonly unitIds: ReadonlySet<IrUnitId>;
  readonly counts: ReadonlyMap<IrUnitId, number>;
  /**
   * `true` for **R2 only** — the assertion "a row that fell back to the direct
   * route emitted exactly one direct body". It holds there because the R2
   * population predicate itself requires `statement.body` AND the receipt is an
   * exact `compileFunctionBody` entry for that unit.
   *
   * It is `false` for R3 and R4 because the audit demonstrably cannot see every
   * direct class/module body, and asserting one would be asserting an absence
   * it cannot observe — with `reportErrorNoNode` turning each such row into a
   * hard compile error. Three measured populations, all pre-existing and all
   * tracked elsewhere:
   *
   * - **R4, ambient-only module init.** An ambient `declare namespace` is still
   *   module-init population (#5283 residual, pinned by its own tests), so
   *   `tests/fixtures/extern-demo.ts` and
   *   `tests/dogfood/corpus/import-attributes.module.js` mint a terminal for a
   *   source with nothing to execute and enter no direct root.
   * - **R3, anonymous default class.** `tests/issue-3519-ir-outcomes.test.ts`
   *   measures that the only audited entry for such a source is a
   *   `compileDeclarations` root with NO unit identity; attributing those roots
   *   is the #3523 gap-1 unattributed-entry debt.
   * - **R3, directly-emitted implicit constructor.** Its member root carries
   *   the class declaration and is indistinguishable from class scaffolding —
   *   see `#indexClassMemberBodyReceipt`.
   *
   * Everything else applies to all three unchanged: impossible counts,
   * duplicate receipts, the skip-vs-receipt contradiction (which is the
   * compile-twice detector this issue exists to arm for R3/R4), and both
   * emitted/unsupported IR-patch bounds.
   */
  readonly unsupportedRequiresDirectBody: boolean;
  /**
   * `true` for **R3 and R4**: where this population has no exact receipt for a
   * unit, fall back to the #5283 root evidence — "a legacy body was available,
   * no exact skip receipt was taken, and the unit physically entered an audited
   * direct-body root".
   *
   * This is what keeps the counters and the booleans one contract.
   * `hasMalformedBodyEmissionAccounting` requires `legacyBodyEmitted ===
   * (directBodyEmissions === 1)`, so a count that is merely CONSERVATIVE would
   * not read as conservative — it would LOWER a legacy claim the compiler
   * already made, and the `evidence.kind === "failed"` arm below turns a
   * lowered claim into an `unpatched-slot` invariant, i.e. a hard compile
   * error. Measured 2026-09-03: without this fallback, nine
   * `tests/issue-3522-*` cases went red on exactly that path while the corpus
   * (which has no such row) stayed green.
   *
   * The fallback is receipt-derived, not a guess — `physicalRootUnitIds` is
   * physical entry evidence and the skip set is an exact receipt — but it is
   * COARSER: a class root cannot be told apart from a member-body root, so for
   * these two populations `directBodyEmissions` is 0/1 evidence rather than a
   * multiplicity count. It is used only where an exact receipt is absent, so it
   * never masks one: a SKIPPED unit's fallback is `false` by construction,
   * which is precisely what leaves the compile-twice detector armed — an exact
   * member receipt on a skipped unit still reads 1 and still raises.
   */
  readonly coarseDirectBodyEvidence: boolean;
}

interface R2FreeFunctionPopulationIndex {
  readonly unitIdsBySourceId: ReadonlyMap<IrSourceId, ReadonlySet<IrUnitId>>;
}

const r2FreeFunctionPopulationIndexByContext = new WeakMap<IrPlanningIdentityContext, R2FreeFunctionPopulationIndex>();

/**
 * (#5308) The R3 population, indexed ONCE for the whole graph.
 *
 * A per-source `terminalUnits.filter(...)` reads the whole terminal census for
 * every source, which is a full extra census per source on a multi-source
 * graph — the complexity `tests/issue-3520-*` "builds the R2 source population
 * once across a multi-source graph" pins (it went red at 12 sources before this
 * cache existed). One graph-wide indexing pass is allowed; another per-source
 * census is not.
 */
const r3ClassMemberPopulationIndexByContext = new WeakMap<
  IrPlanningIdentityContext,
  ReadonlyMap<IrSourceId, ReadonlySet<IrUnitId>>
>();

function indexR3ClassMemberPopulations(
  identityContext: IrPlanningIdentityContext,
): ReadonlyMap<IrSourceId, ReadonlySet<IrUnitId>> {
  const cached = r3ClassMemberPopulationIndexByContext.get(identityContext);
  if (cached) return cached;
  const unitIdsBySourceId = new Map<IrSourceId, Set<IrUnitId>>();
  for (const sourceId of identityContext.sourceFileBySourceId.keys()) {
    unitIdsBySourceId.set(sourceId, new Set());
  }
  for (const unit of identityContext.inventory.terminalUnits) {
    if (unit.observedKind !== "class-member") continue;
    const unitIds = unitIdsBySourceId.get(unit.sourceId);
    if (unitIds) unitIds.add(unit.id);
  }
  r3ClassMemberPopulationIndexByContext.set(identityContext, unitIdsBySourceId);
  return unitIdsBySourceId;
}

interface ValidatedDirectFunctionBodyReceipts {
  readonly countsByUnitId: ReadonlyMap<IrUnitId, number>;
  readonly failuresByUnitId: ReadonlyMap<IrUnitId, IrPreparationFailure>;
  readonly sourceFailure?: IrPreparationFailure;
}

interface IndexedIrTerminalPatchReceipts {
  readonly countsByUnitId: ReadonlyMap<IrUnitId, number>;
}

/** Build the exact physically emitted R2 denominator once for the graph. */
function indexR2FreeFunctionPopulations(identityContext: IrPlanningIdentityContext): R2FreeFunctionPopulationIndex {
  const cached = r2FreeFunctionPopulationIndexByContext.get(identityContext);
  if (cached) return cached;

  const unitIdsBySourceId = new Map<IrSourceId, ReadonlySet<IrUnitId>>();
  for (const [sourceId, sourceFile] of identityContext.sourceFileBySourceId) {
    const unitIds = new Set<IrUnitId>();
    if (!sourceFile.isDeclarationFile) {
      const lastNamedBody = new Map<string, ts.FunctionDeclaration>();
      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && !hasDeclareModifier(statement)) {
          lastNamedBody.set(statement.name.text, statement);
        }
      }
      for (const statement of sourceFile.statements) {
        if (
          !ts.isFunctionDeclaration(statement) ||
          !statement.body ||
          hasDeclareModifier(statement) ||
          (statement.name ? lastNamedBody.get(statement.name.text) !== statement : !hasExportModifier(statement))
        ) {
          continue;
        }
        const unitId = identityContext.unitIdByDeclaration.get(statement);
        if (unitId === undefined) {
          throw new Error(`physical R2 declaration in ${sourceFile.fileName} has no authoritative inventory identity`);
        }
        const unit = identityContext.unitByUnitId.get(unitId);
        if (!unit || unit.sourceId !== sourceId || identityContext.declarationByUnitId.get(unitId) !== statement) {
          throw new Error(`physical R2 declaration ${unitId} does not match its authoritative source identity`);
        }
        if (unit.terminal && unit.kind === "top-level-function" && unit.observedKind === "function") {
          unitIds.add(unit.id);
        }
      }
    }
    unitIdsBySourceId.set(sourceId, unitIds);
  }
  const indexed = { unitIdsBySourceId };
  r2FreeFunctionPopulationIndexByContext.set(identityContext, indexed);
  return indexed;
}

/**
 * (#5308) The three physically-emitted body populations of one source, each
 * paired with the receipt map that counts it.
 *
 * R2 is source-local, public, physical free-function terminals only. R3 is
 * every terminal class member of the source. R4 is the source's module-init
 * terminal, when it owns one.
 */
function collectBodyAccountingPopulations(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  audit: IrDirectFunctionBodyReceiptAudit,
): readonly IrBodyAccountingPopulation[] {
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (!sourceId || identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    throw new Error(
      `IR function-body accounting source ${sourceFile.fileName} is outside the authoritative planning context`,
    );
  }
  const r2UnitIds = indexR2FreeFunctionPopulations(identityContext).unitIdsBySourceId.get(sourceId);
  if (!r2UnitIds) {
    throw new Error(`IR function-body accounting source ${sourceId} has no indexed R2 population`);
  }
  const moduleInitUnitId = identityContext.moduleInitUnitIdBySourceFile.get(sourceFile);
  const moduleInitTerminal =
    moduleInitUnitId === undefined ? undefined : identityContext.terminalByUnitId.get(moduleInitUnitId);
  return [
    {
      label: "R2 top-level free-function",
      sourceId,
      unitIds: r2UnitIds,
      counts: audit.countsByUnitId,
      unsupportedRequiresDirectBody: true,
      coarseDirectBodyEvidence: false,
    },
    {
      label: "R3 class-member",
      sourceId,
      unitIds: indexR3ClassMemberPopulations(identityContext).get(sourceId) ?? new Set<IrUnitId>(),
      counts: audit.classMemberCountsByUnitId,
      unsupportedRequiresDirectBody: false,
      coarseDirectBodyEvidence: true,
    },
    {
      label: "R4 module-init",
      sourceId,
      unitIds: new Set(
        moduleInitUnitId !== undefined &&
          moduleInitTerminal?.observedKind === "module-init" &&
          moduleInitTerminal.sourceId === sourceId
          ? [moduleInitUnitId]
          : [],
      ),
      counts: audit.moduleInitCountsByUnitId,
      unsupportedRequiresDirectBody: false,
      coarseDirectBodyEvidence: true,
    },
  ];
}

function bodyEmissionInvariant(detail: string): IrPreparationFailure {
  return invariant("body-emission-evidence", detail);
}

/** Validate and index the direct receipt census once for one source. */
function validateDirectFunctionBodyReceipts(input: {
  readonly audit: IrDirectFunctionBodyReceiptAudit;
  readonly populations: readonly IrBodyAccountingPopulation[];
}): ValidatedDirectFunctionBodyReceipts {
  const countsByUnitId = new Map<IrUnitId, number>();
  const failuresByUnitId = new Map<IrUnitId, IrPreparationFailure>();
  let sourceFailure: IrPreparationFailure | undefined;
  const failSource = (detail: string): void => {
    sourceFailure ??= bodyEmissionInvariant(detail);
  };
  const failUnit = (unitId: IrUnitId, detail: string): void => {
    failuresByUnitId.set(unitId, bodyEmissionInvariant(detail));
  };

  const { audit, populations } = input;
  const localUnitIds = new Set(populations.flatMap((population) => [...population.unitIds]));
  for (const population of populations) {
    if (audit.sourceId !== population.sourceId) {
      failSource(
        `direct function-body receipt source ${audit.sourceId} does not match the local ${population.label} source ${population.sourceId}`,
      );
    }
    for (const [receiptUnitId, count] of population.counts) {
      if (!population.unitIds.has(receiptUnitId)) {
        failSource(`direct function-body receipt ${receiptUnitId} is outside the local ${population.label} population`);
        continue;
      }
      if (!Number.isSafeInteger(count) || count <= 0 || count > 1) {
        failUnit(receiptUnitId, `direct function-body receipt ${receiptUnitId} has impossible count ${count}`);
      }
      countsByUnitId.set(receiptUnitId, count);
    }
  }
  if (audit.unattributedViolation) {
    failSource(
      `unattributed direct function-body receipt violation [${audit.unattributedViolation.code}]: ` +
        audit.unattributedViolation.detail,
    );
  }
  for (const violation of audit.violations) {
    const detail = `direct function-body receipt violation [${violation.code}]${
      violation.unitId === undefined ? "" : ` for ${violation.unitId}`
    }: ${violation.detail}`;
    if (violation.unitId === undefined || !localUnitIds.has(violation.unitId)) failSource(detail);
    else failUnit(violation.unitId, detail);
  }
  return {
    countsByUnitId,
    failuresByUnitId,
    ...(sourceFailure ? { sourceFailure } : {}),
  };
}

/** Index exact terminal patch receipts once, for every accounted population. */
function indexIrTerminalPatchReceipts(
  report: IrIntegrationReport,
  accountedUnitIds: ReadonlySet<IrUnitId>,
): IndexedIrTerminalPatchReceipts {
  const countsByUnitId = new Map<IrUnitId, number>();
  for (const evidence of report.terminalEvidence ?? []) {
    if (evidence.kind !== "patched" || !accountedUnitIds.has(evidence.unitId)) continue;
    countsByUnitId.set(evidence.unitId, (countsByUnitId.get(evidence.unitId) ?? 0) + 1);
  }
  return { countsByUnitId };
}

/**
 * Reconcile the two physical body emitters for one accounted terminal. The
 * direct count comes only from the AST dispatcher receipt; the IR count comes
 * only from exact terminal patch events, never from selector or name telemetry.
 */
function reconcileFunctionBodyEmissionAccounting(input: {
  readonly directReceipts: ValidatedDirectFunctionBodyReceipts;
  readonly irPatchReceipts: IndexedIrTerminalPatchReceipts;
  readonly population: IrBodyAccountingPopulation;
  readonly unit: ObservedIrUnit;
  /**
   * (#5283) "A legacy body was available, no exact skip receipt was taken, and
   * this unit physically entered an audited direct-body root." Read only where
   * the population allows coarse evidence AND no exact receipt exists.
   */
  readonly coarseDirectRoot: boolean;
}): IrFunctionBodyEmissionAccounting {
  const exactDirectBodyEmissions = input.directReceipts.countsByUnitId.get(input.unit.unitId);
  const directBodyEmissions =
    exactDirectBodyEmissions ?? (input.population.coarseDirectBodyEvidence && input.coarseDirectRoot ? 1 : 0);
  const irBodyEmissions = input.irPatchReceipts.countsByUnitId.get(input.unit.unitId) ?? 0;
  const receiptFailure =
    input.directReceipts.failuresByUnitId.get(input.unit.unitId) ??
    input.directReceipts.sourceFailure ??
    (!Number.isSafeInteger(irBodyEmissions) || irBodyEmissions < 0 || irBodyEmissions > 1
      ? bodyEmissionInvariant(`IR terminal patch receipt ${input.unit.unitId} has impossible count ${irBodyEmissions}`)
      : undefined);
  return {
    prepareAttempts: 1,
    directBodyEmissions,
    irBodyEmissions,
    legacyBodyEmitted: directBodyEmissions === 1,
    irBodyEmitted: irBodyEmissions === 1,
    unsupportedRequiresDirectBody: input.population.unsupportedRequiresDirectBody,
    ...(receiptFailure ? { receiptFailure } : {}),
  };
}

function functionBodyAccountingFailure(input: {
  readonly unit: ObservedIrUnit;
  readonly skippedBodyUnitIds: ReadonlySet<IrUnitId>;
  readonly accounting: IrFunctionBodyEmissionAccounting;
  readonly outcome: IrObservedOutcome;
}): IrPreparationFailure | undefined {
  if (input.accounting.receiptFailure) return input.accounting.receiptFailure;
  if (input.skippedBodyUnitIds.has(input.unit.unitId) && input.accounting.directBodyEmissions !== 0) {
    return bodyEmissionInvariant(
      `${input.unit.unitId} recorded ${input.accounting.directBodyEmissions} direct body receipts after an exact skip receipt`,
    );
  }
  if (input.outcome.kind === "emitted" && input.accounting.irBodyEmissions !== 1) {
    return bodyEmissionInvariant(
      `${input.unit.unitId} emitted without exactly one terminal IR patch receipt (observed ${input.accounting.irBodyEmissions})`,
    );
  }
  if (
    input.outcome.kind === "emitted" &&
    !input.skippedBodyUnitIds.has(input.unit.unitId) &&
    input.accounting.directBodyEmissions !== 1
  ) {
    return bodyEmissionInvariant(
      `${input.unit.unitId} patched after the direct route without exactly one direct body receipt (observed ${input.accounting.directBodyEmissions})`,
    );
  }
  if (
    input.outcome.kind === "unsupported" &&
    input.accounting.unsupportedRequiresDirectBody &&
    input.accounting.directBodyEmissions !== 1
  ) {
    return bodyEmissionInvariant(
      `${input.unit.unitId} fell back to direct emission without exactly one direct body receipt (observed ${input.accounting.directBodyEmissions})`,
    );
  }
  if (input.outcome.kind === "unsupported" && input.accounting.irBodyEmissions !== 0) {
    return bodyEmissionInvariant(
      `${input.unit.unitId} fell back to direct emission with ${input.accounting.irBodyEmissions} terminal IR patch receipts`,
    );
  }
  // (#5262) There is deliberately NO arm for `outcome.kind === "invariant"`.
  // The one that used to live here fired on `directBodyEmissions !== 0`, but its
  // own message described a bound on IR PATCH receipts ("may retain only zero or
  // one exact IR patch receipt") — a different quantity, and one already
  // enforced upstream in `reconcileR2FunctionBodyEmissionAccounting`, which
  // turns `irBodyEmissions > 1` into a `receiptFailure`. Meanwhile any unit that
  // reached an invariant after legitimately falling back to the direct route
  // carries `directBodyEmissions === 1`, so the arm fired on the NORMAL shape
  // and its only effect was to overwrite the root cause with
  // `body-emission-evidence`. It added no coverage; deleting it loses no red.
  return undefined;
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
      const outcomeOnly = evidence.diagnosticVisibility === "outcome-only";
      if (evidence.diagnosticVisibility !== "report" && evidence.diagnosticVisibility !== "outcome-only") {
        recordMismatch(mismatchOwnerId, `failed integration event ${evidence.unitId} has invalid visibility`);
      } else if (
        outcomeOnly &&
        (evidence.error.outcome.kind !== "unsupported" ||
          evidence.error.outcome.code !== "late-preparation-unsupported" ||
          evidence.error.outcome.stage !== "resolve")
      ) {
        recordMismatch(mismatchOwnerId, `outcome-only integration event ${evidence.unitId} has invalid evidence`);
      }
      if (outcomeOnly ? eventErrors.length !== 0 : eventErrors[0] !== evidence.error) {
        recordMismatch(
          mismatchOwnerId,
          outcomeOnly
            ? `outcome-only integration event ${evidence.unitId} retained public errors`
            : `failed integration event ${evidence.unitId} does not retain its representative public error first`,
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

/**
 * (#3523 R4 gap 4) Build the one observational row for a source whose module
 * init has nothing to do, or `undefined` when the source is not that shape.
 *
 * The admission test is deliberately a CONJUNCTION, and both halves are
 * fail-closed rather than convenient:
 *
 * - **No module-init terminal unit.** `buildIrModuleInitPlan` reads its own
 *   `unitId` straight out of this map (`module-init-plan.ts:496`), so an absent
 *   entry IS `plan.unitId === null`. It also guarantees no existing row can be
 *   duplicated, because a row is only ever minted from a terminal unit.
 * - **No module-init population.** The syntactic ground truth for "nothing to
 *   evaluate". Measured 2026-08-31: across function-only, type-only, empty,
 *   class-without-static, class-with-static and executable sources, this
 *   conjunction coincides exactly with `plan.executable === false`.
 *
 * They can only disagree in the state `buildIrModuleInitPlan` already reports as
 * the `missing-module-init-unit` gap — an executable source that lost its
 * terminal. There we record NOTHING rather than a row claiming the source has
 * nothing to do, because that row would be precisely the lie this arm exists to
 * remove from the ledger.
 */
export function buildNonExecutableModuleInitOutcome(input: {
  readonly sourceFile: ts.SourceFile;
  readonly identityContext: IrPlanningIdentityContext;
  readonly target: IrObservedOutcome["target"];
  readonly existingOutcomes: readonly IrObservedOutcome[];
}): IrObservedOutcome | undefined {
  const { sourceFile, identityContext } = input;
  if (identityContext.moduleInitUnitIdBySourceFile.has(sourceFile)) return undefined;
  if (collectModuleInitPopulation(sourceFile).length !== 0) return undefined;
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (!sourceId || identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) return undefined;
  // Exactly one row per source, including every empty source of a multi-source
  // graph. A second call for the same source is a no-op, not a second row.
  if (input.existingOutcomes.some((outcome) => outcome.kind === "non-executable" && outcome.sourceId === sourceId)) {
    return undefined;
  }
  const outcome: IrObservedOutcome = {
    key: `${sourceFile.fileName}::module-init::${MODULE_INIT_UNIT_NAME}#0`,
    sourceId,
    file: sourceFile.fileName,
    unitKind: "module-init",
    displayName: MODULE_INIT_UNIT_NAME,
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: input.target,
    kind: "non-executable",
    stage: "select",
    legacyBodyEmitted: false,
    irBodyEmitted: false,
  };
  // The contract is a validator, not a comment: never emit a row the policy
  // layer would have to reject as malformed evidence.
  return nonExecutableOutcomeDefect(outcome) === undefined ? outcome : undefined;
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

function sameInvariantFailure(outcome: IrObservedOutcome, failure: IrPreparationFailure): boolean {
  return (
    outcome.kind === "invariant" &&
    failure.kind === "invariant" &&
    outcome.code === failure.code &&
    outcome.stage === failure.stage &&
    outcome.detail === failure.detail
  );
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
  const bodyAccountingPopulations = input.directFunctionBodyReceiptAudit
    ? collectBodyAccountingPopulations(
        input.sourceFile,
        input.identityPlan.identityContext,
        input.directFunctionBodyReceiptAudit,
      )
    : undefined;
  const populationByUnitId = new Map<IrUnitId, IrBodyAccountingPopulation>(
    (bodyAccountingPopulations ?? []).flatMap((population) =>
      [...population.unitIds].map((unitId) => [unitId, population] as const),
    ),
  );
  const directReceipts =
    input.directFunctionBodyReceiptAudit && bodyAccountingPopulations
      ? validateDirectFunctionBodyReceipts({
          audit: input.directFunctionBodyReceiptAudit,
          populations: bodyAccountingPopulations,
        })
      : undefined;
  const irPatchReceipts = bodyAccountingPopulations
    ? indexIrTerminalPatchReceipts(input.report, new Set(populationByUnitId.keys()))
    : undefined;
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
    // (#5263) A prepared-callable terminal is owned by the publication path.
    // Skip the WHOLE unit, not just the diagnostic push: computing a row that
    // the caller then discards is exactly the defect this fixes — the row was
    // thrown away at `recordObservedIrOutcomes` while its diagnostic was
    // reported anyway, failing every standalone multi-source compile with a
    // `body-emission-evidence` invariant about receipts the unit correctly
    // never took.
    if (input.ownedElsewhereUnitIds?.has(unit.unitId)) continue;
    const accountingPopulation = populationByUnitId.get(unit.unitId);
    // (#5283) The root prediction, computed BEFORE the accounting because R3/R4
    // read it as their coarse direct-body evidence — see
    // `coarseDirectBodyEvidence`. R2 never reads it: its receipts are exact.
    const physicalRootUnitIds = input.directFunctionBodyReceiptAudit?.physicalRootUnitIds;
    const coarseDirectRoot =
      unit.legacyBodyAvailable &&
      !input.skippedBodyUnitIds.has(unit.unitId) &&
      (physicalRootUnitIds?.has(unit.unitId) ?? true);
    const bodyAccounting =
      directReceipts && irPatchReceipts && accountingPopulation
        ? reconcileFunctionBodyEmissionAccounting({
            directReceipts,
            irPatchReceipts,
            population: accountingPopulation,
            unit,
            coarseDirectRoot,
          })
        : undefined;
    // R2/R3/R4 rows derive compatibility booleans from exact production
    // receipts. Every other unit kind now REQUIRES a physical direct-body root
    // as well (#5283): "a legacy body was available and we did not skip it" is
    // a prediction about what the direct front end would do, and it read `true`
    // on units where no direct pass ran at all — measured on
    // `tests/fixtures/extern-demo.ts` and
    // `tests/dogfood/corpus/import-attributes.module.js`, both of which the
    // route audit already flagged with `missing-legacy-entry-evidence`.
    //
    // The root is a NECESSARY condition, not a sufficient one, so this can only
    // ever turn a `true` into a `false`. A root attributed to a unit can be the
    // dispatcher entering for a sibling obligation: measured on the implicit
    // constructor of a class with a static block, `compileClassBodies` records
    // a root against `Counter_new` while that constructor's own body is skipped
    // and IR-patched. Reading the root alone would report compile-twice on a
    // unit that compiled once — the exact inflation this issue is about, in the
    // other direction. Callers that did not opt into the route audit have no
    // receipts to read and keep the prediction unchanged.
    const legacyBodyEmitted = bodyAccounting?.legacyBodyEmitted ?? coarseDirectRoot;
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
      ...(bodyAccounting
        ? {
            prepareAttempts: bodyAccounting.prepareAttempts,
            directBodyEmissions: bodyAccounting.directBodyEmissions,
            irBodyEmissions: bodyAccounting.irBodyEmissions,
          }
        : {}),
      legacyBodyEmitted,
      irBodyEmitted: bodyAccounting?.irBodyEmitted ?? false,
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
      // (#3521 R2-T1) A row that emitted BOTH bodies is the compile-twice shape
      // R2 exists to retire; it carries exactly one reason. The per-unit record
      // wins over the source default, which only covers the routes where the
      // selector never saw the unit. Attached by spread, so `IrObservedOutcome`
      // itself is unchanged and no emitter reads the field.
      const r2Withdrawal =
        bodyAccounting?.directBodyEmissions === 1 && bodyAccounting.irBodyEmissions === 1
          ? (input.r2WithdrawalsByUnitId?.get(unit.unitId) ??
            (input.r2NotAttemptedReason
              ? ({ stage: "not-attempted", reason: input.r2NotAttemptedReason } as const)
              : undefined))
          : undefined;
      outcome = {
        ...base,
        kind: "emitted",
        stage: "patch",
        irBodyEmitted: true,
        ...(evidence.preparedComponentId === undefined ? {} : { preparedComponentId: evidence.preparedComponentId }),
        ...(r2Withdrawal ? { r2Withdrawal } : {}),
      };
    } else {
      outcome = observedFailure(base, {
        kind: "invariant",
        code: legacyBodyEmitted ? "missing-terminal-outcome" : "unpatched-slot",
        stage: "patch",
        detail: `${unit.matchName} was prepared but integration neither patched it nor reported a failure`,
      });
    }

    let accountingFailure: IrPreparationFailure | undefined;
    let accountingApplied = false;
    if (bodyAccounting) {
      accountingFailure = functionBodyAccountingFailure({
        unit,
        skippedBodyUnitIds: input.skippedBodyUnitIds,
        accounting: bodyAccounting,
        outcome,
      });
      if (accountingFailure && outcome.kind !== "invariant") {
        // (#5262) An `emitted` or `unsupported` row that fails accounting took
        // neither body route or both. These arms are the ONLY detector for that
        // corruption, so they still REPLACE the outcome — demoting them to a
        // note would leave the row `unsupported`, drop it out of the invariant
        // diagnostic push below, and turn a real red into silence.
        outcome = observedFailure(base, accountingFailure);
        accountingApplied = true;
      } else if (accountingFailure) {
        // (#5262) Root cause wins the `code` slot. The accounting evidence rides
        // alongside by spread, exactly like `r2Withdrawal` (#3521 R2-T1):
        // `IrObservedOutcome` is unchanged and no emitter reads the field. The
        // asymmetry with the branch above is load-bearing — do NOT simplify this
        // to "attach, never replace".
        const noted: IrObservedOutcomeWithBodyAccountingNote = {
          ...outcome,
          bodyAccountingFailure: accountingFailure,
        };
        outcome = noted;
      }
    }

    outcomes.push(outcome);
    const unchangedReportVisibleInvariant =
      !accountingApplied &&
      evidence?.kind === "failed" &&
      evidence.diagnosticVisibility === "report" &&
      sameInvariantFailure(outcome, evidence.error.outcome);
    if (outcome.kind === "invariant" && !unchangedReportVisibleInvariant) {
      diagnostics.push(`IR outcome invariant [${outcome.code}] for ${unit.matchName}: ${outcome.detail}`);
    }
    // (#5262) An accounting failure that lost the `code` slot must not vanish
    // from the diagnostic channel too — the evidence is still real, it is just
    // no longer the headline.
    if (accountingFailure && !accountingApplied) {
      diagnostics.push(`IR body-emission accounting note for ${unit.matchName}: ${accountingFailure.detail}`);
    }
  }
  return { outcomes, diagnostics };
}
