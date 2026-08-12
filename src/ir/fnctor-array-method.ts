// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "./identity.js";

/** Exact stable module carrier whose user constructor inherits an Array HOF. */
export interface IrFnctorArrayMethodPlan {
  readonly receiverDeclaration: ts.VariableDeclaration;
  readonly receiverName: string;
  readonly constructorDeclaration: ts.FunctionDeclaration;
  readonly constructorName: string;
  readonly methodName: "filter";
  readonly arity: 1;
  readonly receiverGlobalBindingId?: IrBindingId;
  readonly receiverStorageOwnerUnitId?: IrUnitId;
  readonly receiverSourceId?: IrSourceId;
  readonly receiverDeclarationOrdinal?: number;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function exactTopLevelVariableDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const declarations = new Set(
    [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
      (candidate): candidate is ts.VariableDeclaration =>
        candidate !== undefined &&
        ts.isVariableDeclaration(candidate) &&
        candidate.getSourceFile() === sourceFile &&
        ts.isIdentifier(candidate.name) &&
        ts.isVariableDeclarationList(candidate.parent) &&
        ts.isVariableStatement(candidate.parent.parent) &&
        candidate.parent.parent.parent === sourceFile,
    ),
  );
  return declarations.size === 1 ? [...declarations][0] : undefined;
}

function exactTopLevelFunctionDeclaration(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): ts.FunctionDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const sourceFile = node.getSourceFile();
  const declarations = new Set(
    [symbol.valueDeclaration, ...(symbol.declarations ?? [])].filter(
      (candidate): candidate is ts.FunctionDeclaration =>
        candidate !== undefined &&
        ts.isFunctionDeclaration(candidate) &&
        candidate.getSourceFile() === sourceFile &&
        candidate.parent === sourceFile &&
        candidate.name !== undefined,
    ),
  );
  if (declarations.size !== 1) return undefined;
  const declaration = [...declarations][0]!;
  return checker.getSymbolAtLocation(declaration.name!) === symbol ? declaration : undefined;
}

function identifierIsWritten(node: ts.Identifier): boolean {
  let target: ts.Node = node;
  let parent = target.parent;
  while (
    (ts.isParenthesizedExpression(parent) && parent.expression === target) ||
    (ts.isArrayLiteralExpression(parent) && parent.elements.includes(target as ts.Expression)) ||
    (ts.isObjectLiteralExpression(parent) && parent.properties.includes(target as ts.ObjectLiteralElementLike)) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === target) ||
    (ts.isSpreadElement(parent) && parent.expression === target) ||
    (ts.isSpreadAssignment(parent) && parent.expression === target)
  ) {
    target = parent;
    parent = target.parent;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === target;
}

function sourceBindingIsStable(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (stable && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol && identifierIsWritten(node)) {
      stable = false;
      return;
    }
    if (stable) node.forEachChild(visit);
  };
  declaration.getSourceFile().forEachChild(visit);
  return stable;
}

function sourceModuleExportsSymbol(sourceFile: ts.SourceFile, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return true;
  try {
    return checker.getExportsOfModule(moduleSymbol).some((exported) => {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      return target === symbol;
    });
  } catch {
    return true;
  }
}

function argumentIsBridgeable(checker: ts.TypeChecker, argument: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(unwrapExpression(argument));
  return (
    (type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.Object |
        ts.TypeFlags.NonPrimitive)) !==
    0
  );
}

/** Build the selector-safe #4387 source plan; ambiguity always declines. */
export function makeFnctorArrayMethodPlan(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  stablePrototypeNames: ReadonlySet<string> | undefined,
): IrFnctorArrayMethodPlan | undefined {
  if (
    !stablePrototypeNames ||
    call.questionDotToken ||
    call.typeArguments?.length ||
    call.arguments.length !== 1 ||
    call.arguments.some(ts.isSpreadElement) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.name.text !== "filter" ||
    !argumentIsBridgeable(checker, call.arguments[0]!)
  ) {
    return undefined;
  }

  const receiver = call.expression.expression;
  const receiverDeclaration = exactTopLevelVariableDeclaration(receiver, checker);
  const initializer = receiverDeclaration?.initializer ? unwrapExpression(receiverDeclaration.initializer) : undefined;
  if (
    !receiverDeclaration ||
    !initializer ||
    !ts.isNewExpression(initializer) ||
    initializer.arguments?.length !== 0 ||
    !ts.isIdentifier(initializer.expression) ||
    !ts.isVariableDeclarationList(receiverDeclaration.parent) ||
    (receiverDeclaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 ||
    !sourceBindingIsStable(checker, receiverDeclaration)
  ) {
    return undefined;
  }

  const receiverSymbol = checker.getSymbolAtLocation(receiver);
  const declarationSymbol = checker.getSymbolAtLocation(receiverDeclaration.name);
  const constructorDeclaration = exactTopLevelFunctionDeclaration(initializer.expression, checker);
  const constructorSymbol = constructorDeclaration?.name
    ? checker.getSymbolAtLocation(constructorDeclaration.name)
    : undefined;
  const sourceFile = receiverDeclaration.getSourceFile();
  if (
    !receiverSymbol ||
    receiverSymbol !== declarationSymbol ||
    !constructorDeclaration?.name ||
    !constructorSymbol ||
    checker.getSymbolAtLocation(initializer.expression) !== constructorSymbol ||
    constructorDeclaration.getSourceFile() !== sourceFile ||
    !ts.isExternalModule(sourceFile) ||
    sourceModuleExportsSymbol(sourceFile, receiverSymbol, checker) ||
    sourceModuleExportsSymbol(sourceFile, constructorSymbol, checker) ||
    !stablePrototypeNames.has(constructorDeclaration.name.text)
  ) {
    return undefined;
  }

  return {
    receiverDeclaration,
    receiverName: receiver.text,
    constructorDeclaration,
    constructorName: constructorDeclaration.name.text,
    methodName: "filter",
    arity: 1,
  };
}
