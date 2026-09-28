// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import { IrPlanningIdentityInvariantError, type IrPlanningIdentityContext } from "./planning-identity.js";

export interface PropagationFunction {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly declaration: ts.FunctionDeclaration;
}

export type CallTargetResolver = (identifier: ts.Identifier) => IrUnitId | undefined;

export function collectIndexedFunctionDeclarations(
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): readonly PropagationFunction[] {
  const selectedSources = new Set<ts.SourceFile>();
  for (const sourceFile of sourceFiles) {
    if (!identityContext.sourceIdBySourceFile.has(sourceFile)) {
      throw new IrPlanningIdentityInvariantError(
        "source-record-mismatch",
        `IR propagation source ${sourceFile.fileName} is not part of the supplied planning identity context`,
      );
    }
    selectedSources.add(sourceFile);
  }

  const functions: PropagationFunction[] = [];
  for (const unit of identityContext.inventory.allUnits) {
    const declaration = identityContext.declarationByUnitId.get(unit.id);
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.name ||
      !declaration.body ||
      !ts.isSourceFile(declaration.parent) ||
      !selectedSources.has(declaration.parent)
    ) {
      continue;
    }
    functions.push({ unitId: unit.id, displayName: declaration.name.text, declaration });
  }
  return functions;
}

/** A callable declaration's body summary cannot describe a reassigned binding. */
export function collectReassignedCallables(
  sources: readonly ts.SourceFile[],
  resolve: CallTargetResolver,
): ReadonlySet<IrUnitId> {
  const reassigned = new Set<IrUnitId>();
  const record = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const unitId = resolve(node);
      if (unitId) reassigned.add(unitId);
    } else if (ts.isVariableDeclarationList(node)) {
      for (const declaration of node.declarations) record(declaration.name);
    } else if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) if (ts.isBindingElement(element)) record(element.name);
    } else if (ts.isParenthesizedExpression(node)) record(node.expression);
    else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) record(element);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) record(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) record(property.name);
        else if (ts.isSpreadAssignment(property)) record(property.expression);
      }
    } else if (ts.isSpreadElement(node)) record(node.expression);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) record(node.left);
    // Property keys, default-value expressions and property receivers are
    // reads, not writes to their identifier bindings.
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) record(node.name);
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      record(node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      record(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      record(node.operand);
    forEachChild(node, visit);
  };
  for (const source of sources) visit(source);
  return reassigned;
}

/** Precision only for stable straight-line aliases and an explicit final return.
 * The ordinary return walker ignores writes and bare/fallthrough returns; it is
 * not evidence for retaining this marker across those unsupported flows.
 */
export function hasStableGeneratorReturnFlow(fn: ts.FunctionDeclaration): boolean {
  // An ordinary async function wraps its return in Promise, even when its
  // body returns a synchronous generator object without awaiting anything.
  if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const statements = fn.body?.statements;
  if (!statements?.length) return false;
  const last = statements[statements.length - 1]!;
  if (!ts.isReturnStatement(last) || !last.expression) return false;
  const locals = new Set<string>();
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name)) return false;
    locals.add(parameter.name.text);
  }
  for (const statement of statements.slice(0, -1)) {
    if (!ts.isVariableStatement(statement)) return false;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || locals.has(declaration.name.text))
        return false;
      locals.add(declaration.name.text);
    }
  }
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      safe = false;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      safe = false;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      safe = false;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && locals.has(node.expression.text)) safe = false;
    forEachChild(node, visit);
  };
  for (const statement of statements) visit(statement);
  return safe;
}

export function makeCallTargetResolver(
  functions: readonly PropagationFunction[],
  checker: ts.TypeChecker | undefined,
  identityContext: IrPlanningIdentityContext,
): CallTargetResolver {
  const eligible = new Set(functions.map((info) => info.unitId));
  if (!checker) {
    const byDisplayName = new Map<string, IrUnitId[]>();
    for (const info of functions) {
      const matches = byDisplayName.get(info.displayName);
      if (matches) matches.push(info.unitId);
      else byDisplayName.set(info.displayName, [info.unitId]);
    }
    return (identifier) => {
      const matches = byDisplayName.get(identifier.text);
      return matches?.length === 1 ? matches[0] : undefined;
    };
  }

  const symbolCache = new Map<ts.Symbol, IrUnitId | null>();
  const identifierCache = new Map<ts.Identifier, IrUnitId | null>();
  const resolveSymbol = (input: ts.Symbol): IrUnitId | undefined => {
    if (symbolCache.has(input)) return symbolCache.get(input) ?? undefined;
    let symbol = input;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        symbolCache.set(input, null);
        return undefined;
      }
    }
    if (symbolCache.has(symbol)) {
      const resolved = symbolCache.get(symbol) ?? null;
      symbolCache.set(input, resolved);
      return resolved ?? undefined;
    }

    let match: IrUnitId | undefined;
    let ambiguous = false;
    const consider = (declaration: ts.Declaration | undefined): void => {
      if (!declaration) return;
      const unitId = identityContext.unitIdByDeclaration.get(declaration);
      if (!unitId || !eligible.has(unitId)) return;
      if (match !== undefined && match !== unitId) ambiguous = true;
      else match = unitId;
    };
    for (const declaration of symbol.declarations ?? []) consider(declaration);
    consider(symbol.valueDeclaration);
    const resolved = ambiguous ? null : (match ?? null);
    symbolCache.set(symbol, resolved);
    symbolCache.set(input, resolved);
    return resolved ?? undefined;
  };

  return (identifier) => {
    if (identifierCache.has(identifier)) return identifierCache.get(identifier) ?? undefined;
    let binding: ts.Node = identifier;
    while (
      ts.isBindingElement(binding.parent) ||
      ts.isArrayBindingPattern(binding.parent) ||
      ts.isObjectBindingPattern(binding.parent)
    ) {
      binding = binding.parent;
    }
    const declaration =
      ts.isVariableDeclaration(binding.parent) && binding.parent.name === binding ? binding.parent : undefined;
    const isVarBinding =
      declaration &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0;
    // For a script's function/var redeclaration, the checker can attach a
    // separate symbol to the declaration name. Resolve the actual value binding
    // in that exact lexical scope, as a reference to it would be resolved.
    const symbol = isVarBinding
      ? checker.resolveName(identifier.text, identifier, ts.SymbolFlags.Value, false)
      : ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
        ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : checker.getSymbolAtLocation(identifier);
    const resolved = symbol ? (resolveSymbol(symbol) ?? null) : null;
    identifierCache.set(identifier, resolved);
    return resolved ?? undefined;
  };
}
