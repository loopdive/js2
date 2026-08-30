// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { MultiTypedAST } from "../checker/index.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import {
  buildIrModuleInitPlan,
  reconcileIrModuleInitPlan,
  type IrModuleInitPlanningEvidence,
} from "../ir/module-init-plan.js";
import { collectModuleInitPopulation } from "../ir/module-init.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrIntegrationReport } from "../ir/integration.js";
import type { IrSelection } from "../ir/select.js";
import type { FuncHandle, Instr, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, CodegenOptions } from "./context/types.js";
import { preallocateModuleInitCallable } from "./declarations.js";
import { prepareModuleTdzGlobals } from "./module-global-registration.js";
import type { IrOverlayPlan } from "./index.js";
import { prepareIrBodies, type PreparedIrModuleInitBody } from "./ir-prepared-free-functions.js";

export interface MultiPreparedModuleInitSourcePlan {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId | null;
  readonly executable: boolean;
  readonly evaluationCount: number;
  readonly planning: IrModuleInitPlanningEvidence;
}

export interface MultiPreparedModuleInitLexicalEvidence {
  readonly unitId: IrUnitId;
  readonly globalBindingIds: ReadonlySet<string>;
  readonly invocationKind: "wasm-start" | "deferred-export";
}

export interface MultiPreparedModuleInitPlanningInput {
  readonly ctx: CodegenContext;
  readonly multiAst: MultiTypedAST;
  readonly options?: CodegenOptions;
  readonly identityContext: IrPlanningIdentityContext;
  readonly planSource: (sourceFile: ts.SourceFile) => IrOverlayPlan;
  readonly planResolvedSource: (sourceFile: ts.SourceFile) => IrOverlayPlan;
  readonly safeSelection: (plan: IrOverlayPlan, sourceFile: ts.SourceFile) => IrSelection;
  readonly projectLoweringPlans: (plan: IrOverlayPlan, selection: IrSelection) => IrIntegrationLoweringPlans;
  readonly selectExactLexicalModuleInit: (
    sourceFile: ts.SourceFile,
    selection: Pick<IrSelection, "moduleInit">,
    planning: IrModuleInitPlanningEvidence,
  ) => MultiPreparedModuleInitLexicalEvidence | undefined;
}

export interface MultiPreparedModuleInitPreparation {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly sourcePlans: readonly MultiPreparedModuleInitSourcePlan[];
  readonly invocationKind: "wasm-start" | "deferred-export";
  readonly preparedComponentId: string;
  readonly preparedFunction: WasmFunction;
  readonly preparedHandle: FuncHandle;
  readonly preparedFunctionBody: WasmFunction["body"];
  readonly preparedInstructions: readonly Instr[];
  readonly preparedBody: PreparedIrModuleInitBody;
  readonly report: IrIntegrationReport;
  readonly selection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">;
}

function sourceEntries<
  T extends { readonly initializer?: ts.Expression; readonly staticBlock?: ts.ClassStaticBlockDeclaration },
>(entries: readonly T[], sourceFile: ts.SourceFile): readonly T[] {
  return entries.filter((entry) => (entry.staticBlock ?? entry.initializer)?.getSourceFile() === sourceFile);
}

function sourceLiveFunctionNames(ctx: CodegenContext, sourceFile: ts.SourceFile): readonly string[] {
  const names = new Set(
    sourceFile.statements
      .filter(
        (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.name,
      )
      .map((statement) => statement.name!.text),
  );
  return [...(ctx.liveFuncBindingGlobals ?? [])].filter((name) => names.has(name));
}

/** Return false for syntax that is outside the deliberately tiny M2 owner. */
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
      ts.isYieldExpression(node)
    ) {
      forbidden = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      let resolved = symbol;
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        resolved = checker.getAliasedSymbol(symbol);
        if (!resolved || resolved === symbol || (resolved.declarations?.length ?? 0) === 0) {
          forbidden = true;
          return;
        }
      }
      const declarations = resolved?.declarations ?? [];
      if (declarations.some((declaration) => declaration.getSourceFile() !== sourceFile)) {
        forbidden = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of collectModuleInitPopulation(sourceFile)) visit(statement);
  return forbidden;
}

function rejectBeforeReservation(input: MultiPreparedModuleInitPlanningInput): boolean {
  const { ctx, multiAst, options } = input;
  if (
    process.env.JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER !== "1" ||
    !options?.experimentalIR ||
    options.disableIrFirst ||
    multiAst.sourceFiles.length <= 1 ||
    ctx.fast ||
    ctx.wasi ||
    ctx.strictNoHostImports ||
    !ctx.programAbiModuleInitCallables
  ) {
    return true;
  }
  if ((ctx.staticInitExprs?.length ?? 0) !== 0 || (ctx.liveFuncBindingGlobals?.size ?? 0) !== 0) return true;
  return false;
}

/** Plan and prepare the one exact source-owned module-init unit for M2. */
export function planMultiPreparedModuleInit(
  input: MultiPreparedModuleInitPlanningInput,
): MultiPreparedModuleInitPreparation | undefined {
  if (rejectBeforeReservation(input)) return undefined;

  const sourcePlans = input.multiAst.sourceFiles.map((sourceFile): MultiPreparedModuleInitSourcePlan => {
    const sourceId = input.identityContext.sourceIdBySourceFile.get(sourceFile);
    if (!sourceId) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `source ${sourceFile.fileName} has no exact source ID`,
      );
    }
    const plan = buildIrModuleInitPlan({
      sourceFile,
      checker: input.multiAst.checker,
      identityContext: input.identityContext,
      target: input.ctx.wasi ? "wasi" : input.ctx.standalone ? "standalone" : "host",
      deferTopLevelInit: input.ctx.deferTopLevelInit,
    });
    const planning = Object.freeze({
      plan,
      parity: reconcileIrModuleInitPlan(plan, sourceFile, {
        liveFunctionNames: sourceLiveFunctionNames(input.ctx, sourceFile),
        staticEntries: sourceEntries(input.ctx.staticInitExprs, sourceFile),
        moduleStatements: input.ctx.moduleInitStatements.filter(
          (statement) => statement.getSourceFile() === sourceFile,
        ),
      }),
    });
    return Object.freeze({
      sourceFile,
      sourceId,
      unitId: plan.executable ? plan.unitId : null,
      executable: plan.executable,
      evaluationCount: plan.evaluations.length,
      planning,
    });
  });

  const executable = sourcePlans.filter((sourcePlan) => sourcePlan.executable);
  const contributor = executable.length === 1 ? executable[0] : undefined;
  if (
    executable.length !== 1 ||
    !contributor ||
    contributor.unitId === null ||
    sourcePlans.some(
      (sourcePlan) =>
        sourcePlan.planning.plan.gaps.length !== 0 ||
        !sourcePlan.planning.parity.aligned ||
        sourcePlan.planning.plan.liveSeeds.length !== 0 ||
        hasForbiddenModuleInitSyntax(sourcePlan.sourceFile, input.multiAst.checker),
    ) ||
    input.multiAst.sourceFiles.some((sourceFile) =>
      sourceFile.statements.some((statement) => ts.isClassDeclaration(statement)),
    )
  ) {
    return undefined;
  }

  const plans = sourcePlans.map(
    (sourcePlan) => [sourcePlan.sourceFile, input.planSource(sourcePlan.sourceFile)] as const,
  );
  const safeSelections = plans.map(
    ([sourceFile, plan]) => [sourceFile, plan, input.safeSelection(plan, sourceFile)] as const,
  );
  if (
    safeSelections.some(
      ([, plan, selection]) =>
        selection.funcs.size !== 0 ||
        (selection.classMembers?.size ?? 0) !== 0 ||
        (selection.classMemberUnitIds?.size ?? 0) !== 0 ||
        plan.importedCalls.size !== 0 ||
        plan.topLevelFunctionValues.size !== 0 ||
        plan.hostVoidCallbacks.size !== 0 ||
        plan.hostDateSnapshots.size !== 0 ||
        plan.hostDateGetters.size !== 0 ||
        plan.promiseDelays.constructions.size !== 0 ||
        plan.suspendingAsyncUnitIds.size !== 0,
    )
  ) {
    return undefined;
  }

  const contributorPlan = safeSelections.find(([sourceFile]) => sourceFile === contributor.sourceFile);
  if (!contributorPlan) return undefined;
  // The generic multi-source overlay intentionally plans without module
  // bindings. M2 must repeat the contributor plan with the exact resolver so
  // unsupported storage/value representations are rejected before the ABI
  // slot is reserved, rather than becoming a fatal lowering-time mismatch.
  const overlayPlan = input.planResolvedSource(contributor.sourceFile);
  const resolvedSelection = input.safeSelection(overlayPlan, contributor.sourceFile);
  if (
    resolvedSelection.funcs.size !== 0 ||
    (resolvedSelection.classMembers?.size ?? 0) !== 0 ||
    (resolvedSelection.classMemberUnitIds?.size ?? 0) !== 0 ||
    overlayPlan.importedCalls.size !== 0 ||
    overlayPlan.topLevelFunctionValues.size !== 0 ||
    overlayPlan.hostVoidCallbacks.size !== 0 ||
    overlayPlan.hostDateSnapshots.size !== 0 ||
    overlayPlan.hostDateGetters.size !== 0 ||
    overlayPlan.promiseDelays.constructions.size !== 0 ||
    overlayPlan.suspendingAsyncUnitIds.size !== 0
  ) {
    return undefined;
  }
  // The existing multi-source safe-selection projection deliberately clears
  // module-init because its generic overlay is not an owner. M2 consumes the
  // planner's claim assessment directly, then installs its own exact owner.
  const moduleInit = overlayPlan.selection.moduleInit;
  if (moduleInit === undefined) return undefined;
  const lexical = input.selectExactLexicalModuleInit(contributor.sourceFile, { moduleInit }, contributor.planning);
  if (
    !lexical ||
    lexical.unitId !== contributor.unitId ||
    lexical.invocationKind !== contributor.planning.plan.invocation.kind
  ) {
    return undefined;
  }

  // Everything above is a pre-reservation eligibility gate. From this point
  // on, a broken exact handoff is an invariant failure, never a fallback.
  const registry = input.ctx.programAbiModuleInitCallables;
  if (!registry) throw new IrInvariantError("selection-preparation-mismatch", "resolve", "M2 lost its ABI registry");
  preallocateModuleInitCallable(input.ctx, contributor.sourceFile);
  registry.reservePreparedExactUnit(contributor.unitId);
  prepareModuleTdzGlobals(input.ctx, contributor.sourceFile);
  const preparedSelection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit"> = {
    funcs: new Set(),
    classMembers: new Set(),
    classMemberUnitIds: new Set(),
    moduleInit,
  };
  const preparedBodies = prepareIrBodies({
    ctx: input.ctx,
    sourceFile: contributor.sourceFile,
    selection: preparedSelection,
    identityPlan: overlayPlan.identityPlan,
    functionClaimsByUnitId: overlayPlan.functionClaimsByUnitId,
    overrideMap: overlayPlan.overrideMap,
    classShapes: overlayPlan.classShapes,
    classShapesById: overlayPlan.classShapesById,
    projectLoweringPlans: (selection) => input.projectLoweringPlans(overlayPlan, selection),
  });
  const preparedBody = preparedBodies.moduleInit;
  const report = preparedBodies.report;
  const evidence = report.terminalEvidence ?? [];
  const artifacts = report.compiledArtifactEvidence ?? [];
  const terminalEvidence = evidence.find(
    (entry) => entry.kind === "patched" && entry.unitId === contributor.unitId && entry.legacyName === "<module-init>",
  );
  const preparedComponentId = terminalEvidence?.kind === "patched" ? terminalEvidence.preparedComponentId : undefined;
  const preparedFunction = registry.functionForUnit(contributor.unitId);
  const preparedHandle = registry.handleForUnit(contributor.unitId);
  const preparedFunctionBody = preparedFunction?.body;
  const preparedInstructions = preparedFunctionBody ? Object.freeze([...preparedFunctionBody]) : undefined;
  if (
    !preparedBody ||
    report.errors.length !== 0 ||
    report.compiled.length !== 1 ||
    report.compiled[0] !== "<module-init>" ||
    !preparedComponentId ||
    preparedFunction === undefined ||
    preparedHandle === undefined ||
    preparedFunctionBody === undefined ||
    preparedFunctionBody.length === 0 ||
    preparedInstructions === undefined ||
    artifacts.length !== 1
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `Prepared module-init ${contributor.unitId} did not produce one exact IR artifact`,
    );
  }
  return Object.freeze({
    sourceFile: contributor.sourceFile,
    sourceId: contributor.sourceId,
    unitId: contributor.unitId,
    sourcePlans: Object.freeze(sourcePlans),
    invocationKind: lexical.invocationKind,
    preparedComponentId,
    preparedFunction,
    preparedHandle,
    preparedFunctionBody,
    preparedInstructions,
    preparedBody,
    report,
    selection: preparedSelection,
  });
}
