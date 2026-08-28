// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The M0 whole-program owner for the multi-source Prepared routes.
 *
 * This module deliberately does not decide whether a route is eligible and it
 * does not publish the Program ABI.  The existing route planners remain the
 * authorities for those decisions.  The owner authenticates their result
 * against the one planning identity context, freezes the source/unit census,
 * and supplies the phase-checked state consumed by both codegen loops.
 */

import type { MultiTypedAST } from "../checker/index.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import type { IrSourceId, IrSourceKind, IrTerminalUnitRecord, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import type { IrIntegrationReport } from "../ir/integration-report.js";
import { requireValidPreparedCountedStringAppendReceipt } from "../ir/counted-string-append-provenance.js";
import { IrInvariantError, type IrObservedOutcome } from "../ir/outcomes.js";
import type { IrLegacyUnitProjectionEntry, IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSelection } from "../ir/select.js";
import type { Instr, WasmFunction, WasmModule } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, CodegenOptions } from "./context/types.js";
import {
  EMPTY_MULTI_PREPARED_ROUTE_CLAIMS,
  extendMultiPreparedRouteClaims,
  compileMultiPreparedScalarLeafDeclarations,
  planEarlyMultiPreparedScalarLeafRoute,
  type EarlyMultiPreparedScalarLeafState,
  type MultiPreparedFunctionValuePlan,
  type MultiPreparedFunctionValueSupportReceipt,
  type MultiPreparedScalarLeafGraphSafety,
  type MultiPreparedRouteClaimSnapshot,
} from "./multi-prepared-scalar-leaf.js";
import { planEarlyMultiPreparedArrayLeafRoute } from "./multi-prepared-array-leaf.js";
import { planEarlyMultiPreparedFunctionValueRoutes } from "./multi-prepared-fibonacci-pair.js";
import {
  planEarlyMultiPreparedStringLeafRoute,
  type MultiPreparedStringLeafProofContext,
  type MultiPreparedStringLeafShape,
} from "./multi-prepared-string-leaf.js";
import type {
  MultiPreparedEarlyLeafRoute,
  MultiPreparedScalarLeafPlan,
  MultiPreparedScalarLeafReceipt,
} from "./multi-prepared-scalar-leaf.js";
import type { PreparedIrFreeFunctionBodies } from "./ir-prepared-free-functions.js";
import type { MultiPreparedModuleInitPreparation } from "./multi-prepared-module-init.js";
import type { ModuleInitMode } from "./declarations.js";
import type { ProgramAbiSession, PublishedProgramAbi } from "./program-abi-session.js";
import type { IrExactFunctionClaim } from "./ir-overlay-safety.js";

export type MultiPreparedProgramState =
  | "collecting"
  | "body-boundary-sealed"
  | "routes-complete"
  | "complete"
  | "failed";

export type MultiPreparedProgramRouteKind =
  | "scalar"
  | "array"
  | "string"
  | "function-value"
  | "fibonacci-pair"
  | "cross-source-callable"
  | "module-init";

export interface MultiPreparedProgramSourceCensus {
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly canonicalOrder: number;
  readonly semanticOrder: number;
  readonly kind: IrSourceKind;
  readonly terminalUnitIds: readonly IrUnitId[];
}

export interface MultiPreparedProgramReservation {
  readonly unitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly routeKind: MultiPreparedProgramRouteKind;
  readonly preparedComponentId: string;
  readonly preparedBeforeDirectBodies: true;
}

/** The frozen M0 source/unit/reservation denominator. */
export interface MultiPreparedProgramBodyPlan<Plan = unknown> {
  readonly schema: "multi-prepared-program-body-plan-v1";
  readonly entrySourceId: IrSourceId;
  readonly canonicalSourceIds: readonly IrSourceId[];
  readonly semanticSourceIds: readonly IrSourceId[];
  readonly expectedBodySourceIds: readonly IrSourceId[];
  readonly expectedOverlaySourceIds: readonly IrSourceId[];
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly sources: readonly MultiPreparedProgramSourceCensus[];
  readonly reservations: readonly MultiPreparedProgramReservation[];
  readonly unreservedTerminalUnitIds: readonly IrUnitId[];
  /** Keeps the public shape honest without exposing route plans. */
  readonly _planType?: Plan;
}

export interface MultiPreparedProgramAudit {
  readonly schema: "multi-prepared-program-audit-v1";
  readonly bodyPlan: MultiPreparedProgramBodyPlan;
  readonly bodySourceIds: readonly IrSourceId[];
  readonly overlaySourceIds: readonly IrSourceId[];
  readonly abiSessionBound: true;
  readonly moduleInit?: MultiPreparedProgramModuleInitAudit;
}

export interface MultiPreparedProgramModuleInitAudit {
  readonly schema: "multi-prepared-program-module-init-audit-v1";
  readonly sourcePlans: readonly {
    readonly sourceId: IrSourceId;
    readonly unitId: IrUnitId | null;
    readonly executable: boolean;
    readonly evaluationCount: number;
  }[];
  readonly executablePlanCount: 1;
  readonly emptyPlanCount: number;
  readonly contributorSourceId: IrSourceId;
  readonly contributorUnitId: IrUnitId;
  readonly preparedComponentId: string;
  readonly invocationKind: "wasm-start" | "deferred-export";
  readonly directCompileModuleInitBodyRoots: number;
  readonly irBodyEmissions: 1;
}

/** The overlay consumer is run only after the owner authenticates its report. */
export interface MultiPreparedProgramOverlayResult {
  readonly report: IrIntegrationReport;
  readonly consume: () => void;
}

export interface MultiPreparedProgramRoutePlanners<Plan extends MultiPreparedScalarLeafPlan> {
  readonly scalar: (
    claimedRouteClaims?: MultiPreparedRouteClaimSnapshot,
  ) => ReadonlyMap<import("../ts-api.js").ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>;
  readonly array: (
    claimedRouteClaims?: MultiPreparedRouteClaimSnapshot,
  ) => ReadonlyMap<import("../ts-api.js").ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>;
  readonly string?: (
    claimedRouteClaims: MultiPreparedRouteClaimSnapshot,
  ) => ReadonlyMap<import("../ts-api.js").ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>;
  readonly functionValue: (
    claimedRouteClaims?: MultiPreparedRouteClaimSnapshot,
  ) => ReadonlyMap<import("../ts-api.js").ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>;
  readonly fibonacciPair: (
    claimedRouteClaims?: MultiPreparedRouteClaimSnapshot,
  ) => ReadonlyMap<import("../ts-api.js").ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>;
}

export interface MultiPreparedProgramEarlyRouteInput<Plan extends MultiPreparedFunctionValuePlan> {
  readonly active: boolean;
  readonly scalarCutoverEnabled: boolean;
  readonly arrayCutoverEnabled: boolean;
  readonly stringCutoverEnabled: boolean;
  readonly stringProofContext: MultiPreparedStringLeafProofContext;
  readonly functionValueLeafCutoverEnabled: boolean;
  readonly fibonacciPairCutoverEnabled: boolean;
  readonly ctx: CodegenContext;
  readonly sourceFiles: readonly SourceFile[];
  readonly entryFile: SourceFile;
  readonly safety: () => MultiPreparedScalarLeafGraphSafety;
  readonly planSource: (sourceFile: SourceFile, stringShape?: MultiPreparedStringLeafShape) => Plan;
  readonly stringShapes?: readonly MultiPreparedStringLeafShape[];
  readonly safeSelection: (
    plan: Plan,
    sourceFile: SourceFile,
    safety: MultiPreparedScalarLeafGraphSafety,
  ) => IrSelection;
  readonly lateProviderOwnerUnitIds: (plan: Plan, sourceFile: SourceFile) => ReadonlySet<IrUnitId>;
  readonly hasForeignLateProvider: (
    plan: Plan,
    sourceFile: SourceFile,
    unitId: IrUnitId,
    functionValueTarget: boolean,
  ) => boolean;
  readonly prepareFunctionValueSupport: (
    plan: Plan,
    sourceFile: SourceFile,
    unitId: IrUnitId,
    legacyName: string,
  ) => MultiPreparedFunctionValueSupportReceipt | undefined;
  readonly projectLoweringPlans: (plan: Plan, selection: IrSelection) => IrIntegrationLoweringPlans;
}

export interface MultiPreparedProgramOwnerInput {
  readonly multiAst: MultiTypedAST;
  readonly identityContext: IrPlanningIdentityContext;
  readonly programAbiSession: ProgramAbiSession;
  readonly ctx: CodegenContext;
  /** Whether the existing late overlay loop will run for this compilation. */
  readonly overlayEnabled: boolean;
}

export type MultiPreparedProgramInvariantCode =
  | "construction-session-mismatch"
  | "construction-source-count"
  | "construction-source-join"
  | "construction-entry-source"
  | "construction-canonical-order"
  | "construction-terminal-denominator"
  | "routes-already-planned"
  | "duplicate-route-source"
  | "foreign-route-source"
  | "route-plan-mismatch"
  | "route-source-mismatch"
  | "route-unit-mismatch"
  | "route-receipt-mismatch"
  | "route-report-mismatch"
  | "route-support-mismatch"
  | "duplicate-reservation-unit"
  | "duplicate-reservation-component"
  | "invalid-reservation-unit"
  | "body-plan-mismatch"
  | "body-phase-order"
  | "overlay-phase-order"
  | "body-skip-mismatch"
  | "routes-incomplete"
  | "completion-order"
  | "publication-inventory-mismatch"
  | "module-init-plan-mismatch"
  | "module-init-reservation-mismatch"
  | "module-init-body-skip-mismatch"
  | "module-init-startup-mismatch"
  | "owner-failed";

/** The owner keeps its stable sub-code alongside the normal IR invariant kind. */
export type MultiPreparedProgramInvariantError = IrInvariantError & {
  readonly multiPreparedProgramCode: MultiPreparedProgramInvariantCode;
};

type SourceFile = import("../ts-api.js").ts.SourceFile;
type RouteState<Plan extends MultiPreparedScalarLeafPlan> = EarlyMultiPreparedScalarLeafState<Plan>;

/**
 * Exact aggregate callable component prepared before any source body pass.
 * Names are local compatibility labels; unit/declaration/source joins are the
 * authoritative identity used by the owner.
 */
export interface MultiPreparedProgramCallableComponent {
  readonly preparedComponentId: string;
  readonly units: readonly {
    readonly sourceFile: SourceFile;
    readonly sourceId: IrSourceId;
    readonly unitId: IrUnitId;
    readonly legacyName: string;
    readonly declaration: import("../ts-api.js").ts.FunctionDeclaration;
  }[];
  /** Optional post-integration freshness assertion owned by the planner. */
  readonly assertCurrent?: () => void;
}

interface RouteSlot {
  readonly declaration: import("../ts-api.js").ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly receipt: MultiPreparedScalarLeafReceipt;
  readonly allocatedFunction: WasmFunction;
  readonly preparedBody: WasmFunction["body"];
  readonly preparedInstructions: readonly Instr[];
}

interface SupportSnapshot {
  readonly support: object;
  readonly fields: readonly [string, unknown][];
}

interface RouteSnapshot<Plan extends MultiPreparedScalarLeafPlan> {
  readonly sourceFile: SourceFile;
  readonly sourceId: IrSourceId;
  readonly state: RouteState<Plan>;
  readonly plan: Plan;
  readonly route: MultiPreparedEarlyLeafRoute;
  readonly slots: readonly RouteSlot[];
  readonly claims: readonly IrExactFunctionClaim[];
  readonly componentId: string;
  readonly preparedReport: IrIntegrationReport;
  readonly preparedFreeFunctions: PreparedIrFreeFunctionBodies;
  readonly preparedSelection: import("../ir/select.js").IrSelection;
  readonly requestedProjection: object;
  readonly completedBodies: object;
  readonly skipBodies: object;
  readonly preserveBodies: object;
  readonly support?: SupportSnapshot;
}

function routeInvariant(code: MultiPreparedProgramInvariantCode, detail: string): never {
  const error = new IrInvariantError(
    "selection-preparation-mismatch",
    "resolve",
    `multi-prepared-program:${code}: ${detail}`,
  ) as MultiPreparedProgramInvariantError;
  Object.defineProperty(error, "multiPreparedProgramCode", { value: code, enumerable: true });
  throw error;
}

function sameArray<T>(actual: readonly T[] | undefined, expected: readonly T[]): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function sameSet<T>(actual: ReadonlySet<T> | undefined, expected: readonly T[]): boolean {
  return actual !== undefined && actual.size === expected.length && expected.every((value) => actual.has(value));
}

function sameProjection(actual: readonly IrLegacyUnitProjectionEntry[], expected: readonly RouteSlot[]): boolean {
  if (actual.length !== expected.length) return false;
  const byUnit = new Map(actual.map((entry) => [entry.unitId, entry.legacyName]));
  return byUnit.size === expected.length && expected.every((slot) => byUnit.get(slot.unitId) === slot.legacyName);
}

function sameIdentityArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function snapshotSupport(support: object | undefined): SupportSnapshot | undefined {
  if (!support) return undefined;
  const fields = Object.keys(support).map(
    (key) => [key, (support as Record<string, unknown>)[key]] as [string, unknown],
  );
  return { support, fields };
}

function supportIsCurrent(snapshot: SupportSnapshot | undefined, support: object | undefined): boolean {
  if (snapshot === undefined || support === undefined || support !== snapshot.support) return snapshot === support;
  return (
    Object.keys(support).length === snapshot.fields.length &&
    snapshot.fields.every(([key, value]) => (support as Record<string, unknown>)[key] === value)
  );
}

function slotsForRoute(route: MultiPreparedEarlyLeafRoute): readonly RouteSlot[] {
  const slots: RouteSlot[] = [
    {
      declaration: route.declaration,
      unitId: route.unitId,
      legacyName: route.legacyName,
      receipt: route.receipt,
      allocatedFunction: route.allocatedFunction,
      preparedBody: route.preparedBody,
      preparedInstructions: route.preparedInstructions,
    },
  ];
  if (route.routeKind === "fibonacci-pair") {
    slots.push({
      declaration: route.recursiveDeclaration,
      unitId: route.recursiveUnitId,
      legacyName: route.recursiveName,
      receipt: route.recursiveReceipt,
      allocatedFunction: route.recursiveAllocatedFunction,
      preparedBody: route.recursivePreparedBody,
      preparedInstructions: route.recursivePreparedInstructions,
    });
  }
  return slots;
}

function routeSupport(route: MultiPreparedEarlyLeafRoute): object | undefined {
  if (route.routeKind === "scalar") return undefined;
  if (route.routeKind === "array") return route.support;
  return route.support;
}

function routeComponentId(route: MultiPreparedEarlyLeafRoute, slots: readonly RouteSlot[]): string {
  if (route.routeKind === "fibonacci-pair") return route.preparedComponentId;
  const receipt = slots[0]?.receipt;
  if (!receipt || receipt.kind !== "prepared") {
    return routeInvariant("route-receipt-mismatch", `${route.routeKind} has no prepared component receipt`);
  }
  return receipt.preparedComponentId;
}

function inventorySource(inventory: IrUnitInventory, sourceId: IrSourceId) {
  return inventory.sources.find((source) => source.id === sourceId);
}

export function createMultiPreparedProgramOwner<Plan extends MultiPreparedScalarLeafPlan = MultiPreparedScalarLeafPlan>(
  multiAst: MultiTypedAST,
  options: CodegenOptions | undefined,
  ctx: CodegenContext,
): MultiPreparedProgramOwner<Plan> | undefined {
  ctx.irBodyRouteAuditSession?.registerGenerator("multi", "generateMultiModule");
  const { irPlanningIdentityContext: identityContext, programAbiSession } = ctx;
  if (!identityContext || !programAbiSession) return undefined;
  return new MultiPreparedProgramOwner<Plan>({
    multiAst,
    identityContext,
    programAbiSession,
    ctx,
    overlayEnabled: !!options?.experimentalIR && !ctx.fast,
  });
}

export class MultiPreparedProgramOwner<Plan extends MultiPreparedScalarLeafPlan = MultiPreparedScalarLeafPlan> {
  readonly #multiAst: MultiTypedAST;
  readonly #identityContext: IrPlanningIdentityContext;
  readonly #programAbiSession: ProgramAbiSession;
  readonly #ctx: CodegenContext;
  readonly #overlayEnabled: boolean;
  readonly #entryFile: SourceFile;
  readonly #astSourceFiles: readonly SourceFile[];
  readonly #sourceFiles: readonly SourceFile[];
  readonly #inventory: IrUnitInventory;
  readonly #sources: IrUnitInventory["sources"];
  readonly #terminalUnits: readonly IrTerminalUnitRecord[];
  readonly #sourceMap: ReadonlyMap<SourceFile, IrSourceId>;
  readonly #reverseSourceMap: ReadonlyMap<IrSourceId, SourceFile>;
  readonly #terminalMap: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly #unitMap: ReadonlyMap<IrUnitId, IrUnitInventory["allUnits"][number]>;
  readonly #states = new Map<SourceFile, RouteState<Plan>>();
  readonly #callableComponents: MultiPreparedProgramCallableComponent[] = [];
  readonly #callableComponentByUnitId = new Map<IrUnitId, MultiPreparedProgramCallableComponent>();
  readonly #callableComponentsBySourceFile = new Map<SourceFile, MultiPreparedProgramCallableComponent[]>();
  readonly #callableSkippedUnitIds = new Set<IrUnitId>();
  readonly #callableSkippedUnitIdsBySourceFile = new Map<SourceFile, Set<IrUnitId>>();
  #moduleInitPreparation: MultiPreparedModuleInitPreparation | undefined;
  readonly #moduleInitSkippedSourceFiles = new Set<SourceFile>();
  #moduleInitFinalized = false;
  #moduleInitTelemetryRecorded = false;
  readonly #routeSnapshots: RouteSnapshot<Plan>[] = [];
  #claimedRouteClaims: MultiPreparedRouteClaimSnapshot = EMPTY_MULTI_PREPARED_ROUTE_CLAIMS;
  readonly #bodySourceIds: IrSourceId[] = [];
  readonly #overlaySourceIds: IrSourceId[] = [];
  #bodyPlan: MultiPreparedProgramBodyPlan | undefined;
  #audit: MultiPreparedProgramAudit | undefined;
  #publication: PublishedProgramAbi | undefined;
  #routesPlanned = false;
  #bodyCursor = 0;
  #overlayCursor = 0;
  #state: MultiPreparedProgramState = "collecting";

  constructor(input: MultiPreparedProgramOwnerInput) {
    this.#multiAst = input.multiAst;
    this.#identityContext = input.identityContext;
    this.#programAbiSession = input.programAbiSession;
    this.#ctx = input.ctx;
    this.#overlayEnabled = input.overlayEnabled;
    this.#entryFile = input.multiAst.entryFile;
    this.#astSourceFiles = input.multiAst.sourceFiles;
    this.#sourceFiles = Object.freeze([...input.multiAst.sourceFiles]);
    this.#inventory = input.identityContext.inventory;
    this.#sources = Object.freeze([...input.identityContext.inventory.sources]);
    this.#terminalUnits = Object.freeze([...input.identityContext.inventory.terminalUnits]);
    this.#sourceMap = input.identityContext.sourceIdBySourceFile;
    this.#reverseSourceMap = input.identityContext.sourceFileBySourceId;
    this.#terminalMap = input.identityContext.terminalByUnitId;
    this.#unitMap = input.identityContext.unitByUnitId;
    this.#validateConstruction();
  }

  get state(): MultiPreparedProgramState {
    return this.#state;
  }

  get bodyPlan(): MultiPreparedProgramBodyPlan | undefined {
    return this.#bodyPlan;
  }

  get audit(): MultiPreparedProgramAudit | undefined {
    return this.#audit;
  }

  /** Run the existing route planners through this one source-owned ledger. */
  planExistingRoutes(input: MultiPreparedProgramEarlyRouteInput<Plan & MultiPreparedFunctionValuePlan>): void {
    this.planEarlyRoutes({
      scalar: () =>
        planEarlyMultiPreparedScalarLeafRoute({
          active: input.active,
          cutoverEnabled: input.scalarCutoverEnabled,
          ctx: input.ctx,
          sourceFiles: input.sourceFiles,
          entryFile: input.entryFile,
          safety: input.safety,
          planSource: input.planSource,
          safeSelection: input.safeSelection,
          lateProviderOwnerUnitIds: input.lateProviderOwnerUnitIds,
          projectLoweringPlans: input.projectLoweringPlans,
        }),
      array: () =>
        planEarlyMultiPreparedArrayLeafRoute({
          active: input.active,
          cutoverEnabled: input.arrayCutoverEnabled,
          ctx: input.ctx,
          sourceFiles: input.sourceFiles,
          entryFile: input.entryFile,
          safety: input.safety,
          planSource: input.planSource,
          safeSelection: input.safeSelection,
          lateProviderOwnerUnitIds: input.lateProviderOwnerUnitIds,
          prepareFunctionValueSupport: input.prepareFunctionValueSupport,
          projectLoweringPlans: input.projectLoweringPlans,
          claimedRouteClaims: this.#claimedRouteClaims,
        }),
      string: () =>
        planEarlyMultiPreparedStringLeafRoute({
          active: input.active,
          cutoverEnabled: input.stringCutoverEnabled,
          ctx: input.ctx,
          proofContext: input.stringProofContext,
          sourceFiles: input.sourceFiles,
          entryFile: input.entryFile,
          safety: input.safety,
          planSource: input.planSource,
          safeSelection: input.safeSelection,
          hasForeignLateProvider: (plan, sourceFile, unitId) =>
            input.hasForeignLateProvider(plan, sourceFile, unitId, true),
          prepareFunctionValueSupport: input.prepareFunctionValueSupport,
          projectLoweringPlans: input.projectLoweringPlans,
          shapes: input.stringShapes ?? [],
          claimedRouteClaims: this.#claimedRouteClaims,
        }),
      functionValue: () =>
        planEarlyMultiPreparedFunctionValueRoutes({
          active: input.active,
          leafCutoverEnabled: input.functionValueLeafCutoverEnabled,
          fibonacciPairCutoverEnabled: input.fibonacciPairCutoverEnabled,
          ctx: input.ctx,
          sourceFiles: input.sourceFiles,
          entryFile: input.entryFile,
          safety: input.safety,
          planSource: input.planSource,
          safeSelection: input.safeSelection,
          hasForeignLateProvider: input.hasForeignLateProvider,
          prepareFunctionValueSupport: input.prepareFunctionValueSupport,
          projectLoweringPlans: input.projectLoweringPlans,
          claimedRouteClaims: this.#claimedRouteClaims,
        }),
      // The function-value planner owns both the leaf and Fibonacci pair.
      fibonacciPair: () => new Map(),
    });
  }

  /** Merge the existing route planner outputs under this owner. */
  planEarlyRoutes(planners: MultiPreparedProgramRoutePlanners<Plan>): void {
    this.#requireState("collecting");
    if (this.#routesPlanned) this.#fail("routes-already-planned", "early routes were already planned");
    try {
      for (const planner of [
        planners.scalar,
        planners.array,
        ...(planners.string ? [planners.string] : []),
        planners.functionValue,
        planners.fibonacciPair,
      ]) {
        const states = planner(this.#claimedRouteClaims);
        for (const [sourceFile, state] of states) this.#registerState(sourceFile, state);
        for (const state of states.values()) {
          if (!state.route) continue;
          const slots = slotsForRoute(state.route);
          this.#claimedRouteClaims = extendMultiPreparedRouteClaims(
            this.#claimedRouteClaims,
            state.route.sourceFile,
            slots.map((slot) => slot.unitId),
            slots.map((slot) => slot.unitId),
          );
        }
      }
      this.#routesPlanned = true;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Register cross-source callable components after the legacy route planners
   * have produced their source states, but before the body boundary is sealed.
   */
  registerCallableComponents(components: readonly MultiPreparedProgramCallableComponent[]): void {
    this.#requireState("collecting");
    if (!this.#routesPlanned)
      this.#fail("completion-order", "callable components were registered before route planning");
    if (this.#moduleInitPreparation !== undefined && components.length > 0) {
      this.#fail("module-init-plan-mismatch", "Prepared module-init cannot compose with callable components");
    }
    if (this.#callableComponents.length > 0) {
      this.#fail("duplicate-reservation-component", "callable components were registered more than once");
    }
    const componentIds = new Set<string>();
    const componentUnitIds = new Set<IrUnitId>();
    const sourceNames = new Map<SourceFile, Set<string>>();
    try {
      for (const component of components) {
        if (!component.preparedComponentId || component.units.length === 0) {
          this.#fail("route-plan-mismatch", "callable component has no prepared ID or terminal units");
        }
        if (componentIds.has(component.preparedComponentId)) {
          this.#fail(
            "duplicate-reservation-component",
            `callable component ${component.preparedComponentId} occurs twice`,
          );
        }
        componentIds.add(component.preparedComponentId);
        const localUnitIds = new Set<IrUnitId>();
        for (const unit of component.units) {
          const sourceId = this.#sourceId(unit.sourceFile);
          const terminal = this.#terminalMap.get(unit.unitId);
          const declaration = this.#identityContext.declarationByUnitId.get(unit.unitId);
          const routeState = this.#states.get(unit.sourceFile);
          const routeUnits = routeState?.route ? slotsForRoute(routeState.route).map((slot) => slot.unitId) : [];
          const names = sourceNames.get(unit.sourceFile) ?? new Set<string>();
          if (
            unit.sourceId !== sourceId ||
            localUnitIds.has(unit.unitId) ||
            componentUnitIds.has(unit.unitId) ||
            this.#callableComponentByUnitId.has(unit.unitId) ||
            routeUnits.includes(unit.unitId) ||
            !terminal ||
            terminal.sourceId !== sourceId ||
            terminal.kind !== "top-level-function" ||
            terminal.observedKind !== "function" ||
            terminal.terminalOwnerId !== unit.unitId ||
            !declaration ||
            !ts.isFunctionDeclaration(declaration) ||
            declaration !== unit.declaration ||
            declaration.parent !== unit.sourceFile ||
            declaration.name?.text !== unit.legacyName ||
            terminal.legacyMatchName !== unit.legacyName ||
            !declaration.body ||
            names.has(unit.legacyName)
          ) {
            this.#fail(
              "route-unit-mismatch",
              `callable component ${component.preparedComponentId} has a non-exact terminal ${unit.unitId}`,
            );
          }
          // compileDeclarations receives local names, so a component name may
          // not collide with any other source function in the same invocation.
          for (const statement of unit.sourceFile.statements) {
            if (
              ts.isFunctionDeclaration(statement) &&
              statement.body &&
              statement.name?.text === unit.legacyName &&
              statement !== unit.declaration
            ) {
              this.#fail(
                "route-unit-mismatch",
                `callable component ${component.preparedComponentId} shares local name ${unit.legacyName}`,
              );
            }
          }
          names.add(unit.legacyName);
          sourceNames.set(unit.sourceFile, names);
          localUnitIds.add(unit.unitId);
          componentUnitIds.add(unit.unitId);
        }
        this.#callableComponents.push(component);
        for (const unit of component.units) {
          this.#callableComponentByUnitId.set(unit.unitId, component);
          const sourceComponents = this.#callableComponentsBySourceFile.get(unit.sourceFile) ?? [];
          if (!sourceComponents.includes(component)) sourceComponents.push(component);
          this.#callableComponentsBySourceFile.set(unit.sourceFile, sourceComponents);
        }
      }
      this.#ctx.irProgramCallablePreparedUnitIds = new Set(componentUnitIds);
    } catch (error) {
      this.#callableComponents.length = 0;
      this.#callableComponentByUnitId.clear();
      this.#callableComponentsBySourceFile.clear();
      delete this.#ctx.irProgramCallablePreparedUnitIds;
      throw error;
    }
  }

  get callableComponentUnitIds(): ReadonlySet<IrUnitId> {
    return new Set(this.#callableComponentByUnitId.keys());
  }

  get existingRouteUnitIds(): ReadonlySet<IrUnitId> {
    return new Set(
      [...this.#states.values()].flatMap((state) =>
        state.route ? slotsForRoute(state.route).map((slot) => slot.unitId) : [],
      ),
    );
  }

  get preparedModuleInitUnitId(): IrUnitId | undefined {
    return this.#moduleInitPreparation?.unitId;
  }

  /** Exact M2 Prepared module-init receipt, registered before body emission. */
  registerPreparedModuleInit(preparation: MultiPreparedModuleInitPreparation): void {
    this.#requireState("collecting");
    if (!this.#routesPlanned)
      this.#fail("completion-order", "Prepared module-init was registered before route planning");
    if (this.#moduleInitPreparation !== undefined) {
      this.#fail("module-init-reservation-mismatch", "Prepared module-init was registered more than once");
    }
    if (this.#callableComponents.length > 0) {
      this.#fail("module-init-plan-mismatch", "Prepared module-init cannot compose with callable components");
    }
    const sourcePlans = preparation.sourcePlans;
    const executable = sourcePlans.filter((plan) => plan.executable);
    const contributor = sourcePlans.find((plan) => plan.sourceFile === preparation.sourceFile);
    if (
      sourcePlans.length !== this.#sourceFiles.length ||
      sourcePlans.some(
        (plan, index) =>
          plan.sourceFile !== this.#sourceFiles[index] || plan.sourceId !== this.#sourceId(plan.sourceFile),
      ) ||
      executable.length !== 1 ||
      !contributor ||
      !contributor.executable ||
      contributor.unitId !== preparation.unitId ||
      preparation.sourceId !== this.#sourceId(preparation.sourceFile)
    ) {
      this.#fail("module-init-plan-mismatch", "Prepared module-init source census is not semantic-order exact");
    }
    const terminal = this.#terminalMap.get(preparation.unitId);
    const mappedSourceFile = terminal ? this.#reverseSourceMap.get(terminal.sourceId) : undefined;
    const registry = this.#ctx.programAbiModuleInitCallables;
    if (
      !terminal ||
      terminal.sourceId !== preparation.sourceId ||
      mappedSourceFile !== preparation.sourceFile ||
      terminal.kind !== "module-init" ||
      terminal.observedKind !== "module-init" ||
      terminal.terminalOwnerId !== preparation.unitId ||
      registry?.preparedExactUnit !== preparation.unitId ||
      registry.preparedExactFunctionObject !== preparation.preparedFunction ||
      registry.preparedExactHandleValue !== preparation.preparedHandle ||
      registry.functionForUnit(preparation.unitId) !== preparation.preparedFunction ||
      registry.handleForUnit(preparation.unitId) !== preparation.preparedHandle
    ) {
      this.#fail(
        "module-init-reservation-mismatch",
        `Prepared module-init ${preparation.unitId} lost its exact ABI slot`,
      );
    }
    const selected = preparation.selection;
    const preparedBody = preparation.preparedBody;
    const report = preparation.report;
    const evidence = report.terminalEvidence ?? [];
    const artifacts = report.compiledArtifactEvidence ?? [];
    const projection = preparedBody.requestedSkipProjection.entries;
    if (
      selected.funcs.size !== 0 ||
      (selected.classMembers?.size ?? 0) !== 0 ||
      (selected.classMemberUnitIds?.size ?? 0) !== 0 ||
      selected.moduleInit?.stmtCount === 0 ||
      preparation.preparedFunction.body !== preparation.preparedFunctionBody ||
      !Object.isFrozen(preparation.preparedInstructions) ||
      !sameIdentityArray(preparation.preparedFunction.body, preparation.preparedInstructions) ||
      preparedBody.unitId !== preparation.unitId ||
      projection.length !== 1 ||
      projection[0]?.unitId !== preparation.unitId ||
      projection[0]?.legacyName !== "<module-init>" ||
      !preparedBody.skipBodies.has("<module-init>") ||
      !preparedBody.preserveBodies.has("<module-init>") ||
      report.errors.length !== 0 ||
      report.compiled.length !== 1 ||
      report.compiled[0] !== "<module-init>" ||
      (report.terminalCompiledOwners?.length ?? 0) !== 1 ||
      report.terminalCompiledOwners?.[0] !== "<module-init>" ||
      evidence.length !== 1 ||
      evidence[0]?.kind !== "patched" ||
      evidence[0].unitId !== preparation.unitId ||
      evidence[0].legacyName !== "<module-init>" ||
      evidence[0].preparedComponentId !== preparation.preparedComponentId ||
      artifacts.length !== 1 ||
      artifacts[0]?.artifactUnitId !== preparation.unitId ||
      artifacts[0].terminalOwnerUnitId !== preparation.unitId ||
      artifacts[0].name !== "<module-init>" ||
      artifacts[0].preparedComponentId !== preparation.preparedComponentId ||
      (report.syntheticCompiledArtifacts?.length ?? 0) !== 0
    ) {
      this.#fail("module-init-plan-mismatch", `Prepared module-init ${preparation.unitId} has non-exact IR evidence`);
    }
    this.#moduleInitPreparation = Object.freeze({
      ...preparation,
      sourcePlans: Object.freeze([...sourcePlans]),
    });
    this.#ctx.irProgramPreparedModuleInitUnitId = preparation.unitId;
  }

  /** Freeze the exact denominator and the reservations made before bodies. */
  sealBodyBoundary(): MultiPreparedProgramBodyPlan {
    if (this.#state === "body-boundary-sealed" || this.#state === "routes-complete" || this.#state === "complete") {
      this.#assertStable();
      return this.#bodyPlan!;
    }
    this.#requireState("collecting");
    try {
      this.#assertStable();
      this.#routeSnapshots.length = 0;
      const reservations: MultiPreparedProgramReservation[] = [];
      const reservedUnits = new Set<IrUnitId>();
      const components = new Map<string, RouteSnapshot<Plan>>();
      for (const [sourceFile, state] of this.#states) {
        const snapshot = this.#snapshotRoute(sourceFile, state);
        if (!snapshot) continue;
        this.#routeSnapshots.push(snapshot);
        const priorComponent = components.get(snapshot.componentId);
        if (priorComponent && priorComponent.route !== snapshot.route) {
          this.#fail(
            "duplicate-reservation-component",
            `component ${snapshot.componentId} belongs to distinct early routes`,
          );
        }
        components.set(snapshot.componentId, snapshot);
        for (const slot of snapshot.slots) {
          if (reservedUnits.has(slot.unitId)) {
            this.#fail("duplicate-reservation-unit", `terminal ${slot.unitId} was reserved twice`);
          }
          reservedUnits.add(slot.unitId);
          reservations.push({
            unitId: slot.unitId,
            sourceId: snapshot.sourceId,
            routeKind: snapshot.route.routeKind,
            preparedComponentId: snapshot.componentId,
            preparedBeforeDirectBodies: true,
          });
        }
      }
      for (const component of this.#callableComponents) {
        component.assertCurrent?.();
        for (const unit of component.units) {
          if (reservedUnits.has(unit.unitId)) {
            this.#fail("duplicate-reservation-unit", `terminal ${unit.unitId} was reserved twice`);
          }
          reservedUnits.add(unit.unitId);
          reservations.push({
            unitId: unit.unitId,
            sourceId: unit.sourceId,
            routeKind: "cross-source-callable",
            preparedComponentId: component.preparedComponentId,
            preparedBeforeDirectBodies: true,
          });
        }
      }
      if (this.#moduleInitPreparation) {
        const preparation = this.#moduleInitPreparation;
        if (reservedUnits.has(preparation.unitId)) {
          this.#fail("duplicate-reservation-unit", `terminal ${preparation.unitId} was reserved twice`);
        }
        reservedUnits.add(preparation.unitId);
        reservations.push({
          unitId: preparation.unitId,
          sourceId: preparation.sourceId,
          routeKind: "module-init",
          preparedComponentId: preparation.preparedComponentId,
          preparedBeforeDirectBodies: true,
        });
      }
      reservations.sort((a, b) => this.#terminalIndex(a.unitId) - this.#terminalIndex(b.unitId));
      const terminalUnitIds = this.#terminalUnits.map((unit) => unit.id);
      const bodyPlan: MultiPreparedProgramBodyPlan = Object.freeze({
        schema: "multi-prepared-program-body-plan-v1",
        entrySourceId: this.#entrySourceId(),
        canonicalSourceIds: Object.freeze(this.#sources.map((source) => source.id)),
        semanticSourceIds: Object.freeze(this.#sourceFiles.map((sourceFile) => this.#sourceId(sourceFile))),
        expectedBodySourceIds: Object.freeze(this.#sourceFiles.map((sourceFile) => this.#sourceId(sourceFile))),
        expectedOverlaySourceIds: Object.freeze(
          this.#overlayEnabled ? this.#sourceFiles.map((sourceFile) => this.#sourceId(sourceFile)) : [],
        ),
        terminalUnitIds: Object.freeze([...terminalUnitIds]),
        sources: Object.freeze(
          this.#sources.map((source) => {
            const sourceFile = this.#reverseSourceMap.get(source.id);
            if (!sourceFile) this.#fail("construction-source-join", `source ${source.id} has no AST object`);
            return Object.freeze({
              sourceId: source.id,
              sourceKey: source.sourceKey,
              canonicalOrder: source.order,
              semanticOrder: this.#sourceFiles.indexOf(sourceFile),
              kind: source.kind,
              terminalUnitIds: Object.freeze(
                this.#terminalUnits.filter((unit) => unit.sourceId === source.id).map((unit) => unit.id),
              ),
            });
          }),
        ),
        reservations: Object.freeze(reservations.map((reservation) => Object.freeze(reservation))),
        unreservedTerminalUnitIds: Object.freeze(terminalUnitIds.filter((unitId) => !reservedUnits.has(unitId))),
      });
      this.#bodyPlan = bodyPlan;
      this.#state = "body-boundary-sealed";
      this.#assertBodyPlan();
      return bodyPlan;
    } catch (error) {
      if (this.#state !== "failed") this.#state = "failed";
      throw error;
    }
  }

  /** Compile one source through the existing direct-body consumer. */
  compileBodySource(sourceFile: SourceFile, moduleInitMode: ModuleInitMode): void {
    const state = this.#stateForBodySource(sourceFile);
    try {
      // Module-init mode is graph-owned. Once M2 admits one contributor, every
      // source pass uses prepared mode; the final semantic source must never
      // fall back to the old `full` pass and mint/replace a second slot.
      const effectiveModuleInitMode: ModuleInitMode = this.#moduleInitPreparation ? "prepared" : moduleInitMode;
      const moduleInitRouting =
        this.#moduleInitPreparation?.sourceFile === sourceFile
          ? {
              skipBody: true,
              preserveSkippedBody: true,
              skippedNames: [],
              exactSourceFile: sourceFile,
              exactUnitId: this.#moduleInitPreparation.unitId,
              skippedUnitIds: [],
            }
          : undefined;
      compileMultiPreparedScalarLeafDeclarations(this.#ctx, sourceFile, state, effectiveModuleInitMode, {
        skipBodies: this.#callableSkipNames(sourceFile),
        preserveBodies: this.#callableSkipNames(sourceFile),
        skipBodyUnitIds: this.#callableSkipUnitIds(sourceFile),
        preserveBodyUnitIds: this.#callableSkipUnitIds(sourceFile),
        onSkippedUnitIds: (unitIds) => this.#recordCallableSkippedUnitIds(sourceFile, unitIds),
        ...(this.#moduleInitPreparation
          ? {
              moduleInitBodyRouting: moduleInitRouting,
            }
          : {}),
      });
      if (this.#moduleInitPreparation) {
        if (moduleInitRouting?.skippedUnitIds?.length === 1) {
          if (moduleInitRouting.skippedUnitIds[0] !== this.#moduleInitPreparation.unitId) {
            this.#fail(
              "module-init-body-skip-mismatch",
              `source ${sourceFile.fileName} skipped a foreign module-init unit`,
            );
          }
          this.#moduleInitSkippedSourceFiles.add(sourceFile);
        } else if (moduleInitRouting?.skippedUnitIds?.length) {
          this.#fail(
            "module-init-body-skip-mismatch",
            `source ${sourceFile.fileName} skipped module-init more than once`,
          );
        }
      }
      const route = state?.route;
      if (state && route?.routeKind === "string") route.tamperSkipReport(state.skippedFunctionUnitIds);
      this.#assertBodySkip(sourceFile, state);
      this.#assertCallableBodySkip(sourceFile);
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /**
   * Give the late overlay exactly the state selected at the body boundary.
   * The mutable state never escapes this callback and the owner records the
   * source visit even when that source had no early route.
   */
  withOverlayState(
    sourceFile: SourceFile,
    consumer: (state: RouteState<Plan> | undefined) => MultiPreparedProgramOverlayResult | undefined,
  ): void {
    const state = this.#stateForOverlaySource(sourceFile);
    try {
      if (state?.route?.routeKind === "string") state.route.sealAfterDirectCurrentness();
      if (state?.route) {
        const snapshot = this.#routeSnapshots.find((candidate) => candidate.state === state);
        if (!snapshot) this.#fail("route-plan-mismatch", `overlay source ${sourceFile.fileName} lost its sealed route`);
        this.#assertRouteFields(sourceFile, state, state.route, slotsForRoute(state.route), snapshot.componentId);
      }
      const result = consumer(state);
      if (state?.route?.routeKind === "string" && !result) {
        this.#fail("route-report-mismatch", `string route ${state.route.unitId} produced no merged overlay report`);
      }
      if (state?.route && result) {
        const route = state.route;
        const reportForAudit = route.routeKind === "string" ? route.mergedReportForTest(result.report) : result.report;
        this.#assertMergedIntegrationReport(state.route, reportForAudit);
      }
      result?.consume();
      if (state?.route?.routeKind === "string") state.route.sealAfterOverlayCurrentness();
      this.#assertBodySkip(sourceFile, state);
      this.#assertCallableBodySkip(sourceFile);
      for (const component of this.#callableComponentsBySourceFile.get(sourceFile) ?? []) {
        component.assertCurrent?.();
      }
      if (state?.route) {
        const snapshot = this.#routeSnapshots.find((candidate) => candidate.state === state);
        if (!snapshot) this.#fail("route-plan-mismatch", `overlay source ${sourceFile.fileName} lost its sealed route`);
        const currentSlots = slotsForRoute(state.route);
        this.#assertRouteFields(sourceFile, state, state.route, currentSlots, snapshot.componentId, true);
      }
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #assertMergedIntegrationReport(route: MultiPreparedEarlyLeafRoute, report: IrIntegrationReport): void {
    if (route.routeKind !== "string") return;
    const receipts = report.preparedCountedStringAppendReceipts ?? [];
    const stored = route.preparedCountedStringAppendReceipt;
    if (receipts.length !== 1 || receipts[0] !== stored) {
      this.#fail(
        "route-report-mismatch",
        `string route ${route.unitId} did not retain exactly one stored counted-string receipt in the merged report`,
      );
    }
    try {
      const identity = requireValidPreparedCountedStringAppendReceipt(stored);
      if (identity.ownerUnitId !== route.unitId || stored.plan !== route.candidate.loweringPlan) {
        this.#fail("route-report-mismatch", `string route ${route.unitId} retained a foreign counted-string receipt`);
      }
    } catch (error) {
      if (error instanceof IrInvariantError) throw error;
      this.#fail("route-report-mismatch", `string route ${route.unitId} retained an invalid counted-string receipt`);
    }
  }

  /** Seal string-route instruction identity after the final trampoline rebuild. */
  sealPostOverlayFinalization(): void {
    this.#requireState("body-boundary-sealed");
    for (const state of this.#states.values()) {
      if (state.route?.routeKind === "string") state.route.sealAfterFinalizationCurrentness();
    }
  }

  /** Seal final optimized instruction identity immediately before ABI publication. */
  sealBeforePublication(): void {
    this.#requireState("routes-complete");
    if (this.#moduleInitPreparation && !this.#moduleInitFinalized) {
      this.#fail(
        "module-init-startup-mismatch",
        "Prepared module-init startup was not finalized before ABI publication",
      );
    }
    for (const state of this.#states.values()) {
      if (state.route?.routeKind === "string") state.route.sealBeforePublicationCurrentness();
    }
  }

  sealRoutesComplete(): void {
    if (this.#state === "routes-complete" || this.#state === "complete") {
      this.#assertStable();
      this.#assertBodyPlan();
      return;
    }
    this.#requireState("body-boundary-sealed");
    try {
      this.#assertStable();
      if (
        this.#bodyCursor !== this.#sourceFiles.length ||
        this.#overlayCursor !== (this.#overlayEnabled ? this.#sourceFiles.length : 0)
      ) {
        this.#fail("routes-incomplete", "body and overlay source visits are not complete");
      }
      this.#assertBodyPlan();
      this.#assertAllBodySkips();
      this.#assertAllCallableBodySkips();
      for (const component of this.#callableComponents) component.assertCurrent?.();
      for (const snapshot of this.#routeSnapshots) this.#assertRouteSnapshot(snapshot);
      this.#recordCallableIrTelemetry();
      this.#assertAllModuleInitBodySkips();
      this.#recordModuleInitIrTelemetry();
      this.#state = "routes-complete";
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  /** Assert the Prepared body and exact ABI slot before intentional startup wrapping. */
  assertPreparedModuleInitCurrent(): void {
    this.#requireState("routes-complete");
    const preparation = this.#moduleInitPreparation;
    if (!preparation) return;
    if (process.env.JS2WASM_TEST_MUTATE_MULTI_PREPARED_MODULE_INIT_BODY === "1") {
      preparation.preparedFunction.body = [{ op: "unreachable" }];
    }
    const registry = this.#ctx.programAbiModuleInitCallables;
    if (
      registry?.functionForUnit(preparation.unitId) !== preparation.preparedFunction ||
      registry.handleForUnit(preparation.unitId) !== preparation.preparedHandle ||
      preparation.preparedFunction.body !== preparation.preparedFunctionBody ||
      !sameIdentityArray(preparation.preparedFunction.body, preparation.preparedInstructions)
    ) {
      this.#fail(
        "module-init-startup-mismatch",
        "Prepared module-init body or exact ABI slot changed before startup finalization",
      );
    }
  }

  /** Finalize the exact retained module-init slot after all source passes. */
  finalizePreparedModuleInitStartup(): void {
    this.#requireState("routes-complete");
    const preparation = this.#moduleInitPreparation;
    if (!preparation) return;
    if (this.#moduleInitFinalized) {
      this.#fail("module-init-startup-mismatch", "Prepared module-init startup was finalized twice");
    }
    const registry = this.#ctx.programAbiModuleInitCallables;
    const initFunc = registry?.functionForUnit(preparation.unitId);
    const initHandle = registry?.handleForUnit(preparation.unitId);
    if (
      initFunc !== preparation.preparedFunction ||
      initHandle !== preparation.preparedHandle ||
      initFunc.body.length === 0
    ) {
      this.#fail(
        "module-init-startup-mismatch",
        "Prepared module-init lost its exact retained function before startup wiring",
      );
    }
    const exportModuleInit = this.#ctx.deferTopLevelInit && !this.#ctx.wasi;
    if (exportModuleInit) {
      if (this.#ctx.mod.startFuncIdx !== undefined) {
        this.#fail("module-init-startup-mismatch", "Prepared deferred module-init already has a start adapter");
      }
    } else {
      if (this.#ctx.mod.startFuncIdx !== undefined && this.#ctx.mod.startFuncIdx !== initHandle) {
        this.#fail("module-init-startup-mismatch", "Prepared module-init start adapter points at a foreign function");
      }
      this.#ctx.mod.startFuncIdx = initHandle;
    }
    if (process.env.JS2WASM_TEST_MODULE_INIT_DOUBLE_ADAPTER === "1") {
      if (exportModuleInit) this.#ctx.mod.startFuncIdx = initHandle;
      else this.#ctx.mod.exports.push({ name: "__module_init", desc: { kind: "func", index: initHandle! } });
    }
    const exportedAliases = this.#ctx.mod.exports.filter(
      (entry) => entry.name === "__module_init" && entry.desc.kind === "func" && entry.desc.index === initHandle,
    ).length;
    const startsOnInstantiation = this.#ctx.mod.startFuncIdx === initHandle;
    if (
      (exportModuleInit && (exportedAliases !== 1 || startsOnInstantiation)) ||
      (!exportModuleInit && (exportedAliases !== 0 || !startsOnInstantiation))
    ) {
      this.#fail(
        "module-init-startup-mismatch",
        `Prepared module-init must have exactly one ${exportModuleInit ? "deferred export" : "wasm start"} adapter`,
      );
    }
    this.#ctx.mod.hasTopLevelStatements = true;
    this.#moduleInitFinalized = true;
  }

  /** Complete the ownership audit after the exact ABI publication. */
  complete(publication: PublishedProgramAbi): MultiPreparedProgramAudit {
    if (this.#audit) {
      this.#assertStable();
      if (publication !== this.#publication)
        this.#fail("completion-order", "completion received a different ABI publication");
      return this.#audit;
    }
    this.#requireState("routes-complete");
    if (publication.abi.inventory !== this.#identityContext.inventory) {
      this.#fail("publication-inventory-mismatch", "Program ABI publication belongs to another inventory");
    }
    try {
      this.#assertStable();
      this.#assertBodyPlan();
      for (const snapshot of this.#routeSnapshots) this.#assertRouteSnapshot(snapshot);
      const moduleInitAudit = this.#moduleInitAudit();
      const audit: MultiPreparedProgramAudit = Object.freeze({
        schema: "multi-prepared-program-audit-v1",
        bodyPlan: this.#bodyPlan!,
        bodySourceIds: Object.freeze([...this.#bodySourceIds]),
        overlaySourceIds: Object.freeze([...this.#overlaySourceIds]),
        abiSessionBound: true,
        ...(moduleInitAudit ? { moduleInit: moduleInitAudit } : {}),
      });
      this.#publication = publication;
      this.#audit = audit;
      this.#state = "complete";
      return audit;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #sourceId(sourceFile: SourceFile): IrSourceId {
    const sourceId = this.#sourceMap.get(sourceFile);
    if (
      !sourceId ||
      this.#reverseSourceMap.get(sourceId) !== sourceFile ||
      !inventorySource(this.#identityContext.inventory, sourceId)
    ) {
      this.#fail("construction-source-join", `source ${sourceFile.fileName} is not an exact inventory source`);
    }
    return sourceId;
  }

  #entrySourceId(): IrSourceId {
    const sourceId = this.#sourceId(this.#multiAst.entryFile);
    const source = inventorySource(this.#identityContext.inventory, sourceId);
    if (!source || source.kind !== "entry")
      this.#fail("construction-entry-source", "entry AST file is not the entry inventory source");
    return sourceId;
  }

  #terminalIndex(unitId: IrUnitId): number {
    const index = this.#terminalUnits.findIndex((unit) => unit.id === unitId);
    if (index < 0) this.#fail("invalid-reservation-unit", `unknown terminal ${unitId}`);
    return index;
  }

  #registerState(sourceFile: SourceFile, state: RouteState<Plan>): void {
    this.#sourceId(sourceFile);
    if (this.#states.has(sourceFile))
      this.#fail("duplicate-route-source", `source ${sourceFile.fileName} has multiple route states`);
    if (state === undefined || state.plan === undefined)
      this.#fail("route-plan-mismatch", "early route state has no plan");
    if (
      state.plan.identityPlan.identityContext !== this.#identityContext ||
      state.plan.identityPlan.identityContext.inventory !== this.#identityContext.inventory
    ) {
      this.#fail("route-plan-mismatch", `route plan for ${sourceFile.fileName} belongs to another identity context`);
    }
    this.#states.set(sourceFile, state);
  }

  #snapshotRoute(sourceFile: SourceFile, state: RouteState<Plan>): RouteSnapshot<Plan> | undefined {
    if (state.plan.identityPlan.identityContext !== this.#identityContext) {
      this.#fail("route-plan-mismatch", `route plan for ${sourceFile.fileName} changed identity context`);
    }
    const route = state.route;
    if (!route) {
      if (state.skippedFunctionUnitIds.size !== 0)
        this.#fail("body-skip-mismatch", `unrouted source ${sourceFile.fileName} has a skip projection`);
      return undefined;
    }
    if (route.sourceFile !== sourceFile)
      this.#fail("route-source-mismatch", `route stored under ${sourceFile.fileName} has another source object`);
    const slots = slotsForRoute(route);
    const componentId = routeComponentId(route, slots);
    if (!componentId) this.#fail("route-receipt-mismatch", `route ${route.routeKind} has an empty component ID`);
    this.#assertRouteFields(sourceFile, state, route, slots, componentId);
    if (state.skippedFunctionUnitIds.size !== 0)
      this.#fail("body-skip-mismatch", `route ${route.unitId} was correlated before the body boundary`);
    const family = route.preparedFreeFunctions;
    const claims = slots.map((slot) => state.plan.functionClaimsByUnitId.get(slot.unitId));
    if (claims.some((claim): claim is undefined => claim === undefined)) {
      this.#fail("route-unit-mismatch", `route ${route.routeKind} has a missing exact function claim`);
    }
    return {
      sourceFile,
      sourceId: this.#sourceId(sourceFile),
      state,
      plan: state.plan,
      route,
      slots,
      claims: Object.freeze(claims as IrExactFunctionClaim[]),
      componentId,
      preparedReport: route.preparedReport,
      preparedFreeFunctions: family,
      preparedSelection: route.preparedSelection,
      requestedProjection: family.requestedSkipProjection,
      completedBodies: family.completedBodies,
      skipBodies: family.skipBodies,
      preserveBodies: family.preserveBodies,
      support: snapshotSupport(routeSupport(route)),
    };
  }

  #assertRouteFields(
    sourceFile: SourceFile,
    state: RouteState<Plan>,
    route: MultiPreparedEarlyLeafRoute,
    slots: readonly RouteSlot[],
    componentId: string,
    allowInstalledBodyChange = false,
  ): void {
    const sourceId = this.#sourceId(sourceFile);
    const routeIdentityPlan = route.routeKind === "fibonacci-pair" ? route.identityPlan : undefined;
    if (routeIdentityPlan && routeIdentityPlan !== state.plan.identityPlan) {
      this.#fail("route-plan-mismatch", `Fibonacci route ${route.unitId} carries a different identity plan`);
    }
    const expectedNames = slots.map((slot) => slot.legacyName);
    const expectedUnits = slots.map((slot) => slot.unitId);
    for (const slot of slots) {
      const terminal = this.#terminalMap.get(slot.unitId);
      const declaration = this.#identityContext.declarationByUnitId.get(slot.unitId);
      const reverseUnit = declaration ? this.#identityContext.unitIdByDeclaration.get(declaration) : undefined;
      const claim = state.plan.functionClaimsByUnitId.get(slot.unitId);
      if (
        !terminal ||
        this.#unitMap.get(slot.unitId) !== terminal ||
        terminal.sourceId !== sourceId ||
        terminal.kind !== "top-level-function" ||
        terminal.observedKind !== "function" ||
        terminal.terminalOwnerId !== slot.unitId ||
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        declaration !== slot.declaration ||
        reverseUnit !== slot.unitId ||
        declaration.getSourceFile() !== sourceFile ||
        declaration.parent !== sourceFile ||
        declaration.name?.text !== slot.legacyName ||
        terminal.legacyMatchName !== slot.legacyName ||
        !claim ||
        claim.unitId !== slot.unitId ||
        claim.declaration !== slot.declaration ||
        claim.legacyName !== slot.legacyName ||
        !slot.declaration.body ||
        terminal.declarationStart !== slot.declaration.getStart(sourceFile) ||
        terminal.declarationEnd !== slot.declaration.end ||
        slot.allocatedFunction.name !== slot.legacyName
      ) {
        this.#fail(
          "route-unit-mismatch",
          `route ${route.routeKind} does not map ${slot.unitId} to its exact terminal declaration`,
        );
      }
      if (
        slot.receipt.kind !== "prepared" ||
        slot.receipt.unitId !== slot.unitId ||
        slot.receipt.legacyName !== slot.legacyName ||
        slot.receipt.preparedComponentId !== componentId ||
        (!allowInstalledBodyChange && slot.allocatedFunction.body !== slot.preparedBody) ||
        slot.preparedBody.length === 0 ||
        !Object.isFrozen(slot.preparedInstructions) ||
        (!allowInstalledBodyChange && !sameIdentityArray(slot.allocatedFunction.body, slot.preparedInstructions))
      ) {
        this.#fail("route-receipt-mismatch", `route ${route.routeKind} has stale Prepared slot ${slot.unitId}`);
      }
    }
    if (
      route.preparedFreeFunctions === undefined ||
      route.preparedReport === undefined ||
      route.preparedSelection === undefined ||
      route.preparedSelection.moduleInit !== undefined ||
      (route.preparedSelection.classMembers?.size ?? 0) !== 0 ||
      (route.preparedSelection.classMemberUnitIds?.size ?? 0) !== 0 ||
      !sameSet(route.preparedSelection.funcs, expectedNames) ||
      !sameProjection(route.preparedFreeFunctions.requestedSkipProjection.entries, slots) ||
      !sameSet(route.preparedFreeFunctions.completedBodies, expectedNames) ||
      !sameSet(route.preparedFreeFunctions.skipBodies, expectedNames) ||
      !sameSet(route.preparedFreeFunctions.preserveBodies, expectedNames)
    ) {
      this.#fail("route-report-mismatch", `route ${route.routeKind} has a non-exact Prepared body projection`);
    }
    const report = route.preparedReport;
    const evidence = report.terminalEvidence ?? [];
    const artifacts = report.compiledArtifactEvidence ?? [];
    if (
      report.errors.length !== 0 ||
      !sameSet(new Set(report.compiled), expectedNames) ||
      report.compiled.length !== expectedNames.length ||
      !sameSet(new Set(report.terminalCompiledOwners ?? []), expectedNames) ||
      (report.terminalCompiledOwners?.length ?? 0) !== expectedNames.length ||
      evidence.length !== slots.length ||
      artifacts.length !== slots.length ||
      (report.syntheticCompiledArtifacts?.length ?? 0) !== 0 ||
      !slots.every((slot) =>
        evidence.some(
          (entry) =>
            entry.kind === "patched" &&
            entry.unitId === slot.unitId &&
            entry.legacyName === slot.legacyName &&
            entry.preparedComponentId === componentId,
        ),
      ) ||
      !slots.every((slot) =>
        artifacts.some(
          (artifact) =>
            artifact.artifactUnitId === slot.unitId &&
            artifact.terminalOwnerUnitId === slot.unitId &&
            artifact.name === slot.legacyName &&
            artifact.preparedComponentId === componentId,
        ),
      )
    ) {
      this.#fail("route-report-mismatch", `route ${route.routeKind} has non-exact Prepared integration evidence`);
    }
    if (route.routeKind === "fibonacci-pair") {
      const recursiveReceipt = route.recursiveReceipt;
      if (
        route.preparedComponentId !== componentId ||
        recursiveReceipt.kind !== "prepared" ||
        route.receipt.kind !== "prepared" ||
        recursiveReceipt.preparedComponentId !== componentId ||
        route.receipt.preparedComponentId !== componentId ||
        route.recursiveUnitId === route.unitId
      ) {
        this.#fail("route-receipt-mismatch", `Fibonacci route ${route.unitId} does not own one atomic pair`);
      }
    }
    if (route.routeKind === "function-value" && !supportIsCurrent(snapshotSupport(route.support), route.support)) {
      this.#fail("route-support-mismatch", `function-value route ${route.unitId} has stale support`);
    }
    if (route.routeKind === "array") {
      if (route.callback && !route.support)
        this.#fail("route-support-mismatch", `array route ${route.unitId} lost callback support`);
      if (route.callback && !supportIsCurrent(snapshotSupport(route.support), route.support)) {
        this.#fail("route-support-mismatch", `array route ${route.unitId} has stale callback support`);
      }
    }
    if (route.routeKind === "fibonacci-pair" && !supportIsCurrent(snapshotSupport(route.support), route.support)) {
      this.#fail("route-support-mismatch", `Fibonacci route ${route.unitId} has stale support`);
    }
    if (route.routeKind === "string") {
      try {
        const identity = requireValidPreparedCountedStringAppendReceipt(route.preparedCountedStringAppendReceipt);
        if (
          identity.ownerUnitId !== route.unitId ||
          route.preparedCountedStringAppendReceipt.plan !== route.candidate.loweringPlan
        ) {
          this.#fail("route-report-mismatch", `string route ${route.unitId} has a foreign counted-string receipt`);
        }
      } catch (error) {
        if (error instanceof IrInvariantError) throw error;
        this.#fail("route-report-mismatch", `string route ${route.unitId} has an invalid counted-string receipt`);
      }
      route.assertCurrent();
    }
    // Force the route's unit population to be checked as a source-local set;
    // this catches a swapped recursive/wrapper receipt even when names happen
    // to be identical.
    const localTerminalIds = this.#terminalUnits.filter((unit) => unit.sourceId === sourceId).map((unit) => unit.id);
    if (!expectedUnits.every((unitId) => localTerminalIds.includes(unitId))) {
      this.#fail("route-unit-mismatch", `route ${route.unitId} reserves a terminal from another source`);
    }
  }

  #assertRouteSnapshot(snapshot: RouteSnapshot<Plan>): void {
    const state = this.#states.get(snapshot.sourceFile);
    if (state !== snapshot.state || state?.plan !== snapshot.plan || state?.route !== snapshot.route) {
      this.#fail("route-plan-mismatch", `route state for ${snapshot.sourceFile.fileName} was replaced after sealing`);
    }
    if (
      snapshot.slots.some(
        (slot, index) => snapshot.plan.functionClaimsByUnitId.get(slot.unitId) !== snapshot.claims[index],
      )
    ) {
      this.#fail("route-plan-mismatch", `route ${snapshot.route.unitId} changed its exact function claim objects`);
    }
    const currentSlots = slotsForRoute(snapshot.route);
    if (
      currentSlots.length !== snapshot.slots.length ||
      currentSlots.some(
        (slot, index) =>
          slot.declaration !== snapshot.slots[index]!.declaration ||
          slot.unitId !== snapshot.slots[index]!.unitId ||
          slot.legacyName !== snapshot.slots[index]!.legacyName ||
          slot.receipt !== snapshot.slots[index]!.receipt ||
          slot.allocatedFunction !== snapshot.slots[index]!.allocatedFunction ||
          slot.preparedBody !== snapshot.slots[index]!.preparedBody ||
          slot.preparedInstructions !== snapshot.slots[index]!.preparedInstructions,
      )
    ) {
      this.#fail(
        "route-receipt-mismatch",
        `route ${snapshot.route.unitId} changed its prepared slot objects after sealing`,
      );
    }
    // Integration keeps the exact allocated function object but installs its
    // lowered body into that object in place. The pre-integration body snapshot
    // remains immutable; only this one post-consumer body reference may differ.
    if (
      state &&
      !sameSet(
        state.skippedFunctionUnitIds,
        snapshot.slots.map((slot) => slot.unitId),
      )
    ) {
      this.#fail("body-skip-mismatch", `route ${snapshot.route.unitId} changed its body skip projection`);
    }
    this.#assertRouteFields(snapshot.sourceFile, state, snapshot.route, currentSlots, snapshot.componentId, true);
    const family = snapshot.route.preparedFreeFunctions;
    if (
      family !== snapshot.preparedFreeFunctions ||
      snapshot.route.preparedReport !== snapshot.preparedReport ||
      snapshot.route.preparedSelection !== snapshot.preparedSelection ||
      family.requestedSkipProjection !== snapshot.requestedProjection ||
      family.completedBodies !== snapshot.completedBodies ||
      family.skipBodies !== snapshot.skipBodies ||
      family.preserveBodies !== snapshot.preserveBodies ||
      !supportIsCurrent(snapshot.support, routeSupport(snapshot.route))
    ) {
      this.#fail("route-report-mismatch", `route ${snapshot.route.unitId} changed Prepared evidence after sealing`);
    }
  }

  #assertBodySkip(sourceFile: SourceFile, state: RouteState<Plan> | undefined): void {
    if (!state) return;
    const route = state.route;
    if (!route) {
      if (state.skippedFunctionUnitIds.size !== 0)
        this.#fail("body-skip-mismatch", `unrouted ${sourceFile.fileName} has skipped units`);
      return;
    }
    const expected = slotsForRoute(route).map((slot) => slot.unitId);
    if (!sameSet(state.skippedFunctionUnitIds, expected)) {
      this.#fail("body-skip-mismatch", `source ${sourceFile.fileName} did not correlate its exact body skips`);
    }
  }

  #callableSkipNames(sourceFile: SourceFile): ReadonlySet<string> {
    const names = new Set<string>();
    for (const component of this.#callableComponentsBySourceFile.get(sourceFile) ?? []) {
      for (const unit of component.units) {
        if (unit.sourceFile === sourceFile) names.add(unit.legacyName);
      }
    }
    return names;
  }

  #callableSkipUnitIds(sourceFile: SourceFile): ReadonlySet<IrUnitId> {
    return new Set(
      (this.#callableComponentsBySourceFile.get(sourceFile) ?? []).flatMap((component) =>
        component.units.filter((unit) => unit.sourceFile === sourceFile).map((unit) => unit.unitId),
      ),
    );
  }

  #recordCallableSkippedUnitIds(sourceFile: SourceFile, unitIds: readonly IrUnitId[]): void {
    const expected = this.#callableSkipUnitIds(sourceFile);
    if (expected.size === 0) {
      if (unitIds.length !== 0) {
        this.#fail("body-skip-mismatch", `source ${sourceFile.fileName} reported foreign callable body skips`);
      }
      this.#callableSkippedUnitIdsBySourceFile.set(sourceFile, new Set());
      return;
    }
    const observed = new Set(unitIds);
    if (!sameSet(observed, [...expected])) {
      this.#fail("body-skip-mismatch", `source ${sourceFile.fileName} did not skip its exact callable units`);
    }
    for (const unitId of observed) this.#callableSkippedUnitIds.add(unitId);
    this.#callableSkippedUnitIdsBySourceFile.set(sourceFile, observed);
  }

  #assertCallableBodySkip(sourceFile: SourceFile): void {
    const expected = this.#callableSkipUnitIds(sourceFile);
    const observed = this.#callableSkippedUnitIdsBySourceFile.get(sourceFile) ?? new Set<IrUnitId>();
    if (!sameSet(observed, [...expected])) {
      this.#fail("body-skip-mismatch", `source ${sourceFile.fileName} has an incomplete callable component skip set`);
    }
  }

  #assertAllCallableBodySkips(): void {
    for (const sourceFile of this.#sourceFiles) this.#assertCallableBodySkip(sourceFile);
    const expected = new Set(this.#callableComponentByUnitId.keys());
    if (!sameSet(this.#callableSkippedUnitIds, [...expected])) {
      this.#fail("body-skip-mismatch", "callable component body skips do not cover the reserved unit population");
    }
  }

  #recordCallableIrTelemetry(): void {
    if (this.#callableComponents.length === 0) return;
    const names = this.#callableComponents.flatMap((component) => component.units.map((unit) => unit.legacyName));
    this.#ctx.irCompiledFuncs = [...(this.#ctx.irCompiledFuncs ?? []), ...names];
    const outcomes = this.#ctx.irOutcomes;
    if (!outcomes) return;
    const target: IrObservedOutcome["target"] = this.#ctx.wasi ? "wasi" : this.#ctx.standalone ? "standalone" : "gc";
    const existingUnitIds = new Set(outcomes.flatMap((outcome) => (outcome.unitId ? [outcome.unitId] : [])));
    const existingKeys = new Set(outcomes.map((outcome) => outcome.key));
    for (const component of this.#callableComponents) {
      for (const unit of component.units) {
        const terminal = this.#terminalMap.get(unit.unitId)!;
        if (existingUnitIds.has(unit.unitId) || existingKeys.has(terminal.legacyKey)) {
          this.#fail("route-report-mismatch", `callable component ${unit.unitId} already has a terminal outcome`);
        }
        outcomes.push({
          key: terminal.legacyKey,
          sourceId: terminal.sourceId,
          unitId: terminal.id,
          file: unit.sourceFile.fileName,
          unitKind: terminal.observedKind,
          displayName: terminal.displayName,
          ordinal: terminal.legacyOrdinal,
          line: terminal.line,
          column: terminal.column,
          backend: "wasmgc",
          target,
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: component.preparedComponentId,
          kind: "emitted",
          stage: "patch",
        });
        existingUnitIds.add(unit.unitId);
        existingKeys.add(terminal.legacyKey);
      }
    }
  }

  #assertAllModuleInitBodySkips(): void {
    const preparation = this.#moduleInitPreparation;
    if (!preparation) return;
    if (
      this.#moduleInitSkippedSourceFiles.size !== 1 ||
      !this.#moduleInitSkippedSourceFiles.has(preparation.sourceFile)
    ) {
      this.#fail(
        "module-init-body-skip-mismatch",
        "Prepared module-init was not skipped exactly once by its contributor source",
      );
    }
    for (const sourcePlan of preparation.sourcePlans) {
      if (!sourcePlan.executable && sourcePlan.unitId !== null) {
        this.#fail("module-init-plan-mismatch", `empty source ${sourcePlan.sourceId} retained a module-init unit`);
      }
    }
  }

  #recordModuleInitIrTelemetry(): void {
    const preparation = this.#moduleInitPreparation;
    if (!preparation || this.#moduleInitTelemetryRecorded) return;
    const terminal = this.#terminalMap.get(preparation.unitId);
    if (!terminal) this.#fail("module-init-reservation-mismatch", `missing module-init terminal ${preparation.unitId}`);
    if (!this.#ctx.irCompiledFuncs?.includes("<module-init>")) {
      this.#ctx.irCompiledFuncs = [...(this.#ctx.irCompiledFuncs ?? []), "<module-init>"];
    }
    const outcomes = this.#ctx.irOutcomes;
    if (outcomes) {
      if (outcomes.some((outcome) => outcome.unitId === preparation.unitId || outcome.key === terminal.legacyKey)) {
        this.#fail("module-init-reservation-mismatch", `module-init ${preparation.unitId} already has an outcome`);
      }
      const target: IrObservedOutcome["target"] = this.#ctx.wasi ? "wasi" : this.#ctx.standalone ? "standalone" : "gc";
      outcomes.push({
        key: terminal.legacyKey,
        sourceId: terminal.sourceId,
        unitId: terminal.id,
        file: preparation.sourceFile.fileName,
        unitKind: terminal.observedKind,
        displayName: terminal.displayName,
        ordinal: terminal.legacyOrdinal,
        line: terminal.line,
        column: terminal.column,
        backend: "wasmgc",
        target,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: preparation.preparedComponentId,
        kind: "emitted",
        stage: "patch",
      });
    }
    this.#moduleInitTelemetryRecorded = true;
  }

  #moduleInitAudit(): MultiPreparedProgramModuleInitAudit | undefined {
    const preparation = this.#moduleInitPreparation;
    if (!preparation) return undefined;
    const directCompileModuleInitBodyRoots =
      this.#ctx.irBodyRouteAuditSession?.countRoots("compileModuleInitBody") ?? 0;
    if (directCompileModuleInitBodyRoots !== 0) {
      this.#fail(
        "module-init-body-skip-mismatch",
        `Prepared module-init recorded ${directCompileModuleInitBodyRoots} direct body roots`,
      );
    }
    return Object.freeze({
      schema: "multi-prepared-program-module-init-audit-v1" as const,
      sourcePlans: Object.freeze(
        preparation.sourcePlans.map((plan) =>
          Object.freeze({
            sourceId: plan.sourceId,
            unitId: plan.unitId,
            executable: plan.executable,
            evaluationCount: plan.evaluationCount,
          }),
        ),
      ),
      executablePlanCount: 1 as const,
      emptyPlanCount: preparation.sourcePlans.filter((plan) => !plan.executable).length,
      contributorSourceId: preparation.sourceId,
      contributorUnitId: preparation.unitId,
      preparedComponentId: preparation.preparedComponentId,
      invocationKind: preparation.invocationKind,
      directCompileModuleInitBodyRoots,
      irBodyEmissions: 1 as const,
    });
  }

  #assertAllBodySkips(): void {
    for (const [sourceFile, state] of this.#states) this.#assertBodySkip(sourceFile, state);
  }

  #stateForBodySource(sourceFile: SourceFile): RouteState<Plan> | undefined {
    this.#requireState("body-boundary-sealed");
    const expected = this.#sourceFiles[this.#bodyCursor];
    if (expected !== sourceFile) this.#fail("body-phase-order", `body source visit is out of semantic order`);
    this.#bodyCursor++;
    this.#bodySourceIds.push(this.#sourceId(sourceFile));
    return this.#states.get(sourceFile);
  }

  #stateForOverlaySource(sourceFile: SourceFile): RouteState<Plan> | undefined {
    this.#requireState("body-boundary-sealed");
    if (!this.#overlayEnabled) this.#fail("overlay-phase-order", "overlay state requested while overlay is disabled");
    if (this.#bodyCursor !== this.#sourceFiles.length)
      this.#fail("overlay-phase-order", "overlay began before all body visits");
    const expected = this.#sourceFiles[this.#overlayCursor];
    if (expected !== sourceFile) this.#fail("overlay-phase-order", "overlay source visit is out of semantic order");
    this.#overlayCursor++;
    this.#overlaySourceIds.push(this.#sourceId(sourceFile));
    return this.#states.get(sourceFile);
  }

  #assertBodyPlan(): void {
    const plan = this.#bodyPlan;
    if (!plan) this.#fail("body-plan-mismatch", "body plan has not been sealed");
    const canonical = this.#sources.map((source) => source.id);
    const semantic = this.#sourceFiles.map((sourceFile) => this.#sourceId(sourceFile));
    const terminals = this.#terminalUnits.map((unit) => unit.id);
    const expectedReservations: MultiPreparedProgramReservation[] = [
      ...this.#routeSnapshots.flatMap((snapshot) =>
        snapshot.slots.map(
          (slot): MultiPreparedProgramReservation => ({
            unitId: slot.unitId,
            sourceId: snapshot.sourceId,
            routeKind: snapshot.route.routeKind,
            preparedComponentId: snapshot.componentId,
            preparedBeforeDirectBodies: true,
          }),
        ),
      ),
      ...this.#callableComponents.flatMap((component) =>
        component.units.map(
          (unit): MultiPreparedProgramReservation => ({
            unitId: unit.unitId,
            sourceId: unit.sourceId,
            routeKind: "cross-source-callable",
            preparedComponentId: component.preparedComponentId,
            preparedBeforeDirectBodies: true,
          }),
        ),
      ),
      ...(this.#moduleInitPreparation
        ? [
            {
              unitId: this.#moduleInitPreparation.unitId,
              sourceId: this.#moduleInitPreparation.sourceId,
              routeKind: "module-init" as const,
              preparedComponentId: this.#moduleInitPreparation.preparedComponentId,
              preparedBeforeDirectBodies: true as const,
            },
          ]
        : []),
    ].sort((a, b) => this.#terminalIndex(a.unitId) - this.#terminalIndex(b.unitId));
    const reserved = new Set(expectedReservations.map((reservation) => reservation.unitId));
    if (
      plan!.entrySourceId !== this.#entrySourceId() ||
      !sameArray(plan!.canonicalSourceIds, canonical) ||
      !sameArray(plan!.semanticSourceIds, semantic) ||
      !sameArray(plan!.expectedBodySourceIds, semantic) ||
      !sameArray(plan!.expectedOverlaySourceIds, this.#overlayEnabled ? semantic : []) ||
      !sameArray(plan!.terminalUnitIds, terminals) ||
      plan!.reservations.length !== expectedReservations.length ||
      plan!.reservations.some((reservation, index) => {
        const expected = expectedReservations[index]!;
        return (
          reservation.unitId !== expected.unitId ||
          reservation.sourceId !== expected.sourceId ||
          reservation.routeKind !== expected.routeKind ||
          reservation.preparedComponentId !== expected.preparedComponentId ||
          reservation.preparedBeforeDirectBodies !== true
        );
      }) ||
      !sameArray(
        plan!.unreservedTerminalUnitIds,
        terminals.filter((unitId) => !reserved.has(unitId)),
      ) ||
      plan!.sources.length !== canonical.length ||
      plan!.sources.some((source, index) => {
        const inventory = this.#sources[index]!;
        const sourceFile = this.#reverseSourceMap.get(inventory.id);
        return (
          source.sourceId !== inventory.id ||
          source.sourceKey !== inventory.sourceKey ||
          source.canonicalOrder !== inventory.order ||
          source.semanticOrder !== this.#sourceFiles.indexOf(sourceFile!) ||
          source.kind !== inventory.kind ||
          !sameArray(
            source.terminalUnitIds,
            this.#terminalUnits.filter((unit) => unit.sourceId === inventory.id).map((unit) => unit.id),
          )
        );
      })
    ) {
      this.#fail("body-plan-mismatch", "sealed source/unit/reservation census no longer matches the owner");
    }
  }

  #validateConstruction(): void {
    if (
      this.#identityContext.inventory !== this.#inventory ||
      this.#programAbiSession.inventory !== this.#identityContext.inventory ||
      this.#ctx.programAbiSession !== this.#programAbiSession ||
      this.#ctx.irPlanningIdentityContext !== this.#identityContext ||
      this.#identityContext.sourceIdBySourceFile !== this.#sourceMap ||
      this.#identityContext.sourceFileBySourceId !== this.#reverseSourceMap ||
      this.#identityContext.terminalByUnitId !== this.#terminalMap ||
      this.#identityContext.unitByUnitId !== this.#unitMap
    ) {
      this.#fail("construction-session-mismatch", "owner was not bound to the exact context and ABI session");
    }
    if (
      this.#multiAst.sourceFiles !== this.#astSourceFiles ||
      !sameIdentityArray(this.#multiAst.sourceFiles, this.#sourceFiles)
    ) {
      this.#fail("construction-source-join", "AST source population changed after owner construction");
    }
    if (this.#multiAst.entryFile !== this.#entryFile) {
      this.#fail("construction-source-join", "entry AST object changed after owner construction");
    }
    if (
      !sameIdentityArray(this.#identityContext.inventory.sources, this.#sources) ||
      !sameIdentityArray(this.#identityContext.inventory.terminalUnits, this.#terminalUnits)
    ) {
      this.#fail("construction-terminal-denominator", "inventory denominator changed after owner construction");
    }
    if (this.#sourceFiles.length !== this.#sources.length) {
      this.#fail("construction-source-count", "AST and identity source populations differ");
    }
    const astSet = new Set<SourceFile>();
    for (const sourceFile of this.#sourceFiles) {
      if (astSet.has(sourceFile))
        this.#fail("construction-source-join", `source ${sourceFile.fileName} occurs twice in AST order`);
      astSet.add(sourceFile);
      this.#sourceId(sourceFile);
    }
    let entryCount = 0;
    for (const source of this.#sources) {
      const sourceFile = this.#reverseSourceMap.get(source.id);
      if (!sourceFile || !astSet.has(sourceFile) || this.#sourceMap.get(sourceFile) !== source.id) {
        this.#fail("construction-source-join", `inventory source ${source.id} has no exact reverse AST join`);
      }
      if (source.kind === "entry") entryCount++;
    }
    if (entryCount !== 1 || this.#identityContext.inventory.sources.some((source, index) => source.order !== index)) {
      this.#fail("construction-canonical-order", "inventory source order is not the canonical order");
    }
    this.#entrySourceId();
    const terminalIds = new Set<IrUnitId>();
    const localCounts = new Map<IrSourceId, number>();
    for (const terminal of this.#terminalUnits) {
      if (
        terminalIds.has(terminal.id) ||
        this.#terminalMap.get(terminal.id) !== terminal ||
        this.#unitMap.get(terminal.id) !== terminal
      ) {
        this.#fail(
          "construction-terminal-denominator",
          `terminal ${terminal.id} is missing or duplicated in the identity maps`,
        );
      }
      if (!inventorySource(this.#identityContext.inventory, terminal.sourceId)) {
        this.#fail("construction-terminal-denominator", `terminal ${terminal.id} belongs to unknown source`);
      }
      const declaration = this.#identityContext.declarationByUnitId.get(terminal.id);
      if (declaration && this.#sourceMap.get(declaration.getSourceFile()) !== terminal.sourceId) {
        this.#fail("construction-terminal-denominator", `terminal ${terminal.id} is attached to the wrong source`);
      }
      terminalIds.add(terminal.id);
      localCounts.set(terminal.sourceId, (localCounts.get(terminal.sourceId) ?? 0) + 1);
    }
    if (terminalIds.size !== this.#terminalMap.size) {
      this.#fail("construction-terminal-denominator", "terminal identity map contains a foreign or missing terminal");
    }
    for (const [unitId, terminal] of this.#terminalMap) {
      if (!terminalIds.has(unitId) || this.#terminalUnits.find((candidate) => candidate.id === unitId) !== terminal) {
        this.#fail("construction-terminal-denominator", `terminal map entry ${unitId} is not in the exact denominator`);
      }
    }
    for (const source of this.#sources) {
      const local = this.#terminalUnits.filter((terminal) => terminal.sourceId === source.id);
      if (local.length !== (localCounts.get(source.id) ?? 0)) {
        this.#fail("construction-terminal-denominator", `source ${source.id} has an inconsistent terminal denominator`);
      }
    }
  }

  #assertStable(): void {
    this.#validateConstruction();
    if (this.#ctx.irProgramPreparedModuleInitUnitId !== this.#moduleInitPreparation?.unitId) {
      this.#fail("module-init-reservation-mismatch", "module-init owner marker changed after exact registration");
    }
    if (
      !sameSet(this.#ctx.irProgramCallablePreparedUnitIds ?? new Set<IrUnitId>(), [
        ...this.#callableComponentByUnitId.keys(),
      ])
    ) {
      this.#fail("route-plan-mismatch", "callable component context projection changed after registration");
    }
    if (this.#bodyPlan) this.#assertBodyPlan();
  }

  #requireState(expected: MultiPreparedProgramState): void {
    if (this.#state === "failed") this.#fail("owner-failed", "multi-prepared program owner is failed closed");
    if (this.#state !== expected) this.#fail("completion-order", `owner is ${this.#state}, expected ${expected}`);
  }

  #fail(code: MultiPreparedProgramInvariantCode, detail: string): never {
    this.#state = "failed";
    return routeInvariant(code, detail);
  }
}

export function publishMultiPreparedProgram<Plan extends MultiPreparedScalarLeafPlan>(
  owner: MultiPreparedProgramOwner<Plan> | undefined,
  programAbiSession: ProgramAbiSession | undefined,
  mod: WasmModule,
): void {
  owner?.sealBeforePublication();
  const publication = programAbiSession?.publish(mod);
  if (publication) owner?.complete(publication);
}
