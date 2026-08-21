// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../ir/identity.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import { asVal } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrSelection } from "../ir/select.js";
import type { Instr, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";
import { prepareIrBodies, type PreparedIrFreeFunctionBodies } from "./ir-prepared-free-functions.js";
import {
  exactOracleValueDeclaration,
  multiPreparedFunctionValueUseIsCurrent,
  resolveMultiPreparedFunctionValueImportTarget,
} from "./multi-prepared-function-value-import-target.js";
import {
  collectMultiPreparedScalarLeafCandidates,
  exactAllocatedNumericCallable,
  functionValueSupportIsCurrent,
  hasExactNumericDeclarationSignature,
  identifierResolvesExactly,
  planEarlyMultiPreparedFunctionValueLeafRoute,
  sourceContainsCommonJsExport,
  type EarlyMultiPreparedScalarLeafState,
  type MultiPreparedFunctionValueCandidateEvidence,
  type MultiPreparedFunctionValueLeafRoute,
  type MultiPreparedFunctionValuePlan,
  type MultiPreparedFunctionValueSupportReceipt,
  type MultiPreparedScalarLeafGraphSafety,
  type MultiPreparedScalarLeafReceipt,
} from "./multi-prepared-scalar-leaf.js";

interface ExactFibonacciPairSyntax {
  readonly sourceFile: ts.SourceFile;
  readonly recursiveDeclaration: ts.FunctionDeclaration;
  readonly wrapperDeclaration: ts.FunctionDeclaration;
  readonly wrapperCall: ts.CallExpression;
}

interface MultiPreparedFibonacciPairCandidateEvidence extends MultiPreparedFunctionValueCandidateEvidence {
  readonly recursiveDeclaration: ts.FunctionDeclaration;
  readonly recursiveUnitId: IrUnitId;
  readonly recursiveName: string;
  readonly wrapperDeclaration: ts.FunctionDeclaration;
  readonly wrapperCall: ts.CallExpression;
}

interface PreparedFunctionSlotReceipt {
  readonly declaration: ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly receipt: MultiPreparedScalarLeafReceipt;
  readonly allocatedFunction: WasmFunction;
  readonly preparedBody: WasmFunction["body"];
  readonly preparedInstructions: readonly Instr[];
}

export type MultiPreparedFibonacciPairRoute = Omit<MultiPreparedFunctionValueLeafRoute, "routeKind"> & {
  readonly routeKind: "fibonacci-pair";
  readonly recursiveDeclaration: ts.FunctionDeclaration;
  readonly recursiveUnitId: IrUnitId;
  readonly recursiveName: string;
  readonly recursiveReceipt: MultiPreparedScalarLeafReceipt;
  readonly recursiveAllocatedFunction: WasmFunction;
  readonly recursivePreparedBody: WasmFunction["body"];
  readonly recursivePreparedInstructions: readonly Instr[];
  readonly wrapperCall: ts.CallExpression;
  readonly preparedComponentId: string;
  readonly identityPlan: MultiPreparedFunctionValuePlan["identityPlan"];
};

function invariant(stage: "resolve" | "patch", detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", stage, detail);
}

function rejectRequired(detail: string): undefined {
  if (process.env.JS2WASM_TEST_REQUIRE_MULTI_PREPARED_FIB_PAIR === "1") {
    invariant("resolve", `required multi-source Fibonacci pair rejected: ${detail}`);
  }
  return undefined;
}

function numericLiteralIs(expression: ts.Expression | undefined, text: string): expression is ts.NumericLiteral {
  return expression !== undefined && ts.isNumericLiteral(expression) && expression.text === text;
}

function exactRecursiveArgument(
  ctx: CodegenContext,
  expression: ts.Expression,
  parameter: ts.ParameterDeclaration,
  decrement: string,
): boolean {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    ts.isIdentifier(expression.left) &&
    identifierResolvesExactly(ctx, expression.left, parameter) &&
    numericLiteralIs(expression.right, decrement)
  );
}

function exactRecursiveCall(
  ctx: CodegenContext,
  expression: ts.Expression,
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
  decrement: string,
): expression is ts.CallExpression {
  return (
    ts.isCallExpression(expression) &&
    expression.questionDotToken === undefined &&
    (expression.typeArguments?.length ?? 0) === 0 &&
    ts.isIdentifier(expression.expression) &&
    identifierResolvesExactly(ctx, expression.expression, declaration) &&
    expression.arguments.length === 1 &&
    exactRecursiveArgument(ctx, expression.arguments[0]!, parameter, decrement)
  );
}

function isExactFibonacciRecurrence(ctx: CodegenContext, declaration: ts.FunctionDeclaration): boolean {
  if (!hasExactNumericDeclarationSignature(declaration) || declaration.parameters.length !== 1 || !declaration.body) {
    return false;
  }
  const parameter = declaration.parameters[0]!;
  if (!ts.isIdentifier(parameter.name)) return false;
  const [baseCase, recursiveReturn] = declaration.body.statements;
  if (
    declaration.body.statements.length !== 2 ||
    !baseCase ||
    !ts.isIfStatement(baseCase) ||
    baseCase.elseStatement !== undefined ||
    !ts.isBinaryExpression(baseCase.expression) ||
    baseCase.expression.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken ||
    !ts.isIdentifier(baseCase.expression.left) ||
    !identifierResolvesExactly(ctx, baseCase.expression.left, parameter) ||
    !numericLiteralIs(baseCase.expression.right, "1") ||
    !ts.isReturnStatement(baseCase.thenStatement) ||
    !baseCase.thenStatement.expression ||
    !ts.isIdentifier(baseCase.thenStatement.expression) ||
    !identifierResolvesExactly(ctx, baseCase.thenStatement.expression, parameter) ||
    !recursiveReturn ||
    !ts.isReturnStatement(recursiveReturn) ||
    !recursiveReturn.expression ||
    !ts.isBinaryExpression(recursiveReturn.expression) ||
    recursiveReturn.expression.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    return false;
  }
  return (
    exactRecursiveCall(ctx, recursiveReturn.expression.left, declaration, parameter, "1") &&
    exactRecursiveCall(ctx, recursiveReturn.expression.right, declaration, parameter, "2")
  );
}

function exactFibonacciWrapperCall(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  recursiveDeclaration: ts.FunctionDeclaration,
): ts.CallExpression | undefined {
  if (
    !hasExactNumericDeclarationSignature(declaration) ||
    declaration.parameters.length !== 0 ||
    !declaration.body ||
    declaration.body.statements.length !== 1
  ) {
    return undefined;
  }
  const statement = declaration.body.statements[0];
  const call = statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.questionDotToken !== undefined ||
    (call.typeArguments?.length ?? 0) !== 0 ||
    !ts.isIdentifier(call.expression) ||
    !identifierResolvesExactly(ctx, call.expression, recursiveDeclaration) ||
    call.arguments.length !== 1 ||
    !numericLiteralIs(call.arguments[0], "30")
  ) {
    return undefined;
  }
  return call;
}

function collectExactFibonacciPairSyntax(
  ctx: CodegenContext,
  sourceFiles: readonly ts.SourceFile[],
): { readonly recurrences: readonly ts.FunctionDeclaration[]; readonly pairs: readonly ExactFibonacciPairSyntax[] } {
  if (sourceFiles.some(sourceContainsCommonJsExport)) return { recurrences: [], pairs: [] };
  const recurrences = sourceFiles.flatMap((sourceFile) =>
    sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && isExactFibonacciRecurrence(ctx, statement),
    ),
  );
  const pairs: ExactFibonacciPairSyntax[] = [];
  for (const recursiveDeclaration of recurrences) {
    const sourceFile = recursiveDeclaration.getSourceFile();
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) || statement === recursiveDeclaration) continue;
      const wrapperCall = exactFibonacciWrapperCall(ctx, statement, recursiveDeclaration);
      if (wrapperCall) {
        pairs.push({ sourceFile, recursiveDeclaration, wrapperDeclaration: statement, wrapperCall });
      }
    }
  }
  return { recurrences, pairs };
}

function setIsExactly<T>(actual: ReadonlySet<T> | undefined, expected: readonly T[]): boolean {
  return actual !== undefined && actual.size === expected.length && expected.every((value) => actual.has(value));
}

function exactFibonacciCallTopology(
  sourceFile: ts.SourceFile,
  identityPlan: IrOverlayIdentityPlan,
  recursiveUnitId: IrUnitId,
  wrapperUnitId: IrUnitId,
): boolean {
  const edges = collectLocalCallEdgesByIdentity(sourceFile, identityPlan.identityContext);
  const pairIds = new Set([recursiveUnitId, wrapperUnitId]);
  if (
    !setIsExactly(edges.callees.get(recursiveUnitId), [recursiveUnitId]) ||
    !setIsExactly(edges.callees.get(wrapperUnitId), [recursiveUnitId]) ||
    edges.calleesFromUnownedCallers.has(recursiveUnitId) ||
    edges.calleesFromUnownedCallers.has(wrapperUnitId) ||
    (edges.constructionCallees.get(recursiveUnitId)?.size ?? 0) !== 0 ||
    (edges.constructionCallees.get(wrapperUnitId)?.size ?? 0) !== 0 ||
    (edges.moduleBindingStorageTerminals.get(recursiveUnitId)?.size ?? 0) !== 0 ||
    (edges.moduleBindingStorageTerminals.get(wrapperUnitId)?.size ?? 0) !== 0
  ) {
    return false;
  }
  for (const [callerUnitId, callees] of edges.callees) {
    if (pairIds.has(callerUnitId)) continue;
    if ([...callees].some((calleeUnitId) => pairIds.has(calleeUnitId))) return false;
  }
  return true;
}

function exactFunctionReferences(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): readonly ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node !== declaration.name && identifierResolvesExactly(ctx, node, declaration)) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function functionHasNoSupport(ctx: CodegenContext, legacyName: string): boolean {
  const trampolineName = `__fn_tramp_${legacyName}_cached`;
  const cacheName = `__fn_closure_${legacyName}`;
  return (
    !ctx.funcMap.has(trampolineName) &&
    !ctx.funcClosureGlobals.has(legacyName) &&
    !ctx.mod.functions.some((func) => func.name === trampolineName) &&
    !ctx.mod.globals.some((global) => global.name === cacheName)
  );
}

function exactFunctionIdentity(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  plan: MultiPreparedFunctionValuePlan,
  safeSelection: IrSelection,
  safety: MultiPreparedScalarLeafGraphSafety,
  parameterCount: number,
): { readonly unitId: IrUnitId; readonly legacyName: string } | undefined {
  const legacyName = declaration.name?.text;
  const unitId = plan.identityPlan.identityContext.unitIdByDeclaration.get(declaration);
  const terminal = unitId ? plan.identityPlan.identityContext.terminalByUnitId.get(unitId) : undefined;
  const claim = unitId ? plan.functionClaimsByUnitId.get(unitId) : undefined;
  const override = unitId ? plan.overrideMapByUnitId.get(unitId) : undefined;
  if (
    !legacyName ||
    !declaration.name ||
    exactOracleValueDeclaration(ctx.oracle, declaration.name) !== declaration ||
    !unitId ||
    !terminal ||
    terminal !== plan.identityPlan.identityContext.unitByUnitId.get(unitId) ||
    terminal.kind !== "top-level-function" ||
    terminal.observedKind !== "function" ||
    terminal.terminalOwnerId !== unitId ||
    plan.identityPlan.identityContext.declarationByUnitId.get(unitId) !== declaration ||
    claim?.declaration !== declaration ||
    claim.legacyName !== legacyName ||
    !safeSelection.funcs.has(legacyName) ||
    !plan.identityPlan.safeFunctionUnitIds.has(unitId) ||
    !override ||
    override.params.length !== parameterCount ||
    !override.params.every((type) => asVal(type)?.kind === "f64") ||
    override.returnType === null ||
    asVal(override.returnType)?.kind !== "f64" ||
    safety.collisions.has(legacyName) ||
    safety.crossFileFunctionNames.has(legacyName) ||
    safety.importAliasNames.has(legacyName) ||
    safety.occupiedFunctionNameCounts.get(legacyName) !== 1 ||
    safety.occupiedFunctionKeys.some((key) => key.startsWith(`${legacyName}$`)) ||
    ctx.liveFuncBindingGlobals?.has(legacyName) === true ||
    !exactAllocatedNumericCallable(ctx, unitId, legacyName, parameterCount, true)
  ) {
    return undefined;
  }
  return { unitId, legacyName };
}

function resolveExactFibonacciPair<Plan extends MultiPreparedFunctionValuePlan>(input: {
  readonly ctx: CodegenContext;
  readonly syntax: ExactFibonacciPairSyntax;
  readonly plan: Plan;
  readonly safeSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
  readonly hasForeignLateProvider: (recursiveUnitId: IrUnitId, wrapperUnitId: IrUnitId) => boolean;
}): MultiPreparedFibonacciPairCandidateEvidence | undefined {
  const { ctx, plan, safeSelection, safety, syntax } = input;
  const { recursiveDeclaration, sourceFile, wrapperCall, wrapperDeclaration } = syntax;
  if (!ctx.standalone || ctx.fast || ctx.wasi) return rejectRequired("target lane");
  if (recursiveDeclaration.parent !== sourceFile || wrapperDeclaration.parent !== sourceFile) {
    return rejectRequired("source children");
  }
  if (safeSelection.moduleInit !== undefined || (plan.selection.moduleInit?.stmtCount ?? 0) !== 0) {
    return rejectRequired("module init");
  }
  if (plan.classShapes.size !== 0 || plan.classShapesById.size !== 0) return rejectRequired("class shapes");
  const recursive = exactFunctionIdentity(ctx, recursiveDeclaration, plan, safeSelection, safety, 1);
  const wrapper = exactFunctionIdentity(ctx, wrapperDeclaration, plan, safeSelection, safety, 0);
  if (!recursive || !wrapper || recursive.unitId === wrapper.unitId) return rejectRequired("function identities");
  if (!exactFibonacciCallTopology(sourceFile, plan.identityPlan, recursive.unitId, wrapper.unitId)) {
    return rejectRequired("call topology");
  }
  if (input.hasForeignLateProvider(recursive.unitId, wrapper.unitId)) return rejectRequired("late provider");
  if (!ctx.programAbiSession) return rejectRequired("Program ABI session");
  if (
    [...ctx.programAbiSession.derivedUnitRecords()].some(
      (record) => record.terminalOwnerId === recursive.unitId || record.terminalOwnerId === wrapper.unitId,
    )
  ) {
    return rejectRequired("derived unit");
  }
  const recursiveReferences = exactFunctionReferences(ctx, sourceFile, recursiveDeclaration);
  if (
    recursiveReferences.length !== 3 ||
    recursiveReferences.some(
      (identifier) => !ts.isCallExpression(identifier.parent) || identifier.parent.expression !== identifier,
    ) ||
    !recursiveReferences.some((identifier) => identifier.parent === wrapperCall)
  ) {
    return rejectRequired("recursive references");
  }
  const wrapperReferences = exactFunctionReferences(ctx, sourceFile, wrapperDeclaration).filter(
    (identifier) => !(ts.isCallExpression(identifier.parent) && identifier.parent.expression === identifier),
  );
  const valueIdentifier = wrapperReferences.length === 1 ? wrapperReferences[0] : undefined;
  const importedCall = valueIdentifier?.parent;
  if (
    !valueIdentifier ||
    !importedCall ||
    !ts.isCallExpression(importedCall) ||
    importedCall.arguments.filter((argument) => argument === valueIdentifier).length !== 1
  ) {
    return rejectRequired(`wrapper value reference count ${wrapperReferences.length}`);
  }
  let owner: ts.Node | undefined = importedCall.parent;
  while (owner && owner !== sourceFile && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || !ts.isFunctionDeclaration(owner) || owner.parent !== sourceFile || !owner.name || !owner.body) {
    return rejectRequired("legacy owner");
  }
  const legacyOwnerUnitId = plan.identityPlan.identityContext.unitIdByDeclaration.get(owner);
  const ownerTerminal = legacyOwnerUnitId
    ? plan.identityPlan.identityContext.terminalByUnitId.get(legacyOwnerUnitId)
    : undefined;
  const importedTarget = ts.isIdentifier(importedCall.expression)
    ? resolveMultiPreparedFunctionValueImportTarget({
        oracle: ctx.oracle,
        sourceFile,
        callee: importedCall.expression,
        identityContext: plan.identityPlan.identityContext,
      })
    : undefined;
  const importedTargetUnitId = importedTarget
    ? plan.identityPlan.identityContext.unitIdByDeclaration.get(importedTarget)
    : undefined;
  if (
    !legacyOwnerUnitId ||
    legacyOwnerUnitId === recursive.unitId ||
    legacyOwnerUnitId === wrapper.unitId ||
    ownerTerminal?.observedKind !== "function" ||
    ownerTerminal.terminalOwnerId !== legacyOwnerUnitId ||
    plan.identityPlan.identityContext.declarationByUnitId.get(legacyOwnerUnitId) !== owner ||
    safeSelection.funcs.has(owner.name.text) ||
    !importedTarget ||
    !importedTargetUnitId ||
    plan.identityPlan.identityContext.declarationByUnitId.get(importedTargetUnitId) !== importedTarget ||
    importedTarget.getSourceFile() === sourceFile ||
    !functionHasNoSupport(ctx, recursive.legacyName) ||
    !functionHasNoSupport(ctx, wrapper.legacyName)
  ) {
    return rejectRequired("function-value edge/support");
  }
  return {
    legacyName: wrapper.legacyName,
    unitId: wrapper.unitId,
    valueIdentifier,
    legacyOwnerUnitId,
    legacyOwnerName: owner.name.text,
    importedCall,
    importedTargetUnitId,
    recursiveDeclaration,
    recursiveUnitId: recursive.unitId,
    recursiveName: recursive.legacyName,
    wrapperDeclaration,
    wrapperCall,
  };
}

function exactPairWithdrawal(
  report: MultiPreparedFunctionValueLeafRoute["preparedReport"],
  prepared: PreparedIrFreeFunctionBodies,
  candidate: MultiPreparedFibonacciPairCandidateEvidence,
): boolean {
  const evidence = report.terminalEvidence ?? [];
  const empty =
    prepared.skipBodies.size === 0 &&
    prepared.preserveBodies.size === 0 &&
    prepared.completedBodies.size === 0 &&
    prepared.requestedSkipProjection.entries.length === 0 &&
    report.compiled.length === 0 &&
    (report.compiledArtifactEvidence?.length ?? 0) === 0 &&
    (report.syntheticCompiledArtifacts?.length ?? 0) === 0;
  if (!empty) return false;
  if (report.errors.length === 0 && evidence.length === 0) return true;
  const expected = new Map<IrUnitId, string>([
    [candidate.recursiveUnitId, candidate.recursiveName],
    [candidate.unitId, candidate.legacyName],
  ]);
  return (
    report.errors.length === 2 &&
    evidence.length === 2 &&
    setIsExactly(new Set(evidence.map((entry) => entry.unitId)), [...expected.keys()]) &&
    evidence.every(
      (entry) =>
        entry.kind === "failed" &&
        expected.get(entry.unitId) === entry.legacyName &&
        entry.error.outcome.kind === "unsupported" &&
        report.errors.includes(entry.error),
    )
  );
}

function preparedSlotReceipt(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  unitId: IrUnitId,
  legacyName: string,
  parameterCount: number,
  componentId: string,
): PreparedFunctionSlotReceipt {
  const allocated = exactAllocatedNumericCallable(ctx, unitId, legacyName, parameterCount, false);
  if (!allocated || allocated.func.body.length === 0) {
    invariant("patch", `multi-source Fibonacci pair ${unitId} lost its prepared source slot`);
  }
  return {
    declaration,
    unitId,
    legacyName,
    receipt: { kind: "prepared", unitId, legacyName, preparedComponentId: componentId },
    allocatedFunction: allocated.func,
    preparedBody: allocated.func.body,
    preparedInstructions: Object.freeze([...allocated.func.body]),
  };
}

function tryPrepareExactFibonacciPair<Plan extends MultiPreparedFunctionValuePlan>(input: {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly plan: Plan;
  readonly candidate: MultiPreparedFibonacciPairCandidateEvidence;
  readonly support: MultiPreparedFunctionValueSupportReceipt;
  readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
}): MultiPreparedFibonacciPairRoute | undefined {
  const { candidate, ctx, plan, sourceFile, support } = input;
  if (
    !functionValueSupportIsCurrent(ctx, candidate, support, true) ||
    !functionHasNoSupport(ctx, candidate.recursiveName)
  ) {
    invariant("resolve", `multi-source Fibonacci pair ${candidate.unitId} lost its preallocated support receipt`);
  }
  const preparedSelection: IrSelection = {
    funcs: new Set([candidate.recursiveName, candidate.legacyName]),
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
    projectLoweringPlans: input.projectLoweringPlans,
  });
  if (prepared.classMembers || prepared.moduleInit || prepared.implicitConstructorUnitIds.size !== 0) {
    invariant("patch", `multi-source Fibonacci pair ${candidate.unitId} produced a foreign Prepared family`);
  }
  if (prepared.freeFunctions.skipBodies.size === 0) {
    if (
      exactPairWithdrawal(prepared.report, prepared.freeFunctions, candidate) &&
      functionValueSupportIsCurrent(ctx, candidate, support, true) &&
      functionHasNoSupport(ctx, candidate.recursiveName)
    ) {
      return undefined;
    }
    invariant("patch", `multi-source Fibonacci pair ${candidate.unitId} did not withdraw both bodies before skip`);
  }
  const expectedByUnitId = new Map<IrUnitId, string>([
    [candidate.recursiveUnitId, candidate.recursiveName],
    [candidate.unitId, candidate.legacyName],
  ]);
  const expectedNames = [...expectedByUnitId.values()];
  const evidence = prepared.report.terminalEvidence ?? [];
  const artifacts = prepared.report.compiledArtifactEvidence ?? [];
  const componentIds = new Set(
    evidence.flatMap((entry) =>
      entry.kind === "patched" && entry.preparedComponentId ? [entry.preparedComponentId] : [],
    ),
  );
  const componentId = componentIds.size === 1 ? [...componentIds][0] : undefined;
  const exact =
    componentId !== undefined &&
    prepared.report.errors.length === 0 &&
    evidence.length === 2 &&
    setIsExactly(new Set(evidence.map((entry) => entry.unitId)), [...expectedByUnitId.keys()]) &&
    evidence.every(
      (entry) =>
        entry.kind === "patched" &&
        expectedByUnitId.get(entry.unitId) === entry.legacyName &&
        entry.preparedComponentId === componentId,
    ) &&
    artifacts.length === 2 &&
    setIsExactly(new Set(artifacts.map((artifact) => artifact.artifactUnitId)), [...expectedByUnitId.keys()]) &&
    artifacts.every(
      (artifact) =>
        expectedByUnitId.get(artifact.artifactUnitId) === artifact.name &&
        artifact.terminalOwnerUnitId === artifact.artifactUnitId &&
        artifact.preparedComponentId === componentId,
    ) &&
    prepared.report.compiled.length === 2 &&
    setIsExactly(new Set(prepared.report.compiled), expectedNames) &&
    prepared.report.terminalCompiledOwners?.length === 2 &&
    setIsExactly(new Set(prepared.report.terminalCompiledOwners), expectedNames) &&
    setIsExactly(prepared.freeFunctions.skipBodies, expectedNames) &&
    setIsExactly(prepared.freeFunctions.preserveBodies, expectedNames) &&
    setIsExactly(prepared.freeFunctions.completedBodies, expectedNames) &&
    prepared.freeFunctions.requestedSkipProjection.entries.length === 2 &&
    setIsExactly(new Set(prepared.freeFunctions.requestedSkipProjection.entries.map((entry) => entry.unitId)), [
      ...expectedByUnitId.keys(),
    ]) &&
    prepared.freeFunctions.requestedSkipProjection.entries.every(
      (entry) => expectedByUnitId.get(entry.unitId) === entry.legacyName,
    ) &&
    (prepared.report.syntheticCompiledArtifacts?.length ?? 0) === 0;
  if (!exact || !componentId) {
    invariant("patch", `multi-source Fibonacci pair ${candidate.unitId} produced a non-atomic Prepared receipt`);
  }
  const recursiveSlot = preparedSlotReceipt(
    ctx,
    candidate.recursiveDeclaration,
    candidate.recursiveUnitId,
    candidate.recursiveName,
    1,
    componentId,
  );
  const wrapperSlot = preparedSlotReceipt(
    ctx,
    plan.identityPlan.identityContext.declarationByUnitId.get(candidate.unitId) === candidate.wrapperDeclaration
      ? candidate.wrapperDeclaration
      : invariant("patch", `multi-source Fibonacci pair ${candidate.unitId} lost its wrapper source`),
    candidate.unitId,
    candidate.legacyName,
    0,
    componentId,
  );
  if (
    !functionValueSupportIsCurrent(ctx, candidate, support, false) ||
    !functionHasNoSupport(ctx, candidate.recursiveName)
  ) {
    invariant("patch", `multi-source Fibonacci pair ${candidate.unitId} drifted during Prepared certification`);
  }
  return Object.freeze({
    routeKind: "fibonacci-pair",
    sourceFile,
    declaration: wrapperSlot.declaration,
    unitId: wrapperSlot.unitId,
    legacyName: wrapperSlot.legacyName,
    preparedSelection,
    preparedReport: prepared.report,
    preparedFreeFunctions: prepared.freeFunctions,
    receipt: wrapperSlot.receipt,
    allocatedFunction: wrapperSlot.allocatedFunction,
    preparedBody: wrapperSlot.preparedBody,
    preparedInstructions: wrapperSlot.preparedInstructions,
    valueIdentifier: candidate.valueIdentifier,
    legacyOwnerUnitId: candidate.legacyOwnerUnitId,
    legacyOwnerName: candidate.legacyOwnerName,
    importedCall: candidate.importedCall,
    importedTargetUnitId: candidate.importedTargetUnitId,
    support,
    recursiveDeclaration: recursiveSlot.declaration,
    recursiveUnitId: recursiveSlot.unitId,
    recursiveName: recursiveSlot.legacyName,
    recursiveReceipt: recursiveSlot.receipt,
    recursiveAllocatedFunction: recursiveSlot.allocatedFunction,
    recursivePreparedBody: recursiveSlot.preparedBody,
    recursivePreparedInstructions: recursiveSlot.preparedInstructions,
    wrapperCall: candidate.wrapperCall,
    preparedComponentId: componentId,
    identityPlan: plan.identityPlan,
  });
}

function allocatedSlotIsCurrent(
  ctx: CodegenContext,
  slot: PreparedFunctionSlotReceipt,
  parameterCount: number,
): boolean {
  const allocated = exactAllocatedNumericCallable(ctx, slot.unitId, slot.legacyName, parameterCount, false);
  return (
    allocated !== undefined &&
    allocated.func === slot.allocatedFunction &&
    allocated.func.body === slot.preparedBody &&
    allocated.func.body.length === slot.preparedInstructions.length &&
    allocated.func.body.every((instruction, index) => instruction === slot.preparedInstructions[index]) &&
    allocated.func.body.length > 0
  );
}

export function assertMultiPreparedFibonacciPairRouteCurrent(input: {
  readonly ctx: CodegenContext;
  readonly route: MultiPreparedFibonacciPairRoute;
  readonly finalSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
}): void {
  const { ctx, finalSelection, route, safety } = input;
  const tamper = process.env.JS2WASM_TEST_TAMPER_MULTI_PREPARED_FIB_PAIR;
  if (tamper && tamper !== "0" && tamper !== "false") {
    route.support.trampolineFunction.name = `${route.support.trampolineFunction.name}$tampered`;
  }
  const recursiveSlot: PreparedFunctionSlotReceipt = {
    declaration: route.recursiveDeclaration,
    unitId: route.recursiveUnitId,
    legacyName: route.recursiveName,
    receipt: route.recursiveReceipt,
    allocatedFunction: route.recursiveAllocatedFunction,
    preparedBody: route.recursivePreparedBody,
    preparedInstructions: route.recursivePreparedInstructions,
  };
  const wrapperSlot: PreparedFunctionSlotReceipt = {
    declaration: route.declaration,
    unitId: route.unitId,
    legacyName: route.legacyName,
    receipt: route.receipt,
    allocatedFunction: route.allocatedFunction,
    preparedBody: route.preparedBody,
    preparedInstructions: route.preparedInstructions,
  };
  const currentSyntax =
    isExactFibonacciRecurrence(ctx, route.recursiveDeclaration) &&
    exactFibonacciWrapperCall(ctx, route.declaration, route.recursiveDeclaration) === route.wrapperCall;
  const candidate: MultiPreparedFibonacciPairCandidateEvidence = {
    legacyName: route.legacyName,
    unitId: route.unitId,
    valueIdentifier: route.valueIdentifier,
    legacyOwnerUnitId: route.legacyOwnerUnitId,
    legacyOwnerName: route.legacyOwnerName,
    importedCall: route.importedCall,
    importedTargetUnitId: route.importedTargetUnitId,
    recursiveDeclaration: route.recursiveDeclaration,
    recursiveUnitId: route.recursiveUnitId,
    recursiveName: route.recursiveName,
    wrapperDeclaration: route.declaration,
    wrapperCall: route.wrapperCall,
  };
  const names = [route.recursiveName, route.legacyName];
  const safetyCurrent = names.every(
    (name) =>
      !safety.collisions.has(name) &&
      !safety.crossFileFunctionNames.has(name) &&
      !safety.importAliasNames.has(name) &&
      safety.occupiedFunctionNameCounts.get(name) === 1 &&
      !safety.occupiedFunctionKeys.some((key) => key.startsWith(`${name}$`)) &&
      ctx.liveFuncBindingGlobals?.has(name) !== true,
  );
  if (
    route.identityPlan.identityContext !== ctx.irPlanningIdentityContext ||
    !currentSyntax ||
    !exactFibonacciCallTopology(route.sourceFile, route.identityPlan, route.recursiveUnitId, route.unitId) ||
    !finalSelection.funcs.has(route.recursiveName) ||
    !finalSelection.funcs.has(route.legacyName) ||
    finalSelection.funcs.has(route.legacyOwnerName) ||
    !safetyCurrent ||
    route.recursiveReceipt.kind !== "prepared" ||
    route.receipt.kind !== "prepared" ||
    route.recursiveReceipt.preparedComponentId !== route.preparedComponentId ||
    route.receipt.preparedComponentId !== route.preparedComponentId ||
    !allocatedSlotIsCurrent(ctx, recursiveSlot, 1) ||
    !allocatedSlotIsCurrent(ctx, wrapperSlot, 0) ||
    !multiPreparedFunctionValueUseIsCurrent(ctx.oracle, ctx.irPlanningIdentityContext, route) ||
    !functionValueSupportIsCurrent(ctx, candidate, route.support, false) ||
    !functionHasNoSupport(ctx, route.recursiveName)
  ) {
    invariant(
      "patch",
      `multi-source Fibonacci pair ${route.recursiveUnitId}/${route.unitId} drifted after direct-body certification`,
    );
  }
}

export function planEarlyMultiPreparedFunctionValueRoutes<Plan extends MultiPreparedFunctionValuePlan>(input: {
  readonly active: boolean;
  readonly leafCutoverEnabled: boolean;
  readonly fibonacciPairCutoverEnabled: boolean;
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
  readonly hasForeignLateProvider: (
    plan: Plan,
    sourceFile: ts.SourceFile,
    unitId: IrUnitId,
    functionValueTarget: boolean,
  ) => boolean;
  readonly prepareFunctionValueSupport: (
    plan: Plan,
    sourceFile: ts.SourceFile,
    unitId: IrUnitId,
    legacyName: string,
  ) => MultiPreparedFunctionValueSupportReceipt | undefined;
  readonly projectLoweringPlans: (plan: Plan, selection: IrSelection) => IrIntegrationLoweringPlans;
}): Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>> {
  const leafStates = planEarlyMultiPreparedFunctionValueLeafRoute({
    active: input.active,
    cutoverEnabled: input.leafCutoverEnabled,
    ctx: input.ctx,
    sourceFiles: input.sourceFiles,
    entryFile: input.entryFile,
    safety: input.safety,
    planSource: input.planSource,
    safeSelection: input.safeSelection,
    hasForeignLateProvider: (plan, sourceFile, unitId) => input.hasForeignLateProvider(plan, sourceFile, unitId, true),
    prepareFunctionValueSupport: input.prepareFunctionValueSupport,
    projectLoweringPlans: input.projectLoweringPlans,
  });
  if (leafStates.size !== 0) return leafStates;
  const states = new Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>();
  if (!input.active || collectMultiPreparedScalarLeafCandidates(input.sourceFiles).length !== 0) {
    if (process.env.JS2WASM_TEST_REQUIRE_MULTI_PREPARED_FIB_PAIR === "1") {
      invariant("resolve", "required multi-source Fibonacci pair failed its active/competing-route gate");
    }
    return states;
  }
  const syntax = collectExactFibonacciPairSyntax(input.ctx, input.sourceFiles);
  if (syntax.recurrences.length !== 1 || syntax.pairs.length !== 1) {
    if (process.env.JS2WASM_TEST_REQUIRE_MULTI_PREPARED_FIB_PAIR === "1") {
      invariant(
        "resolve",
        `required multi-source Fibonacci pair found ${syntax.recurrences.length} recurrences/${syntax.pairs.length} wrappers`,
      );
    }
    return states;
  }
  const exactSyntax = syntax.pairs[0]!;
  if (exactSyntax.sourceFile !== input.entryFile) return states;
  const safety = input.safety();
  const plan = input.planSource(exactSyntax.sourceFile);
  const safeSelection = input.safeSelection(plan, exactSyntax.sourceFile, safety);
  const candidate = resolveExactFibonacciPair({
    ctx: input.ctx,
    syntax: exactSyntax,
    plan,
    safeSelection,
    safety,
    hasForeignLateProvider: (recursiveUnitId, wrapperUnitId) =>
      input.hasForeignLateProvider(plan, exactSyntax.sourceFile, recursiveUnitId, false) ||
      input.hasForeignLateProvider(plan, exactSyntax.sourceFile, wrapperUnitId, true),
  });
  if (!candidate) return states;
  const state: EarlyMultiPreparedScalarLeafState<Plan> = { plan, skippedFunctionUnitIds: new Set() };
  states.set(exactSyntax.sourceFile, state);
  if (!input.fibonacciPairCutoverEnabled) return states;
  const support = input.prepareFunctionValueSupport(
    plan,
    exactSyntax.sourceFile,
    candidate.unitId,
    candidate.legacyName,
  );
  if (!support || !functionValueSupportIsCurrent(input.ctx, candidate, support, true)) {
    invariant("resolve", `multi-source Fibonacci pair ${candidate.unitId} could not preallocate exact support`);
  }
  const route = tryPrepareExactFibonacciPair({
    ctx: input.ctx,
    sourceFile: exactSyntax.sourceFile,
    plan,
    candidate,
    support,
    projectLoweringPlans: (selection) => input.projectLoweringPlans(plan, selection),
  });
  if (route) states.set(exactSyntax.sourceFile, { plan, route, skippedFunctionUnitIds: new Set() });
  return states;
}
