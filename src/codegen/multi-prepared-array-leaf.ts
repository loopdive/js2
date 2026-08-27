// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Narrow multi-source Prepared route for the standalone numeric array leaf.
 *
 * This module intentionally owns only the array proof.  Array lowering itself
 * remains in the shared IR frontend (`array-element-lowering.ts` and
 * `from-ast.ts`); this route merely certifies that the already-existing
 * prepared body is the exact body that can be withdrawn from the legacy pass.
 */

import type { IrUnitId } from "../ir/identity.js";
import type { IrIntegrationReport } from "../ir/integration.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { asVal } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrSelection } from "../ir/select.js";
import type { Instr } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { hasExportModifier } from "./ast-modifiers.js";
import type { CodegenContext } from "./context/types.js";
import { canonicalCountedPushPlanForCall, canonicalCountedPushPlanForLiteral } from "../ir/array-element-lowering.js";
import {
  exactAllocatedNumericCallable,
  functionValueSupportIsCurrent,
  hasExactNumericDeclarationSignature,
  identifierResolvesExactly,
  type EarlyMultiPreparedScalarLeafState,
  type MultiPreparedFunctionValueCandidateEvidence,
  type MultiPreparedFunctionValueSupportReceipt,
  type MultiPreparedLeafRouteBase,
  type MultiPreparedScalarLeafGraphSafety,
  type MultiPreparedScalarLeafPlan,
  type MultiPreparedScalarLeafReceipt,
  multiPreparedRouteClaimsOverlap,
  type MultiPreparedRouteClaimSnapshot,
} from "./multi-prepared-scalar-leaf.js";
import {
  multiPreparedFunctionValueUseIsCurrent,
  resolveMultiPreparedFunctionValueImportTarget,
} from "./multi-prepared-function-value-import-target.js";
import { prepareIrBodies, type PreparedIrFreeFunctionBodies } from "./ir-prepared-free-functions.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";

export interface MultiPreparedArrayLeafShape {
  readonly arrayDeclaration: ts.VariableDeclaration;
  readonly fillLoop: ts.ForStatement;
  readonly pushCall: ts.CallExpression;
  readonly fillCounter: ts.VariableDeclaration;
  readonly totalDeclaration: ts.VariableDeclaration;
  readonly reduceLoop: ts.ForStatement;
  readonly reduceCounter: ts.VariableDeclaration;
  readonly reduceAssignment: ts.BinaryExpression;
  readonly indexedAccess: ts.ElementAccessExpression;
}

export interface MultiPreparedArrayLeafCallback extends MultiPreparedFunctionValueCandidateEvidence {}

export interface MultiPreparedArrayLeafRoute extends MultiPreparedLeafRouteBase {
  readonly routeKind: "array";
  readonly shape: MultiPreparedArrayLeafShape;
  readonly callback?: MultiPreparedArrayLeafCallback;
  readonly support?: MultiPreparedFunctionValueSupportReceipt;
}

interface ArrayCandidateEvidence {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly shape: MultiPreparedArrayLeafShape;
  readonly callback?: MultiPreparedArrayLeafCallback;
}

interface ArrayCandidateInput<Plan extends MultiPreparedScalarLeafPlan> {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.FunctionDeclaration;
  readonly plan: Plan;
  readonly safeSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
  readonly lateProviderOwnerUnitIds: ReadonlySet<IrUnitId>;
}

function numericLiteralIs(expression: ts.Expression | undefined, text: string): expression is ts.NumericLiteral {
  return !!expression && ts.isNumericLiteral(expression) && expression.text === text;
}

function isIdentifierOf(
  ctx: CodegenContext,
  node: ts.Node | undefined,
  declaration: ts.Declaration,
): node is ts.Identifier {
  return !!node && ts.isIdentifier(node) && identifierResolvesExactly(ctx, node, declaration);
}

function oneStatementBody(statement: ts.Statement): ts.Statement | undefined {
  if (ts.isBlock(statement)) return statement.statements.length === 1 ? statement.statements[0] : undefined;
  return statement;
}

function exactArrayShape(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
): MultiPreparedArrayLeafShape | undefined {
  if (!declaration.body || declaration.body.statements.length !== 5) return undefined;
  const [arrayStatement, fillStatement, totalStatement, reduceStatement, returnStatement] = declaration.body.statements;
  if (
    !arrayStatement ||
    !ts.isVariableStatement(arrayStatement) ||
    arrayStatement.declarationList.flags !== ts.NodeFlags.Const ||
    arrayStatement.declarationList.declarations.length !== 1
  ) {
    return undefined;
  }
  const arrayDeclaration = arrayStatement.declarationList.declarations[0]!;
  if (
    !ts.isIdentifier(arrayDeclaration.name) ||
    !arrayDeclaration.type ||
    !ts.isArrayTypeNode(arrayDeclaration.type) ||
    arrayDeclaration.type.elementType.kind !== ts.SyntaxKind.NumberKeyword ||
    !arrayDeclaration.initializer ||
    !ts.isArrayLiteralExpression(arrayDeclaration.initializer) ||
    arrayDeclaration.initializer.elements.length !== 0
  ) {
    return undefined;
  }
  const fillLoop = fillStatement && ts.isForStatement(fillStatement) ? fillStatement : undefined;
  if (!fillLoop) return undefined;
  const fillInit = fillLoop.initializer;
  if (
    !fillInit ||
    !ts.isVariableDeclarationList(fillInit) ||
    fillInit.flags !== ts.NodeFlags.Let ||
    fillInit.declarations.length !== 1
  ) {
    return undefined;
  }
  const fillCounter = fillInit.declarations[0]!;
  if (!ts.isIdentifier(fillCounter.name) || !numericLiteralIs(fillCounter.initializer, "0")) return undefined;
  if (
    !fillLoop.condition ||
    !ts.isBinaryExpression(fillLoop.condition) ||
    fillLoop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !isIdentifierOf(ctx, fillLoop.condition.left, fillCounter) ||
    !ts.isNumericLiteral(fillLoop.condition.right) ||
    !Number.isSafeInteger(Number(fillLoop.condition.right.text)) ||
    Number(fillLoop.condition.right.text) <= 0
  ) {
    return undefined;
  }
  if (
    !fillLoop.incrementor ||
    !ts.isPostfixUnaryExpression(fillLoop.incrementor) ||
    fillLoop.incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !isIdentifierOf(ctx, fillLoop.incrementor.operand, fillCounter)
  ) {
    return undefined;
  }
  const pushStatement = oneStatementBody(fillLoop.statement);
  const pushCall = pushStatement && ts.isExpressionStatement(pushStatement) ? pushStatement.expression : undefined;
  if (
    !pushCall ||
    !ts.isCallExpression(pushCall) ||
    pushCall.arguments.length !== 1 ||
    ts.isSpreadElement(pushCall.arguments[0]!) ||
    !ts.isPropertyAccessExpression(pushCall.expression) ||
    pushCall.expression.name.text !== "push" ||
    !isIdentifierOf(ctx, pushCall.expression.expression, arrayDeclaration) ||
    !isIdentifierOf(ctx, pushCall.arguments[0], fillCounter)
  ) {
    return undefined;
  }
  const pushPlan = canonicalCountedPushPlanForLiteral(arrayDeclaration.initializer, ctx.checker);
  if (!pushPlan || pushPlan.pushCall !== pushCall || pushPlan.capacity !== Number(fillLoop.condition.right.text)) {
    return undefined;
  }

  if (
    !totalStatement ||
    !ts.isVariableStatement(totalStatement) ||
    totalStatement.declarationList.flags !== ts.NodeFlags.Let ||
    totalStatement.declarationList.declarations.length !== 1
  ) {
    return undefined;
  }
  const totalDeclaration = totalStatement.declarationList.declarations[0]!;
  if (!ts.isIdentifier(totalDeclaration.name) || !numericLiteralIs(totalDeclaration.initializer, "0")) return undefined;

  const reduceLoop = reduceStatement && ts.isForStatement(reduceStatement) ? reduceStatement : undefined;
  if (!reduceLoop) return undefined;
  const reduceInit = reduceLoop.initializer;
  if (
    !reduceInit ||
    !ts.isVariableDeclarationList(reduceInit) ||
    reduceInit.flags !== ts.NodeFlags.Let ||
    reduceInit.declarations.length !== 1
  ) {
    return undefined;
  }
  const reduceCounter = reduceInit.declarations[0]!;
  if (!ts.isIdentifier(reduceCounter.name) || !numericLiteralIs(reduceCounter.initializer, "0")) return undefined;
  if (
    !reduceLoop.condition ||
    !ts.isBinaryExpression(reduceLoop.condition) ||
    reduceLoop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !isIdentifierOf(ctx, reduceLoop.condition.left, reduceCounter) ||
    !ts.isPropertyAccessExpression(reduceLoop.condition.right) ||
    reduceLoop.condition.right.name.text !== "length" ||
    !isIdentifierOf(ctx, reduceLoop.condition.right.expression, arrayDeclaration)
  ) {
    return undefined;
  }
  if (
    !reduceLoop.incrementor ||
    !ts.isPostfixUnaryExpression(reduceLoop.incrementor) ||
    reduceLoop.incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !isIdentifierOf(ctx, reduceLoop.incrementor.operand, reduceCounter)
  ) {
    return undefined;
  }
  const reduceStatementBody = oneStatementBody(reduceLoop.statement);
  const reduceExpression =
    reduceStatementBody && ts.isExpressionStatement(reduceStatementBody) ? reduceStatementBody.expression : undefined;
  const reduceAssignment = reduceExpression && ts.isBinaryExpression(reduceExpression) ? reduceExpression : undefined;
  if (
    !reduceAssignment ||
    reduceAssignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isIdentifierOf(ctx, reduceAssignment.left, totalDeclaration) ||
    !ts.isBinaryExpression(reduceAssignment.right) ||
    reduceAssignment.right.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !isIdentifierOf(ctx, reduceAssignment.right.left, totalDeclaration) ||
    !ts.isElementAccessExpression(reduceAssignment.right.right) ||
    !isIdentifierOf(ctx, reduceAssignment.right.right.expression, arrayDeclaration) ||
    reduceAssignment.right.right.argumentExpression === undefined ||
    !isIdentifierOf(ctx, reduceAssignment.right.right.argumentExpression, reduceCounter)
  ) {
    return undefined;
  }
  const indexedAccess = reduceAssignment.right.right;
  const reducePlan = canonicalCountedPushPlanForCall(pushCall, ctx.checker);
  if (!reducePlan || reducePlan.pushCall !== pushCall) {
    // The helper is intentionally called on the push site above; this branch
    // documents that the count proof is shared, while reduction uses length.
    return undefined;
  }
  if (
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !isIdentifierOf(ctx, returnStatement.expression, totalDeclaration)
  ) {
    return undefined;
  }
  return {
    arrayDeclaration,
    fillLoop,
    pushCall,
    fillCounter,
    totalDeclaration,
    reduceLoop,
    reduceCounter,
    reduceAssignment,
    indexedAccess,
  };
}

function exactLocalSingleton(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  unitId: IrUnitId,
  plan: IrOverlayIdentityPlan,
): boolean {
  const edges = collectLocalCallEdgesByIdentity(sourceFile, plan.identityContext);
  if ((edges.callees.get(unitId)?.size ?? 0) !== 0 || edges.calleesFromUnownedCallers.has(unitId)) return false;
  return ![...edges.callees].some(([caller, callees]) => caller !== unitId && callees.has(unitId));
}

function collectCallback(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
  identityPlan: IrOverlayIdentityPlan,
): MultiPreparedArrayLeafCallback | undefined {
  const refs: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      identifierResolvesExactly(ctx, node, declaration) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      refs.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (refs.length === 0) return undefined;
  if (refs.length !== 1) return undefined;
  const valueIdentifier = refs[0]!;
  const importedCall = valueIdentifier.parent;
  if (
    !ts.isCallExpression(importedCall) ||
    importedCall.arguments.filter((arg) => arg === valueIdentifier).length !== 1
  ) {
    return undefined;
  }
  let owner: ts.Node | undefined = importedCall.parent;
  while (owner && owner !== sourceFile && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || !ts.isFunctionDeclaration(owner) || owner.parent !== sourceFile || !owner.name) return undefined;
  const legacyOwnerUnitId = identityPlan.identityContext.unitIdByDeclaration.get(owner);
  const unitId = identityPlan.identityContext.unitIdByDeclaration.get(declaration);
  const importedTarget = ts.isIdentifier(importedCall.expression)
    ? resolveMultiPreparedFunctionValueImportTarget({
        oracle: ctx.oracle,
        sourceFile,
        callee: importedCall.expression,
        identityContext: identityPlan.identityContext,
      })
    : undefined;
  const importedTargetUnitId = importedTarget
    ? identityPlan.identityContext.unitIdByDeclaration.get(importedTarget)
    : undefined;
  const ownerTerminal = legacyOwnerUnitId
    ? identityPlan.identityContext.terminalByUnitId.get(legacyOwnerUnitId)
    : undefined;
  if (
    !unitId ||
    !legacyOwnerUnitId ||
    legacyOwnerUnitId === unitId ||
    !ownerTerminal ||
    ownerTerminal.terminalOwnerId !== legacyOwnerUnitId ||
    ownerTerminal.observedKind !== "function" ||
    !importedTarget ||
    importedTarget.name?.text !== "addBenchCard" ||
    !importedTargetUnitId
  ) {
    return undefined;
  }
  return {
    legacyName: declaration.name!.text,
    unitId,
    valueIdentifier,
    legacyOwnerUnitId,
    legacyOwnerName: owner.name.text,
    importedCall,
    importedTargetUnitId,
  };
}

export function collectMultiPreparedArrayLeafCandidates(
  ctx: CodegenContext,
  sourceFiles: readonly ts.SourceFile[],
): readonly ts.FunctionDeclaration[] {
  return sourceFiles.flatMap((sourceFile) =>
    sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        hasExportModifier(statement) &&
        hasExactNumericDeclarationSignature(statement) &&
        statement.parameters.length === 0 &&
        exactArrayShape(ctx, statement) !== undefined,
    ),
  );
}

function resolveArrayCandidate<Plan extends MultiPreparedScalarLeafPlan>(
  input: ArrayCandidateInput<Plan>,
): ArrayCandidateEvidence | undefined {
  const { ctx, declaration, lateProviderOwnerUnitIds, plan, safeSelection, safety, sourceFile } = input;
  if (
    !ctx.standalone ||
    ctx.fast ||
    ctx.wasi ||
    declaration.parent !== sourceFile ||
    !declaration.name ||
    !declaration.body
  ) {
    return undefined;
  }
  const shape = exactArrayShape(ctx, declaration);
  if (!shape) return undefined;
  const legacyName = declaration.name.text;
  const unitId = plan.identityPlan.identityContext.unitIdByDeclaration.get(declaration);
  const terminal = unitId ? plan.identityPlan.identityContext.terminalByUnitId.get(unitId) : undefined;
  const claim = unitId ? plan.functionClaimsByUnitId.get(unitId) : undefined;
  const override = unitId ? plan.overrideMapByUnitId.get(unitId) : undefined;
  const callback = collectCallback(ctx, sourceFile, declaration, plan.identityPlan);
  const foreignLateProvider = unitId !== undefined && lateProviderOwnerUnitIds.has(unitId) && !callback;
  if (
    !unitId ||
    !terminal ||
    terminal.kind !== "top-level-function" ||
    terminal.observedKind !== "function" ||
    terminal.terminalOwnerId !== unitId ||
    plan.identityPlan.identityContext.declarationByUnitId.get(unitId) !== declaration ||
    claim?.declaration !== declaration ||
    claim.legacyName !== legacyName ||
    !safeSelection.funcs.has(legacyName) ||
    !plan.identityPlan.safeFunctionUnitIds.has(unitId) ||
    !override ||
    override.params.length !== 0 ||
    override.returnType === null ||
    asVal(override.returnType)?.kind !== "f64" ||
    safety.collisions.has(legacyName) ||
    safety.crossFileFunctionNames.has(legacyName) ||
    safety.importAliasNames.has(legacyName) ||
    safety.occupiedFunctionNameCounts.get(legacyName) !== 1 ||
    safety.occupiedFunctionKeys.some((key) => key.startsWith(`${legacyName}$`)) ||
    ctx.liveFuncBindingGlobals?.has(legacyName) === true ||
    foreignLateProvider ||
    plan.classShapes.size !== 0 ||
    plan.classShapesById.size !== 0 ||
    !exactLocalSingleton(ctx, sourceFile, unitId, plan.identityPlan) ||
    exactAllocatedNumericCallable(ctx, unitId, legacyName, 0, true) === undefined
  ) {
    return undefined;
  }
  // A non-empty reference set which is not the exact imported callback is not
  // safe to prepare. `undefined` is ambiguous, so distinguish it by counting
  // the references again only for this narrow candidate.
  if (callback === undefined) {
    let references = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== declaration.name && identifierResolvesExactly(ctx, node, declaration))
        references++;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (references !== 0) return undefined;
  }
  return { unitId, legacyName, shape, ...(callback ? { callback } : {}) };
}

function exactWithdrawal(
  preparedReport: IrIntegrationReport,
  prepared: PreparedIrFreeFunctionBodies,
  unitId: IrUnitId,
  legacyName: string,
): boolean {
  const evidence = (preparedReport.terminalEvidence ?? [])[0];
  return (
    prepared.skipBodies.size === 0 &&
    prepared.preserveBodies.size === 0 &&
    prepared.completedBodies.size === 0 &&
    prepared.requestedSkipProjection.entries.length === 0 &&
    preparedReport.compiled.length === 0 &&
    (preparedReport.compiledArtifactEvidence?.length ?? 0) === 0 &&
    (preparedReport.syntheticCompiledArtifacts?.length ?? 0) === 0 &&
    ((preparedReport.errors.length === 0 && (preparedReport.terminalEvidence?.length ?? 0) === 0) ||
      (preparedReport.errors.length === 1 &&
        preparedReport.terminalEvidence?.length === 1 &&
        evidence?.kind === "failed" &&
        evidence.unitId === unitId &&
        evidence.legacyName === legacyName &&
        evidence.error === preparedReport.errors[0] &&
        evidence.error.outcome.kind === "unsupported"))
  );
}

export function tryPrepareMultiSourceArrayLeaf<Plan extends MultiPreparedScalarLeafPlan>(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.FunctionDeclaration;
  readonly plan: Plan;
  readonly candidate: ArrayCandidateEvidence;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
  readonly prepareFunctionValueSupport?: (
    unitId: IrUnitId,
    legacyName: string,
  ) => MultiPreparedFunctionValueSupportReceipt | undefined;
}): MultiPreparedArrayLeafRoute | undefined {
  const { candidate, ctx, declaration, plan, projectLoweringPlans, sourceFile } = input;
  const support = candidate.callback
    ? input.prepareFunctionValueSupport?.(candidate.unitId, candidate.legacyName)
    : undefined;
  if (candidate.callback && (!support || !functionValueSupportIsCurrent(ctx, candidate.callback, support, true)))
    return undefined;
  const preparedSelection: IrSelection = {
    funcs: new Set([candidate.legacyName]),
    classMembers: new Set(),
    classMemberUnitIds: new Set(),
    moduleInit: undefined,
  };
  const prepared = prepareIrBodies({
    ctx,
    sourceFile,
    selection: preparedSelection,
    identityPlan: plan.identityPlan,
    functionClaimsByUnitId: plan.functionClaimsByUnitId,
    overrideMap: plan.overrideMap,
    classShapes: plan.classShapes,
    classShapesById: plan.classShapesById,
    projectLoweringPlans,
  });
  if (prepared.classMembers || prepared.moduleInit || prepared.implicitConstructorUnitIds.size !== 0) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `array leaf ${candidate.unitId} produced foreign routing`,
    );
  }
  if (prepared.freeFunctions.skipBodies.size === 0) {
    if (exactWithdrawal(prepared.report, prepared.freeFunctions, candidate.unitId, candidate.legacyName))
      return undefined;
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `array leaf ${candidate.unitId} did not withdraw`,
    );
  }
  const requested = prepared.freeFunctions.requestedSkipProjection.entries;
  const evidence = (prepared.report.terminalEvidence ?? [])[0];
  const artifact = (prepared.report.compiledArtifactEvidence ?? [])[0];
  if (
    requested.length !== 1 ||
    requested[0]?.unitId !== candidate.unitId ||
    requested[0]?.legacyName !== candidate.legacyName ||
    prepared.freeFunctions.skipBodies.size !== 1 ||
    !prepared.freeFunctions.skipBodies.has(candidate.legacyName) ||
    prepared.freeFunctions.completedBodies.size !== 1 ||
    !prepared.freeFunctions.completedBodies.has(candidate.legacyName) ||
    (prepared.report.terminalEvidence?.length ?? 0) !== 1 ||
    evidence?.kind !== "patched" ||
    evidence.unitId !== candidate.unitId ||
    evidence.legacyName !== candidate.legacyName ||
    evidence.preparedComponentId === undefined ||
    prepared.report.errors.length !== 0 ||
    prepared.report.compiled.length !== 1 ||
    prepared.report.compiled[0] !== candidate.legacyName ||
    (prepared.report.compiledArtifactEvidence?.length ?? 0) !== 1 ||
    artifact?.artifactUnitId !== candidate.unitId ||
    artifact?.terminalOwnerUnitId !== candidate.unitId ||
    artifact?.name !== candidate.legacyName ||
    artifact?.preparedComponentId !== evidence.preparedComponentId ||
    prepared.freeFunctions.preserveBodies.size !== 1 ||
    !prepared.freeFunctions.preserveBodies.has(candidate.legacyName)
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `array leaf ${candidate.unitId} produced non-exact receipt`,
    );
  }
  const allocated = exactAllocatedNumericCallable(ctx, candidate.unitId, candidate.legacyName, 0, false);
  if (!allocated || allocated.func.body.length === 0) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `array leaf ${candidate.unitId} lost prepared body`,
    );
  }
  return Object.freeze({
    routeKind: "array",
    sourceFile,
    declaration,
    unitId: candidate.unitId,
    legacyName: candidate.legacyName,
    preparedSelection,
    preparedReport: prepared.report,
    preparedFreeFunctions: prepared.freeFunctions,
    receipt: {
      kind: "prepared",
      unitId: candidate.unitId,
      legacyName: candidate.legacyName,
      preparedComponentId: evidence.preparedComponentId,
    } satisfies MultiPreparedScalarLeafReceipt,
    allocatedFunction: allocated.func,
    preparedBody: allocated.func.body,
    preparedInstructions: Object.freeze([...allocated.func.body]) as readonly Instr[],
    shape: candidate.shape,
    ...(candidate.callback ? { callback: candidate.callback } : {}),
    ...(support ? { support } : {}),
  });
}

export function planEarlyMultiPreparedArrayLeafRoute<Plan extends MultiPreparedScalarLeafPlan>(input: {
  readonly active: boolean;
  readonly cutoverEnabled: boolean;
  readonly ctx: CodegenContext;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly entryFile: ts.SourceFile;
  readonly safety: () => MultiPreparedScalarLeafGraphSafety;
  readonly planSource: (sourceFile: ts.SourceFile) => Plan;
  readonly safeSelection: (
    plan: Plan,
    sourceFile: ts.SourceFile,
    safety: MultiPreparedScalarLeafGraphSafety,
  ) => IrSelection;
  readonly lateProviderOwnerUnitIds: (plan: Plan, sourceFile: ts.SourceFile) => ReadonlySet<IrUnitId>;
  readonly prepareFunctionValueSupport?: (
    plan: Plan,
    sourceFile: ts.SourceFile,
    unitId: IrUnitId,
    legacyName: string,
  ) => MultiPreparedFunctionValueSupportReceipt | undefined;
  readonly projectLoweringPlans: (plan: Plan, selection: IrSelection) => IrIntegrationLoweringPlans;
  /** Earlier successful route families, frozen by MultiPreparedProgramOwner. */
  readonly claimedRouteClaims?: MultiPreparedRouteClaimSnapshot;
}): Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>> {
  const states = new Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>();
  if (!input.active) return states;
  const candidates = collectMultiPreparedArrayLeafCandidates(input.ctx, input.sourceFiles);
  if (candidates.length === 0) return states;
  const safety = input.safety();
  const eligible: Array<{
    declaration: ts.FunctionDeclaration;
    sourceFile: ts.SourceFile;
    plan: Plan;
    candidate: ArrayCandidateEvidence;
  }> = [];
  for (const declaration of candidates) {
    const sourceFile = declaration.getSourceFile();
    const state = states.get(sourceFile) ?? { plan: input.planSource(sourceFile), skippedFunctionUnitIds: new Set() };
    states.set(sourceFile, state);
    const candidate = resolveArrayCandidate({
      ctx: input.ctx,
      sourceFile,
      declaration,
      plan: state.plan,
      safeSelection: input.safeSelection(state.plan, sourceFile, safety),
      safety,
      lateProviderOwnerUnitIds: input.lateProviderOwnerUnitIds(state.plan, sourceFile),
    });
    if (!candidate && process.env.JS2WASM_TEST_REQUIRE_MULTI_PREPARED_ARRAY_LEAF === "1") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `required multi-source array leaf candidate rejected: ${declaration.name?.text ?? "<unnamed>"}`,
      );
    }
    if (candidate) eligible.push({ declaration, sourceFile, plan: state.plan, candidate });
  }
  const exact = eligible.length === 1 ? eligible[0] : undefined;
  if (
    exact &&
    input.claimedRouteClaims &&
    multiPreparedRouteClaimsOverlap(
      input.claimedRouteClaims,
      exact.sourceFile,
      [exact.candidate.unitId],
      [exact.candidate.unitId],
    )
  ) {
    return states;
  }
  if (!input.cutoverEnabled || !exact || exact.sourceFile !== input.entryFile) return states;
  const route = tryPrepareMultiSourceArrayLeaf({
    ctx: input.ctx,
    sourceFile: exact.sourceFile,
    declaration: exact.declaration,
    plan: exact.plan,
    candidate: exact.candidate,
    prepareFunctionValueSupport: exact.candidate.callback
      ? (unitId, legacyName) => input.prepareFunctionValueSupport?.(exact.plan, exact.sourceFile, unitId, legacyName)
      : undefined,
    projectLoweringPlans: (selection) => input.projectLoweringPlans(exact.plan, selection),
  });
  if (!route && process.env.JS2WASM_TEST_REQUIRE_MULTI_PREPARED_ARRAY_LEAF === "1") {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `required multi-source array leaf route did not prepare ${exact.candidate.legacyName}`,
    );
  }
  if (route) states.set(exact.sourceFile, { plan: exact.plan, route, skippedFunctionUnitIds: new Set() });
  return states;
}

export function assertMultiPreparedArrayLeafRouteCurrent(input: {
  readonly ctx: CodegenContext;
  readonly route: MultiPreparedArrayLeafRoute;
  readonly finalSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
}): void {
  const { ctx, route, finalSelection, safety } = input;
  if (process.env.JS2WASM_TEST_TAMPER_MULTI_PREPARED_ARRAY_LEAF?.split(",").includes(route.legacyName)) {
    route.allocatedFunction.name = `${route.legacyName}$tampered`;
  }
  const allocated = exactAllocatedNumericCallable(ctx, route.unitId, route.legacyName, 0, false);
  const shape = exactArrayShape(ctx, route.declaration);
  if (
    !finalSelection.funcs.has(route.legacyName) ||
    safety.collisions.has(route.legacyName) ||
    safety.crossFileFunctionNames.has(route.legacyName) ||
    safety.importAliasNames.has(route.legacyName) ||
    !allocated ||
    allocated.func !== route.allocatedFunction ||
    allocated.func.body !== route.preparedBody ||
    allocated.func.body.length !== route.preparedInstructions.length ||
    allocated.func.body.some((instruction, index) => instruction !== route.preparedInstructions[index]) ||
    route.receipt.kind !== "prepared" ||
    !route.receipt.preparedComponentId ||
    !shape ||
    shape.arrayDeclaration !== route.shape.arrayDeclaration ||
    shape.fillLoop !== route.shape.fillLoop ||
    shape.pushCall !== route.shape.pushCall ||
    shape.reduceLoop !== route.shape.reduceLoop ||
    shape.reduceAssignment !== route.shape.reduceAssignment ||
    (route.callback !== undefined &&
      (!route.support ||
        !functionValueSupportIsCurrent(ctx, route.callback, route.support, false) ||
        !multiPreparedFunctionValueUseIsCurrent(ctx.oracle, ctx.irPlanningIdentityContext, {
          sourceFile: route.sourceFile,
          declaration: route.declaration,
          ...route.callback,
        })))
  ) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `array leaf ${route.unitId} drifted after certification`,
    );
  }
}
