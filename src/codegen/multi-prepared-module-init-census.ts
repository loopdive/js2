// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The whole-program semantic module-initializer census used by the Prepared
 * multi-source coordinator.
 *
 * This file owns discovery only.  It deliberately does not reserve an ABI
 * slot, select a body, or decide whether the legacy queue is admissible.  A
 * semantic plan is made once for every source (including empty sources); the
 * legacy queue is observed later, after declaration collection has completed.
 */

import type { MultiTypedAST } from "../checker/index.js";
import {
  buildIrModuleInitPlan,
  reconcileIrModuleInitPlan,
  type IrModuleInitParityReport,
  type IrModuleInitPlan,
  type IrModuleInitPlanningEvidence,
  type LegacyModuleInitStaticEntry,
} from "../ir/module-init-plan.js";
import type { IrSourceId, IrSourceKind, IrTerminalUnitRecord, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

export interface MultiPreparedModuleInitCensusInput {
  readonly multiAst: MultiTypedAST;
  readonly identityContext: IrPlanningIdentityContext;
  readonly target: "host" | "standalone" | "wasi";
  readonly deferTopLevelInit: boolean;
}

/** The semantic and source-owned facts retained for one source. */
export interface MultiPreparedModuleInitSourceCensus {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly kind: IrSourceKind;
  readonly canonicalOrder: number;
  readonly semanticOrder: number;
  /** Every terminal owned by this source, including function terminals. */
  readonly terminalUnitIds: readonly IrUnitId[];
  /** The exact source-owned module-init terminal, when the inventory has one. */
  readonly unitId: IrUnitId | null;
  readonly executable: boolean;
  readonly evaluationCount: number;
  /** The complete semantic plan, retained even when parity is unavailable. */
  readonly plan: IrModuleInitPlan;
  /** Present only after the post-collection legacy queue observation. */
  readonly planning?: IrModuleInitPlanningEvidence;
  /** A report can remain visible when the producer was unavailable. */
  readonly parity?: IrModuleInitParityReport;
  readonly parityAvailable: boolean;
}

/**
 * Defensively immutable, source-ordered M2 preparation authority.  `sourcePlans`
 * use semantic AST order; `canonicalSources` use inventory order.  Keeping both
 * projections explicit prevents a caller's map/order from becoming execution
 * order by accident.
 */
export interface MultiPreparedModuleInitCensus {
  readonly schema: "multi-prepared-module-init-census-v1";
  readonly inventory: IrUnitInventory;
  readonly identityContext: IrPlanningIdentityContext;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly canonicalSourceIds: readonly IrSourceId[];
  readonly semanticSourceIds: readonly IrSourceId[];
  readonly canonicalSources: readonly MultiPreparedModuleInitSourceCensus[];
  readonly sourcePlans: readonly MultiPreparedModuleInitSourceCensus[];
  readonly executableSourceIds: readonly IrSourceId[];
  readonly executableUnitIds: readonly IrUnitId[];
  readonly semanticEntryCount: number;
  readonly parityObserved: boolean;
}

/** Serializable audit projection carried by the program body plan. */
export interface MultiPreparedModuleInitCensusProjection {
  readonly schema: "multi-prepared-module-init-census-projection-v1";
  readonly canonicalSourceIds: readonly IrSourceId[];
  readonly semanticSourceIds: readonly IrSourceId[];
  readonly executableSourceIds: readonly IrSourceId[];
  readonly executableUnitIds: readonly IrUnitId[];
  readonly semanticEntryCount: number;
  readonly parityObserved: boolean;
  readonly canonicalSources: readonly MultiPreparedModuleInitSourceProjection[];
  readonly sourcePlans: readonly MultiPreparedModuleInitSourceProjection[];
}

export interface MultiPreparedModuleInitSourceProjection {
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly kind: IrSourceKind;
  readonly canonicalOrder: number;
  readonly semanticOrder: number;
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly unitId: IrUnitId | null;
  readonly executable: boolean;
  readonly evaluationCount: number;
  readonly plan: IrModuleInitPlan;
  readonly planning?: IrModuleInitPlanningEvidence;
  readonly parity?: IrModuleInitParityReport;
  readonly parityAvailable: boolean;
}

export interface MultiPreparedModuleInitLegacyObservationInput {
  /** False means the producer could not provide a trustworthy queue view. */
  readonly available?: boolean;
  readonly liveFunctionNames?: Iterable<string>;
  readonly staticEntries?: readonly LegacyModuleInitStaticEntry[];
  readonly moduleStatements?: readonly ts.Statement[];
}

export interface ObserveMultiPreparedModuleInitCensusInput {
  readonly ctx: CodegenContext;
  /** Test and alternate front ends may explicitly report queue unavailability. */
  readonly legacy?: MultiPreparedModuleInitLegacyObservationInput;
}

type CensusInvariantCode =
  | "source-count"
  | "source-join"
  | "canonical-order"
  | "terminal-join"
  | "syntax-changed"
  | "parity-changed";

interface SourceSyntaxSnapshot {
  readonly statements: readonly ts.Statement[];
  readonly nodes: readonly ts.Node[];
  readonly scalarFields: readonly string[];
  readonly text: string;
}

interface LegacySnapshot {
  readonly available: boolean;
  readonly liveFunctionNames: readonly string[];
  readonly staticEntries: readonly LegacyModuleInitStaticEntry[];
  readonly staticEntryFields: readonly StaticEntryFields[];
  readonly moduleStatements: readonly ts.Statement[];
}

interface StaticEntryFields {
  readonly entry: LegacyModuleInitStaticEntry;
  readonly initializer: ts.Expression | undefined;
  readonly staticBlock: ts.ClassStaticBlockDeclaration | undefined;
  readonly className: string | undefined;
}

interface CensusMetadata {
  readonly syntaxBySourceFile: ReadonlyMap<ts.SourceFile, SourceSyntaxSnapshot>;
  readonly legacyByCensus: WeakMap<object, ReadonlyMap<ts.SourceFile, LegacySnapshot>>;
  readonly ctx?: CodegenContext;
}

const metadataByCensus = new WeakMap<object, CensusMetadata>();

function censusInvariant(code: CensusInvariantCode, detail: string): never {
  throw new IrInvariantError(
    "selection-preparation-mismatch",
    "resolve",
    `multi-prepared-module-init-census:${code}: ${detail}`,
  );
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function sameIdentityArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sourceRecordFor(
  identityContext: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
): IrUnitInventory["sources"][number] {
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  const source = sourceId
    ? identityContext.inventory.sources.find((candidate) => candidate.id === sourceId)
    : undefined;
  if (!sourceId || !source || identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return censusInvariant("source-join", `source ${sourceFile.fileName} is absent from the exact inventory join`);
  }
  return source;
}

function terminalRecordsFor(inventory: IrUnitInventory, sourceId: IrSourceId): readonly IrTerminalUnitRecord[] {
  return inventory.terminalUnits.filter((terminal) => terminal.sourceId === sourceId);
}

function snapshotSourceSyntax(sourceFile: ts.SourceFile): SourceSyntaxSnapshot {
  const nodes: ts.Node[] = [];
  const scalarFields: string[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    scalarFields.push(nodeSyntaxScalarFields(node));
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) visit(statement);
  return Object.freeze({
    statements: freezeArray(sourceFile.statements),
    nodes: freezeArray(nodes),
    scalarFields: freezeArray(scalarFields),
    text: sourceFile.text,
  });
}

/**
 * Keep the AST identity check sensitive to in-place parser-field edits. The
 * compiler normally treats these fields as immutable, but a retained plan must
 * fail closed if a producer mutates a node after discovery. Cache fields such
 * as `transformFlags` are intentionally excluded because the checker may fill
 * them lazily without changing source semantics.
 */
function nodeSyntaxScalarFields(node: ts.Node): string {
  const value = node as ts.Node & {
    readonly escapedText?: string | number;
    readonly hasExtendedUnicodeEscape?: boolean;
    readonly isUnterminated?: boolean;
    readonly multiLine?: boolean;
    readonly numericLiteralFlags?: number;
    readonly rawText?: string;
    readonly singleQuote?: boolean;
    readonly text?: string;
  };
  return JSON.stringify([
    node.kind,
    value.text,
    value.escapedText,
    value.rawText,
    value.hasExtendedUnicodeEscape,
    value.isUnterminated,
    value.multiLine,
    value.numericLiteralFlags,
    value.singleQuote,
  ]);
}

function currentSourceSyntax(snapshot: SourceSyntaxSnapshot, sourceFile: ts.SourceFile): boolean {
  if (snapshot.text !== sourceFile.text || !sameIdentityArray(sourceFile.statements, snapshot.statements)) return false;
  const nodes: ts.Node[] = [];
  const scalarFields: string[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    scalarFields.push(nodeSyntaxScalarFields(node));
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) visit(statement);
  return sameIdentityArray(nodes, snapshot.nodes) && sameIdentityArray(scalarFields, snapshot.scalarFields);
}

function sourceLiveFunctionNames(
  sourcePlans: readonly MultiPreparedModuleInitSourceCensus[],
  ctx: CodegenContext,
  suppliedLiveFunctionNames?: Iterable<string>,
): { readonly available: boolean; readonly bySource: ReadonlyMap<ts.SourceFile, readonly string[]> } {
  const declarations = sourcePlans.flatMap((sourcePlan) =>
    sourcePlan.sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && !!statement.name && !!statement.body,
    ),
  );
  const names = new Set(suppliedLiveFunctionNames ?? ctx.liveFuncBindingGlobals ?? []);
  const exactDeclarations = ctx.reassignedFunctionDeclarations;
  const bySource = new Map<ts.SourceFile, readonly string[]>();
  let available = true;
  if (names.size === 0) {
    for (const sourcePlan of sourcePlans) bySource.set(sourcePlan.sourceFile, freezeArray([]));
    return { available, bySource };
  }
  if (exactDeclarations) {
    for (const sourcePlan of sourcePlans) {
      const sourceNames = sourcePlan.sourceFile.statements
        .filter(
          (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && !!statement.name && !!statement.body,
        )
        .filter((declaration) => exactDeclarations.has(declaration))
        .map((declaration) => declaration.name!.text);
      if (sourceNames.some((name) => !names.has(name))) available = false;
      bySource.set(sourcePlan.sourceFile, freezeArray(sourceNames));
    }
    return { available, bySource };
  }

  // Older/alternate producers expose only names.  Permit that view only when
  // each name has one source-local declaration; same-spelled declarations make
  // the observation unavailable rather than selecting an arbitrary source.
  for (const name of names) {
    const matches = declarations.filter((declaration) => declaration.name!.text === name);
    if (matches.length !== 1) available = false;
  }
  for (const sourcePlan of sourcePlans) {
    const sourceNames = sourcePlan.sourceFile.statements
      .filter(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && !!statement.name && !!statement.body,
      )
      .filter((declaration) => names.has(declaration.name!.text))
      .map((declaration) => declaration.name!.text);
    bySource.set(sourcePlan.sourceFile, freezeArray(sourceNames));
  }
  return { available, bySource };
}

function captureLegacyObservation(
  census: MultiPreparedModuleInitCensus,
  input: ObserveMultiPreparedModuleInitCensusInput,
): { readonly available: boolean; readonly bySource: ReadonlyMap<ts.SourceFile, LegacySnapshot> } {
  const supplied = input.legacy;
  const ctx = input.ctx;
  const sourcePlans = census.sourcePlans;
  const live = sourceLiveFunctionNames(sourcePlans, ctx, supplied?.liveFunctionNames);
  const suppliedStaticEntries = supplied?.staticEntries ?? ctx.staticInitExprs;
  const suppliedModuleStatements = supplied?.moduleStatements ?? ctx.moduleInitStatements;
  const available =
    supplied?.available !== false &&
    live.available &&
    Array.isArray(suppliedStaticEntries) &&
    Array.isArray(suppliedModuleStatements);
  const staticEntries = freezeArray(suppliedStaticEntries ?? []);
  const moduleStatements = freezeArray(suppliedModuleStatements ?? []);
  const knownSources = new Set(sourcePlans.map((sourcePlan) => sourcePlan.sourceFile));
  const staticNodes = staticEntries
    .map((entry) => entry.staticBlock ?? entry.initializer)
    .filter((node) => node !== undefined);
  const foreignStatic = staticNodes.some((node) => !knownSources.has(node.getSourceFile()));
  const foreignStatements = moduleStatements.some((statement) => !knownSources.has(statement.getSourceFile()));
  const bySource = new Map<ts.SourceFile, LegacySnapshot>();
  for (const sourcePlan of sourcePlans) {
    const sourceFile = sourcePlan.sourceFile;
    const staticForSource = staticEntries.filter(
      (entry) => (entry.staticBlock ?? entry.initializer)?.getSourceFile() === sourceFile,
    );
    const statementsForSource = moduleStatements.filter((statement) => statement.getSourceFile() === sourceFile);
    bySource.set(
      sourceFile,
      Object.freeze({
        available: available && !foreignStatic && !foreignStatements,
        liveFunctionNames: live.bySource.get(sourceFile) ?? freezeArray([]),
        staticEntries: freezeArray(staticForSource),
        staticEntryFields: freezeArray(staticForSource.map(staticEntryFields)),
        moduleStatements: freezeArray(statementsForSource),
      }),
    );
  }
  return { available: available && !foreignStatic && !foreignStatements, bySource };
}

function staticEntryFields(entry: LegacyModuleInitStaticEntry): StaticEntryFields {
  return Object.freeze({
    entry,
    initializer: entry.initializer,
    staticBlock: entry.staticBlock,
    className: (entry as LegacyModuleInitStaticEntry & { readonly className?: string }).className,
  });
}

function sourceProjection(source: MultiPreparedModuleInitSourceCensus): MultiPreparedModuleInitSourceProjection {
  return Object.freeze({
    sourceId: source.sourceId,
    sourceKey: source.sourceKey,
    kind: source.kind,
    canonicalOrder: source.canonicalOrder,
    semanticOrder: source.semanticOrder,
    terminalUnitIds: freezeArray(source.terminalUnitIds),
    unitId: source.unitId,
    executable: source.executable,
    evaluationCount: source.evaluationCount,
    plan: source.plan,
    ...(source.planning ? { planning: source.planning } : {}),
    ...(source.parity ? { parity: source.parity } : {}),
    parityAvailable: source.parityAvailable,
  });
}

export function projectMultiPreparedModuleInitCensus(
  census: MultiPreparedModuleInitCensus,
): MultiPreparedModuleInitCensusProjection {
  return Object.freeze({
    schema: "multi-prepared-module-init-census-projection-v1" as const,
    canonicalSourceIds: freezeArray(census.canonicalSourceIds),
    semanticSourceIds: freezeArray(census.semanticSourceIds),
    executableSourceIds: freezeArray(census.executableSourceIds),
    executableUnitIds: freezeArray(census.executableUnitIds),
    semanticEntryCount: census.semanticEntryCount,
    parityObserved: census.parityObserved,
    canonicalSources: freezeArray(census.canonicalSources.map(sourceProjection)),
    sourcePlans: freezeArray(census.sourcePlans.map(sourceProjection)),
  });
}

export function buildMultiPreparedModuleInitCensus(
  input: MultiPreparedModuleInitCensusInput,
): MultiPreparedModuleInitCensus {
  const { multiAst, identityContext } = input;
  const inventory = identityContext.inventory;
  if (multiAst.sourceFiles.length !== inventory.sources.length) {
    return censusInvariant(
      "source-count",
      `AST has ${multiAst.sourceFiles.length} sources but inventory has ${inventory.sources.length}`,
    );
  }
  const canonicalSourceIds = inventory.sources.map((source) => source.id);
  if (new Set(canonicalSourceIds).size !== canonicalSourceIds.length) {
    return censusInvariant("canonical-order", "inventory contains duplicate source IDs");
  }
  for (const [canonicalOrder, source] of inventory.sources.entries()) {
    if (source.order !== canonicalOrder) {
      return censusInvariant(
        "canonical-order",
        `source ${source.id} has order ${source.order}, expected canonical order ${canonicalOrder}`,
      );
    }
  }
  const sourcePlans = multiAst.sourceFiles.map((sourceFile, semanticOrder): MultiPreparedModuleInitSourceCensus => {
    const source = sourceRecordFor(identityContext, sourceFile);
    if (source.order < 0 || source.order >= inventory.sources.length) {
      return censusInvariant("canonical-order", `source ${source.id} has invalid canonical order ${source.order}`);
    }
    const plan = buildIrModuleInitPlan({
      sourceFile,
      checker: multiAst.checker,
      identityContext,
      target: input.target,
      deferTopLevelInit: input.deferTopLevelInit,
    });
    if (plan.sourceId !== source.id) {
      return censusInvariant(
        "source-join",
        `plan for ${sourceFile.fileName} carries ${plan.sourceId}, expected ${source.id}`,
      );
    }
    const terminalUnits = terminalRecordsFor(inventory, source.id);
    const moduleTerminal = plan.unitId
      ? inventory.terminalUnits.find(
          (terminal) =>
            terminal.id === plan.unitId &&
            terminal.sourceId === source.id &&
            terminal.kind === "module-init" &&
            terminal.observedKind === "module-init" &&
            terminal.terminalOwnerId === terminal.id,
        )
      : undefined;
    if (
      plan.executable &&
      (!moduleTerminal || identityContext.moduleInitUnitIdBySourceFile.get(sourceFile) !== plan.unitId)
    ) {
      return censusInvariant("terminal-join", `executable source ${source.id} lost its exact module-init terminal`);
    }
    return Object.freeze({
      sourceFile,
      sourceId: source.id,
      sourceKey: source.sourceKey,
      kind: source.kind,
      canonicalOrder: source.order,
      semanticOrder,
      terminalUnitIds: freezeArray(terminalUnits.map((terminal) => terminal.id)),
      unitId: plan.executable ? plan.unitId : null,
      executable: plan.executable,
      evaluationCount: plan.evaluations.length,
      plan,
      parityAvailable: false,
    });
  });
  const bySourceId = new Map(sourcePlans.map((sourcePlan) => [sourcePlan.sourceId, sourcePlan] as const));
  const canonicalSources = inventory.sources.map((source) => {
    const sourcePlan = bySourceId.get(source.id);
    if (!sourcePlan) return censusInvariant("source-join", `canonical source ${source.id} is absent from AST order`);
    return sourcePlan;
  });
  const semanticSourceIds = sourcePlans.map((sourcePlan) => sourcePlan.sourceId);
  const executable = sourcePlans.filter((sourcePlan) => sourcePlan.executable && sourcePlan.unitId !== null);
  const census: MultiPreparedModuleInitCensus = Object.freeze({
    schema: "multi-prepared-module-init-census-v1" as const,
    inventory,
    identityContext,
    sourceFiles: freezeArray(multiAst.sourceFiles),
    canonicalSourceIds: freezeArray(inventory.sources.map((source) => source.id)),
    semanticSourceIds: freezeArray(semanticSourceIds),
    canonicalSources: freezeArray(canonicalSources),
    sourcePlans: freezeArray(sourcePlans),
    executableSourceIds: freezeArray(executable.map((sourcePlan) => sourcePlan.sourceId)),
    executableUnitIds: freezeArray(executable.map((sourcePlan) => sourcePlan.unitId!)),
    semanticEntryCount: sourcePlans.reduce((count, sourcePlan) => count + sourcePlan.plan.evaluations.length, 0),
    parityObserved: false,
  });
  const syntaxBySourceFile = new Map(
    multiAst.sourceFiles.map((sourceFile) => [sourceFile, snapshotSourceSyntax(sourceFile)] as const),
  );
  metadataByCensus.set(census, {
    syntaxBySourceFile,
    legacyByCensus: new WeakMap(),
  });
  return census;
}

/** Observe the current direct-front-end queues without rebuilding semantics. */
export function reconcileMultiPreparedModuleInitCensus(
  census: MultiPreparedModuleInitCensus,
  input: ObserveMultiPreparedModuleInitCensusInput,
): MultiPreparedModuleInitCensus {
  assertMultiPreparedModuleInitCensusCurrent(census);
  const metadata = metadataByCensus.get(census);
  if (!metadata) return censusInvariant("parity-changed", "census has no retained metadata");
  if (census.parityObserved) return censusInvariant("parity-changed", "legacy queue parity was observed twice");
  const observed = captureLegacyObservation(census, input);
  const sourcePlans = census.sourcePlans.map((sourcePlan) => {
    const legacy = observed.bySource.get(sourcePlan.sourceFile);
    if (!legacy) return censusInvariant("source-join", `missing legacy source observation for ${sourcePlan.sourceId}`);
    const parity = reconcileIrModuleInitPlan(sourcePlan.plan, sourcePlan.sourceFile, {
      liveFunctionNames: legacy.liveFunctionNames,
      staticEntries: legacy.staticEntries,
      moduleStatements: legacy.moduleStatements,
    });
    return Object.freeze({
      ...sourcePlan,
      ...(legacy.available ? { planning: Object.freeze({ plan: sourcePlan.plan, parity }) } : {}),
      parity,
      parityAvailable: observed.available && legacy.available,
    });
  });
  const bySourceId = new Map(sourcePlans.map((sourcePlan) => [sourcePlan.sourceId, sourcePlan] as const));
  const canonicalSources = census.canonicalSourceIds.map((sourceId) => {
    const sourcePlan = bySourceId.get(sourceId);
    if (!sourcePlan) return censusInvariant("source-join", `observed census lost canonical source ${sourceId}`);
    return sourcePlan;
  });
  const observedCensus: MultiPreparedModuleInitCensus = Object.freeze({
    ...census,
    canonicalSources: freezeArray(canonicalSources),
    sourcePlans: freezeArray(sourcePlans),
    parityObserved: true,
  });
  const observedMetadata: CensusMetadata = { ...metadata, ctx: input.ctx };
  metadataByCensus.set(observedCensus, observedMetadata);
  observedMetadata.legacyByCensus.set(observedCensus, observed.bySource);
  return observedCensus;
}

/**
 * The queue observation is tied to the exact codegen context and ABI session
 * that will consume it. A matching inventory alone is insufficient: another
 * context may have a distinct queue population or session lifecycle.
 */
export function isMultiPreparedModuleInitCensusObservedFor(
  census: MultiPreparedModuleInitCensus,
  ctx: CodegenContext,
  session: NonNullable<CodegenContext["programAbiSession"]>,
): boolean {
  const metadata = metadataByCensus.get(census);
  return census.parityObserved && metadata?.ctx === ctx && ctx.programAbiSession === session;
}

function sameParity(actual: IrModuleInitParityReport | undefined, expected: IrModuleInitParityReport): boolean {
  if (!actual) return false;
  return (
    actual.aligned === expected.aligned &&
    actual.plannedEntryCount === expected.plannedEntryCount &&
    actual.legacyEntryCount === expected.legacyEntryCount &&
    sameIdentityArray(actual.plannedOrder, expected.plannedOrder) &&
    sameIdentityArray(actual.legacyOrder, expected.legacyOrder) &&
    sameIdentityArray(actual.missingFromLegacy, expected.missingFromLegacy) &&
    sameIdentityArray(actual.extraInLegacy, expected.extraInLegacy) &&
    actual.reordered.length === expected.reordered.length &&
    actual.reordered.every(
      (entry, index) =>
        entry.planned === expected.reordered[index]?.planned && entry.observed === expected.reordered[index]?.observed,
    )
  );
}

function sameLegacySnapshot(actual: LegacySnapshot, expected: LegacySnapshot): boolean {
  return (
    actual.available === expected.available &&
    sameIdentityArray(actual.liveFunctionNames, expected.liveFunctionNames) &&
    sameIdentityArray(actual.staticEntries, expected.staticEntries) &&
    actual.staticEntryFields.length === expected.staticEntryFields.length &&
    actual.staticEntryFields.every(
      (entry, index) =>
        entry.entry === expected.staticEntryFields[index]?.entry &&
        entry.initializer === expected.staticEntryFields[index]?.initializer &&
        entry.staticBlock === expected.staticEntryFields[index]?.staticBlock &&
        entry.className === expected.staticEntryFields[index]?.className,
    ) &&
    sameIdentityArray(actual.moduleStatements, expected.moduleStatements)
  );
}

/** Recheck source/inventory/AST and, when observed, queue currentness. */
export function assertMultiPreparedModuleInitCensusCurrent(census: MultiPreparedModuleInitCensus): void {
  const metadata = metadataByCensus.get(census);
  if (!metadata) censusInvariant("parity-changed", "census has no retained metadata");
  if (census.inventory !== census.identityContext.inventory) {
    censusInvariant("source-join", "census inventory and identity inventory diverged");
  }
  if (census.sourceFiles.length !== census.identityContext.inventory.sources.length) {
    censusInvariant("source-count", "census source population changed");
  }
  const sourceById = new Map(census.sourcePlans.map((sourcePlan) => [sourcePlan.sourceId, sourcePlan] as const));
  const seenFiles = new Set<ts.SourceFile>();
  for (const [semanticOrder, sourceFile] of census.sourceFiles.entries()) {
    if (seenFiles.has(sourceFile)) censusInvariant("source-join", `source ${sourceFile.fileName} occurs twice`);
    seenFiles.add(sourceFile);
    const sourceId = census.identityContext.sourceIdBySourceFile.get(sourceFile);
    const sourcePlan = sourceId ? sourceById.get(sourceId) : undefined;
    if (
      !sourceId ||
      !sourcePlan ||
      sourcePlan.sourceFile !== sourceFile ||
      sourcePlan.semanticOrder !== semanticOrder ||
      census.identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile ||
      !currentSourceSyntax(metadata.syntaxBySourceFile.get(sourceFile)!, sourceFile)
    ) {
      censusInvariant("syntax-changed", `source ${sourceFile.fileName} no longer matches the retained census`);
    }
    const source = census.identityContext.inventory.sources.find((candidate) => candidate.id === sourceId);
    if (!source || sourcePlan.sourceKey !== source.sourceKey || sourcePlan.canonicalOrder !== source.order) {
      censusInvariant("canonical-order", `source ${sourceFile.fileName} changed canonical identity`);
    }
    const terminals = terminalRecordsFor(census.identityContext.inventory, sourceId).map((terminal) => terminal.id);
    if (!sameIdentityArray(sourcePlan.terminalUnitIds, terminals)) {
      censusInvariant("terminal-join", `source ${sourceId} changed its terminal denominator`);
    }
    const moduleUnit = census.identityContext.moduleInitUnitIdBySourceFile.get(sourceFile) ?? null;
    if (
      sourcePlan.plan.unitId !== moduleUnit ||
      sourcePlan.unitId !== (sourcePlan.plan.executable ? moduleUnit : null)
    ) {
      censusInvariant("terminal-join", `source ${sourceId} changed its module-init unit join`);
    }
  }
  const canonical = census.canonicalSourceIds;
  if (
    !sameIdentityArray(
      canonical,
      census.identityContext.inventory.sources.map((source) => source.id),
    ) ||
    !sameIdentityArray(
      census.semanticSourceIds,
      census.sourceFiles.map((sourceFile) => census.identityContext.sourceIdBySourceFile.get(sourceFile)!),
    )
  ) {
    censusInvariant("canonical-order", "canonical or semantic source order changed");
  }
  if (
    census.canonicalSources.length !== canonical.length ||
    census.sourcePlans.length !== census.sourceFiles.length ||
    census.canonicalSources.some(
      (sourcePlan, canonicalOrder) =>
        sourcePlan !== sourceById.get(canonical[canonicalOrder]) ||
        sourcePlan.canonicalOrder !== canonicalOrder ||
        sourcePlan.sourceId !== canonical[canonicalOrder],
    ) ||
    census.sourcePlans.some(
      (sourcePlan, semanticOrder) =>
        sourcePlan.semanticOrder !== semanticOrder || sourcePlan.sourceId !== census.semanticSourceIds[semanticOrder],
    )
  ) {
    censusInvariant("canonical-order", "retained canonical and semantic source projections diverged");
  }
  if (!census.parityObserved) return;
  const currentMetadata = metadata.ctx;
  if (!currentMetadata) censusInvariant("parity-changed", "observed census lost its queue context");
  const expectedLegacy = metadata.legacyByCensus.get(census);
  if (!expectedLegacy) censusInvariant("parity-changed", "observed census lost its queue snapshot");
  const current = captureLegacyObservation(census, { ctx: currentMetadata });
  for (const sourcePlan of census.sourcePlans) {
    const expected = expectedLegacy.get(sourcePlan.sourceFile);
    const actual = current.bySource.get(sourcePlan.sourceFile);
    if (!expected || !actual || !sameLegacySnapshot(actual, expected)) {
      censusInvariant("parity-changed", `legacy queue for ${sourcePlan.sourceId} changed after reconciliation`);
    }
    if (
      sourcePlan.parity &&
      !sameParity(
        reconcileIrModuleInitPlan(sourcePlan.plan, sourcePlan.sourceFile, {
          liveFunctionNames: actual.liveFunctionNames,
          staticEntries: actual.staticEntries,
          moduleStatements: actual.moduleStatements,
        }),
        sourcePlan.parity,
      )
    ) {
      censusInvariant("parity-changed", `legacy parity for ${sourcePlan.sourceId} changed after reconciliation`);
    }
  }
}
