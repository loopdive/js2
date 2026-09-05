// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * M2-P2A's initializer-only transaction.
 *
 * The existing multi-source owner has a useful detached component boundary,
 * but it is intentionally written for one function component at a time. This
 * coordinator supplies the missing whole-population boundary: classify every
 * source first, describe every source-local storage slot, reserve every
 * initializer, lower every body into a pending receipt, and expose one commit
 * operation for the owner. A failed later source therefore cannot publish an
 * earlier source's body or ABI scope.
 */

import type { MultiTypedAST } from "../checker/index.js";
import { irModuleGlobalBindingId, irModuleTdzGlobalBindingId } from "../ir/abi-bindings.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../ir/identity.js";
import type { IrModuleInitBindingIntent } from "../ir/module-init-plan.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrIntegrationReport } from "../ir/integration-report.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import type { IrSelection } from "../ir/select.js";
import type { GlobalDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import {
  compilePreparedProgramComponent,
  samePreparedIrResourceAllocatorSnapshot,
  type PreparedIrResourceCensus,
} from "../ir/integration.js";
import {
  abortPendingPreparedProgramComponentReceipt,
  takePendingPreparedProgramComponentReceipt,
  type PendingPreparedProgramComponentReceipt,
  type PreparedComponentPublicationToken,
} from "../ir/prepared-component-publication.js";
import type { CodegenContext, CodegenOptions } from "./context/types.js";
import { preallocateModuleInitCallable } from "./declarations.js";
import { prepareModuleTdzGlobals } from "./module-global-registration.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { IrOverlayPlan } from "./index.js";
import { addFuncType } from "./registry/types.js";
import type {
  MultiPreparedModuleInitCensus,
  MultiPreparedModuleInitSourceCensus,
} from "./multi-prepared-module-init-census.js";
import type {
  MultiPreparedModuleInitLexicalEvidence,
  MultiPreparedModuleInitPlanningInput,
  MultiPreparedModuleInitSourcePlan,
} from "./multi-prepared-module-init.js";

export interface MultiPreparedModuleInitStorageObservation {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly declaration: ts.VariableDeclaration;
  readonly declarationOrdinal: number;
  readonly name: string;
  readonly valueBindingId: IrBindingId;
  readonly value: GlobalDef;
  /** A declaration-bound TDZ slot that materialization must allocate. */
  readonly tdzAllocationIntent?: "required" | "elided";
  readonly tdzBindingId?: IrBindingId;
  readonly tdz?: GlobalDef;
  readonly storageOwnerUnitId: IrUnitId;
  readonly carrier: "f64" | "i32";
}

export interface MultiPreparedModuleInitBatchContributor {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly sourcePlan: MultiPreparedModuleInitSourcePlan;
  readonly plan: IrOverlayPlan;
  readonly selection: IrSelection;
  readonly storage: readonly MultiPreparedModuleInitStorageObservation[];
  readonly pendingReceipt: PendingPreparedProgramComponentReceipt;
  readonly preparedComponentId: string;
  readonly preparedFunction: WasmFunction;
  readonly preparedHandle: number;
  readonly report: IrIntegrationReport;
}

export interface MultiPreparedModuleInitBatchPreparation {
  readonly sourcePlans: readonly MultiPreparedModuleInitSourcePlan[];
  readonly contributors: readonly MultiPreparedModuleInitBatchContributor[];
  readonly storage: readonly MultiPreparedModuleInitStorageObservation[];
  readonly invocationKind: "wasm-start" | "deferred-export";
  readonly adapterHandle: number;
  readonly adapterFunction: WasmFunction;
  readonly adapterBody: readonly Instr[];
  readonly preparedComponentIds: readonly string[];
  readonly pendingReceipts: readonly PendingPreparedProgramComponentReceipt[];
  /** Complete built-IR/resource evidence consumed by the exact reservation. */
  readonly resourceCensus: PreparedIrResourceCensus;
  /** Revoke every detached initializer scope before owner registration/commit. */
  readonly abort: () => void;
  /** Commit every pending initializer scope exactly once after owner checks. */
  readonly commit: () => void;
}

export type MultiPreparedModuleInitBatchPlanningInput = Omit<MultiPreparedModuleInitPlanningInput, "census"> & {
  readonly census: MultiPreparedModuleInitCensus;
};

const MODULE_INIT_NAME = "<module-init>";

function sameIdentityArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function valueType(global: GlobalDef): "f64" | "i32" | undefined {
  if (global.type.kind === "f64") return "f64";
  if (global.type.kind === "i32") return "i32";
  return undefined;
}

function topLevelVariableDeclarations(sourceFile: ts.SourceFile): readonly ts.VariableDeclaration[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter((declaration): declaration is ts.VariableDeclaration =>
          ts.isVariableDeclaration(declaration),
        )
      : [],
  );
}

function sourceBindingDecls(
  sourceFile: ts.SourceFile,
  plan: MultiPreparedModuleInitSourcePlan,
): readonly { readonly declaration: ts.VariableDeclaration; readonly binding: IrModuleInitBindingIntent }[] {
  const declarations = topLevelVariableDeclarations(sourceFile);
  return plan.planning.plan.bindings.flatMap((binding) => {
    const declaration = declarations[binding.declarationOrdinal];
    return declaration === undefined ? [] : [{ declaration, binding }];
  });
}

function preclaimStorage(
  ctx: CodegenContext,
  sourcePlan: MultiPreparedModuleInitSourcePlan,
): {
  readonly observations?: readonly MultiPreparedModuleInitStorageObservation[];
  readonly gaps: readonly string[];
} {
  const sourceFile = sourcePlan.sourceFile;
  const unitId = sourcePlan.unitId;
  if (unitId === null) return { observations: Object.freeze([]), gaps: Object.freeze([]) };
  const sourceId = sourcePlan.sourceId;
  const observations: MultiPreparedModuleInitStorageObservation[] = [];
  const gaps: string[] = [];
  for (const { declaration, binding } of sourceBindingDecls(sourceFile, sourcePlan)) {
    if (!ts.isIdentifier(declaration.name)) {
      gaps.push(`${sourceId}:destructuring-binding:${binding.declarationOrdinal}`);
      continue;
    }
    const valueBindingId = irModuleGlobalBindingId(sourceId, binding.declarationOrdinal);
    const observed = ctx.programAbiGlobals?.moduleBinding(declaration);
    const carrier = observed?.value === undefined ? undefined : valueType(observed.value);
    const typeFact = ctx.oracle.typeFactOf(declaration.name);
    const exactType = typeFact.kind === "number" ? "f64" : typeFact.kind === "boolean" ? "i32" : undefined;
    if (
      !observed ||
      !ctx.mod.globals.includes(observed.value) ||
      !observed.value.mutable ||
      observed.value.name !== `__mod_${declaration.name.text}` ||
      carrier === undefined ||
      exactType === undefined ||
      carrier !== exactType
    ) {
      gaps.push(`${sourceId}:missing-or-unproven-value:${binding.declarationOrdinal}:${declaration.name.text}`);
      continue;
    }
    const requiresTdz = binding.tdzBindingId !== null;
    const tdzBindingId = requiresTdz ? irModuleTdzGlobalBindingId(sourceId, binding.declarationOrdinal) : undefined;
    const tdz = requiresTdz ? observed.tdz : undefined;
    if (
      requiresTdz &&
      (!tdzBindingId ||
        (tdz !== undefined &&
          (!ctx.mod.globals.includes(tdz) ||
            !tdz.mutable ||
            tdz.type.kind !== "i32" ||
            tdz.name !== `__tdz_${declaration.name.text}`)))
    ) {
      gaps.push(`${sourceId}:missing-or-unproven-tdz:${binding.declarationOrdinal}:${declaration.name.text}`);
      continue;
    }
    observations.push(
      Object.freeze({
        sourceId,
        unitId,
        declaration,
        declarationOrdinal: binding.declarationOrdinal,
        name: declaration.name.text,
        valueBindingId,
        value: observed.value,
        ...(requiresTdz ? { tdzAllocationIntent: "required" as const } : {}),
        ...(tdzBindingId ? { tdzBindingId } : {}),
        ...(tdz ? { tdz } : {}),
        storageOwnerUnitId: unitId,
        carrier,
      }),
    );
  }
  if (sourcePlan.planning.plan.bindings.length !== observations.length) {
    gaps.push(`${sourceId}:storage-population-incomplete`);
  }
  return gaps.length === 0
    ? { observations: Object.freeze(observations), gaps: Object.freeze([]) }
    : { gaps: Object.freeze(gaps) };
}

/**
 * Materialize the TDZ slots described by the exact declaration intents only
 * after the whole source population has passed the side-effect-free preclaim.
 * The existing declaration preparation helper owns elision and allocation;
 * this seam only re-reads its exact declaration observation. The later IR
 * resolver therefore consumes the allocator object authenticated here rather
 * than minting a name-compatible replacement.
 */
function materializePreparedStorageTdz(
  ctx: CodegenContext,
  observations: readonly MultiPreparedModuleInitStorageObservation[],
): readonly MultiPreparedModuleInitStorageObservation[] {
  const materialized = observations.map((observation) => {
    if (!observation.tdzAllocationIntent || !observation.tdzBindingId) return observation;
    prepareModuleTdzGlobals(ctx, observation.declaration.getSourceFile());
    const observed = ctx.programAbiGlobals?.moduleBinding(observation.declaration);
    const tdz = observed?.tdz;
    // The existing declaration policy may prove every read post-initializer
    // and deliberately elide the sidecar. That is retained semantic evidence,
    // rather than a missing allocation; only a retained sidecar must be bound
    // into the prepared observation below.
    if (!tdz) {
      const { tdzAllocationIntent: _tdzAllocationIntent, ...elided } = observation;
      return Object.freeze({ ...elided, tdzAllocationIntent: "elided" as const });
    }
    if (
      !ctx.mod.globals.includes(tdz) ||
      !tdz.mutable ||
      tdz.type.kind !== "i32" ||
      tdz.name !== `__tdz_${observation.name}`
    ) {
      throw new IrInvariantError(
        "unknown-global-ref",
        "build",
        `module-init: declaration-bound TDZ allocation for '${observation.name}' was not retained`,
      );
    }
    return Object.freeze({ ...observation, tdz });
  });
  return Object.freeze(materialized);
}

function storageIsUnique(observations: readonly MultiPreparedModuleInitStorageObservation[]): readonly string[] {
  const gaps: string[] = [];
  const values = new Map<GlobalDef, MultiPreparedModuleInitStorageObservation>();
  const tdzs = new Map<GlobalDef, MultiPreparedModuleInitStorageObservation>();
  for (const observation of observations) {
    const priorValue = values.get(observation.value);
    if (priorValue && priorValue !== observation) {
      gaps.push(
        `shared-value-global:${priorValue.sourceId}:${priorValue.declarationOrdinal}:${observation.sourceId}:${observation.declarationOrdinal}`,
      );
    } else values.set(observation.value, observation);
    if (observation.tdz) {
      const priorTdz = tdzs.get(observation.tdz);
      if (priorTdz && priorTdz !== observation) {
        gaps.push(
          `shared-tdz-global:${priorTdz.sourceId}:${priorTdz.declarationOrdinal}:${observation.sourceId}:${observation.declarationOrdinal}`,
        );
      } else tdzs.set(observation.tdz, observation);
    }
  }
  return Object.freeze(gaps);
}

function hasForbiddenModuleInitSyntax(sourceFile: ts.SourceFile, checker: ts.TypeChecker): boolean {
  let forbidden = false;
  const visit = (node: ts.Node): void => {
    if (forbidden) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isFunctionLike(node) ||
      ts.isClassExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      // P2A's retained initializer resource proof is scalar-only.  An array
      // literal can mint a vector type/allocator while lowering even when a
      // later optimizer would fold its selected element, so refuse it in the
      // source eligibility census before any slot or scope reservation.
      ts.isArrayLiteralExpression(node)
    ) {
      forbidden = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const resolved =
        symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
      const declarations = resolved?.declarations ?? [];
      if (declarations.some((declaration) => declaration.getSourceFile() !== sourceFile)) forbidden = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of collectModuleInitPopulation(sourceFile)) visit(statement);
  return forbidden;
}

function emptySelection(moduleInit: NonNullable<IrSelection["moduleInit"]>): IrSelection {
  return {
    funcs: new Set(),
    classMembers: new Set(),
    classMemberUnitIds: new Set(),
    moduleInit,
  };
}

interface PreparedReceiptPartition {
  readonly receipts: readonly PendingPreparedProgramComponentReceipt[];
  readonly byUnitId: ReadonlyMap<IrUnitId, PendingPreparedProgramComponentReceipt>;
}

interface PreparedTokenPartition {
  readonly tokens: readonly PreparedComponentPublicationToken[];
  readonly byUnitId: ReadonlyMap<IrUnitId, PreparedComponentPublicationToken>;
}

function partitionPreparedTokens(
  tokens: readonly PreparedComponentPublicationToken[],
  unitIds: readonly IrUnitId[],
): PreparedTokenPartition | undefined {
  if (tokens.length === 0 || unitIds.length === 0 || new Set(unitIds).size !== unitIds.length) return undefined;
  const expected = new Set(unitIds);
  const byUnitId = new Map<IrUnitId, PreparedComponentPublicationToken>();
  const componentIds = new Set<string>();
  for (const token of tokens) {
    if (
      token.terminalUnitIds.length === 0 ||
      token.terminalUnitIds.some((unitId) => !expected.has(unitId)) ||
      new Set(token.terminalUnitIds).size !== token.terminalUnitIds.length ||
      componentIds.has(token.preparedComponentId)
    ) {
      return undefined;
    }
    componentIds.add(token.preparedComponentId);
    for (const unitId of token.terminalUnitIds) {
      if (byUnitId.has(unitId)) return undefined;
      byUnitId.set(unitId, token);
    }
  }
  if (byUnitId.size !== unitIds.length || unitIds.some((unitId) => !byUnitId.has(unitId))) return undefined;
  return Object.freeze({ tokens, byUnitId });
}

/**
 * Validate the detached publication scopes as a partition of the exact
 * semantic terminal vector.  Components are allowed to remain independent;
 * only their union is ordered by the module-init census and startup adapter.
 */
function partitionPreparedReceipts(
  receipts: readonly PendingPreparedProgramComponentReceipt[] | undefined,
  unitIds: readonly IrUnitId[],
): PreparedReceiptPartition | undefined {
  if (
    !receipts ||
    receipts.length === 0 ||
    unitIds.length === 0 ||
    !Object.isFrozen(receipts) ||
    new Set(unitIds).size !== unitIds.length
  ) {
    return undefined;
  }
  const expected = new Set(unitIds);
  const byUnitId = new Map<IrUnitId, PendingPreparedProgramComponentReceipt>();
  const componentIds = new Set<string>();
  for (const receipt of receipts) {
    if (
      !Object.isFrozen(receipt.terminalUnitIds) ||
      receipt.terminalUnitIds.length === 0 ||
      receipt.terminalUnitIds.some((unitId) => !expected.has(unitId)) ||
      new Set(receipt.terminalUnitIds).size !== receipt.terminalUnitIds.length ||
      componentIds.has(receipt.preparedComponentId)
    ) {
      return undefined;
    }
    componentIds.add(receipt.preparedComponentId);
    for (const unitId of receipt.terminalUnitIds) {
      if (byUnitId.has(unitId)) return undefined;
      byUnitId.set(unitId, receipt);
    }
  }
  if (byUnitId.size !== unitIds.length || unitIds.some((unitId) => !byUnitId.has(unitId))) return undefined;
  return Object.freeze({ receipts, byUnitId });
}

function reportIsExact(
  report: IrIntegrationReport,
  receipts: readonly PendingPreparedProgramComponentReceipt[] | undefined,
  unitIds: readonly IrUnitId[],
): boolean {
  const partition = partitionPreparedReceipts(receipts, unitIds);
  if (!partition || partition.receipts.some((receipt) => receipt.report !== report)) return false;
  const artifacts = report.compiledArtifactEvidence ?? [];
  const evidence = report.terminalEvidence ?? [];
  return (
    report.errors.length === 0 &&
    report.compiled.length === unitIds.length &&
    report.compiled.every((name) => name === MODULE_INIT_NAME) &&
    (report.terminalCompiledOwners?.length ?? 0) === unitIds.length &&
    artifacts.length === unitIds.length &&
    artifacts.every(
      (artifact, index) =>
        artifact.artifactUnitId === unitIds[index] &&
        artifact.terminalOwnerUnitId === unitIds[index] &&
        artifact.name === MODULE_INIT_NAME &&
        artifact.preparedComponentId === partition.byUnitId.get(unitIds[index])?.preparedComponentId,
    ) &&
    evidence.length === unitIds.length &&
    evidence.every(
      (entry, index) =>
        entry.kind === "patched" &&
        entry.unitId === unitIds[index] &&
        entry.legacyName.startsWith(`${MODULE_INIT_NAME}@`) &&
        entry.preparedComponentId === partition.byUnitId.get(unitIds[index])?.preparedComponentId,
    ) &&
    (report.syntheticCompiledArtifacts?.length ?? 0) === 0 &&
    (report.preparedCountedStringAppendReceipts?.length ?? 0) === 0
  );
}

function resourceCensusIsExact(
  census: PreparedIrResourceCensus | undefined,
  unitIds: readonly IrUnitId[],
): census is PreparedIrResourceCensus {
  if (!census || !Object.isFrozen(census)) return false;
  const vectors = [
    census.artifactUnitIds,
    census.intrinsicIds,
    census.features,
    census.providerIds,
    census.hostCapabilityIds,
    census.backendRequirements,
  ];
  const allocatorSnapshotsExact =
    census.preLoweringAllocator !== undefined &&
    census.finalAllocator !== undefined &&
    Object.isFrozen(census.preLoweringAllocator) &&
    Object.isFrozen(census.finalAllocator) &&
    samePreparedIrResourceAllocatorSnapshot(census.preLoweringAllocator, census.finalAllocator) &&
    [
      census.preLoweringAllocator.types,
      census.preLoweringAllocator.imports,
      census.preLoweringAllocator.functions,
      census.preLoweringAllocator.globals,
      census.preLoweringAllocator.tags,
      census.preLoweringAllocator.stringPool,
      census.finalAllocator.types,
      census.finalAllocator.imports,
      census.finalAllocator.functions,
      census.finalAllocator.globals,
      census.finalAllocator.tags,
      census.finalAllocator.stringPool,
    ].every((vector) => Object.isFrozen(vector));
  return (
    vectors.every((vector) => Object.isFrozen(vector)) &&
    allocatorSnapshotsExact &&
    sameIdentityArray(census.artifactUnitIds, unitIds) &&
    new Set(census.artifactUnitIds).size === census.artifactUnitIds.length &&
    new Set(census.intrinsicIds).size === census.intrinsicIds.length &&
    new Set(census.features).size === census.features.length &&
    new Set(census.providerIds).size === census.providerIds.length &&
    new Set(census.hostCapabilityIds).size === census.hostCapabilityIds.length &&
    new Set(census.backendRequirements).size === census.backendRequirements.length
  );
}

function invariant(detail: string, cause?: unknown): never {
  throw new IrInvariantError("selection-preparation-mismatch", "patch", detail, cause);
}

function adapterType(ctx: CodegenContext): number {
  return addFuncType(ctx, [], [], "__ir_r5_m2p2a_module_init_adapter");
}

/**
 * Prepare every executable source-owned initializer and return one owner
 * transaction. `undefined` is a typed preclaim decline and is only possible
 * before any initializer slot or detached component has been created.
 */
export function planMultiPreparedModuleInitBatch(
  input: MultiPreparedModuleInitBatchPlanningInput,
): MultiPreparedModuleInitBatchPreparation | undefined {
  const { ctx, multiAst, census, options } = input;
  if (
    process.env.JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER !== "1" ||
    !options?.experimentalIR ||
    options.disableIrFirst ||
    multiAst.sourceFiles.length <= 1 ||
    ctx.fast ||
    ctx.wasi ||
    ctx.strictNoHostImports ||
    !ctx.programAbiSession ||
    !ctx.programAbiModuleInitCallables ||
    !census.parityObserved ||
    !census.sourcePlans.every((sourcePlan) => sourcePlan.parityAvailable && sourcePlan.planning && sourcePlan.parity)
  ) {
    return undefined;
  }
  if (
    census.sourcePlans.some(
      (sourcePlan) =>
        sourcePlan.plan.gaps.length !== 0 ||
        sourcePlan.planning?.plan.gaps.length !== 0 ||
        sourcePlan.planning?.parity.aligned !== true ||
        sourcePlan.plan.liveSeeds.length !== 0 ||
        hasForbiddenModuleInitSyntax(sourcePlan.sourceFile, multiAst.checker) ||
        sourcePlan.sourceFile.statements.some((statement) => ts.isClassDeclaration(statement)),
    )
  ) {
    return undefined;
  }

  const sourcePlans = Object.freeze(
    census.sourcePlans.map((sourcePlan): MultiPreparedModuleInitSourcePlan => {
      if (!sourcePlan.planning || !sourcePlan.parity) {
        return invariant(`source ${sourcePlan.sourceId} lost finalized module-init planning evidence`);
      }
      return Object.freeze({
        ...sourcePlan,
        planning: sourcePlan.planning,
        parity: sourcePlan.parity,
        parityAvailable: true,
      });
    }),
  );
  const resolvedPlans = new Map<ts.SourceFile, IrOverlayPlan>();
  const selections = new Map<ts.SourceFile, IrSelection>();
  let storages: MultiPreparedModuleInitStorageObservation[] = [];
  const preclaimGaps = new Map<ts.SourceFile, readonly string[]>();
  const executable = sourcePlans.filter((sourcePlan) => sourcePlan.executable && sourcePlan.unitId !== null);
  // Keep the established single-contributor M2 owner as the compatibility
  // route.  P2A's transaction boundary is exercised only when it has a real
  // multi-contributor population to make atomic; this also preserves the
  // singleton's deferred/WASI-specific lifecycle and evidence.
  if (executable.length < 2) return undefined;
  const invocationKind = executable[0]!.planning!.plan.invocation.kind;
  if (invocationKind !== "wasm-start" && invocationKind !== "deferred-export") {
    return undefined;
  }
  if (executable.some((sourcePlan) => sourcePlan.planning!.plan.invocation.kind !== invocationKind)) {
    return undefined;
  }
  for (const sourcePlan of sourcePlans) {
    const plan = input.planResolvedSource(sourcePlan.sourceFile);
    resolvedPlans.set(sourcePlan.sourceFile, plan);
    const selection = input.safeSelection(plan, sourcePlan.sourceFile);
    if (
      selection.funcs.size !== 0 ||
      (selection.classMembers?.size ?? 0) !== 0 ||
      (selection.classMemberUnitIds?.size ?? 0) !== 0 ||
      plan.importedCalls.size !== 0 ||
      plan.topLevelFunctionValues.size !== 0 ||
      plan.hostVoidCallbacks.size !== 0 ||
      plan.hostDateSnapshots.size !== 0 ||
      plan.hostDateGetters.size !== 0 ||
      plan.promiseDelays.constructions.size !== 0 ||
      plan.suspendingAsyncUnitIds.size !== 0
    ) {
      return undefined;
    }
    const moduleInit = plan.selection.moduleInit;
    if (sourcePlan.executable) {
      if (!moduleInit || moduleInit.reason !== null || moduleInit.stmtCount === 0 || sourcePlan.unitId === null) {
        return undefined;
      }
      const lexical = input.selectExactLexicalModuleInit(sourcePlan.sourceFile, { moduleInit }, sourcePlan.planning!);
      if (!lexical || lexical.unitId !== sourcePlan.unitId || lexical.invocationKind === "wasi-start-export") {
        return undefined;
      }
      selections.set(sourcePlan.sourceFile, emptySelection(moduleInit));
      const storage = preclaimStorage(ctx, sourcePlan);
      if (!storage.observations) {
        // Describe every source before deciding that the batch is ineligible.
        // A first missing TDZ/value slot must not hide a second contributor's
        // independent capability gap from the owner audit.
        preclaimGaps.set(sourcePlan.sourceFile, Object.freeze([...storage.gaps]));
      } else {
        storages.push(...storage.observations);
      }
    } else if (moduleInit !== undefined && moduleInit.stmtCount !== 0) {
      return undefined;
    }
  }
  if (preclaimGaps.size !== 0) {
    ctx.irProgramPreparedModuleInitBatchPreclaimGaps = new Map(preclaimGaps);
    return undefined;
  }
  const storageGaps = storageIsUnique(storages);
  if (storageGaps.length !== 0) {
    ctx.irProgramPreparedModuleInitBatchPreclaimGaps = new Map([[multiAst.entryFile, Object.freeze([...storageGaps])]]);
    return undefined;
  }
  // The source census only describes exact declaration-bound storage. Once
  // every contributor has passed that side-effect-free check, run the existing
  // declaration preparation policy once for each owner and retain its actual
  // TDZ allocator objects before any aggregate IR build or exact reservation.
  storages = [...materializePreparedStorageTdz(ctx, storages)];
  const materializedStorageGaps = storageIsUnique(storages);
  if (materializedStorageGaps.length !== 0) {
    ctx.irProgramPreparedModuleInitBatchPreclaimGaps = new Map([
      [multiAst.entryFile, Object.freeze([...materializedStorageGaps])],
    ]);
    return undefined;
  }
  if (ctx.irProgramPreparedModuleInitBatchPreclaimGaps) ctx.irProgramPreparedModuleInitBatchPreclaimGaps = undefined;

  const registry = ctx.programAbiModuleInitCallables;
  const unitIds = executable.map((sourcePlan) => sourcePlan.unitId!);
  const preparedBuildSources = executable.map((sourcePlan) => {
    const sourceFile = sourcePlan.sourceFile;
    const plan = resolvedPlans.get(sourceFile);
    const selection = selections.get(sourceFile);
    if (!plan || !selection) return invariant(`source ${sourcePlan.sourceId} lost its resolved initializer plan`);
    return {
      sourceFile,
      selection,
      overrides: plan.overrideMap,
      classShapes: plan.classShapes,
      loweringPlans: input.projectLoweringPlans(plan, selection),
    };
  });
  // Preallocation is the legacy declaration slot, not the Prepared
  // reservation. It is required by the AST→IR builder, while the exact
  // semantic reservation below remains behind the complete multi-source
  // build/resource preparation transaction.
  for (const sourcePlan of executable) {
    preallocateModuleInitCallable(ctx, sourcePlan.sourceFile, { publishDeferredExport: false });
  }

  // The graph adapter is a planned compiler-support callable, so allocate its
  // stable type/handle before the aggregate integration starts.  This makes
  // the adapter part of the integration resource snapshots instead of a
  // post-census append; its body is filled from the already-known source
  // handles and is reserved only after every detached source receipt passes.
  const adapterTypeIdx = adapterType(ctx);
  const adapterHandle = mintDefinedFunc(ctx);
  const adapterBody = Object.freeze(
    unitIds.map((unitId): Instr => {
      const handle = registry.handleForUnit(unitId);
      if (handle === undefined) return invariant(`source ${unitId} lost its exact preallocated module-init handle`);
      return { op: "call", funcIdx: handle };
    }),
  );
  const adapterFunction: WasmFunction = {
    name: "__ir_r5_m2p2a_module_init_adapter",
    typeIdx: adapterTypeIdx,
    locals: [],
    body: [...adapterBody],
    exported: false,
  };
  pushDefinedFunc(ctx, adapterHandle, adapterFunction);

  const receipts: PendingPreparedProgramComponentReceipt[] = [];
  const contributors: MultiPreparedModuleInitBatchContributor[] = [];
  let committed = false;
  let aborted = false;
  const abortAll = (): void => {
    for (const receipt of receipts) {
      try {
        abortPendingPreparedProgramComponentReceipt(receipt);
      } catch {
        // Keep the first invariant/failure as the diagnostic authority.
      }
    }
  };
  const abort = (): void => {
    // A committed receipt has no revocable pending capability.  The owner may
    // still call this from a broad catch after the no-throw publication phase;
    // treating that call as idempotent avoids turning the original failure into
    // a misleading "already published" diagnostic.
    if (committed || aborted) return;
    aborted = true;
    abortAll();
  };
  try {
    const first = executable[0];
    const firstBuild = preparedBuildSources[0];
    if (!first || !firstBuild) return invariant("initializer batch has no first prepared build input");
    // One integration call owns the complete BuiltFn vector. It performs the
    // AST→IR build for every source, then common hygiene/resource preparation,
    // then detached lowering; no source can reserve or publish ahead of a
    // later contributor's build.
    const result = compilePreparedProgramComponent(
      ctx,
      first.sourceFile,
      firstBuild.selection,
      firstBuild.overrides,
      firstBuild.classShapes,
      firstBuild.loweringPlans,
      {
        integrationSourceFiles: sourcePlans.map(({ sourceFile }) => sourceFile),
        preparedModuleInitBatch: true,
        preparedModuleInitBatchSources: preparedBuildSources,
      },
    );
    const receiptPartition = partitionPreparedReceipts(
      result.pendingReceipts ?? (result.pendingReceipt ? Object.freeze([result.pendingReceipt]) : undefined),
      unitIds,
    );
    const reportExact = receiptPartition ? reportIsExact(result.report, receiptPartition.receipts, unitIds) : false;
    const censusExact = resourceCensusIsExact(result.resourceCensus, unitIds);
    if (!receiptPartition || !reportExact || !censusExact) {
      for (const receipt of receiptPartition?.receipts ?? []) receipt.abort();
      // A known per-owner preparation/resource refusal is a typed decline of
      // this aggregate route.  Keep its exact terminal details as an explicit
      // preclaim gap so the legacy route can report the refusal without
      // turning a late resource check into a generated-code error.  Structural
      // receipt corruption remains an invariant below.
      if (
        result.report.errors.length > 0 ||
        (result.report.terminalEvidence ?? []).some((entry) => entry.kind === "failed")
      ) {
        const details = [
          ...result.report.errors.map(({ outcome }) => `${outcome.code}:${outcome.detail}`),
          ...(result.report.terminalEvidence ?? [])
            .filter((entry): entry is Extract<typeof entry, { kind: "failed" }> => entry.kind === "failed")
            .flatMap((entry) => (entry.errors ?? []).map(({ outcome }) => `${outcome.code}:${outcome.detail}`)),
        ];
        ctx.irProgramPreparedModuleInitBatchPreclaimGaps = new Map([
          [multiAst.entryFile, Object.freeze(details.length > 0 ? details : ["resource-census-unavailable"])],
        ]);
        return undefined;
      }
      return invariant("initializer batch did not produce one exact detached module-init/resource receipt");
    }
    receipts.push(...receiptPartition.receipts);
    for (let index = 0; index < executable.length; index++) {
      const sourcePlan = executable[index]!;
      const sourceFile = sourcePlan.sourceFile;
      const plan = resolvedPlans.get(sourceFile);
      const selection = selections.get(sourceFile);
      if (!plan || !selection) return invariant(`source ${sourcePlan.sourceId} lost its resolved initializer plan`);
      const preparedFunction = registry.functionForUnit(sourcePlan.unitId!);
      const preparedHandle = registry.handleForUnit(sourcePlan.unitId!);
      if (!preparedFunction || preparedHandle === undefined) {
        return invariant(`source ${sourcePlan.sourceId} lost its exact preallocated module-init function`);
      }
      const terminalEvidence = (result.report.terminalEvidence ?? []).find(
        (entry) => entry.kind === "patched" && entry.unitId === sourcePlan.unitId,
      );
      if (!terminalEvidence || terminalEvidence.kind !== "patched") {
        return invariant(`source ${sourcePlan.sourceId} detached receipt has no patched terminal evidence`);
      }
      const receipt = receiptPartition.byUnitId.get(sourcePlan.unitId!);
      if (!receipt) return invariant(`source ${sourcePlan.sourceId} has no exact prepared component receipt`);
      contributors.push(
        Object.freeze({
          sourceFile,
          sourceId: sourcePlan.sourceId,
          unitId: sourcePlan.unitId!,
          sourcePlan,
          plan,
          selection,
          storage: Object.freeze(storages.filter((observation) => observation.sourceId === sourcePlan.sourceId)),
          pendingReceipt: receipt,
          preparedComponentId: receipt.preparedComponentId,
          preparedFunction,
          preparedHandle,
          report: result.report,
        }),
      );
    }
    if (
      contributors.length !== executable.length ||
      new Set(contributors.map(({ unitId }) => unitId)).size !== executable.length
    ) {
      return invariant("initializer batch receipt population is not exact");
    }
    // The registry reservation follows the complete build, common resource
    // census, and detached receipt. A late contributor failure therefore
    // leaves no successful Prepared reservation prefix.
    registry.reservePreparedExactUnits(unitIds);
    registry.reservePreparedGraphAdapter(adapterHandle, adapterFunction, unitIds);
    const commit = (): void => {
      if (committed) {
        invariant("initializer batch commit was requested twice");
        return;
      }
      if (aborted) {
        invariant("initializer batch commit was requested after abort");
        return;
      }
      try {
        for (const receipt of receipts) receipt.assertCurrent();
        const tokens: PreparedComponentPublicationToken[] = receipts.map((receipt) =>
          takePendingPreparedProgramComponentReceipt(receipt),
        );
        const tokenPartition = partitionPreparedTokens(tokens, unitIds);
        if (!tokenPartition) {
          invariant("initializer batch receipt order changed before commit");
          return;
        }
        ctx.programAbiSession!.commitPreparedScopes(tokens.map((token) => token.pendingScope));
        for (const token of tokens) token.publishBodies();
        committed = true;
      } catch (error) {
        abort();
        throw error;
      }
    };
    return Object.freeze({
      sourcePlans,
      contributors: Object.freeze(contributors),
      storage: Object.freeze(storages),
      invocationKind,
      adapterHandle,
      adapterFunction,
      adapterBody,
      preparedComponentIds: Object.freeze(receipts.map((receipt) => receipt.preparedComponentId)),
      pendingReceipts: Object.freeze(receipts),
      resourceCensus: result.resourceCensus,
      abort,
      commit,
    });
  } catch (error) {
    abort();
    throw error;
  }
}
