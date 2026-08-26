// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Dormant source-qualified argument-edge evidence for #3521.
 *
 * This module proves one bounded transfer of a function-constructor instance
 * into one local function parameter. It deliberately does not alter the
 * propagation lattice, admit an IR owner, or provide a lowering decision.
 */

import { forEachChild, ts } from "../ts-api.js";
import type { IrSourceId, IrUnitId } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { _propagationCore, type IrUnitTypeMap, type LatticeType } from "./propagate.js";

export type IrFnctorConstructorDeclaration = ts.FunctionDeclaration | ts.FunctionExpression;

/** Checker-type-independent syntax; symbol identity is checked, but the parameter is not claimed as string. */
export interface IrFnctorInputConstructorSyntaxProof {
  readonly kind: "fnctor-input-constructor-syntax";
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
  readonly constructorUnitId: IrUnitId;
  readonly constructorDeclaration: IrFnctorConstructorDeclaration;
  readonly parameterDeclaration: ts.ParameterDeclaration;
  readonly parameterIndex: 0;
  readonly assignmentStatement: ts.ExpressionStatement;
  readonly inputAssignment: ts.BinaryExpression;
  readonly proof: {
    readonly sameSource: true;
    readonly exactDeclarationIdentity: true;
    readonly oneRequiredParameter: true;
    readonly fixedUnconditionalInput: true;
  };
}

/** The current direct backend's exact reserved type identity. L2 replaces its positional layout assumptions. */
export interface IrFnctorPhysicalReservationProof {
  readonly kind: "fnctor-physical-reservation";
  readonly sourceId: IrSourceId;
  readonly constructorUnitId: IrUnitId;
  readonly constructorDeclaration: IrFnctorConstructorDeclaration;
  readonly constructorSite: ts.NewExpression;
  readonly reservationKey: string;
  readonly reservedTypeIdx: number;
}

export type IrFnctorPhysicalReservationResolver = (
  site: ts.NewExpression,
  constructorProof: IrFnctorInputConstructorSyntaxProof,
) => IrFnctorPhysicalReservationProof | undefined;

/** Live authority needed to re-resolve retained AST and physical-reservation joins. */
export interface IrFnctorArgumentProjectionAuthority {
  readonly checker: ts.TypeChecker;
  readonly resolvePhysicalReservation: IrFnctorPhysicalReservationResolver;
}

/**
 * Frozen evidence retained on the structural identity plan. This is not an
 * {@link IrFnctorAdmission}: the instance crosses one certified call edge, so
 * this record intentionally has no `noEscape` assertion.
 */
export interface IrFnctorArgumentProjection {
  readonly kind: "fnctor-argument-projection";
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
  readonly callerUnitId: IrUnitId;
  readonly callerDeclaration: ts.FunctionDeclaration;
  readonly directCall: ts.CallExpression;
  readonly calleeUnitId: IrUnitId;
  readonly calleeDeclaration: ts.FunctionDeclaration;
  readonly calleeParameterDeclaration: ts.ParameterDeclaration;
  readonly calleeParameterIndex: 0;
  readonly constructorUnitId: IrUnitId;
  readonly constructorDeclaration: IrFnctorConstructorDeclaration;
  readonly constructorParameterDeclaration: ts.ParameterDeclaration;
  readonly constructorParameterIndex: 0;
  readonly constructorSite: ts.NewExpression;
  readonly allocationArgument: ts.Expression;
  readonly constructorSyntax: IrFnctorInputConstructorSyntaxProof;
  readonly physicalReservation: IrFnctorPhysicalReservationProof;
  readonly logicalShape: {
    readonly fieldName: "input";
    readonly fieldType: "string";
  };
  readonly proof: {
    readonly sameSource: true;
    readonly exactIdentityJoins: true;
    readonly logicalStringArgument: true;
    readonly directConstructor: true;
    readonly directCallArgument: true;
    readonly uniqueAllocation: true;
    readonly uniqueCallEdge: true;
    readonly noAlias: true;
    readonly noAssignment: true;
    readonly noCapture: true;
    readonly noReturn: true;
    readonly noPropertyWrite: true;
    readonly noSecondUse: true;
  };
}

const ARGUMENT_PROOF_KEYS = Object.freeze([
  "sameSource",
  "exactIdentityJoins",
  "logicalStringArgument",
  "directConstructor",
  "directCallArgument",
  "uniqueAllocation",
  "uniqueCallEdge",
  "noAlias",
  "noAssignment",
  "noCapture",
  "noReturn",
  "noPropertyWrite",
  "noSecondUse",
] as const);
const SORTED_ARGUMENT_PROOF_KEYS = Object.freeze([...ARGUMENT_PROOF_KEYS].sort());
const CONSTRUCTOR_PROOF_KEYS = Object.freeze([
  "sameSource",
  "exactDeclarationIdentity",
  "oneRequiredParameter",
  "fixedUnconditionalInput",
] as const);
const SORTED_CONSTRUCTOR_PROOF_KEYS = Object.freeze([...CONSTRUCTOR_PROOF_KEYS].sort());

function aliasedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

function symbolOwnsDeclaration(checker: ts.TypeChecker, node: ts.Identifier, declaration: ts.Node): boolean {
  const symbol = aliasedSymbol(checker, node);
  if (!symbol) return false;
  return (symbol.getDeclarations() ?? []).some((candidate) => {
    if (candidate === declaration) return true;
    return (
      ts.isVariableDeclaration(candidate) &&
      candidate.initializer !== undefined &&
      unwrapTransparentExpression(candidate.initializer) === declaration
    );
  });
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

interface FunctionDeclarationResolution {
  readonly declarations: ReadonlySet<IrFnctorConstructorDeclaration>;
  readonly uncertain: boolean;
}

function isConstVariableDeclaration(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

/**
 * Resolve one callable expression through checker aliases and transparent
 * local const aliases. Mutable/compound aliases retain every visible target
 * but are marked uncertain so a relevant use closes the projection.
 */
function resolveFunctionDeclarations(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seenSymbols: ReadonlySet<ts.Symbol> = new Set(),
): FunctionDeclarationResolution {
  const bare = unwrapTransparentExpression(expression);
  const location = ts.isPropertyAccessExpression(bare) ? bare.name : bare;
  let symbol = checker.getSymbolAtLocation(location);
  if (!symbol) {
    const declarations = new Set<IrFnctorConstructorDeclaration>();
    if (!ts.isIdentifier(bare)) {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const nested = resolveFunctionDeclarations(checker, node, seenSymbols);
          for (const candidate of nested.declarations) declarations.add(candidate);
          return;
        }
        forEachChild(node, visit);
      };
      visit(bare);
    }
    return { declarations, uncertain: declarations.size > 0 };
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return { declarations: new Set(), uncertain: true };
    }
  }
  if (seenSymbols.has(symbol)) return { declarations: new Set(), uncertain: true };
  const nextSeen = new Set(seenSymbols).add(symbol);
  const declarations = new Set<IrFnctorConstructorDeclaration>();
  let uncertain = false;
  for (const declaration of symbol.getDeclarations() ?? []) {
    if ((ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) && declaration.body) {
      declarations.add(declaration);
      continue;
    }
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
    const initializer = unwrapTransparentExpression(declaration.initializer);
    if (ts.isFunctionExpression(initializer) && initializer.body) {
      declarations.add(initializer);
      continue;
    }
    const nested = resolveFunctionDeclarations(checker, initializer, nextSeen);
    for (const candidate of nested.declarations) declarations.add(candidate);
    if (nested.declarations.size > 0 && !isConstVariableDeclaration(declaration)) uncertain = true;
    uncertain ||= nested.uncertain;
  }
  if (!ts.isIdentifier(bare)) {
    // A compound callable (`Parser.bind(...)`, `cond ? Parser : Other`,
    // `readNumber.call`, …) is never exact. Still trace every checker-resolved
    // identifier it contains so a relevant target cannot disappear behind the
    // wrapper merely because the compound expression itself has no symbol.
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node !== location) {
        const nested = resolveFunctionDeclarations(checker, node, nextSeen);
        if (nested.declarations.size > 0) {
          for (const candidate of nested.declarations) declarations.add(candidate);
          uncertain = true;
        }
        return;
      }
      forEachChild(node, visit);
    };
    visit(bare);
  }
  return { declarations, uncertain };
}

function exactResolvedFunctionDeclaration(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): IrFnctorConstructorDeclaration | undefined {
  const resolution = resolveFunctionDeclarations(checker, expression);
  return !resolution.uncertain && resolution.declarations.size === 1 ? [...resolution.declarations][0] : undefined;
}

type ExactTargetResolution = "exact" | "uncertain" | "other";

function expressionResolutionAgainstTarget(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  target: IrFnctorConstructorDeclaration,
): ExactTargetResolution {
  const resolution = resolveFunctionDeclarations(checker, expression);
  if (resolution.declarations.has(target)) {
    return !resolution.uncertain && resolution.declarations.size === 1 ? "exact" : "uncertain";
  }

  // Compound aliases such as `cond ? Parser : Other` have no symbol at the
  // expression root. Seeing the exact target anywhere inside is relevant but
  // not exact enough to authorize, so fail closed rather than miss the use.
  let referencesTarget = false;
  const visit = (node: ts.Node): void => {
    if (referencesTarget) return;
    if (ts.isIdentifier(node)) {
      const symbol = aliasedSymbol(checker, node);
      if ((symbol?.getDeclarations() ?? []).some((declaration) => declaration === target)) {
        referencesTarget = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(expression);
  return referencesTarget ? "uncertain" : "other";
}

function exactUnitForDeclaration(
  identity: IrPlanningIdentityContext,
  sourceId: IrSourceId,
  declaration: ts.Node,
): IrUnitId | undefined {
  const unitId = identity.unitIdByDeclaration.get(declaration);
  const unit = unitId === undefined ? undefined : identity.unitByUnitId.get(unitId);
  return unitId !== undefined &&
    unit?.sourceId === sourceId &&
    identity.declarationByUnitId.get(unitId) === declaration &&
    identity.sourceIdBySourceFile.get(declaration.getSourceFile()) === sourceId &&
    identity.sourceFileBySourceId.get(sourceId) === declaration.getSourceFile()
    ? unitId
    : undefined;
}

function exactFunctionUnit(
  identity: IrPlanningIdentityContext,
  sourceId: IrSourceId,
  declaration: ts.FunctionDeclaration,
): IrUnitId | undefined {
  const unitId = exactUnitForDeclaration(identity, sourceId, declaration);
  const terminal = unitId === undefined ? undefined : identity.terminalByUnitId.get(unitId);
  return terminal?.observedKind === "function" && terminal.terminalOwnerId === unitId ? unitId : undefined;
}

function exactInputAssignment(
  statement: ts.Statement,
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): { statement: ts.ExpressionStatement; assignment: ts.BinaryExpression } | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined;
  const assignment = statement.expression;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  if (!ts.isPropertyAccessExpression(assignment.left) || assignment.left.name.text !== "input") return undefined;
  if (assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  if (!ts.isIdentifier(assignment.right) || !symbolOwnsDeclaration(checker, assignment.right, parameter)) {
    return undefined;
  }
  return { statement, assignment };
}

/** Pure constructor syntax proof shared by the old admission and the new dormant edge. */
export function proveIrFnctorInputConstructorSyntax(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  declaration: IrFnctorConstructorDeclaration,
): IrFnctorInputConstructorSyntaxProof | undefined {
  const sourceFile = declaration.getSourceFile();
  const sourceId = identity.sourceIdBySourceFile.get(sourceFile);
  if (sourceId === undefined || identity.sourceFileBySourceId.get(sourceId) !== sourceFile) return undefined;
  const constructorUnitId = exactUnitForDeclaration(identity, sourceId, declaration);
  if (constructorUnitId === undefined || declaration.parameters.length !== 1) return undefined;
  const parameter = declaration.parameters[0]!;
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.initializer !== undefined ||
    parameter.questionToken !== undefined ||
    parameter.dotDotDotToken !== undefined ||
    !declaration.body ||
    declaration.body.statements.length !== 1
  ) {
    return undefined;
  }
  const input = exactInputAssignment(declaration.body.statements[0]!, checker, parameter);
  if (!input) return undefined;

  let inputAssignments = 0;
  let foreignThisWrite = false;
  const visit = (node: ts.Node): void => {
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      if (node.left.name.text === "input") inputAssignments++;
      else foreignThisWrite = true;
    }
    forEachChild(node, visit);
  };
  visit(declaration.body);
  if (inputAssignments !== 1 || foreignThisWrite) return undefined;

  return Object.freeze({
    kind: "fnctor-input-constructor-syntax",
    sourceId,
    sourceFile,
    constructorUnitId,
    constructorDeclaration: declaration,
    parameterDeclaration: parameter,
    parameterIndex: 0,
    assignmentStatement: input.statement,
    inputAssignment: input.assignment,
    proof: Object.freeze({
      sameSource: true,
      exactDeclarationIdentity: true,
      oneRequiredParameter: true,
      fixedUnconditionalInput: true,
    }),
  });
}

function constructorDeclarationFor(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  sourceId: IrSourceId,
  identifier: ts.Identifier,
): IrFnctorConstructorDeclaration | undefined {
  const candidate = exactResolvedFunctionDeclaration(checker, identifier);
  if (!candidate || !symbolOwnsDeclaration(checker, identifier, candidate)) return undefined;
  return exactUnitForDeclaration(identity, sourceId, candidate) === undefined ? undefined : candidate;
}

function topLevelFunctionFor(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  identifier: ts.Identifier,
): ts.FunctionDeclaration | undefined {
  const declaration = exactResolvedFunctionDeclaration(checker, identifier);
  return declaration &&
    symbolOwnsDeclaration(checker, identifier, declaration) &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.body &&
    declaration.parent === sourceFile &&
    exactFunctionUnit(identity, sourceId, declaration) !== undefined
    ? declaration
    : undefined;
}

function enclosingTopLevelFunction(site: ts.Node, sourceFile: ts.SourceFile): ts.FunctionDeclaration | undefined {
  for (let current: ts.Node | undefined = site.parent; current && current !== sourceFile; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    return ts.isFunctionDeclaration(current) && current.parent === sourceFile && current.body ? current : undefined;
  }
  return undefined;
}

function collectTopLevelFunctions(
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  identity: IrPlanningIdentityContext,
): readonly ts.FunctionDeclaration[] | undefined {
  const functions: ts.FunctionDeclaration[] = [];
  for (const terminal of identity.inventory.terminalUnits) {
    if (terminal.sourceId !== sourceId || terminal.observedKind !== "function") continue;
    const declaration = identity.declarationByUnitId.get(terminal.id);
    if (!declaration) return undefined;
    if (!ts.isFunctionDeclaration(declaration) || declaration.parent !== sourceFile || !declaration.body) continue;
    if (exactFunctionUnit(identity, sourceId, declaration) !== terminal.id) return undefined;
    functions.push(declaration);
  }
  return functions;
}

interface SourceSyntaxPopulation {
  readonly allocations: readonly ts.NewExpression[];
  readonly calls: readonly ts.CallExpression[];
  readonly identifiers: readonly ts.Identifier[];
}

function collectSourceSyntax(functions: readonly ts.FunctionDeclaration[]): SourceSyntaxPopulation {
  const allocations: ts.NewExpression[] = [];
  const calls: ts.CallExpression[] = [];
  const identifiers: ts.Identifier[] = [];
  for (const declaration of functions) {
    const visit = (node: ts.Node): void => {
      if (node !== declaration.body && ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node)) allocations.push(node);
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isIdentifier(node)) identifiers.push(node);
      forEachChild(node, visit);
    };
    visit(declaration.body!);
  }
  return { allocations, calls, identifiers };
}

/** Exact complete active source population, including module init, nested bodies, and class members. */
function collectActiveSyntaxPopulation(identity: IrPlanningIdentityContext): SourceSyntaxPopulation | undefined {
  if (
    identity.inventory.sources.length !== identity.sourceFileBySourceId.size ||
    identity.inventory.sources.length !== identity.sourceIdBySourceFile.size
  ) {
    return undefined;
  }
  const allocations: ts.NewExpression[] = [];
  const calls: ts.CallExpression[] = [];
  const identifiers: ts.Identifier[] = [];
  for (const source of identity.inventory.sources) {
    const sourceFile = identity.sourceFileBySourceId.get(source.id);
    if (!sourceFile || identity.sourceIdBySourceFile.get(sourceFile) !== source.id) return undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) allocations.push(node);
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isIdentifier(node)) identifiers.push(node);
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { allocations, calls, identifiers };
}

function identifierDefinesTarget(identifier: ts.Identifier, target: IrFnctorConstructorDeclaration): boolean {
  if (target.name === identifier) return true;
  const parent = identifier.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.name === identifier &&
    parent.initializer !== undefined &&
    unwrapTransparentExpression(parent.initializer) === target
  );
}

function exactTargetUseCensusIsExact(
  checker: ts.TypeChecker,
  identifiers: readonly ts.Identifier[],
  target: IrFnctorConstructorDeclaration,
  certifiedUse: ts.Identifier,
): boolean {
  let uses = 0;
  for (const identifier of identifiers) {
    if (identifierDefinesTarget(identifier, target) || !symbolOwnsDeclaration(checker, identifier, target)) continue;
    uses++;
    if (identifier !== certifiedUse) return false;
  }
  return uses === 1;
}

function completePopulationCensusIsExact(
  checker: ts.TypeChecker,
  population: SourceSyntaxPopulation,
  projection: IrFnctorArgumentProjection,
): boolean {
  const constructorAllocations: ts.NewExpression[] = [];
  for (const site of population.allocations) {
    const resolution = expressionResolutionAgainstTarget(checker, site.expression, projection.constructorDeclaration);
    if (resolution === "uncertain") return false;
    if (resolution === "exact") constructorAllocations.push(site);
  }
  const calleeCalls: ts.CallExpression[] = [];
  for (const call of population.calls) {
    const resolution = expressionResolutionAgainstTarget(checker, call.expression, projection.calleeDeclaration);
    if (resolution === "uncertain") return false;
    if (resolution === "exact") calleeCalls.push(call);
  }
  if (
    !ts.isIdentifier(projection.constructorSite.expression) ||
    !ts.isIdentifier(projection.directCall.expression) ||
    !exactTargetUseCensusIsExact(
      checker,
      population.identifiers,
      projection.constructorDeclaration,
      projection.constructorSite.expression,
    ) ||
    !exactTargetUseCensusIsExact(
      checker,
      population.identifiers,
      projection.calleeDeclaration,
      projection.directCall.expression,
    )
  ) {
    return false;
  }
  return (
    constructorAllocations.length === 1 &&
    constructorAllocations[0] === projection.constructorSite &&
    calleeCalls.length === 1 &&
    calleeCalls[0] === projection.directCall
  );
}

function exactCallTargetResolver(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
): (identifier: ts.Identifier) => IrUnitId | undefined {
  return (identifier) => {
    const declaration = topLevelFunctionFor(checker, identity, sourceFile, sourceId, identifier);
    return declaration ? exactFunctionUnit(identity, sourceId, declaration) : undefined;
  };
}

function logicalArgumentType(
  argument: ts.Expression,
  caller: ts.FunctionDeclaration,
  callerUnitId: IrUnitId,
  unitTypeMap: IrUnitTypeMap,
  resolveCallTarget: (identifier: ts.Identifier) => IrUnitId | undefined,
): LatticeType | undefined {
  const callerEntry = unitTypeMap.get(callerUnitId);
  if (!callerEntry || callerEntry.params.length !== caller.parameters.length) return undefined;
  const scope = new Map<string, LatticeType>();
  for (let index = 0; index < caller.parameters.length; index++) {
    const parameter = caller.parameters[index]!;
    if (ts.isIdentifier(parameter.name)) scope.set(parameter.name.text, callerEntry.params[index]!);
  }
  const entries = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>(
    [...unitTypeMap].map(([unitId, entry]) => [unitId, { params: [...entry.params], returnType: entry.returnType }]),
  );
  return _propagationCore.inferExpr(argument, scope, entries, resolveCallTarget);
}

function directCallFor(site: ts.NewExpression): ts.CallExpression | undefined {
  const parent = site.parent;
  if (!ts.isCallExpression(parent) || parent.arguments.length !== 1 || parent.arguments[0] !== site) return undefined;
  if (
    parent.questionDotToken !== undefined ||
    (parent.typeArguments?.length ?? 0) !== 0 ||
    !ts.isIdentifier(parent.expression) ||
    parent.arguments.some((argument) => ts.isSpreadElement(argument))
  ) {
    return undefined;
  }
  return parent;
}

function requiredOnlyParameter(declaration: ts.FunctionDeclaration): ts.ParameterDeclaration | undefined {
  if (declaration.parameters.length !== 1) return undefined;
  const parameter = declaration.parameters[0]!;
  return ts.isIdentifier(parameter.name) &&
    parameter.initializer === undefined &&
    parameter.questionToken === undefined &&
    parameter.dotDotDotToken === undefined
    ? parameter
    : undefined;
}

function normalizeReservation(
  candidate: IrFnctorPhysicalReservationProof,
  site: ts.NewExpression,
  syntax: IrFnctorInputConstructorSyntaxProof,
): IrFnctorPhysicalReservationProof | undefined {
  if (
    candidate.kind !== "fnctor-physical-reservation" ||
    candidate.sourceId !== syntax.sourceId ||
    candidate.constructorUnitId !== syntax.constructorUnitId ||
    candidate.constructorDeclaration !== syntax.constructorDeclaration ||
    candidate.constructorSite !== site ||
    typeof candidate.reservationKey !== "string" ||
    candidate.reservationKey.length === 0 ||
    !Number.isSafeInteger(candidate.reservedTypeIdx) ||
    candidate.reservedTypeIdx < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: candidate.kind,
    sourceId: candidate.sourceId,
    constructorUnitId: candidate.constructorUnitId,
    constructorDeclaration: candidate.constructorDeclaration,
    constructorSite: candidate.constructorSite,
    reservationKey: candidate.reservationKey,
    reservedTypeIdx: candidate.reservedTypeIdx,
  });
}

export interface CollectIrFnctorArgumentProjectionsInput {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly identityContext: IrPlanningIdentityContext;
  readonly unitTypeMap: IrUnitTypeMap;
  readonly resolvePhysicalReservation: IrFnctorPhysicalReservationResolver;
}

/** Collect the single bounded edge from the complete source identity population, never from the claimed-owner set. */
export function collectIrFnctorArgumentProjections(
  input: CollectIrFnctorArgumentProjectionsInput,
): readonly IrFnctorArgumentProjection[] {
  const sourceId = input.identityContext.sourceIdBySourceFile.get(input.sourceFile);
  if (sourceId === undefined || input.identityContext.sourceFileBySourceId.get(sourceId) !== input.sourceFile) {
    return Object.freeze([]);
  }
  const functions = collectTopLevelFunctions(input.sourceFile, sourceId, input.identityContext);
  if (!functions) return Object.freeze([]);
  const syntaxPopulation = collectSourceSyntax(functions);
  const activePopulation = collectActiveSyntaxPopulation(input.identityContext);
  if (!activePopulation) return Object.freeze([]);
  const resolveCallTarget = exactCallTargetResolver(input.checker, input.identityContext, input.sourceFile, sourceId);
  const candidates: IrFnctorArgumentProjection[] = [];

  for (const site of syntaxPopulation.allocations) {
    if (
      !ts.isIdentifier(site.expression) ||
      (site.typeArguments?.length ?? 0) !== 0 ||
      (site.arguments?.length ?? 0) !== 1 ||
      site.arguments?.some((argument) => ts.isSpreadElement(argument))
    ) {
      continue;
    }
    const callerDeclaration = enclosingTopLevelFunction(site, input.sourceFile);
    const directCall = directCallFor(site);
    if (!callerDeclaration || !directCall || !ts.isIdentifier(directCall.expression)) continue;
    const callerUnitId = exactFunctionUnit(input.identityContext, sourceId, callerDeclaration);
    const constructorDeclaration = constructorDeclarationFor(
      input.checker,
      input.identityContext,
      sourceId,
      site.expression,
    );
    const calleeDeclaration = topLevelFunctionFor(
      input.checker,
      input.identityContext,
      input.sourceFile,
      sourceId,
      directCall.expression,
    );
    if (!callerUnitId || !constructorDeclaration || !calleeDeclaration) continue;
    const constructorSyntax = proveIrFnctorInputConstructorSyntax(
      input.checker,
      input.identityContext,
      constructorDeclaration,
    );
    const calleeUnitId = exactFunctionUnit(input.identityContext, sourceId, calleeDeclaration);
    const calleeParameter = requiredOnlyParameter(calleeDeclaration);
    const constructorTerminal = constructorSyntax
      ? input.identityContext.terminalByUnitId.get(constructorSyntax.constructorUnitId)
      : undefined;
    if (
      !constructorSyntax ||
      constructorTerminal?.observedKind !== "function" ||
      constructorTerminal.terminalOwnerId !== constructorSyntax.constructorUnitId ||
      !calleeUnitId ||
      !calleeParameter
    ) {
      continue;
    }
    if (
      callerUnitId === calleeUnitId ||
      callerUnitId === constructorSyntax.constructorUnitId ||
      calleeUnitId === constructorSyntax.constructorUnitId
    ) {
      continue;
    }
    const allocationArgument = site.arguments![0]!;
    if (
      logicalArgumentType(allocationArgument, callerDeclaration, callerUnitId, input.unitTypeMap, resolveCallTarget)
        ?.kind !== "string"
    ) {
      continue;
    }
    const reservationCandidate = input.resolvePhysicalReservation(site, constructorSyntax);
    const physicalReservation = reservationCandidate
      ? normalizeReservation(reservationCandidate, site, constructorSyntax)
      : undefined;
    if (!physicalReservation) continue;

    candidates.push(
      Object.freeze({
        kind: "fnctor-argument-projection",
        sourceId,
        sourceFile: input.sourceFile,
        callerUnitId,
        callerDeclaration,
        directCall,
        calleeUnitId,
        calleeDeclaration,
        calleeParameterDeclaration: calleeParameter,
        calleeParameterIndex: 0,
        constructorUnitId: constructorSyntax.constructorUnitId,
        constructorDeclaration,
        constructorParameterDeclaration: constructorSyntax.parameterDeclaration,
        constructorParameterIndex: 0,
        constructorSite: site,
        allocationArgument,
        constructorSyntax,
        physicalReservation,
        logicalShape: Object.freeze({ fieldName: "input", fieldType: "string" }),
        proof: Object.freeze({
          sameSource: true,
          exactIdentityJoins: true,
          logicalStringArgument: true,
          directConstructor: true,
          directCallArgument: true,
          uniqueAllocation: true,
          uniqueCallEdge: true,
          noAlias: true,
          noAssignment: true,
          noCapture: true,
          noReturn: true,
          noPropertyWrite: true,
          noSecondUse: true,
        }),
      }),
    );
  }

  if (candidates.length !== 1) return Object.freeze([]);
  const projection = candidates[0]!;
  if (!completePopulationCensusIsExact(input.checker, activePopulation, projection)) return Object.freeze([]);
  return Object.freeze([projection]);
}

function exactProofObject(proof: IrFnctorArgumentProjection["proof"]): boolean {
  const keys = Object.keys(proof).sort();
  if (keys.length !== ARGUMENT_PROOF_KEYS.length) return false;
  if (keys.some((key, index) => key !== SORTED_ARGUMENT_PROOF_KEYS[index])) return false;
  if (Object.prototype.hasOwnProperty.call(proof, "noEscape")) return false;
  return ARGUMENT_PROOF_KEYS.every((key) => proof[key] === true);
}

function exactConstructorProofObject(proof: IrFnctorInputConstructorSyntaxProof["proof"]): boolean {
  const keys = Object.keys(proof).sort();
  return (
    keys.length === CONSTRUCTOR_PROOF_KEYS.length &&
    keys.every((key, index) => key === SORTED_CONSTRUCTOR_PROOF_KEYS[index]) &&
    CONSTRUCTOR_PROOF_KEYS.every((key) => proof[key] === true)
  );
}

function exactConstructorSyntaxRecord(
  syntax: IrFnctorInputConstructorSyntaxProof,
  projection: IrFnctorArgumentProjection,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  checker: ts.TypeChecker,
): boolean {
  const declaration = projection.constructorDeclaration;
  const statement = declaration.body?.statements[0];
  const assignment = syntax.inputAssignment;
  return (
    syntax.kind === "fnctor-input-constructor-syntax" &&
    syntax.sourceId === sourceId &&
    syntax.sourceFile === sourceFile &&
    syntax.constructorUnitId === projection.constructorUnitId &&
    syntax.constructorDeclaration === declaration &&
    declaration.parameters.length === 1 &&
    declaration.parameters[0] === syntax.parameterDeclaration &&
    syntax.parameterDeclaration === projection.constructorParameterDeclaration &&
    syntax.parameterIndex === 0 &&
    syntax.parameterDeclaration.initializer === undefined &&
    syntax.parameterDeclaration.questionToken === undefined &&
    syntax.parameterDeclaration.dotDotDotToken === undefined &&
    declaration.body?.statements.length === 1 &&
    statement === syntax.assignmentStatement &&
    syntax.assignmentStatement.parent === declaration.body &&
    syntax.assignmentStatement.expression === assignment &&
    assignment.parent === syntax.assignmentStatement &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(assignment.left) &&
    assignment.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    assignment.left.name.text === "input" &&
    ts.isIdentifier(assignment.right) &&
    symbolOwnsDeclaration(checker, assignment.right, syntax.parameterDeclaration) &&
    exactConstructorProofObject(syntax.proof)
  );
}

function projectionIsExact(
  projection: IrFnctorArgumentProjection,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  identity: IrPlanningIdentityContext,
  authority: IrFnctorArgumentProjectionAuthority,
): boolean {
  const { checker } = authority;
  const callerUnitId = exactFunctionUnit(identity, sourceId, projection.callerDeclaration);
  const calleeUnitId = exactFunctionUnit(identity, sourceId, projection.calleeDeclaration);
  const constructorUnitId = exactUnitForDeclaration(identity, sourceId, projection.constructorDeclaration);
  const call = projection.directCall;
  const site = projection.constructorSite;
  const syntax = projection.constructorSyntax;
  const reservation = projection.physicalReservation;
  const currentSyntax = proveIrFnctorInputConstructorSyntax(checker, identity, projection.constructorDeclaration);
  const currentReservationCandidate = currentSyntax
    ? authority.resolvePhysicalReservation(site, currentSyntax)
    : undefined;
  const currentReservation =
    currentSyntax && currentReservationCandidate
      ? normalizeReservation(currentReservationCandidate, site, currentSyntax)
      : undefined;
  return (
    projection.kind === "fnctor-argument-projection" &&
    projection.sourceId === sourceId &&
    projection.sourceFile === sourceFile &&
    callerUnitId === projection.callerUnitId &&
    calleeUnitId === projection.calleeUnitId &&
    constructorUnitId === projection.constructorUnitId &&
    projection.callerUnitId !== projection.calleeUnitId &&
    projection.callerUnitId !== projection.constructorUnitId &&
    projection.calleeUnitId !== projection.constructorUnitId &&
    enclosingTopLevelFunction(site, sourceFile) === projection.callerDeclaration &&
    enclosingTopLevelFunction(call, sourceFile) === projection.callerDeclaration &&
    site.parent === call &&
    call.getSourceFile() === sourceFile &&
    call.arguments.length === 1 &&
    call.arguments[0] === site &&
    call.questionDotToken === undefined &&
    (call.typeArguments?.length ?? 0) === 0 &&
    ts.isIdentifier(call.expression) &&
    exactResolvedFunctionDeclaration(checker, call.expression) === projection.calleeDeclaration &&
    symbolOwnsDeclaration(checker, call.expression, projection.calleeDeclaration) &&
    site.getSourceFile() === sourceFile &&
    ts.isIdentifier(site.expression) &&
    exactResolvedFunctionDeclaration(checker, site.expression) === projection.constructorDeclaration &&
    symbolOwnsDeclaration(checker, site.expression, projection.constructorDeclaration) &&
    (site.typeArguments?.length ?? 0) === 0 &&
    site.arguments?.length === 1 &&
    site.arguments[0] === projection.allocationArgument &&
    projection.allocationArgument.parent === site &&
    !ts.isSpreadElement(projection.allocationArgument) &&
    projection.calleeDeclaration.parameters.length === 1 &&
    projection.calleeDeclaration.parameters[0] === projection.calleeParameterDeclaration &&
    projection.calleeParameterDeclaration.parent === projection.calleeDeclaration &&
    projection.calleeParameterIndex === 0 &&
    projection.constructorDeclaration.parameters.length === 1 &&
    projection.constructorDeclaration.parameters[0] === projection.constructorParameterDeclaration &&
    projection.constructorParameterDeclaration.parent === projection.constructorDeclaration &&
    projection.constructorParameterIndex === 0 &&
    exactConstructorSyntaxRecord(syntax, projection, sourceFile, sourceId, checker) &&
    currentSyntax?.constructorDeclaration === syntax.constructorDeclaration &&
    currentSyntax.parameterDeclaration === syntax.parameterDeclaration &&
    currentSyntax.assignmentStatement === syntax.assignmentStatement &&
    currentSyntax.inputAssignment === syntax.inputAssignment &&
    reservation.kind === "fnctor-physical-reservation" &&
    reservation.sourceId === sourceId &&
    reservation.constructorUnitId === projection.constructorUnitId &&
    reservation.constructorDeclaration === projection.constructorDeclaration &&
    reservation.constructorSite === site &&
    reservation.reservationKey === `__fnctor_${site.expression.text}` &&
    Number.isSafeInteger(reservation.reservedTypeIdx) &&
    reservation.reservedTypeIdx >= 0 &&
    currentReservation?.sourceId === reservation.sourceId &&
    currentReservation.constructorUnitId === reservation.constructorUnitId &&
    currentReservation.constructorDeclaration === reservation.constructorDeclaration &&
    currentReservation.constructorSite === reservation.constructorSite &&
    currentReservation.reservationKey === reservation.reservationKey &&
    currentReservation.reservedTypeIdx === reservation.reservedTypeIdx &&
    projection.logicalShape.fieldName === "input" &&
    projection.logicalShape.fieldType === "string" &&
    exactProofObject(projection.proof) &&
    ((): boolean => {
      const population = collectActiveSyntaxPopulation(identity);
      return population !== undefined && completePopulationCensusIsExact(checker, population, projection);
    })()
  );
}

function canonicalizeIrFnctorArgumentProjection(projection: IrFnctorArgumentProjection): IrFnctorArgumentProjection {
  const constructorSyntax: IrFnctorInputConstructorSyntaxProof = Object.freeze({
    kind: "fnctor-input-constructor-syntax",
    sourceId: projection.constructorSyntax.sourceId,
    sourceFile: projection.constructorSyntax.sourceFile,
    constructorUnitId: projection.constructorSyntax.constructorUnitId,
    constructorDeclaration: projection.constructorSyntax.constructorDeclaration,
    parameterDeclaration: projection.constructorSyntax.parameterDeclaration,
    parameterIndex: 0,
    assignmentStatement: projection.constructorSyntax.assignmentStatement,
    inputAssignment: projection.constructorSyntax.inputAssignment,
    proof: Object.freeze({
      sameSource: true,
      exactDeclarationIdentity: true,
      oneRequiredParameter: true,
      fixedUnconditionalInput: true,
    }),
  });
  const physicalReservation: IrFnctorPhysicalReservationProof = Object.freeze({
    kind: "fnctor-physical-reservation",
    sourceId: projection.physicalReservation.sourceId,
    constructorUnitId: projection.physicalReservation.constructorUnitId,
    constructorDeclaration: projection.physicalReservation.constructorDeclaration,
    constructorSite: projection.physicalReservation.constructorSite,
    reservationKey: projection.physicalReservation.reservationKey,
    reservedTypeIdx: projection.physicalReservation.reservedTypeIdx,
  });
  return Object.freeze({
    kind: "fnctor-argument-projection",
    sourceId: projection.sourceId,
    sourceFile: projection.sourceFile,
    callerUnitId: projection.callerUnitId,
    callerDeclaration: projection.callerDeclaration,
    directCall: projection.directCall,
    calleeUnitId: projection.calleeUnitId,
    calleeDeclaration: projection.calleeDeclaration,
    calleeParameterDeclaration: projection.calleeParameterDeclaration,
    calleeParameterIndex: 0,
    constructorUnitId: projection.constructorUnitId,
    constructorDeclaration: projection.constructorDeclaration,
    constructorParameterDeclaration: projection.constructorParameterDeclaration,
    constructorParameterIndex: 0,
    constructorSite: projection.constructorSite,
    allocationArgument: projection.allocationArgument,
    constructorSyntax,
    physicalReservation,
    logicalShape: Object.freeze({ fieldName: "input", fieldType: "string" }),
    proof: Object.freeze({
      sameSource: true,
      exactIdentityJoins: true,
      logicalStringArgument: true,
      directConstructor: true,
      directCallArgument: true,
      uniqueAllocation: true,
      uniqueCallEdge: true,
      noAlias: true,
      noAssignment: true,
      noCapture: true,
      noReturn: true,
      noPropertyWrite: true,
      noSecondUse: true,
    }),
  });
}

/** Revalidate precomputed evidence at the structural identity seam and return one canonical frozen row. */
export function retainIrFnctorArgumentProjections(
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  identity: IrPlanningIdentityContext,
  authority: IrFnctorArgumentProjectionAuthority | undefined,
  candidates: readonly IrFnctorArgumentProjection[] | undefined,
): readonly IrFnctorArgumentProjection[] | undefined {
  if (!authority || !candidates || candidates.length !== 1) return undefined;
  const valid = candidates.filter((candidate) =>
    projectionIsExact(candidate, sourceFile, sourceId, identity, authority),
  );
  if (valid.length !== 1) return undefined;
  return Object.freeze([canonicalizeIrFnctorArgumentProjection(valid[0]!)]);
}
