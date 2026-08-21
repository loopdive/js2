// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClassId, IrUnitId } from "../ir/identity.js";
import type { IrIntegrationLoweringPlans } from "../ir/ast-lowering-plans.js";
import type { IrIntegrationReport, IrTypeOverrideMap } from "../ir/integration.js";
import { asVal, type IrClassShape, type IrType } from "../ir/nodes.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrSelection } from "../ir/select.js";
import type { Instr, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { hasDeclareModifier } from "./ast-modifiers.js";
import { compileDeclarations } from "./audited-declarations.js";
import type { ModuleInitMode } from "./declarations.js";
import { definedFuncAt } from "./func-space.js";
import { collectLocalCallEdgesByIdentity } from "./ir-first-gate.js";
import type { IrOverlayIdentityPlan } from "./ir-overlay-identity.js";
import { prepareIrBodies, type PreparedIrFreeFunctionBodies } from "./ir-prepared-free-functions.js";
import { correlateIrSkippedFunctionNames, type IrExactFunctionClaim } from "./ir-overlay-safety.js";

export interface MultiPreparedScalarLeafGraphSafety {
  readonly collisions: ReadonlySet<string>;
  readonly crossFileFunctionNames: ReadonlySet<string>;
  readonly importAliasNames: ReadonlySet<string>;
  readonly occupiedFunctionKeys: readonly string[];
  readonly occupiedFunctionNameCounts: ReadonlyMap<string, number>;
}

/** Flat function names shared by two or more source files are not safe IR keys. */
export function collectMultiIrFunctionNameCollisions(sourceFiles: readonly ts.SourceFile[]): ReadonlySet<string> {
  const owner = new Map<string, ts.SourceFile>();
  const collisions = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const namesInFile = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && !hasDeclareModifier(statement)) {
        namesInFile.add(statement.name.text);
      }
    }
    for (const name of namesInFile) {
      const previous = owner.get(name);
      if (previous && previous !== sourceFile) collisions.add(name);
      else owner.set(name, sourceFile);
    }
  }
  return collisions;
}

function collectMultiImportAliasNames(sourceFiles: readonly ts.SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name) names.add(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          names.add(clause.namedBindings.name.text);
        } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const target = (element.propertyName ?? element.name).text;
            if (element.name.text !== target) names.add(element.name.text);
          }
        }
      } else if (ts.isImportEqualsDeclaration(statement)) {
        names.add(statement.name.text);
      }
    }
  }
  return names;
}

function collectMultiImportedFunctionNames(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): ReadonlySet<string> {
  const names = new Set<string>();
  const allFunctionNames = new Set(
    sourceFiles.flatMap((sourceFile) =>
      sourceFile.statements.flatMap((statement) =>
        ts.isFunctionDeclaration(statement) && statement.name && statement.body ? [statement.name.text] : [],
      ),
    ),
  );
  const addFunctionDeclarations = (symbol: ts.Symbol | undefined): boolean => {
    if (!symbol) return false;
    let target = symbol;
    try {
      if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
    } catch {
      return false;
    }
    let found = false;
    for (const declaration of target.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.name) {
        names.add(declaration.name.text);
        found = true;
      }
    }
    if (target.flags & ts.SymbolFlags.Module) {
      for (const exported of checker.getExportsOfModule(target)) {
        let value = exported;
        try {
          if (value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
        } catch {
          for (const name of allFunctionNames) names.add(name);
          return true;
        }
        for (const declaration of value.declarations ?? []) {
          if (ts.isFunctionDeclaration(declaration) && declaration.name) {
            names.add(declaration.name.text);
            found = true;
          }
        }
      }
    }
    return found;
  };
  const addTarget = (local: ts.Identifier, syntacticTarget?: string, conservativeAll = false): void => {
    const found = addFunctionDeclarations(checker.getSymbolAtLocation(local));
    if (syntacticTarget) names.add(syntacticTarget);
    if (!found && conservativeAll) for (const name of allFunctionNames) names.add(name);
  };

  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) addTarget(clause.name, undefined, true);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addTarget(clause.namedBindings.name, undefined, true);
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          addTarget(element.name, (element.propertyName ?? element.name).text);
        }
      }
    }
    for (const statement of sourceFile.statements) {
      if (ts.isImportEqualsDeclaration(statement)) addTarget(statement.name, undefined, true);
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const target = element.propertyName ?? element.name;
          if (!addFunctionDeclarations(checker.getSymbolAtLocation(target))) names.add(target.text);
        }
      } else if (!addFunctionDeclarations(checker.getSymbolAtLocation(statement.moduleSpecifier))) {
        for (const name of allFunctionNames) names.add(name);
      }
    }
  }
  return names;
}

function collectMultiCrossFileFunctionNames(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): ReadonlySet<string> {
  const names = new Set(collectMultiImportedFunctionNames(sourceFiles, checker));
  if (!sourceFiles.some((sourceFile) => !ts.isExternalModule(sourceFile))) return names;
  const sourceSet = new Set(sourceFiles);
  const allFunctionNames = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        allFunctionNames.add(statement.name.text);
      }
    }
  }
  const markUnknownTargetConservatively = (): void => {
    for (const name of allFunctionNames) names.add(name);
  };
  const addResolvedTarget = (symbol: ts.Symbol | undefined, referenceFile: ts.SourceFile): void => {
    if (!symbol) return;
    let target = symbol;
    if (target.flags & ts.SymbolFlags.Alias) {
      try {
        target = checker.getAliasedSymbol(target);
      } catch {
        markUnknownTargetConservatively();
        return;
      }
    }
    for (const declaration of target.declarations ?? []) {
      if (
        ts.isFunctionDeclaration(declaration) &&
        declaration.name &&
        declaration.body &&
        sourceSet.has(declaration.getSourceFile()) &&
        declaration.getSourceFile() !== referenceFile
      ) {
        names.add(declaration.name.text);
      }
    }
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        try {
          addResolvedTarget(checker.getSymbolAtLocation(node), sourceFile);
        } catch {
          markUnknownTargetConservatively();
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return names;
}

export function buildMultiIrGraphSafety(
  ctx: CodegenContext,
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): MultiPreparedScalarLeafGraphSafety {
  const occupiedFunctionNameCounts = new Map<string, number>();
  for (const fn of ctx.mod.functions) {
    occupiedFunctionNameCounts.set(fn.name, (occupiedFunctionNameCounts.get(fn.name) ?? 0) + 1);
  }
  return {
    collisions: collectMultiIrFunctionNameCollisions(sourceFiles),
    crossFileFunctionNames: collectMultiCrossFileFunctionNames(sourceFiles, checker),
    importAliasNames: collectMultiImportAliasNames(sourceFiles),
    occupiedFunctionKeys: [...ctx.funcMap.keys()],
    occupiedFunctionNameCounts,
  };
}

export interface MultiPreparedScalarLeafPlan {
  readonly identityPlan: IrOverlayIdentityPlan;
  readonly functionClaimsByUnitId: ReadonlyMap<IrUnitId, IrExactFunctionClaim>;
  readonly overrideMapByUnitId: ReadonlyMap<
    IrUnitId,
    { readonly params: readonly IrType[]; readonly returnType: IrType | null }
  >;
  readonly overrideMap: IrTypeOverrideMap;
  readonly classShapes: ReadonlyMap<string, IrClassShape>;
  readonly classShapesById: ReadonlyMap<IrClassId, IrClassShape>;
}

export type MultiPreparedScalarLeafReceipt =
  | {
      readonly kind: "prepared";
      readonly unitId: IrUnitId;
      readonly legacyName: string;
      readonly preparedComponentId: string;
    }
  | {
      readonly kind: "invariant";
      readonly unitId: IrUnitId;
      readonly legacyName: string;
    };

export interface MultiPreparedScalarLeafRoute {
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.FunctionDeclaration;
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly preparedSelection: IrSelection;
  readonly preparedReport: IrIntegrationReport;
  readonly preparedFreeFunctions: PreparedIrFreeFunctionBodies;
  readonly receipt: MultiPreparedScalarLeafReceipt;
  readonly allocatedFunction: WasmFunction;
  readonly preparedBody: WasmFunction["body"];
  readonly preparedInstructions: readonly Instr[];
}

function invariant(stage: "resolve" | "patch", detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", stage, detail);
}

function isCommonJsAssignmentTarget(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text === "exports";
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
  const receiver = current.expression;
  if (ts.isIdentifier(receiver) && (receiver.text === "exports" || receiver.text === "module")) return true;
  return isCommonJsAssignmentTarget(receiver);
}

function sourceContainsCommonJsExport(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && (node.text === "exports" || node.text === "module" || node.text === "require")) {
      found = true;
      return;
    }
    if (ts.isExportAssignment(node) && node.isExportEquals) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isCommonJsAssignmentTarget(node.left)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasExactNumericDeclarationSignature(declaration: ts.FunctionDeclaration): boolean {
  return (
    declaration.name !== undefined &&
    declaration.body !== undefined &&
    declaration.asteriskToken === undefined &&
    (declaration.typeParameters?.length ?? 0) === 0 &&
    !declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    declaration.type?.kind === ts.SyntaxKind.NumberKeyword &&
    declaration.parameters.every(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.type?.kind === ts.SyntaxKind.NumberKeyword &&
        parameter.questionToken === undefined &&
        parameter.dotDotDotToken === undefined &&
        parameter.initializer === undefined,
    )
  );
}

/**
 * A syntax-only preflight used to decide whether moving multi-source IR
 * planning before the direct body loop is even relevant. It deliberately
 * accepts only one entry-source numeric leaf and has no mutation surface.
 */
function isSyntacticScalarLeaf(declaration: ts.FunctionDeclaration): boolean {
  if (!hasExactNumericDeclarationSignature(declaration) || !declaration.body) return false;
  const localNames = new Set(declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text));
  let valid = true;

  const collectLocals = (node: ts.Node): void => {
    if (!valid) return;
    if (node !== declaration.body && ts.isFunctionLike(node)) {
      valid = false;
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      valid = false;
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) {
        valid = false;
        return;
      }
      localNames.add(node.name.text);
    }
    ts.forEachChild(node, collectLocals);
  };
  collectLocals(declaration.body);
  if (!valid) return false;

  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (
      (ts.isBinaryExpression(node) &&
        ![
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
        ].includes(node.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(node) &&
        node.operator !== ts.SyntaxKind.PlusToken &&
        node.operator !== ts.SyntaxKind.MinusToken) ||
      ts.isPostfixUnaryExpression(node)
    ) {
      valid = false;
      return;
    }
    if (
      (node !== declaration.body && ts.isFunctionLike(node)) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isThrowStatement(node) ||
      ts.isTryStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node) ||
      node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.SuperKeyword ||
      node.kind === ts.SyntaxKind.AwaitExpression ||
      node.kind === ts.SyntaxKind.YieldExpression
    ) {
      valid = false;
      return;
    }
    if (ts.isIdentifier(node) && !localNames.has(node.text)) {
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return valid;
}

/** Collect syntax candidates without choosing an arbitrary graph member. */
export function collectMultiPreparedScalarLeafCandidates(
  sourceFiles: readonly ts.SourceFile[],
): readonly ts.FunctionDeclaration[] {
  if (sourceFiles.some(sourceContainsCommonJsExport)) return [];
  return sourceFiles.flatMap((sourceFile) =>
    sourceFile.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && isSyntacticScalarLeaf(statement),
    ),
  );
}

function exactAllocatedNumericCallable(
  ctx: CodegenContext,
  unitId: IrUnitId,
  legacyName: string,
  parameterCount: number,
  requireEmptyBody: boolean,
) {
  const registry = ctx.programAbiSourceCallables;
  const handle = registry?.handleForUnit(unitId);
  const func = registry?.functionForUnit(unitId);
  const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
  if (
    handle === undefined ||
    func === undefined ||
    definedFuncAt(ctx, handle) !== func ||
    ctx.funcMap.get(legacyName) !== handle ||
    func.name !== legacyName ||
    (requireEmptyBody && func.body.length !== 0) ||
    signature?.kind !== "func" ||
    signature.params.length !== parameterCount ||
    !signature.params.every((type) => type.kind === "f64") ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "f64"
  ) {
    return undefined;
  }
  return { handle, func, signature };
}

function isExactSingletonComponent(
  sourceFile: ts.SourceFile,
  unitId: IrUnitId,
  identityPlan: IrOverlayIdentityPlan,
): boolean {
  const edges = collectLocalCallEdgesByIdentity(sourceFile, identityPlan.identityContext);
  if ((edges.callees.get(unitId)?.size ?? 0) > 0 || edges.calleesFromUnownedCallers.has(unitId)) return false;
  for (const [callerUnitId, callees] of edges.callees) {
    if (callerUnitId !== unitId && callees.has(unitId)) return false;
  }
  return true;
}

function exactWithdrawal(
  preparedReport: IrIntegrationReport,
  prepared: PreparedIrFreeFunctionBodies,
  unitId: IrUnitId,
  legacyName: string,
): boolean {
  const terminalEvidence = preparedReport.terminalEvidence ?? [];
  const evidence = terminalEvidence[0];
  const emptyRoute =
    prepared.skipBodies.size === 0 &&
    prepared.preserveBodies.size === 0 &&
    prepared.completedBodies.size === 0 &&
    prepared.requestedSkipProjection.entries.length === 0 &&
    preparedReport.compiled.length === 0 &&
    (preparedReport.compiledArtifactEvidence?.length ?? 0) === 0 &&
    (preparedReport.syntheticCompiledArtifacts?.length ?? 0) === 0;
  return (
    emptyRoute &&
    ((preparedReport.errors.length === 0 && terminalEvidence.length === 0) ||
      (preparedReport.errors.length === 1 &&
        terminalEvidence.length === 1 &&
        evidence?.kind === "failed" &&
        evidence.unitId === unitId &&
        evidence.legacyName === legacyName &&
        evidence.error === preparedReport.errors[0] &&
        evidence.error.outcome.kind === "unsupported"))
  );
}

interface MultiPreparedScalarLeafCandidateInput {
  readonly ctx: CodegenContext;
  readonly sourceFile: ts.SourceFile;
  readonly declaration: ts.FunctionDeclaration;
  readonly plan: MultiPreparedScalarLeafPlan;
  readonly safeSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
  readonly lateProviderOwnerUnitIds: ReadonlySet<IrUnitId>;
}

interface MultiPreparedScalarLeafCandidateEvidence {
  readonly legacyName: string;
  readonly unitId: IrUnitId;
}

function resolveExactCandidate(
  input: MultiPreparedScalarLeafCandidateInput,
): MultiPreparedScalarLeafCandidateEvidence | undefined {
  const { ctx, declaration, plan, safeSelection, safety, sourceFile } = input;
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
  const legacyName = declaration.name.text;
  const unitId = plan.identityPlan.identityContext.unitIdByDeclaration.get(declaration);
  const terminal = unitId ? plan.identityPlan.identityContext.terminalByUnitId.get(unitId) : undefined;
  const claim = unitId ? plan.functionClaimsByUnitId.get(unitId) : undefined;
  const override = unitId ? plan.overrideMapByUnitId.get(unitId) : undefined;
  if (
    unitId === undefined ||
    terminal === undefined ||
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
    override.params.length !== declaration.parameters.length ||
    !override.params.every((type) => asVal(type)?.kind === "f64") ||
    override.returnType === null ||
    asVal(override.returnType)?.kind !== "f64" ||
    safety.collisions.has(legacyName) ||
    safety.crossFileFunctionNames.has(legacyName) ||
    safety.importAliasNames.has(legacyName) ||
    safety.occupiedFunctionNameCounts.get(legacyName) !== 1 ||
    safety.occupiedFunctionKeys.some((key) => key.startsWith(`${legacyName}$`)) ||
    ctx.liveFuncBindingGlobals?.has(legacyName) === true ||
    input.lateProviderOwnerUnitIds.has(unitId) ||
    plan.classShapes.size !== 0 ||
    plan.classShapesById.size !== 0 ||
    !isExactSingletonComponent(sourceFile, unitId, plan.identityPlan) ||
    exactAllocatedNumericCallable(ctx, unitId, legacyName, declaration.parameters.length, true) === undefined
  ) {
    return undefined;
  }
  return { legacyName, unitId };
}

/** Read-only eligibility proof used before enforcing graph-wide uniqueness. */
export function isMultiPreparedScalarLeafCandidateEligible(input: MultiPreparedScalarLeafCandidateInput): boolean {
  return resolveExactCandidate(input) !== undefined;
}

/**
 * Prepare one exact entry-source scalar leaf before multi-source direct body
 * emission. All ordinary ineligibility is decided before requesting a skip;
 * once exact Prepared evidence exists, any drift is an invariant.
 */
export function tryPrepareMultiSourceScalarLeaf(
  input: MultiPreparedScalarLeafCandidateInput & {
    readonly projectLoweringPlans: (selection: IrSelection) => IrIntegrationLoweringPlans;
  },
): MultiPreparedScalarLeafRoute | undefined {
  const { ctx, declaration, plan, sourceFile } = input;
  const candidate = resolveExactCandidate(input);
  if (!candidate) return undefined;
  const { legacyName, unitId } = candidate;

  const preparedSelection: IrSelection = {
    funcs: new Set([legacyName]),
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
    invariant("patch", `multi-source scalar leaf ${unitId} produced a foreign Prepared routing family`);
  }
  if (prepared.freeFunctions.skipBodies.size === 0) {
    if (
      exactWithdrawal(prepared.report, prepared.freeFunctions, unitId, legacyName) &&
      exactAllocatedNumericCallable(ctx, unitId, legacyName, declaration.parameters.length, true)
    ) {
      return undefined;
    }
    invariant("patch", `multi-source scalar leaf ${unitId} did not withdraw atomically before its skip`);
  }

  const requested = prepared.freeFunctions.requestedSkipProjection.entries;
  const terminalEvidence = prepared.report.terminalEvidence ?? [];
  const artifactEvidence = prepared.report.compiledArtifactEvidence ?? [];
  const evidence = terminalEvidence[0];
  const artifact = artifactEvidence[0];
  const exactSets =
    requested.length === 1 &&
    requested[0]?.unitId === unitId &&
    requested[0]?.legacyName === legacyName &&
    prepared.freeFunctions.skipBodies.size === 1 &&
    prepared.freeFunctions.skipBodies.has(legacyName) &&
    prepared.freeFunctions.completedBodies.size === 1 &&
    prepared.freeFunctions.completedBodies.has(legacyName) &&
    (prepared.report.syntheticCompiledArtifacts?.length ?? 0) === 0;
  if (!exactSets || terminalEvidence.length !== 1) {
    invariant("patch", `multi-source scalar leaf ${unitId} produced a non-exact Prepared route receipt`);
  }

  let receipt: MultiPreparedScalarLeafReceipt;
  if (evidence?.kind === "patched") {
    if (
      evidence.unitId !== unitId ||
      evidence.legacyName !== legacyName ||
      evidence.preparedComponentId === undefined ||
      prepared.report.errors.length !== 0 ||
      prepared.report.compiled.length !== 1 ||
      prepared.report.compiled[0] !== legacyName ||
      prepared.report.terminalCompiledOwners?.length !== 1 ||
      prepared.report.terminalCompiledOwners[0] !== legacyName ||
      artifactEvidence.length !== 1 ||
      artifact?.artifactUnitId !== unitId ||
      artifact?.terminalOwnerUnitId !== unitId ||
      artifact?.name !== legacyName ||
      artifact?.preparedComponentId !== evidence.preparedComponentId ||
      prepared.freeFunctions.preserveBodies.size !== 1 ||
      !prepared.freeFunctions.preserveBodies.has(legacyName)
    ) {
      invariant("patch", `multi-source scalar leaf ${unitId} lost its exact Prepared Program ABI receipt`);
    }
    receipt = {
      kind: "prepared",
      unitId,
      legacyName,
      preparedComponentId: evidence.preparedComponentId,
    };
  } else {
    if (
      evidence?.kind !== "failed" ||
      evidence.unitId !== unitId ||
      evidence.legacyName !== legacyName ||
      evidence.error.outcome.kind !== "invariant" ||
      artifactEvidence.length !== 0 ||
      prepared.freeFunctions.preserveBodies.size !== 0
    ) {
      invariant("patch", `multi-source scalar leaf ${unitId} failed without an exact invariant receipt`);
    }
    receipt = { kind: "invariant", unitId, legacyName };
  }

  const allocated = exactAllocatedNumericCallable(ctx, unitId, legacyName, declaration.parameters.length, false);
  if (!allocated || (receipt.kind === "prepared" && allocated.func.body.length === 0)) {
    invariant("patch", `multi-source scalar leaf ${unitId} drifted after Prepared certification`);
  }

  return Object.freeze({
    sourceFile,
    declaration,
    unitId,
    legacyName,
    preparedSelection,
    preparedReport: prepared.report,
    preparedFreeFunctions: prepared.freeFunctions,
    receipt,
    allocatedFunction: allocated.func,
    preparedBody: allocated.func.body,
    preparedInstructions: Object.freeze([...allocated.func.body]),
  });
}

export interface EarlyMultiPreparedScalarLeafState<Plan extends MultiPreparedScalarLeafPlan> {
  readonly plan: Plan;
  readonly route?: MultiPreparedScalarLeafRoute;
  skippedFunctionUnitIds: ReadonlySet<IrUnitId>;
}

export function compileMultiPreparedScalarLeafDeclarations<Plan extends MultiPreparedScalarLeafPlan>(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  state: EarlyMultiPreparedScalarLeafState<Plan> | undefined,
  moduleInitMode: ModuleInitMode,
): void {
  const skippedNames = compileDeclarations(
    ctx,
    sourceFile,
    state?.route?.preparedFreeFunctions.skipBodies,
    state?.route?.preparedFreeFunctions.preserveBodies,
    undefined,
    moduleInitMode,
  );
  if (state?.route) {
    state.skippedFunctionUnitIds = correlateIrSkippedFunctionNames(
      state.route.preparedFreeFunctions.requestedSkipProjection,
      skippedNames ?? [],
    ).unitIds;
  }
}

/**
 * Plan every candidate-bearing source at the shared pre-body seam, prove that
 * exactly one graph candidate survives, and prepare only when it belongs to
 * the entry source. Kill-switch controls carry the same plans without a route.
 */
export function planEarlyMultiPreparedScalarLeafRoute<Plan extends MultiPreparedScalarLeafPlan>(input: {
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
  readonly projectLoweringPlans: (plan: Plan, selection: IrSelection) => IrIntegrationLoweringPlans;
}): Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>> {
  const states = new Map<ts.SourceFile, EarlyMultiPreparedScalarLeafState<Plan>>();
  if (!input.active) return states;
  const candidates = collectMultiPreparedScalarLeafCandidates(input.sourceFiles);
  if (candidates.length === 0) return states;
  const safety = input.safety();
  const eligible: Array<{
    declaration: ts.FunctionDeclaration;
    sourceFile: ts.SourceFile;
    plan: Plan;
    safeSelection: IrSelection;
    lateProviderOwnerUnitIds: ReadonlySet<IrUnitId>;
  }> = [];
  for (const declaration of candidates) {
    const sourceFile = declaration.getSourceFile();
    let state = states.get(sourceFile);
    if (!state) {
      state = { plan: input.planSource(sourceFile), skippedFunctionUnitIds: new Set() };
      states.set(sourceFile, state);
    }
    const safeSelection = input.safeSelection(state.plan, sourceFile, safety);
    const lateProviderOwnerUnitIds = input.lateProviderOwnerUnitIds(state.plan, sourceFile);
    if (
      isMultiPreparedScalarLeafCandidateEligible({
        ctx: input.ctx,
        sourceFile,
        declaration,
        plan: state.plan,
        safeSelection,
        safety,
        lateProviderOwnerUnitIds,
      })
    ) {
      eligible.push({ declaration, sourceFile, plan: state.plan, safeSelection, lateProviderOwnerUnitIds });
    }
  }
  const exact = eligible.length === 1 ? eligible[0] : undefined;
  if (!input.cutoverEnabled || exact?.sourceFile !== input.entryFile) return states;
  const route = tryPrepareMultiSourceScalarLeaf({
    ctx: input.ctx,
    sourceFile: exact.sourceFile,
    declaration: exact.declaration,
    plan: exact.plan,
    safeSelection: exact.safeSelection,
    safety,
    lateProviderOwnerUnitIds: exact.lateProviderOwnerUnitIds,
    projectLoweringPlans: (selection) => input.projectLoweringPlans(exact.plan, selection),
  });
  if (route) states.set(exact.sourceFile, { plan: exact.plan, route, skippedFunctionUnitIds: new Set() });
  return states;
}

/** Re-prove the exact leaf after all other direct bodies have run. */
export function assertMultiPreparedScalarLeafRouteCurrent(input: {
  readonly ctx: CodegenContext;
  readonly route: MultiPreparedScalarLeafRoute;
  readonly finalSelection: IrSelection;
  readonly safety: MultiPreparedScalarLeafGraphSafety;
}): void {
  const { ctx, finalSelection, route, safety } = input;
  if (process.env.JS2WASM_TEST_TAMPER_MULTI_PREPARED_SCALAR_LEAF?.split(",").includes(route.legacyName)) {
    route.allocatedFunction.name = `${route.legacyName}$tampered`;
  }
  const allocated = exactAllocatedNumericCallable(
    ctx,
    route.unitId,
    route.legacyName,
    route.declaration.parameters.length,
    false,
  );
  if (
    !finalSelection.funcs.has(route.legacyName) ||
    safety.collisions.has(route.legacyName) ||
    safety.crossFileFunctionNames.has(route.legacyName) ||
    safety.importAliasNames.has(route.legacyName) ||
    safety.occupiedFunctionNameCounts.get(route.legacyName) !== 1 ||
    safety.occupiedFunctionKeys.some((key) => key.startsWith(`${route.legacyName}$`)) ||
    ctx.liveFuncBindingGlobals?.has(route.legacyName) === true ||
    !allocated ||
    allocated.func !== route.allocatedFunction ||
    allocated.func.body !== route.preparedBody ||
    allocated.func.body.length !== route.preparedInstructions.length ||
    allocated.func.body.some((instruction, index) => instruction !== route.preparedInstructions[index]) ||
    (route.receipt.kind === "prepared" && allocated.func.body.length === 0)
  ) {
    invariant("patch", `multi-source scalar leaf ${route.unitId} drifted after direct-body certification`);
  }
}
