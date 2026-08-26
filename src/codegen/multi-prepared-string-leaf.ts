// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Dormant proof-only planner for the exact multi-source counted-string leaf.
 *
 * This module deliberately allocates nothing and prepares no body. It freezes
 * the exact live-AST, identity, callback, lowering-plan, and allocator evidence
 * that the C2 orchestration consumes before it is allowed to request a direct
 * body skip.
 */

import type { TypeOracle } from "../checker/oracle.js";
import {
  countedStringAppendPlanIsCurrent,
  planCountedStringAppend,
  type IrCountedStringAppendPlan,
} from "../ir/analysis/counted-string-append.js";
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import { irSupportGlobalRef, sameIrGlobalBinding } from "../ir/abi-bindings.js";
import type { IrCountedStringAppendLoweringPlan, IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import {
  irCallableBindingKey,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
  sameIrCallableBinding,
} from "../ir/callable-bindings.js";
import { requireCurrentIrCountedStringAppendPlanSite } from "../ir/counted-string-append-provenance.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import { asVal } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrSelection } from "../ir/select.js";
import { IR_STRING_REPEAT_FN } from "../ir/string-runtime.js";
import { ts } from "../ts-api.js";
import { hasDeclareModifier, hasExportModifier } from "./ast-modifiers.js";
import type { CodegenContext } from "./context/types.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import {
  exactOracleValueDeclaration,
  multiPreparedFunctionValueUseIsCurrent,
  resolveMultiPreparedFunctionValueImportTarget,
} from "./multi-prepared-function-value-import-target.js";
import {
  exactAllocatedNumericCallable,
  functionValueSupportIsCurrent,
  hasExactNumericDeclarationSignature,
  type MultiPreparedFunctionValueCandidateEvidence,
  type MultiPreparedFunctionValuePlan,
  type MultiPreparedFunctionValueSupportReceipt,
  type MultiPreparedScalarLeafGraphSafety,
} from "./multi-prepared-scalar-leaf.js";
import { definedFuncAt, definedFuncHandleOf } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import {
  canonicalProgramAbiCallableTypeContract,
  programAbiCallableSignaturesEqual,
} from "./program-abi-signatures.js";

export interface MultiPreparedStringLeafProofContext {
  readonly checker: ts.TypeChecker;
  readonly oracle: TypeOracle;
}

/** Exact live syntax and the shared checker proof that owns it. */
export interface MultiPreparedStringLeafShape {
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.FunctionDeclaration;
  readonly proofConstDeclarations: readonly ts.VariableDeclaration[];
  readonly accumulatorDeclaration: ts.VariableDeclaration;
  readonly loop: ts.ForStatement;
  readonly lengthRead: ts.PropertyAccessExpression;
  readonly returnStatement: ts.ReturnStatement;
  readonly plan: IrCountedStringAppendPlan;
}

/** Frozen evidence C2 carries across support allocation and direct owners. */
export interface MultiPreparedStringLeafCandidateEvidence extends MultiPreparedFunctionValueCandidateEvidence {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly declaration: ts.FunctionDeclaration;
  readonly shape: MultiPreparedStringLeafShape;
  readonly loweringPlan: IrCountedStringAppendLoweringPlan;
  readonly callerDeclaration: ts.FunctionDeclaration;
  readonly importedTarget: ts.FunctionDeclaration;
  readonly importedTargetSourceId: IrSourceId;
}

export interface MultiPreparedStringLeafResolverInput<Plan extends MultiPreparedFunctionValuePlan> {
  readonly ctx: CodegenContext;
  readonly entrySource: ts.SourceFile;
  readonly plan: Plan;
  readonly safeSelection: IrSelection;
  readonly projectedLoweringPlans: IrIntegrationLoweringPlans;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
  readonly proofContext: MultiPreparedStringLeafProofContext;
  readonly shapes: readonly MultiPreparedStringLeafShape[];
  readonly hasForeignLateProvider: (unitId: IrUnitId) => boolean;
}

export type MultiPreparedStringLeafSupportBoundary = "before-prepare" | "after-direct";

interface InspectedShape {
  readonly proofConstDeclarations: readonly ts.VariableDeclaration[];
  readonly accumulatorDeclaration: ts.VariableDeclaration;
  readonly lengthRead: ts.PropertyAccessExpression;
  readonly returnStatement: ts.ReturnStatement;
}

interface CandidateFacts {
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly loweringPlan: IrCountedStringAppendLoweringPlan;
  readonly valueIdentifier: ts.Identifier;
  readonly callerDeclaration: ts.FunctionDeclaration;
  readonly callerUnitId: IrUnitId;
  readonly importedCall: ts.CallExpression;
  readonly importedTarget: ts.FunctionDeclaration;
  readonly importedTargetUnitId: IrUnitId;
  readonly importedTargetSourceId: IrSourceId;
}

type CandidateBoundary = "before-support" | MultiPreparedStringLeafSupportBoundary;

function exactTopLevelNumericStringLeaf(declaration: ts.FunctionDeclaration, sourceFile: ts.SourceFile): boolean {
  return (
    declaration.parent === sourceFile &&
    hasExportModifier(declaration) &&
    !hasDeclareModifier(declaration) &&
    hasExactNumericDeclarationSignature(declaration) &&
    declaration.parameters.length === 0
  );
}

function declarationStatement(declaration: ts.VariableDeclaration): ts.VariableStatement | undefined {
  const list = declaration.parent;
  const statement = list.parent;
  return ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement) ? statement : undefined;
}

function exactProofConstClosure(
  declaration: ts.FunctionDeclaration,
  plan: IrCountedStringAppendPlan,
): readonly ts.VariableDeclaration[] | undefined {
  if (!declaration.body) return undefined;
  const expected = new Set([
    ...plan.startConstDeclarations,
    ...plan.boundConstDeclarations,
    ...plan.fragmentConstDeclarations,
  ]);
  const ordered: ts.VariableDeclaration[] = [];
  for (const statement of declaration.body.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    if (statement.declarationList.declarations.length !== 1) return undefined;
    const current = statement.declarationList.declarations[0]!;
    if (!expected.delete(current)) return undefined;
    ordered.push(current);
  }
  if (expected.size !== 0) return undefined;
  for (const current of ordered) {
    const statement = declarationStatement(current);
    if (
      !statement ||
      statement.parent !== declaration.body ||
      statement.declarationList.declarations.length !== 1 ||
      statement.declarationList.declarations[0] !== current ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      !ts.isIdentifier(current.name) ||
      current.initializer === undefined
    ) {
      return undefined;
    }
  }
  return ordered;
}

function inspectShape(
  proofContext: MultiPreparedStringLeafProofContext,
  declaration: ts.FunctionDeclaration,
  plan: IrCountedStringAppendPlan,
): InspectedShape | undefined {
  const sourceFile = declaration.getSourceFile();
  const body = declaration.body;
  if (
    !body ||
    plan.sourceFile !== sourceFile ||
    plan.loop.getSourceFile() !== sourceFile ||
    plan.loop.parent !== body ||
    plan.accumulatorDeclaration.getSourceFile() !== sourceFile ||
    !ts.isIdentifier(plan.accumulatorDeclaration.name) ||
    !plan.accumulatorDeclaration.initializer ||
    (!ts.isStringLiteral(plan.accumulatorDeclaration.initializer) &&
      !ts.isNoSubstitutionTemplateLiteral(plan.accumulatorDeclaration.initializer))
  ) {
    return undefined;
  }
  const accumulatorStatement = declarationStatement(plan.accumulatorDeclaration);
  if (
    !accumulatorStatement ||
    accumulatorStatement.parent !== body ||
    accumulatorStatement.declarationList.declarations.length !== 1 ||
    accumulatorStatement.declarationList.declarations[0] !== plan.accumulatorDeclaration ||
    (accumulatorStatement.declarationList.flags & ts.NodeFlags.Let) === 0
  ) {
    return undefined;
  }
  const proofConstDeclarations = exactProofConstClosure(declaration, plan);
  if (!proofConstDeclarations) return undefined;
  const accumulatorIndex = body.statements.indexOf(accumulatorStatement);
  const loopIndex = body.statements.indexOf(plan.loop);
  const returnStatement = body.statements.at(-1);
  if (
    proofConstDeclarations.some((current, index) => body.statements[index] !== declarationStatement(current)) ||
    accumulatorIndex !== proofConstDeclarations.length ||
    loopIndex !== accumulatorIndex + 1 ||
    body.statements.length !== proofConstDeclarations.length + 3 ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression ||
    !ts.isPropertyAccessExpression(returnStatement.expression) ||
    returnStatement.expression.questionDotToken !== undefined ||
    returnStatement.expression.name.text !== "length" ||
    !ts.isIdentifier(returnStatement.expression.expression) ||
    proofContext.oracle.valueDeclarationOf(returnStatement.expression.expression) !== plan.accumulatorDeclaration
  ) {
    return undefined;
  }
  const allowed = new Set<ts.Statement>([
    ...proofConstDeclarations.map((current) => declarationStatement(current)!),
    accumulatorStatement,
    plan.loop,
    returnStatement,
  ]);
  if (allowed.size !== body.statements.length || body.statements.some((statement) => !allowed.has(statement))) {
    return undefined;
  }
  return {
    proofConstDeclarations,
    accumulatorDeclaration: plan.accumulatorDeclaration,
    lengthRead: returnStatement.expression,
    returnStatement,
  };
}

/** Collect live shared proofs without selecting or allocating a route. */
export function collectMultiPreparedStringLeafShapes(input: {
  readonly proofContext: MultiPreparedStringLeafProofContext;
  readonly sourceFiles: readonly ts.SourceFile[];
}): readonly MultiPreparedStringLeafShape[] {
  const shapes: MultiPreparedStringLeafShape[] = [];
  for (const sourceFile of input.sourceFiles) {
    for (const declaration of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(declaration) || !exactTopLevelNumericStringLeaf(declaration, sourceFile)) continue;
      const loops = declaration.body!.statements.filter(ts.isForStatement);
      if (loops.length !== 1) continue;
      const plan = planCountedStringAppend(input.proofContext, loops[0]!);
      if (!plan) continue;
      const inspected = inspectShape(input.proofContext, declaration, plan);
      if (!inspected) continue;
      shapes.push(
        Object.freeze({
          sourceFile,
          declaration,
          proofConstDeclarations: Object.freeze([...inspected.proofConstDeclarations]),
          accumulatorDeclaration: inspected.accumulatorDeclaration,
          loop: plan.loop,
          lengthRead: inspected.lengthRead,
          returnStatement: inspected.returnStatement,
          plan,
        }),
      );
    }
  }
  return Object.freeze(shapes);
}

function sameNodes<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function shapeIsCurrent(
  proofContext: MultiPreparedStringLeafProofContext,
  shape: MultiPreparedStringLeafShape,
): boolean {
  if (
    !Object.isFrozen(shape) ||
    !Object.isFrozen(shape.proofConstDeclarations) ||
    !Object.isFrozen(shape.plan) ||
    shape.declaration.parent !== shape.sourceFile ||
    shape.declaration.getSourceFile() !== shape.sourceFile ||
    !exactTopLevelNumericStringLeaf(shape.declaration, shape.sourceFile) ||
    !countedStringAppendPlanIsCurrent(proofContext, shape.plan)
  ) {
    return false;
  }
  const inspected = inspectShape(proofContext, shape.declaration, shape.plan);
  return !!(
    inspected &&
    inspected.accumulatorDeclaration === shape.accumulatorDeclaration &&
    shape.loop === shape.plan.loop &&
    inspected.lengthRead === shape.lengthRead &&
    inspected.returnStatement === shape.returnStatement &&
    sameNodes(inspected.proofConstDeclarations, shape.proofConstDeclarations)
  );
}

function exactVoidTopLevelCaller(declaration: ts.FunctionDeclaration, sourceFile: ts.SourceFile): boolean {
  return (
    declaration.parent === sourceFile &&
    declaration.getSourceFile() === sourceFile &&
    !!declaration.name &&
    !!declaration.body &&
    hasExportModifier(declaration) &&
    !hasDeclareModifier(declaration) &&
    declaration.asteriskToken === undefined &&
    declaration.parameters.length === 0 &&
    (declaration.typeParameters?.length ?? 0) === 0 &&
    declaration.type?.kind === ts.SyntaxKind.VoidKeyword &&
    !declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function requiredPlainParameter(parameter: ts.ParameterDeclaration): boolean {
  return (
    ts.isIdentifier(parameter.name) &&
    parameter.questionToken === undefined &&
    parameter.dotDotDotToken === undefined &&
    parameter.initializer === undefined &&
    (parameter.modifiers?.length ?? 0) === 0
  );
}

function exactHtmlElementType(proofContext: MultiPreparedStringLeafProofContext, parameter: ts.ParameterDeclaration) {
  const type = parameter.type;
  return !!(
    type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "HTMLElement" &&
    (type.typeArguments?.length ?? 0) === 0 &&
    proofContext.oracle.declaredNameOf(parameter) === "HTMLElement"
  );
}

function exactCallbackType(parameter: ts.ParameterDeclaration): boolean {
  const type = parameter.type;
  return !!(
    type &&
    ts.isFunctionTypeNode(type) &&
    (type.typeParameters?.length ?? 0) === 0 &&
    type.parameters.length === 0 &&
    type.type.kind === ts.SyntaxKind.NumberKeyword
  );
}

function exactHelperAbi(proofContext: MultiPreparedStringLeafProofContext, target: ts.FunctionDeclaration): boolean {
  const sourceFile = target.getSourceFile();
  const sameNameDeclarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "addBenchCard",
  );
  if (
    target.parent !== sourceFile ||
    target.name?.text !== "addBenchCard" ||
    !target.body ||
    !hasExportModifier(target) ||
    hasDeclareModifier(target) ||
    target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
    target.asteriskToken !== undefined ||
    target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    (target.typeParameters?.length ?? 0) !== 0 ||
    target.parameters.length !== 4 ||
    target.type?.kind !== ts.SyntaxKind.VoidKeyword ||
    sameNameDeclarations.length !== 1 ||
    sameNameDeclarations[0] !== target ||
    proofContext.oracle.valueDeclarationOf(target.name) !== target ||
    !sameNodes(proofContext.oracle.declarationsOf(target.name), [target]) ||
    !target.parameters.every(requiredPlainParameter)
  ) {
    return false;
  }
  const [wrap, title, desc, callback] = target.parameters;
  return !!(
    wrap &&
    title &&
    desc &&
    callback &&
    exactHtmlElementType(proofContext, wrap) &&
    title.type?.kind === ts.SyntaxKind.StringKeyword &&
    desc.type?.kind === ts.SyntaxKind.StringKeyword &&
    proofContext.oracle.typeFactOf(title).kind === "string" &&
    proofContext.oracle.typeFactOf(desc).kind === "string" &&
    exactCallbackType(callback)
  );
}

function exactCandidateValueUse(
  oracle: TypeOracle,
  sourceFiles: readonly ts.SourceFile[],
  declaration: ts.FunctionDeclaration,
): ts.Identifier | undefined {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node !== declaration.name && oracle.valueDeclarationOf(node) === declaration) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);
  return references.length === 1 ? references[0] : undefined;
}

function nearestFunctionOwner(node: ts.Node, sourceFile: ts.SourceFile): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== sourceFile && !ts.isFunctionLike(current)) current = current.parent;
  return current && ts.isFunctionDeclaration(current) ? current : undefined;
}

function selectionContainsOnly(selection: IrSelection, legacyName: string): boolean {
  return (
    selection.funcs.size === 1 &&
    selection.funcs.has(legacyName) &&
    (selection.classMembers?.size ?? 0) === 0 &&
    (selection.classMemberUnitIds?.size ?? 0) === 0 &&
    (selection.moduleInit === undefined || selection.moduleInit.stmtCount === 0)
  );
}

function exactSourceRecord(input: {
  readonly sourceFile: ts.SourceFile;
  readonly sourceId: IrSourceId;
  readonly sourceKey: string;
  readonly kind: "entry" | "source";
  readonly identityContext: MultiPreparedFunctionValuePlan["identityPlan"]["identityContext"];
}): boolean {
  const { identityContext, kind, sourceFile, sourceId, sourceKey } = input;
  const records = identityContext.inventory.sources.filter((record) => record.id === sourceId);
  const record = records.length === 1 ? records[0] : undefined;
  return !!(
    record &&
    record.kind === kind &&
    record.sourceKey === sourceKey &&
    identityContext.sourceIdBySourceFile.get(sourceFile) === sourceId &&
    identityContext.sourceFileBySourceId.get(sourceId) === sourceFile
  );
}

function exactIdentityTerminal(input: {
  readonly identityContext: MultiPreparedFunctionValuePlan["identityPlan"]["identityContext"];
  readonly declaration: ts.FunctionDeclaration;
  readonly sourceId: IrSourceId;
  readonly unitId: IrUnitId;
}): boolean {
  const { declaration, identityContext, sourceId, unitId } = input;
  const declarationName = declaration.name?.text;
  const terminal = identityContext.terminalByUnitId.get(unitId);
  const inventoryUnits = identityContext.inventory.allUnits.filter((unit) => unit.id === unitId);
  const inventoryTerminals = identityContext.inventory.terminalUnits.filter((unit) => unit.id === unitId);
  return !!(
    terminal &&
    terminal === identityContext.unitByUnitId.get(unitId) &&
    inventoryUnits.length === 1 &&
    inventoryUnits[0] === terminal &&
    inventoryTerminals.length === 1 &&
    inventoryTerminals[0] === terminal &&
    terminal.sourceId === sourceId &&
    terminal.kind === "top-level-function" &&
    terminal.observedKind === "function" &&
    terminal.displayName === declarationName &&
    terminal.legacyMatchName === declarationName &&
    terminal.terminalOwnerId === unitId &&
    terminal.lexicalOwnerId === null &&
    terminal.containingTerminalOwnerId === undefined &&
    identityContext.unitIdByDeclaration.get(declaration) === unitId &&
    identityContext.declarationByUnitId.get(unitId) === declaration
  );
}

function exactCandidateComponent(
  input: MultiPreparedStringLeafResolverInput<MultiPreparedFunctionValuePlan>,
  unitId: IrUnitId,
): boolean {
  const identityContext = input.plan.identityPlan.identityContext;
  const edges = collectLocalCallEdgesByIdentity(input.entrySource, identityContext);
  if ((edges.callees.get(unitId)?.size ?? 0) !== 0 || edges.calleesFromUnownedCallers.has(unitId)) return false;
  if ([...edges.callees].some(([caller, callees]) => caller !== unitId && callees.has(unitId))) return false;
  if (
    identityContext.inventory.allUnits.some((unit) => unit.id !== unitId && unit.terminalOwnerId === unitId) ||
    [...(input.ctx.programAbiSession?.derivedUnitRecords() ?? [])].some((unit) => unit.terminalOwnerId === unitId)
  ) {
    return false;
  }
  return true;
}

type ExactAllocatedNumericCallable = NonNullable<ReturnType<typeof exactAllocatedNumericCallable>>;

function exactTargetProgramAbiAuthority(
  ctx: CodegenContext,
  unitId: IrUnitId,
  legacyName: string,
  allocated: ExactAllocatedNumericCallable,
  boundary: CandidateBoundary,
): boolean {
  const session = ctx.programAbiSession;
  const registry = ctx.programAbiSourceCallables;
  const targetBindingId = irUnitCallableBindingId(unitId);
  if (
    session === undefined ||
    registry?.functionForUnit(unitId) !== allocated.func ||
    registry.handleForUnit(unitId) !== allocated.handle ||
    definedFuncAt(ctx, allocated.handle) !== allocated.func ||
    definedFuncHandleOf(ctx, allocated.func) !== allocated.handle
  ) {
    return false;
  }
  if (boundary !== "after-direct") {
    return (
      !session.hasPlan(targetBindingId) &&
      !session.hasLocator(targetBindingId) &&
      session.locatorBindingId(allocated.func) === undefined
    );
  }

  const targetRef = irUnitFuncRef({ unitId, name: legacyName });
  const structuralReferenceKey = irCallableBindingKey(targetRef.binding);
  const draft = session.getDraft(targetBindingId);
  if (
    !draft ||
    !Object.isFrozen(draft) ||
    !Object.isFrozen(draft.structuralOrder) ||
    !Object.isFrozen(draft.intent) ||
    draft.id !== targetBindingId ||
    draft.displayName !== legacyName ||
    draft.structuralReferenceKey !== structuralReferenceKey ||
    draft.slotPolicy !== "required" ||
    draft.slotSpace !== "function" ||
    draft.intent.kind !== "callable" ||
    draft.intent.origin !== "source" ||
    draft.intent.unitId !== unitId ||
    draft.intent.classId !== undefined ||
    draft.intent.sourceId !== undefined ||
    draft.intent.capabilityId !== undefined ||
    draft.intent.providerId !== undefined ||
    !programAbiCallableSignaturesEqual(
      draft.intent.signature,
      canonicalProgramAbiCallableTypeContract(allocated.signature),
    ) ||
    !session.hasLocator(targetBindingId, allocated.func) ||
    session.locatorBindingId(allocated.func) !== targetBindingId
  ) {
    return false;
  }

  try {
    const expectedOrder = session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.body,
    });
    const plannedReferences = session.bindingIdsForStructuralReference(structuralReferenceKey);
    return (
      draft.structuralOrder.sourceId === expectedOrder.sourceId &&
      draft.structuralOrder.declarationOrdinal === expectedOrder.declarationOrdinal &&
      draft.structuralOrder.domainOrdinal === expectedOrder.domainOrdinal &&
      draft.structuralOrder.roleOrdinal === expectedOrder.roleOrdinal &&
      draft.structuralOrder.derivedOrdinal === expectedOrder.derivedOrdinal &&
      plannedReferences.length === 1 &&
      plannedReferences[0] === targetBindingId &&
      session.resolveCurrentIndex(targetBindingId, "function", structuralReferenceKey) ===
        absoluteFuncIndex(ctx.mod, allocated.handle)
    );
  } catch {
    return false;
  }
}

function exactInitialSupportNamespace(ctx: CodegenContext, unitId: IrUnitId, legacyName: string, targetHandle: number) {
  const trampolineName = `__fn_tramp_${legacyName}_cached`;
  const cacheName = `__fn_closure_${legacyName}`;
  const trampolineRef = irSupportFuncRef(unitId, "function-value-trampoline", trampolineName);
  const cacheRef = irSupportGlobalRef(unitId, "function-value-cache", cacheName);
  const session = ctx.programAbiSession;
  return (
    trampolineRef.binding.kind === "support" &&
    cacheRef.binding.kind === "support" &&
    session !== undefined &&
    !session.hasPlan(trampolineRef.binding.bindingId) &&
    !session.hasPlan(cacheRef.binding.bindingId) &&
    !session.hasLocator(trampolineRef.binding.bindingId) &&
    !session.hasLocator(cacheRef.binding.bindingId) &&
    ![...ctx.funcMap.keys()].some((key) => key === trampolineName || key.startsWith(`${trampolineName}$`)) &&
    !ctx.funcClosureGlobals.has(legacyName) &&
    ![...ctx.funcClosureSingletonKeyByFuncIdx].some(
      ([handle, key]) => handle === targetHandle || key === legacyName || key.startsWith(`${legacyName}$`),
    ) &&
    !ctx.mod.functions.some((func) => func.name === trampolineName || func.name.startsWith(`${trampolineName}$`)) &&
    !ctx.mod.globals.some((global) => global.name === cacheName || global.name.startsWith(`${cacheName}$`)) &&
    ![...ctx.funcMap.keys()].some((key) => key.startsWith(`${legacyName}$`)) &&
    ![...ctx.funcClosureGlobals.keys()].some((key) => key.startsWith(`${legacyName}$`))
  );
}

function resolveCandidateFacts<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
  shape: MultiPreparedStringLeafShape,
  boundary: CandidateBoundary,
): CandidateFacts | undefined {
  const { ctx, entrySource, plan, projectedLoweringPlans, proofContext, safeSelection, safety } = input;
  const identityPlan = plan.identityPlan;
  const identityContext = identityPlan.identityContext;
  const declaration = shape.declaration;
  // Identity-only authentication; all type queries remain behind the oracle/shared proof.
  const { checker: contextChecker } = ctx;
  if (
    !ctx.standalone ||
    ctx.fast ||
    ctx.wasi ||
    proofContext.checker !== contextChecker ||
    proofContext.oracle !== ctx.oracle ||
    ctx.irPlanningIdentityContext !== identityContext ||
    ctx.programAbiSession?.inventory !== identityContext.inventory ||
    ctx.programAbiSourceCallables?.identityContext !== identityContext ||
    projectedLoweringPlans.identityContext !== identityContext ||
    shape.sourceFile !== entrySource ||
    declaration.parent !== entrySource ||
    identityContext.inventory.sources.length !== 2 ||
    identityContext.inventory.classes.length !== 0 ||
    identityContext.inventory.allUnits.length !== 6 ||
    identityContext.inventory.terminalUnits.length !== 5 ||
    identityContext.sourceIdBySourceFile.size !== 2 ||
    identityContext.sourceFileBySourceId.size !== 2 ||
    identityContext.unitIdByDeclaration.size !== 6 ||
    identityContext.declarationByUnitId.size !== 6 ||
    identityContext.unitByUnitId.size !== 6 ||
    identityContext.terminalByUnitId.size !== 5 ||
    identityContext.classIdByDeclaration.size !== 0 ||
    identityContext.declarationByClassId.size !== 0 ||
    identityContext.moduleInitUnitIdBySourceId.size !== 0 ||
    identityContext.moduleInitUnitIdBySourceFile.size !== 0 ||
    identityContext.moduleInitPopulationBySourceFile.size !== 2 ||
    !shapeIsCurrent(proofContext, shape)
  ) {
    return undefined;
  }
  const sourceId = identityContext.sourceIdBySourceFile.get(entrySource);
  const legacyName = declaration.name?.text;
  const unitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!sourceId || !legacyName || !unitId) return undefined;
  const terminal = identityContext.terminalByUnitId.get(unitId);
  const selectedFunction = identityPlan.identitySelection.funcs.get(unitId);
  const selectedUnit = identityPlan.identitySelection.units.get(unitId);
  if (
    !exactSourceRecord({
      sourceFile: entrySource,
      sourceId,
      sourceKey: "string.ts",
      kind: "entry",
      identityContext,
    }) ||
    !exactIdentityTerminal({ identityContext, declaration, sourceId, unitId }) ||
    identityContext.moduleInitUnitIdBySourceFile.has(entrySource) ||
    identityContext.moduleInitUnitIdBySourceId.has(sourceId) ||
    !selectionContainsOnly(plan.selection, legacyName) ||
    plan.selection !== identityPlan.selectionProjection.selection ||
    !selectionContainsOnly(safeSelection, legacyName) ||
    identityPlan.identitySelection.units.size !== 2 ||
    identityPlan.identitySelection.funcs.size !== 1 ||
    !terminal ||
    !selectedFunction ||
    selectedUnit !== selectedFunction ||
    selectedFunction.kind !== "function" ||
    selectedFunction.unitId !== unitId ||
    selectedFunction.displayName !== legacyName ||
    selectedFunction.displayName !== terminal.displayName ||
    selectedFunction.legacyMatchName !== legacyName ||
    identityPlan.safeFunctionUnitIds.size !== 1 ||
    !identityPlan.safeFunctionUnitIds.has(unitId) ||
    identityPlan.functionClaims.length !== 1 ||
    identityPlan.functionClaims[0]?.unitId !== unitId ||
    identityPlan.functionClaims[0]?.declaration !== declaration ||
    identityPlan.functionClaims[0]?.legacyName !== legacyName ||
    identityPlan.functionUnitIdByLegacyName.size !== 1 ||
    identityPlan.functionUnitIdByLegacyName.get(legacyName) !== unitId ||
    identityPlan.unitIdByLegacyName.size !== 2 ||
    identityPlan.unitIdByLegacyName.get(legacyName) !== unitId ||
    identityPlan.declarationByLegacyName.size !== 1 ||
    identityPlan.declarationByLegacyName.get(legacyName) !== declaration ||
    plan.functionClaimsByUnitId.size !== 1 ||
    plan.functionClaimsByUnitId.get(unitId)?.unitId !== unitId ||
    plan.functionClaimsByUnitId.get(unitId)?.declaration !== declaration ||
    plan.functionClaimsByUnitId.get(unitId)?.legacyName !== legacyName ||
    plan.classShapes.size !== 0 ||
    plan.classShapesById.size !== 0
  ) {
    return undefined;
  }
  const override = plan.overrideMapByUnitId.get(unitId);
  const namedOverrideSize = (plan.overrideMap as unknown as { readonly size?: unknown }).size;
  if (
    plan.overrideMapByUnitId.size !== 1 ||
    !override ||
    override.params.length !== 0 ||
    override.returnType === null ||
    asVal(override.returnType)?.kind !== "f64" ||
    namedOverrideSize !== 1 ||
    plan.overrideMap.get(legacyName) !== override ||
    projectedLoweringPlans.signaturesByUnitId.size !== 1 ||
    projectedLoweringPlans.signaturesByUnitId.get(unitId) !== override ||
    projectedLoweringPlans.ownerProjection.entries.length !== 1 ||
    projectedLoweringPlans.ownerProjection.entries[0]?.unitId !== unitId ||
    projectedLoweringPlans.ownerProjection.entries[0]?.legacyName !== legacyName ||
    projectedLoweringPlans.ownerUnitIdByLegacyName.size !== 1 ||
    projectedLoweringPlans.ownerUnitIdByLegacyName.get(legacyName) !== unitId
  ) {
    return undefined;
  }
  const syntaxPlans = identityPlan.identitySelection.countedStringAppendPlans;
  const selectedSyntaxPlans = syntaxPlans?.get(unitId);
  const loweringPlans = projectedLoweringPlans.countedStringAppends;
  const loweringPlan = loweringPlans?.get(shape.loop);
  if (
    syntaxPlans?.size !== 1 ||
    selectedSyntaxPlans?.length !== 1 ||
    selectedSyntaxPlans[0] !== shape.plan ||
    loweringPlans?.size !== 1 ||
    !loweringPlan ||
    !Object.isFrozen(loweringPlan) ||
    loweringPlan.syntaxPlan !== shape.plan ||
    loweringPlan.sourceFile !== entrySource ||
    loweringPlan.sourceId !== sourceId ||
    loweringPlan.ownerUnitId !== unitId ||
    loweringPlan.provider.name !== IR_STRING_REPEAT_FN ||
    loweringPlan.provider.binding.kind !== "intrinsic" ||
    loweringPlan.provider.binding.symbol !== IR_STRING_REPEAT_FN
  ) {
    return undefined;
  }
  try {
    requireCurrentIrCountedStringAppendPlanSite(loweringPlan);
  } catch {
    return undefined;
  }
  const allocated = exactAllocatedNumericCallable(ctx, unitId, legacyName, 0, boundary !== "after-direct");
  const occupiedTarget = ctx.mod.functions.filter((func) => func.name === legacyName);
  if (
    !allocated ||
    occupiedTarget.length !== 1 ||
    occupiedTarget[0] !== allocated.func ||
    safety.collisions.has(legacyName) ||
    safety.crossFileFunctionNames.has(legacyName) ||
    safety.importAliasNames.has(legacyName) ||
    safety.occupiedFunctionNameCounts.get(legacyName) !== 1 ||
    safety.occupiedFunctionKeys.filter((key) => key === legacyName).length !== 1 ||
    safety.occupiedFunctionKeys.some((key) => key.startsWith(`${legacyName}$`)) ||
    ctx.mod.functions.some((func) => func.name.startsWith(`${legacyName}$`)) ||
    ctx.liveFuncBindingGlobals?.has(legacyName) === true ||
    !exactTargetProgramAbiAuthority(ctx, unitId, legacyName, allocated, boundary) ||
    !exactCandidateComponent(input, unitId) ||
    input.hasForeignLateProvider(unitId) ||
    (boundary === "before-support" && !exactInitialSupportNamespace(ctx, unitId, legacyName, allocated.handle))
  ) {
    return undefined;
  }
  const sourceFiles = identityContext.inventory.sources.map((record) =>
    identityContext.sourceFileBySourceId.get(record.id),
  );
  if (sourceFiles.some((sourceFile) => sourceFile === undefined)) return undefined;
  const valueIdentifier = exactCandidateValueUse(proofContext.oracle, sourceFiles as ts.SourceFile[], declaration);
  const importedCall = valueIdentifier?.parent;
  if (
    !valueIdentifier ||
    valueIdentifier.getSourceFile() !== entrySource ||
    !importedCall ||
    !ts.isCallExpression(importedCall) ||
    importedCall.arguments.length !== 4 ||
    importedCall.arguments[3] !== valueIdentifier ||
    importedCall.arguments.some(ts.isSpreadElement) ||
    importedCall.questionDotToken !== undefined ||
    (importedCall.typeArguments?.length ?? 0) !== 0 ||
    !ts.isIdentifier(importedCall.expression)
  ) {
    return undefined;
  }
  const localImport = exactOracleValueDeclaration(proofContext.oracle, importedCall.expression);
  if (
    !localImport ||
    !ts.isImportSpecifier(localImport) ||
    localImport.propertyName !== undefined ||
    localImport.name.text !== "addBenchCard" ||
    importedCall.expression.text !== "addBenchCard"
  ) {
    return undefined;
  }
  const callerDeclaration = nearestFunctionOwner(importedCall, entrySource);
  const callerUnitId = callerDeclaration ? identityContext.unitIdByDeclaration.get(callerDeclaration) : undefined;
  const callerSelectedUnit = callerUnitId ? identityPlan.identitySelection.units.get(callerUnitId) : undefined;
  const callerTerminal = callerUnitId ? identityContext.terminalByUnitId.get(callerUnitId) : undefined;
  if (
    !callerDeclaration ||
    !callerUnitId ||
    callerUnitId === unitId ||
    callerDeclaration.name?.text !== "main" ||
    !exactVoidTopLevelCaller(callerDeclaration, entrySource) ||
    !exactIdentityTerminal({ identityContext, declaration: callerDeclaration, sourceId, unitId: callerUnitId }) ||
    !callerSelectedUnit ||
    !callerTerminal ||
    callerSelectedUnit.kind !== "function" ||
    callerSelectedUnit.unitId !== callerUnitId ||
    callerSelectedUnit.displayName !== callerTerminal.displayName ||
    callerSelectedUnit.legacyMatchName !== callerTerminal.legacyMatchName ||
    identityPlan.unitIdByLegacyName.get("main") !== callerUnitId ||
    plan.selection.funcs.has("main") ||
    safeSelection.funcs.has("main") ||
    identityPlan.safeFunctionUnitIds.has(callerUnitId) ||
    plan.functionClaimsByUnitId.has(callerUnitId) ||
    plan.overrideMapByUnitId.has(callerUnitId) ||
    plan.overrideMap.get("main") !== undefined ||
    safety.crossFileFunctionNames.has(callerDeclaration.name.text)
  ) {
    return undefined;
  }
  const importedTarget = resolveMultiPreparedFunctionValueImportTarget({
    oracle: proofContext.oracle,
    sourceFile: entrySource,
    callee: importedCall.expression,
    identityContext,
  });
  const importedTargetSource = importedTarget?.getSourceFile();
  const importedTargetSourceId = importedTargetSource
    ? identityContext.sourceIdBySourceFile.get(importedTargetSource)
    : undefined;
  const importedTargetUnitId = importedTarget ? identityContext.unitIdByDeclaration.get(importedTarget) : undefined;
  if (
    !importedTarget ||
    !importedTargetSource ||
    !importedTargetSourceId ||
    !importedTargetUnitId ||
    importedTargetSource === entrySource ||
    importedTargetUnitId === unitId ||
    importedTargetUnitId === callerUnitId ||
    !exactSourceRecord({
      sourceFile: importedTargetSource,
      sourceId: importedTargetSourceId,
      sourceKey: "helpers.ts",
      kind: "source",
      identityContext,
    }) ||
    !exactIdentityTerminal({
      identityContext,
      declaration: importedTarget,
      sourceId: importedTargetSourceId,
      unitId: importedTargetUnitId,
    }) ||
    !exactHelperAbi(proofContext, importedTarget) ||
    new Set([legacyName, callerDeclaration.name.text, importedTarget.name!.text]).size !== 3 ||
    [legacyName, callerDeclaration.name.text, importedTarget.name!.text].some(
      (name) => safety.collisions.has(name) || safety.importAliasNames.has(name),
    )
  ) {
    return undefined;
  }
  return {
    sourceId,
    unitId,
    legacyName,
    loweringPlan,
    valueIdentifier,
    callerDeclaration,
    callerUnitId,
    importedCall,
    importedTarget,
    importedTargetUnitId,
    importedTargetSourceId,
  };
}

function candidateMatchesFacts(
  candidate: MultiPreparedStringLeafCandidateEvidence,
  shape: MultiPreparedStringLeafShape,
  facts: CandidateFacts,
): boolean {
  return (
    Object.isFrozen(candidate) &&
    candidate.shape === shape &&
    candidate.sourceFile === shape.sourceFile &&
    candidate.declaration === shape.declaration &&
    candidate.sourceId === facts.sourceId &&
    candidate.unitId === facts.unitId &&
    candidate.legacyName === facts.legacyName &&
    candidate.loweringPlan === facts.loweringPlan &&
    candidate.valueIdentifier === facts.valueIdentifier &&
    candidate.legacyOwnerUnitId === facts.callerUnitId &&
    candidate.legacyOwnerName === facts.callerDeclaration.name?.text &&
    candidate.callerDeclaration === facts.callerDeclaration &&
    candidate.importedCall === facts.importedCall &&
    candidate.importedTarget === facts.importedTarget &&
    candidate.importedTargetUnitId === facts.importedTargetUnitId &&
    candidate.importedTargetSourceId === facts.importedTargetSourceId
  );
}

/** Resolve the sole pre-support candidate; ordinary ineligibility is a decline. */
export function resolveMultiPreparedStringLeafCandidate<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
): MultiPreparedStringLeafCandidateEvidence | undefined {
  if (!Object.isFrozen(input.shapes) || input.shapes.length !== 1) return undefined;
  const shape = input.shapes[0]!;
  const facts = resolveCandidateFacts(input, shape, "before-support");
  if (!facts) return undefined;
  return Object.freeze({
    sourceFile: shape.sourceFile,
    sourceId: facts.sourceId,
    declaration: shape.declaration,
    unitId: facts.unitId,
    legacyName: facts.legacyName,
    shape,
    loweringPlan: facts.loweringPlan,
    valueIdentifier: facts.valueIdentifier,
    legacyOwnerUnitId: facts.callerUnitId,
    legacyOwnerName: facts.callerDeclaration.name!.text,
    callerDeclaration: facts.callerDeclaration,
    importedCall: facts.importedCall,
    importedTarget: facts.importedTarget,
    importedTargetUnitId: facts.importedTargetUnitId,
    importedTargetSourceId: facts.importedTargetSourceId,
  });
}

function candidateIsCurrent<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
  candidate: MultiPreparedStringLeafCandidateEvidence,
  boundary: CandidateBoundary,
): boolean {
  if (
    !Object.isFrozen(input.shapes) ||
    input.shapes.length !== 1 ||
    input.shapes[0] !== candidate.shape ||
    !shapeIsCurrent(input.proofContext, candidate.shape)
  ) {
    return false;
  }
  const facts = resolveCandidateFacts(input, candidate.shape, boundary);
  return !!facts && candidateMatchesFacts(candidate, candidate.shape, facts);
}

function stringLeafInvariant(stage: "resolve" | "patch", candidate: MultiPreparedStringLeafCandidateEvidence): never {
  throw new IrInvariantError(
    "selection-preparation-mismatch",
    stage,
    `multi-source string leaf ${candidate.unitId} drifted after certification`,
  );
}

/** Explicit invariant form for the final pre-support boundary. */
export function requireCurrentMultiPreparedStringLeafCandidate<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
  candidate: MultiPreparedStringLeafCandidateEvidence,
): void {
  if (!candidateIsCurrent(input, candidate, "before-support")) stringLeafInvariant("resolve", candidate);
}

function supportIsCurrent<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
  candidate: MultiPreparedStringLeafCandidateEvidence,
  support: MultiPreparedFunctionValueSupportReceipt,
  boundary: MultiPreparedStringLeafSupportBoundary,
): boolean {
  return (
    candidateIsCurrent(input, candidate, boundary) &&
    exactSupportReceipt(input.ctx, candidate, support, boundary) &&
    multiPreparedFunctionValueUseIsCurrent(input.proofContext.oracle, input.ctx.irPlanningIdentityContext, candidate)
  );
}

function exactSupportReceipt(
  ctx: CodegenContext,
  candidate: MultiPreparedStringLeafCandidateEvidence,
  support: MultiPreparedFunctionValueSupportReceipt,
  boundary: MultiPreparedStringLeafSupportBoundary,
): boolean {
  if (
    !Object.isFrozen(support) ||
    !Object.isFrozen(support.trampolineRef) ||
    !Object.isFrozen(support.trampolineRef.binding) ||
    !Object.isFrozen(support.cacheGlobalRef) ||
    !Object.isFrozen(support.cacheGlobalRef.binding) ||
    !functionValueSupportIsCurrent(ctx, candidate, support, boundary === "before-prepare")
  ) {
    return false;
  }
  const trampolineName = `__fn_tramp_${candidate.legacyName}_cached`;
  const cacheName = `__fn_closure_${candidate.legacyName}`;
  const expectedTrampoline = irSupportFuncRef(candidate.unitId, "function-value-trampoline", trampolineName);
  const expectedCache = irSupportGlobalRef(candidate.unitId, "function-value-cache", cacheName);
  const session = ctx.programAbiSession;
  const allocated = exactAllocatedNumericCallable(
    ctx,
    candidate.unitId,
    candidate.legacyName,
    0,
    boundary !== "after-direct",
  );
  if (
    expectedTrampoline.binding.kind !== "support" ||
    expectedCache.binding.kind !== "support" ||
    session === undefined ||
    !allocated ||
    allocated.func !== support.targetFunction ||
    allocated.handle !== support.targetHandle ||
    !exactTargetProgramAbiAuthority(ctx, candidate.unitId, candidate.legacyName, allocated, boundary)
  ) {
    return false;
  }
  return (
    support.trampolineRef.name === trampolineName &&
    support.cacheGlobalRef.name === cacheName &&
    sameIrCallableBinding(support.trampolineRef.binding, expectedTrampoline.binding) &&
    sameIrGlobalBinding(support.cacheGlobalRef.binding, expectedCache.binding) &&
    support.trampolineBindingId === expectedTrampoline.binding.bindingId &&
    support.cacheGlobalBindingId === expectedCache.binding.bindingId &&
    session.hasPlan(support.trampolineBindingId) &&
    session.hasPlan(support.cacheGlobalBindingId) &&
    session.hasLocator(support.trampolineBindingId, support.trampolineFunction) &&
    session.hasLocator(support.cacheGlobalBindingId, support.cacheGlobal) &&
    session.locatorBindingId(support.trampolineFunction) === support.trampolineBindingId &&
    session.locatorBindingId(support.cacheGlobal) === support.cacheGlobalBindingId &&
    ctx.funcClosureSingletonKeyByFuncIdx.get(support.targetHandle) === candidate.legacyName &&
    [...ctx.funcClosureSingletonKeyByFuncIdx].filter(([, key]) => key === candidate.legacyName).length === 1 &&
    ctx.mod.functions.filter((func) => func.name === trampolineName || func.name.startsWith(`${trampolineName}$`))
      .length === 1 &&
    ctx.mod.functions.find((func) => func.name === trampolineName) === support.trampolineFunction &&
    ctx.mod.globals.filter((global) => global.name === cacheName || global.name.startsWith(`${cacheName}$`)).length ===
      1 &&
    ctx.mod.globals.find((global) => global.name === cacheName) === support.cacheGlobal &&
    [...ctx.funcMap.keys()].filter((key) => key === trampolineName || key.startsWith(`${trampolineName}$`)).length ===
      1 &&
    [...ctx.funcClosureGlobals.keys()].filter(
      (key) => key === candidate.legacyName || key.startsWith(`${candidate.legacyName}$`),
    ).length === 1
  );
}

/** Authenticate the exact support receipt after allocation, without rerunning namespace emptiness. */
export function requireCurrentMultiPreparedStringLeafSupport<Plan extends MultiPreparedFunctionValuePlan>(
  input: MultiPreparedStringLeafResolverInput<Plan>,
  candidate: MultiPreparedStringLeafCandidateEvidence,
  support: MultiPreparedFunctionValueSupportReceipt,
  boundary: MultiPreparedStringLeafSupportBoundary,
): void {
  if (!supportIsCurrent(input, candidate, support, boundary)) stringLeafInvariant("patch", candidate);
}
