// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { readonlyErasureMappedAliasTarget } from "./readonly-erasure-mapped-type.js";

interface GenericStructFactoryDeclaration {
  declaration: ts.FunctionDeclaration;
  /** Present for the `T extends Struct` factory form used by wrapper chains. */
  resultTypeParameter?: ts.Type;
  sourceConstraint: ts.Type;
  /** The declaration ABI must carry sourceConstraint, not its first instantiated T. */
  sourceResultAbi?: true;
}

export interface GenericStructFactoryCall {
  declaration: ts.FunctionDeclaration;
  /** Physical struct carried by the generic function before call-site refinement. */
  sourceConstraint: ts.Type;
  /** Concrete call result, or its enclosing generic's structural constraint. */
  target: ts.Type;
}

export interface StructFactoryExpression {
  /** Physical struct produced before an asserted fresh-result refinement. */
  sourceConstraint: ts.Type;
  /** Structural destination that must be materialized around that source. */
  target: ts.Type;
}

type FactoryMemoEntry = GenericStructFactoryDeclaration | null | "visiting";

const factoryMemo = new WeakMap<CodegenContext, WeakMap<ts.FunctionDeclaration, FactoryMemoEntry>>();
const identityReturnParamMemo = new WeakMap<CodegenContext, WeakMap<ts.FunctionDeclaration, number | null>>();
const bindingStabilityMemo = new WeakMap<CodegenContext, WeakMap<ts.Symbol, boolean>>();

function eraseReadonlyView(type: ts.Type): ts.Type {
  return readonlyErasureMappedAliasTarget(type) ?? type;
}

function sameTypeParameter(left: ts.Type, right: ts.Type): boolean {
  if (left === right) return true;
  return (
    (left.flags & ts.TypeFlags.TypeParameter) !== 0 &&
    (right.flags & ts.TypeFlags.TypeParameter) !== 0 &&
    left.symbol !== undefined &&
    left.symbol === right.symbol
  );
}

function ownedTypeParameter(ctx: CodegenContext, declaration: ts.FunctionDeclaration, type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.TypeParameter)) return false;
  return (
    declaration.typeParameters?.some((parameter) => {
      const parameterType = ctx.checker.getTypeAtLocation(parameter.name);
      return sameTypeParameter(parameterType, type);
    }) === true
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function canonicalSymbol(ctx: CodegenContext, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return ctx.checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function symbolAt(ctx: CodegenContext, node: ts.Node): ts.Symbol | undefined {
  return canonicalSymbol(ctx, ctx.checker.getSymbolAtLocation(node));
}

function callableSourceFiles(ctx: CodegenContext, fallback: ts.SourceFile): readonly ts.SourceFile[] {
  return ctx.callableSourceFiles ?? [fallback];
}

function declarationHasGlobalScriptReach(declaration: ts.Declaration): boolean {
  let current: ts.Node | undefined = declaration.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isModuleBlock(current)) return false;
    current = current.parent;
  }
  return !!current && !ts.isExternalModule(current);
}

function symbolSourceFiles(ctx: CodegenContext, symbol: ts.Symbol, fallback: ts.SourceFile): readonly ts.SourceFile[] {
  const files = new Set<ts.SourceFile>([fallback]);
  for (const declaration of symbol.declarations ?? []) files.add(declaration.getSourceFile());
  if (symbol.declarations?.some(declarationHasGlobalScriptReach)) {
    for (const sourceFile of callableSourceFiles(ctx, fallback)) files.add(sourceFile);
  }
  return [...files];
}

function runtimeBindingDeclaration(declaration: ts.Declaration | undefined): ts.Declaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (
    current &&
    (ts.isBindingElement(current) ||
      ts.isIdentifier(current) ||
      ts.isObjectBindingPattern(current) ||
      ts.isArrayBindingPattern(current))
  ) {
    current = current.parent;
  }
  return current as ts.Declaration | undefined;
}

function bindingOwner(declaration: ts.Declaration): ts.Node {
  for (let current: ts.Node | undefined = declaration.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isModuleBlock(current) || ts.isSourceFile(current)) return current;
  }
  return declaration.getSourceFile();
}

function hasDynamicBindingHazard(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isWithStatement(current)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapExpression(current.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function writeTargetContainsSymbol(ctx: CodegenContext, node: ts.Node, symbol: ts.Symbol): boolean {
  if (ts.isIdentifier(node)) return symbolAt(ctx, node) === symbol;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return false;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return writeTargetContainsSymbol(ctx, node.expression, symbol);
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && writeTargetContainsSymbol(ctx, child, symbol)) found = true;
  });
  return found;
}

/** Check the source, including illegal writes to `const` accepted under skipped diagnostics. */
function bindingIsStable(ctx: CodegenContext, name: ts.Identifier): boolean {
  const symbol = symbolAt(ctx, name);
  if (!symbol) return false;
  let memo = bindingStabilityMemo.get(ctx);
  if (!memo) {
    memo = new WeakMap();
    bindingStabilityMemo.set(ctx, memo);
  }
  const cached = memo.get(symbol);
  if (cached !== undefined) return cached;

  const bodyDeclaration = symbol.declarations?.find(
    (declaration): declaration is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(declaration) && declaration.body !== undefined,
  );
  const primary = runtimeBindingDeclaration(bodyDeclaration ?? symbol.valueDeclaration ?? symbol.declarations?.[0]);
  if (!primary || hasDynamicBindingHazard(bindingOwner(primary))) {
    memo.set(symbol, false);
    return false;
  }
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (ts.isVariableDeclaration(node) && node !== primary && writeTargetContainsSymbol(ctx, node.name, symbol)) {
      reassigned = true;
      return;
    }
    if (ts.isParameter(node) && node !== primary && writeTargetContainsSymbol(ctx, node.name, symbol)) {
      reassigned = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      node !== primary &&
      symbolAt(ctx, node.name) === symbol &&
      (!ts.isFunctionDeclaration(node) || node.body !== undefined)
    ) {
      reassigned = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      writeTargetContainsSymbol(ctx, node.left, symbol)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      writeTargetContainsSymbol(ctx, node.operand, symbol)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      (ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.some((declaration) => writeTargetContainsSymbol(ctx, declaration.name, symbol))
        : writeTargetContainsSymbol(ctx, node.initializer, symbol))
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of symbolSourceFiles(ctx, symbol, name.getSourceFile())) visit(sourceFile);
  const stable = !reassigned;
  memo.set(symbol, stable);
  return stable;
}

function functionDeclarationForCall(
  ctx: CodegenContext,
  call: ts.CallExpression,
  genericOnly = false,
): ts.FunctionDeclaration | undefined {
  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  let declaration: ts.FunctionDeclaration | undefined;
  const resolvedDeclaration = ctx.checker.getResolvedSignature(call)?.getDeclaration();
  if (resolvedDeclaration && ts.isFunctionDeclaration(resolvedDeclaration)) {
    declaration = resolvedDeclaration.body
      ? resolvedDeclaration
      : symbolAt(ctx, resolvedDeclaration.name!)
          ?.getDeclarations()
          ?.find(
            (candidate): candidate is ts.FunctionDeclaration =>
              ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
          );
  }
  // Prefer the checker symbol at this exact call site. Program-ABI replay can
  // compile nested same-named factories from different source components; the
  // lightweight binder's value declaration may then point at a sibling replay
  // declaration even though the checker still retains the source-qualified
  // identity (`baseNodeFactory.createBaseNode` vs nodeFactory's generic helper).
  declaration ??= canonicalSymbol(ctx, ctx.checker.getSymbolAtLocation(callee))
    ?.getDeclarations()
    ?.find((candidate): candidate is ts.FunctionDeclaration => ts.isFunctionDeclaration(candidate) && !!candidate.body);
  const oracleDeclaration = declaration ? undefined : ctx.oracle.valueDeclarationOf(callee);
  if (!declaration && oracleDeclaration && ts.isFunctionDeclaration(oracleDeclaration)) declaration = oracleDeclaration;
  // The generic factory/identity detectors call this helper for every
  // identifier call in a bundle. Resolve the declaration first, then reject
  // the overwhelmingly common non-generic body before bindingIsStable's
  // whole-program write scan. Non-generic identity helpers opt out below.
  if (!declaration || (genericOnly && !declaration.typeParameters?.length)) return undefined;
  return bindingIsStable(ctx, callee) ? declaration : undefined;
}

function directVariableBySymbol(
  ctx: CodegenContext,
  body: ts.Block,
  symbol: ts.Symbol,
): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        symbolAt(ctx, declaration.name) !== symbol
      ) {
        continue;
      }
      if (found) return undefined;
      found = declaration;
    }
  }
  return found;
}

function outerReturns(body: ts.Block): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node)) {
      returns.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns;
}

function propertyValueImplementation(
  ctx: CodegenContext,
  property: ts.ObjectLiteralElementLike,
  owner: ts.FunctionDeclaration,
): ts.FunctionDeclaration | undefined {
  let symbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(property)) {
    symbol = canonicalSymbol(
      ctx,
      (
        ctx.checker as typeof ctx.checker & {
          getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
        }
      ).getShorthandAssignmentValueSymbol?.(property) ?? ctx.checker.getSymbolAtLocation(property.name),
    );
  } else if (ts.isPropertyAssignment(property)) {
    const value = unwrapExpression(property.initializer);
    if (ts.isIdentifier(value)) symbol = symbolAt(ctx, value);
  }
  const implementation = symbol
    ?.getDeclarations()
    ?.find(
      (candidate): candidate is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
    );
  if (!implementation || implementation.parent !== owner.body || !implementation.name) return undefined;
  return bindingIsStable(ctx, implementation.name) ? implementation : undefined;
}

/** One unshadowed static property, with no spread/computed overwrite channel. */
function exactStaticObjectProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.ObjectLiteralElementLike | undefined {
  let selected: ts.ObjectLiteralElementLike | undefined;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return undefined;
    const propertyName = staticPropertyName(property.name);
    if (propertyName === undefined) return undefined;
    if (propertyName !== key) continue;
    if (selected !== undefined) return undefined;
    selected = property;
  }
  return selected;
}

function directPropertyWrite(ctx: CodegenContext, target: ts.Expression, receiver: ts.Symbol, key: string): boolean {
  const current = unwrapExpression(target);
  if (ts.isPropertyAccessExpression(current)) {
    const base = unwrapExpression(current.expression);
    return ts.isIdentifier(base) && symbolAt(ctx, base) === receiver && current.name.text === key;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const base = unwrapExpression(current.expression);
    const property = unwrapExpression(current.argumentExpression);
    return (
      ts.isIdentifier(base) &&
      symbolAt(ctx, base) === receiver &&
      (ts.isStringLiteral(property) || ts.isNumericLiteral(property)) &&
      property.text === key
    );
  }
  return false;
}

function propertyIsNeverWritten(ctx: CodegenContext, receiverName: ts.Identifier, key: string): boolean {
  const receiver = symbolAt(ctx, receiverName);
  if (!receiver) return false;
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      directPropertyWrite(ctx, node.left, receiver, key)
    ) {
      written = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      directPropertyWrite(ctx, node.operand, receiver, key)
    ) {
      written = true;
      return;
    }
    if (ts.isDeleteExpression(node) && directPropertyWrite(ctx, node.expression, receiver, key)) {
      written = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of callableSourceFiles(ctx, receiverName.getSourceFile())) visit(sourceFile);
  return !written;
}

function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

function patcherLoopParts(
  ctx: CodegenContext,
  statement: ts.Statement,
  factory: ts.Symbol,
): { patchers: ts.Identifier; loop: ts.CallExpression } | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const loop = unwrapExpression(statement.expression);
  if (!ts.isCallExpression(loop) || loop.arguments.length !== 2) return undefined;
  const patchers = unwrapExpression(loop.arguments[0]!);
  const callback = unwrapExpression(loop.arguments[1]!);
  if (!ts.isIdentifier(patchers) || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return undefined;
  }
  if (callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0]!.name)) return undefined;
  const callbackSymbol = symbolAt(ctx, callback.parameters[0]!.name);
  const body = ts.isBlock(callback.body)
    ? callback.body.statements.length === 1 && ts.isExpressionStatement(callback.body.statements[0]!)
      ? unwrapExpression(callback.body.statements[0]!.expression)
      : undefined
    : unwrapExpression(callback.body);
  if (!body || !ts.isCallExpression(body) || body.arguments.length !== 1) return undefined;
  const callee = unwrapExpression(body.expression);
  const argument = unwrapExpression(body.arguments[0]!);
  if (
    !callbackSymbol ||
    !ts.isIdentifier(callee) ||
    symbolAt(ctx, callee) !== callbackSymbol ||
    !ts.isIdentifier(argument) ||
    symbolAt(ctx, argument) !== factory
  ) {
    return undefined;
  }
  return { patchers, loop };
}

function patcherArrayIsUnused(ctx: CodegenContext, patchers: ts.Identifier, loop: ts.CallExpression): boolean {
  const patcherSymbol = symbolAt(ctx, patchers);
  const declaration = patcherSymbol?.valueDeclaration;
  const initializer =
    declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? unwrapExpression(declaration.initializer)
      : undefined;
  if (
    !patcherSymbol ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !initializer ||
    !ts.isArrayLiteralExpression(initializer) ||
    initializer.elements.length !== 0 ||
    !bindingIsStable(ctx, declaration.name)
  ) {
    return false;
  }

  const registrationFunctions = new Set<ts.FunctionDeclaration>();
  let valid = true;
  const visitReference = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === patcherSymbol) {
      if (node === declaration.name || node === loop.arguments[0]) return;
      const access = node.parent;
      const call =
        access && ts.isPropertyAccessExpression(access) && access.expression === node ? access.parent : undefined;
      const owner =
        call && ts.isCallExpression(call) && call.expression === access
          ? enclosingFunctionDeclaration(call)
          : undefined;
      if (access && ts.isPropertyAccessExpression(access) && access.name.text === "push" && owner) {
        registrationFunctions.add(owner);
        return;
      }
      valid = false;
      return;
    }
    ts.forEachChild(node, visitReference);
  };
  for (const sourceFile of callableSourceFiles(ctx, patchers.getSourceFile())) visitReference(sourceFile);
  if (!valid || registrationFunctions.size === 0) return false;

  const registrationSymbols = new Set(
    [...registrationFunctions]
      .map((registration) => registration.name && symbolAt(ctx, registration.name))
      .filter((symbol): symbol is ts.Symbol => symbol !== undefined),
  );
  let unused = true;
  const visitRegistrationReference = (node: ts.Node): void => {
    if (!unused) return;
    if (ts.isIdentifier(node) && registrationSymbols.has(symbolAt(ctx, node)!)) {
      if ([...registrationFunctions].some((registration) => registration.name === node)) return;
      if (
        (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)) &&
        (node.parent.name === node || node.parent.propertyName === node)
      ) {
        return;
      }
      unused = false;
      return;
    }
    ts.forEachChild(node, visitRegistrationReference);
  };
  for (const sourceFile of callableSourceFiles(ctx, patchers.getSourceFile())) {
    visitRegistrationReference(sourceFile);
  }
  return unused;
}

function unwrapValueExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function exactIdentityArgument(ctx: CodegenContext, call: ts.CallExpression): ts.Expression | undefined {
  const declaration = functionDeclarationForCall(ctx, call);
  if (!declaration?.body) return undefined;
  const returns = outerReturns(declaration.body);
  if (returns.length !== 1 || !returns[0]!.expression) return undefined;
  const returned = unwrapValueExpression(returns[0]!.expression!);
  if (!ts.isIdentifier(returned)) return undefined;
  const symbol = symbolAt(ctx, returned);
  const parameterIndex = declaration.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && symbolAt(ctx, parameter.name) === symbol,
  );
  const parameter = parameterIndex >= 0 ? declaration.parameters[parameterIndex] : undefined;
  if (!parameter || !ts.isIdentifier(parameter.name) || !bindingIsStable(ctx, parameter.name)) return undefined;
  let unobserved = true;
  const visit = (node: ts.Node): void => {
    if (!unobserved) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === symbol && node !== parameter.name && node !== returned) {
      unobserved = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return unobserved ? call.arguments[parameterIndex] : undefined;
}

function freshConcreteExpression(ctx: CodegenContext, expression: ts.Expression, depth = 0): boolean {
  if (depth > 4) return false;
  const value = unwrapValueExpression(expression);
  // An object literal necessarily allocates. `new C()` does not: JavaScript
  // constructors may explicitly return a previously-existing object, so an
  // unresolved constructor call cannot establish the fresh identity needed by
  // asserted structural materialization.
  if (ts.isObjectLiteralExpression(value)) return true;
  if (!ts.isCallExpression(value)) return false;
  const identityArgument = exactIdentityArgument(ctx, value);
  return identityArgument !== undefined && freshConcreteExpression(ctx, identityArgument, depth + 1);
}

function freshFunctionLikeResult(ctx: CodegenContext, declaration: ts.FunctionLikeDeclaration): boolean {
  const body = declaration.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return freshConcreteExpression(ctx, body);
  const returns = outerReturns(body);
  return (
    returns.length === 1 &&
    body.statements[body.statements.length - 1] === returns[0] &&
    returns[0]!.expression !== undefined &&
    freshConcreteExpression(ctx, returns[0]!.expression!)
  );
}

function closedFactoryParameterPropertyKeys(
  ctx: CodegenContext,
  factoryDeclaration: ts.FunctionDeclaration,
  parameterIndex: number,
): ReadonlySet<string> | undefined {
  const parameter = factoryDeclaration.parameters[parameterIndex];
  if (!parameter || !ts.isIdentifier(parameter.name) || !bindingIsStable(ctx, parameter.name)) return undefined;
  const symbol = symbolAt(ctx, parameter.name);
  if (!symbol || !factoryDeclaration.body) return undefined;

  const keys = new Set<string>();
  let closed = true;
  const visit = (node: ts.Node): void => {
    if (!closed) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === symbol) {
      if (node === parameter.name) return;
      const access = node.parent;
      let key: string | undefined;
      if (ts.isPropertyAccessExpression(access) && access.expression === node) {
        key = access.name.text;
      } else if (ts.isElementAccessExpression(access) && access.expression === node && access.argumentExpression) {
        const argument = unwrapExpression(access.argumentExpression);
        if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) key = argument.text;
      }
      if (!key || !ts.isCallExpression(access.parent) || access.parent.expression !== access) {
        closed = false;
        return;
      }
      keys.add(key);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(factoryDeclaration.body);
  return closed && keys.size > 0 ? keys : undefined;
}

function concreteCallablePropertyIsClosed(
  ctx: CodegenContext,
  object: ts.ObjectLiteralExpression,
  key: string,
): boolean {
  const property = exactStaticObjectProperty(object, key);
  if (!property) return false;
  let implementation: ts.FunctionLikeDeclaration | undefined;
  if (ts.isMethodDeclaration(property)) {
    implementation = property;
  } else if (ts.isPropertyAssignment(property)) {
    const initializer = unwrapExpression(property.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) implementation = initializer;
  } else if (ts.isShorthandPropertyAssignment(property)) {
    const symbol = canonicalSymbol(
      ctx,
      (
        ctx.checker as typeof ctx.checker & {
          getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
        }
      ).getShorthandAssignmentValueSymbol?.(property),
    );
    implementation = symbol
      ?.getDeclarations()
      ?.find(
        (candidate): candidate is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
      );
    if (implementation?.name && !bindingIsStable(ctx, implementation.name)) return false;
  }
  if (!implementation?.body || hasDynamicBindingHazard(implementation.body)) return false;

  let usesThis = false;
  const visit = (node: ts.Node): void => {
    if (usesThis) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      usesThis = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(implementation.body);
  return !usesThis;
}

function factoryArgumentDoesNotEscape(
  ctx: CodegenContext,
  name: ts.Identifier,
  declaration: ts.VariableDeclaration,
  factoryDeclaration: ts.FunctionDeclaration,
  parameterIndex: number,
): boolean {
  const symbol = symbolAt(ctx, name);
  if (!symbol) return false;
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === symbol && node !== declaration.name) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments[parameterIndex] === node) {
        if (functionDeclarationForCall(ctx, parent) === factoryDeclaration) return;
      }
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of callableSourceFiles(ctx, name.getSourceFile())) visit(sourceFile);
  return valid;
}

function concreteFactoryPropertyIsFresh(
  ctx: CodegenContext,
  expression: ts.Expression,
  key: string,
  factoryDeclaration: ts.FunctionDeclaration,
  parameterIndex: number,
  accessedKeys: ReadonlySet<string>,
): boolean {
  const value = unwrapExpression(expression);
  let object: ts.ObjectLiteralExpression | undefined;
  if (ts.isObjectLiteralExpression(value)) {
    object = value;
  } else if (ts.isIdentifier(value)) {
    const declaration = symbolAt(ctx, value)?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !bindingIsStable(ctx, declaration.name) ||
      !propertyIsNeverWritten(ctx, declaration.name, key) ||
      !factoryArgumentDoesNotEscape(ctx, value, declaration, factoryDeclaration, parameterIndex)
    ) {
      return false;
    }
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isObjectLiteralExpression(initializer)) object = initializer;
  }
  if (!object) return false;
  for (const accessedKey of accessedKeys) {
    if (!concreteCallablePropertyIsClosed(ctx, object, accessedKey)) return false;
  }
  const property = exactStaticObjectProperty(object, key);
  if (!property) return false;
  if (ts.isMethodDeclaration(property)) return freshFunctionLikeResult(ctx, property);
  if (ts.isShorthandPropertyAssignment(property)) {
    const symbol = canonicalSymbol(
      ctx,
      (
        ctx.checker as typeof ctx.checker & {
          getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
        }
      ).getShorthandAssignmentValueSymbol?.(property),
    );
    const declaration = symbol
      ?.getDeclarations()
      ?.find(
        (candidate): candidate is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
      );
    return (
      declaration?.name !== undefined &&
      bindingIsStable(ctx, declaration.name) &&
      freshFunctionLikeResult(ctx, declaration)
    );
  }
  if (!ts.isPropertyAssignment(property)) return false;
  const initializer = unwrapExpression(property.initializer);
  return (
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
    freshFunctionLikeResult(ctx, initializer)
  );
}

function contextualFreshNestedFactoryCall(
  ctx: CodegenContext,
  call: ts.CallExpression,
  factoryDeclaration: ts.FunctionDeclaration,
  factoryInvocation: ts.CallExpression,
): boolean {
  const declaration = functionDeclarationForCall(ctx, call, true);
  if (!declaration?.body || declaration.parent !== factoryDeclaration.body) return false;
  const signature = ctx.checker.getSignatureFromDeclaration(declaration);
  const result = signature && eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  if (!result || !ownedTypeParameter(ctx, declaration, result)) return false;
  const constraint = ctx.checker.getBaseConstraintOfType(result);
  const returns = outerReturns(declaration.body);
  if (!constraint || constraint.getProperties().length === 0 || returns.length !== 1 || !returns[0]!.expression) {
    return false;
  }
  if (declaration.body.statements[declaration.body.statements.length - 1] !== returns[0]) return false;
  const returned = returns[0]!.expression!;
  if (!ts.isAsExpression(returned) && !ts.isTypeAssertionExpression(returned)) return false;
  if (!sameTypeParameter(eraseReadonlyView(ctx.checker.getTypeAtLocation(returned)), result)) return false;
  const sourceCall = unwrapExpression(returned.expression);
  if (!ts.isCallExpression(sourceCall)) return false;
  const access = unwrapExpression(sourceCall.expression);
  if (!ts.isPropertyAccessExpression(access)) return false;
  const receiver = unwrapExpression(access.expression);
  if (!ts.isIdentifier(receiver)) return false;
  const receiverSymbol = symbolAt(ctx, receiver);
  const parameterIndex = factoryDeclaration.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && symbolAt(ctx, parameter.name) === receiverSymbol,
  );
  const argument = parameterIndex >= 0 ? factoryInvocation.arguments[parameterIndex] : undefined;
  const source = eraseReadonlyView(ctx.checker.getTypeAtLocation(sourceCall));
  const accessedKeys = closedFactoryParameterPropertyKeys(ctx, factoryDeclaration, parameterIndex);
  return (
    argument !== undefined &&
    accessedKeys !== undefined &&
    source.getProperties().length > 0 &&
    ctx.checker.isTypeAssignableTo(source, constraint) &&
    concreteFactoryPropertyIsFresh(ctx, argument, access.name.text, factoryDeclaration, parameterIndex, accessedKeys)
  );
}

function freshLocalReferenceIsAllowed(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  declaration: ts.VariableDeclaration,
  returned: ts.ReturnStatement,
): boolean {
  if (identifier === declaration.name) return true;
  if (returned.expression && unwrapExpression(returned.expression) === identifier) return true;

  // A write captured by a nested function can run after the fresh source has
  // been copied into its asserted destination. That would mutate the discarded
  // source and break JavaScript object identity, so only immediate-body
  // initialization writes are admissible.
  for (
    let ancestor: ts.Node | undefined = identifier.parent;
    ancestor && ancestor !== returned.parent;
    ancestor = ancestor.parent
  ) {
    if (ts.isFunctionLike(ancestor) || ts.isClassLike(ancestor)) return false;
  }

  let current: ts.Node = identifier;
  let traversedProperty = false;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      traversedProperty = true;
      current = parent;
      continue;
    }
    if (
      traversedProperty &&
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      return true;
    }
    if (
      traversedProperty &&
      (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === current
    ) {
      return true;
    }
    break;
  }
  return false;
}

/**
 * Prove the concrete method body returns one fresh local without replacing or
 * leaking it. Prefix assertions and unrelated control flow are harmless; only
 * property writes through the fresh local and its final return may reference it.
 */
function freshMethodResult(
  ctx: CodegenContext,
  implementation: ts.FunctionDeclaration,
  factoryDeclaration: ts.FunctionDeclaration,
  factoryInvocation: ts.CallExpression,
): boolean {
  const body = implementation.body;
  if (!body || body.statements.length === 0) return false;
  const returns = outerReturns(body);
  const returned = returns.length === 1 ? returns[0] : undefined;
  if (
    !returned?.expression ||
    body.statements[body.statements.length - 1] !== returned ||
    !ts.isIdentifier(unwrapExpression(returned.expression))
  ) {
    return false;
  }
  const returnedName = unwrapExpression(returned.expression);
  if (!ts.isIdentifier(returnedName)) return false;
  const returnedSymbol = symbolAt(ctx, returnedName);
  if (!returnedSymbol) return false;
  const local = directVariableBySymbol(ctx, body, returnedSymbol);
  if (!local || !ts.isIdentifier(local.name) || !local.initializer || !bindingIsStable(ctx, local.name)) {
    return false;
  }
  const seed = unwrapExpression(local.initializer);
  if (
    !ts.isCallExpression(seed) ||
    !contextualFreshNestedFactoryCall(ctx, seed, factoryDeclaration, factoryInvocation)
  ) {
    return false;
  }

  const source = eraseReadonlyView(ctx.checker.getTypeAtLocation(local.name));
  const signature = ctx.checker.getSignatureFromDeclaration(implementation);
  const result = signature && eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  if (!result || source.getProperties().length === 0 || !ctx.checker.isTypeAssignableTo(source, result)) {
    return false;
  }

  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (
      ts.isIdentifier(node) &&
      symbolAt(ctx, node) === returnedSymbol &&
      !freshLocalReferenceIsAllowed(ctx, node, local, returned)
    ) {
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return valid;
}

function directBodyStatement(node: ts.Node, body: ts.Block): ts.Statement | undefined {
  let current: ts.Node = node;
  while (current.parent && current.parent !== body) current = current.parent;
  return current.parent === body && ts.isStatement(current) ? current : undefined;
}

function returnedFactoryDoesNotEscape(
  ctx: CodegenContext,
  body: ts.Block,
  local: ts.VariableDeclaration,
  returned: ts.ReturnStatement,
  patcherLoops: readonly { loop: ts.CallExpression }[],
): boolean {
  if (!ts.isIdentifier(local.name)) return false;
  const symbol = symbolAt(ctx, local.name);
  const allowedStatements = new Set<ts.Statement>([
    returned,
    ...patcherLoops
      .map(({ loop }) => directBodyStatement(loop, body))
      .filter((statement): statement is ts.Statement => statement !== undefined),
  ]);
  let valid = symbol !== undefined;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === symbol && node !== local.name) {
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) {
    if (!allowedStatements.has(statement)) visit(statement);
  }
  return valid;
}

function returnedFactoryMethod(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  invocation: ts.CallExpression,
  key: string,
): ts.FunctionDeclaration | undefined {
  const body = declaration.body;
  if (!body) return undefined;
  const returns = outerReturns(body);
  if (returns.length !== 1 || !returns[0]!.expression) return undefined;
  const returnedName = unwrapExpression(returns[0]!.expression!);
  if (!ts.isIdentifier(returnedName)) return undefined;
  const returnedSymbol = symbolAt(ctx, returnedName);
  if (!returnedSymbol) return undefined;
  const factoryLocal = directVariableBySymbol(ctx, body, returnedSymbol);
  if (
    !factoryLocal ||
    !ts.isIdentifier(factoryLocal.name) ||
    !factoryLocal.initializer ||
    !bindingIsStable(ctx, factoryLocal.name)
  ) {
    return undefined;
  }
  const object = unwrapExpression(factoryLocal.initializer);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const property = exactStaticObjectProperty(object, key);
  if (!property || (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))) {
    return undefined;
  }
  const implementation = propertyValueImplementation(ctx, property, declaration);
  if (!implementation || !freshMethodResult(ctx, implementation, declaration, invocation)) return undefined;

  const patcherLoops = body.statements
    .map((statement) => patcherLoopParts(ctx, statement, returnedSymbol))
    .filter((parts): parts is { patchers: ts.Identifier; loop: ts.CallExpression } => parts !== undefined);
  if (patcherLoops.length > 1) return undefined;
  if (patcherLoops.length === 1 && !patcherArrayIsUnused(ctx, patcherLoops[0]!.patchers, patcherLoops[0]!.loop)) {
    return undefined;
  }

  return returnedFactoryDoesNotEscape(ctx, body, factoryLocal, returns[0]!, patcherLoops) ? implementation : undefined;
}

function sourceObjectDoesNotEscape(
  ctx: CodegenContext,
  source: ts.Identifier,
  declaration: ts.VariableDeclaration,
  destructure: ts.VariableDeclaration,
  selectedKey: string,
): boolean {
  const symbol = symbolAt(ctx, source);
  let valid = symbol !== undefined;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(ctx, node) === symbol) {
      if (node === declaration.name || node === destructure.initializer) return;
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
        if (node.parent.name.text === selectedKey) return;
        valid = false;
        return;
      }
      if (ts.isElementAccessExpression(node.parent) && node.parent.expression === node) {
        const key = node.parent.argumentExpression && unwrapExpression(node.parent.argumentExpression);
        if (key && (ts.isStringLiteral(key) || ts.isNumericLiteral(key)) && key.text === selectedKey) return;
      }
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of callableSourceFiles(ctx, source.getSourceFile())) visit(sourceFile);
  return valid;
}

/**
 * Resolve a destructured call through the exact factory value and returned
 * object-literal method implementation. This is deliberately body- and
 * symbol-proven: interface names and overload spelling alone grant nothing.
 */
function stableReturnedFactoryMethodCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return false;
  const binding = ctx.oracle.valueDeclarationOf(callee);
  if (
    !binding ||
    !ts.isBindingElement(binding) ||
    !ts.isIdentifier(binding.name) ||
    !ts.isObjectBindingPattern(binding.parent) ||
    !bindingIsStable(ctx, binding.name)
  ) {
    return false;
  }
  const key = staticPropertyName(binding.propertyName ?? binding.name);
  const destructure = binding.parent.parent;
  if (!key || !ts.isVariableDeclaration(destructure) || !destructure.initializer) return false;
  const source = unwrapExpression(destructure.initializer);
  if (!ts.isIdentifier(source) || !bindingIsStable(ctx, source) || !propertyIsNeverWritten(ctx, source, key)) {
    return false;
  }
  const sourceSymbol = symbolAt(ctx, source);
  const sourceDeclaration = sourceSymbol?.valueDeclaration;
  if (!sourceDeclaration || !ts.isVariableDeclaration(sourceDeclaration) || !sourceDeclaration.initializer) {
    return false;
  }
  if (!sourceObjectDoesNotEscape(ctx, source, sourceDeclaration, destructure, key)) return false;
  const initializer = unwrapExpression(sourceDeclaration.initializer);
  if (!ts.isCallExpression(initializer)) return false;
  const factoryDeclaration = functionDeclarationForCall(ctx, initializer);
  return (
    factoryDeclaration !== undefined && returnedFactoryMethod(ctx, factoryDeclaration, initializer, key) !== undefined
  );
}

/** Calls whose contract proves that each evaluation produces a fresh structural carrier. */
function provenFreshFactoryCall(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (ts.isPropertyAccessExpression(callee) && /^createBase(?:[A-Z][A-Za-z0-9]*)?Node$/.test(callee.name.text)) {
    const signature = ctx.checker.getResolvedSignature(call);
    const declaration = signature?.getDeclaration();
    const result = signature && eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
    if (
      declaration &&
      ts.isMethodSignature(declaration) &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      declaration.parent.name.text === "BaseNodeFactory" &&
      result?.getSymbol()?.name === "Node"
    ) {
      return true;
    }
  }

  if (stableReturnedFactoryMethodCall(ctx, call)) return true;
  const declaration = functionDeclarationForCall(ctx, call, true);
  return declaration !== undefined && genericStructFactoryDeclaration(ctx, declaration) !== null;
}

function directFactoryReturn(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  resultTypeParameter: ts.Type,
  sourceConstraint: ts.Type,
): boolean {
  if (declaration.body?.statements.length !== 1) return false;
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;

  const returned = unwrapExpression(statement.expression);
  if (!ts.isAsExpression(returned) && !ts.isTypeAssertionExpression(returned)) return false;
  const assertedType = eraseReadonlyView(ctx.checker.getTypeAtLocation(returned));
  if (!sameTypeParameter(assertedType, resultTypeParameter)) return false;

  const operand = unwrapExpression(returned.expression);
  if (!ts.isCallExpression(operand) && !ts.isNewExpression(operand)) return false;
  if (ts.isCallExpression(operand) && !provenFreshFactoryCall(ctx, operand)) return false;
  const operandType = ctx.checker.getTypeAtLocation(operand);
  return ctx.checker.isTypeAssignableTo(operandType, sourceConstraint);
}

/**
 * Physical source for a fresh factory routed through a body-proven identity:
 *
 *   function parseNode<T extends Node>(): T {
 *     return finishNode(factoryCreateToken(kind), pos) as T;
 *   }
 *
 * `finishNode` is intentionally not itself fresh. The composition is fresh
 * only because its exact identity argument is, and that argument's structural
 * type is the carrier the generic declaration must preserve in its Wasm ABI.
 */
function identityWrappedFreshFactorySource(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  resultTypeParameter: ts.Type,
  sourceConstraint: ts.Type,
): ts.Type | undefined {
  const statements = declaration.body?.statements;
  if (!statements?.length) return undefined;
  let prefixReturns = false;
  const visitPrefix = (node: ts.Node): void => {
    if (prefixReturns) return;
    if (ts.isReturnStatement(node)) {
      prefixReturns = true;
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, visitPrefix);
  };
  for (const prefix of statements.slice(0, -1)) visitPrefix(prefix);
  if (prefixReturns) return undefined;
  const statement = statements[statements.length - 1];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return undefined;

  const returned = unwrapExpression(statement.expression);
  if (!ts.isAsExpression(returned) && !ts.isTypeAssertionExpression(returned)) return undefined;
  const assertedType = eraseReadonlyView(ctx.checker.getTypeAtLocation(returned));
  if (!sameTypeParameter(assertedType, resultTypeParameter)) return undefined;

  const identityCall = unwrapExpression(returned.expression);
  if (!ts.isCallExpression(identityCall)) return undefined;
  const identityParameterIndex = genericIdentityReturnParamIndex(ctx, identityCall);
  const factoryExpression =
    identityParameterIndex === undefined ? undefined : identityCall.arguments[identityParameterIndex];
  if (!factoryExpression) return undefined;
  const factoryValue = unwrapExpression(factoryExpression);
  const fresh =
    ts.isObjectLiteralExpression(factoryValue) ||
    (ts.isCallExpression(factoryValue) && provenFreshFactoryCall(ctx, factoryValue));
  if (!fresh) return undefined;

  const source = eraseReadonlyView(ctx.checker.getTypeAtLocation(factoryExpression));
  if (source.getProperties().length === 0 || !ctx.checker.isTypeAssignableTo(source, sourceConstraint)) {
    return undefined;
  }
  return source;
}

function typeNodeReferencesOwnedTypeParameter(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  node: ts.TypeNode,
): boolean {
  const ownedSymbols = new Set(
    declaration.typeParameters
      ?.map((parameter) => ctx.checker.getSymbolAtLocation(parameter.name))
      .filter((symbol): symbol is ts.Symbol => symbol !== undefined) ?? [],
  );
  if (ownedSymbols.size === 0) return false;

  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(current)) {
      const symbol = ctx.checker.getSymbolAtLocation(current);
      if (symbol && ownedSymbols.has(symbol)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * Admit the sibling generic form used by TypeScript's token factory:
 *
 *   function createBaseToken<K extends TokenSyntaxKind>(kind: K) {
 *     return base.createBaseTokenNode(kind) as Mutable<Token<K>>;
 *   }
 *
 * Unlike `createBaseNode<T extends Node>`, the function result is a structural
 * generic instantiated with its owned type parameter, not the type parameter
 * itself. Keep this restricted to a single direct assertion over a fresh
 * proven-fresh call result whose asserted structural type narrows that source. Ordinary
 * generic forwarding and identity functions therefore remain outside the
 * materialization path.
 */
function directInstantiatedFactorySource(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  resultType: ts.Type,
): ts.Type | undefined {
  if (declaration.body?.statements.length !== 1 || resultType.getProperties().length === 0) return undefined;
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return undefined;

  const returned = unwrapExpression(statement.expression);
  if (!ts.isAsExpression(returned) && !ts.isTypeAssertionExpression(returned)) return undefined;
  if (!typeNodeReferencesOwnedTypeParameter(ctx, declaration, returned.type)) return undefined;

  const assertedType = eraseReadonlyView(ctx.checker.getTypeAtLocation(returned));
  if (
    assertedType.getProperties().length === 0 ||
    !ctx.checker.isTypeAssignableTo(assertedType, resultType) ||
    !ctx.checker.isTypeAssignableTo(resultType, assertedType)
  ) {
    return undefined;
  }

  const operand = unwrapExpression(returned.expression);
  if (!ts.isCallExpression(operand) || !provenFreshFactoryCall(ctx, operand)) return undefined;
  const source = eraseReadonlyView(ctx.checker.getTypeAtLocation(operand));
  if (
    source === assertedType ||
    source.getProperties().length === 0 ||
    !ctx.checker.isTypeAssignableTo(assertedType, source)
  ) {
    return undefined;
  }
  return source;
}

function expressionRootedAtSymbol(ctx: CodegenContext, expression: ts.Expression, symbol: ts.Symbol): boolean {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) && ctx.checker.getSymbolAtLocation(current) === symbol;
}

function isFactoryLocalMutation(ctx: CodegenContext, statement: ts.Statement, symbol: ts.Symbol): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrapExpression(statement.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return (
      expressionRootedAtSymbol(ctx, expression.left, symbol) && !ts.isIdentifier(unwrapExpression(expression.left))
    );
  }
  if (
    (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) &&
    (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return expressionRootedAtSymbol(ctx, expression.operand, symbol);
  }
  return false;
}

function wrapperFactoryReturn(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  resultTypeParameter: ts.Type,
): boolean {
  const statements = declaration.body?.statements;
  if (!statements || statements.length < 2) return false;

  const first = statements[0];
  const last = statements[statements.length - 1];
  if (!first || !ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) return false;
  if (!last || !ts.isReturnStatement(last) || !last.expression) return false;

  const local = first.declarationList.declarations[0]!;
  if (!ts.isIdentifier(local.name) || !local.initializer) return false;
  const initializer = unwrapExpression(local.initializer);
  if (!ts.isCallExpression(initializer)) return false;
  const seedDeclaration = functionDeclarationForCall(ctx, initializer, true);
  if (!seedDeclaration || !genericStructFactoryDeclaration(ctx, seedDeclaration)) return false;

  const seedSignature = ctx.checker.getResolvedSignature(initializer);
  if (!seedSignature) return false;
  const seedResult = eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(seedSignature));
  if (!sameTypeParameter(seedResult, resultTypeParameter)) return false;

  const localSymbol = ctx.checker.getSymbolAtLocation(local.name);
  const returned = unwrapExpression(last.expression);
  if (!localSymbol || !ts.isIdentifier(returned) || ctx.checker.getSymbolAtLocation(returned) !== localSymbol) {
    return false;
  }

  return statements.slice(1, -1).every((statement) => isFactoryLocalMutation(ctx, statement, localSymbol));
}

function genericStructFactoryDeclaration(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
): GenericStructFactoryDeclaration | null {
  let memo = factoryMemo.get(ctx);
  if (!memo) {
    memo = new WeakMap();
    factoryMemo.set(ctx, memo);
  }
  const cached = memo.get(declaration);
  if (cached !== undefined) return cached === "visiting" ? null : cached;
  memo.set(declaration, "visiting");

  const signature = declaration.body ? ctx.checker.getSignatureFromDeclaration(declaration) : undefined;
  if (!signature || !declaration.typeParameters?.length) {
    memo.set(declaration, null);
    return null;
  }

  const resultTypeParameter = eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  if (!ownedTypeParameter(ctx, declaration, resultTypeParameter)) {
    const sourceConstraint = directInstantiatedFactorySource(ctx, declaration, resultTypeParameter);
    if (!sourceConstraint) {
      memo.set(declaration, null);
      return null;
    }
    const descriptor = { declaration, sourceConstraint };
    memo.set(declaration, descriptor);
    return descriptor;
  }
  const sourceConstraint = ctx.checker.getBaseConstraintOfType(resultTypeParameter);
  if (!sourceConstraint || sourceConstraint.getProperties().length === 0) {
    memo.set(declaration, null);
    return null;
  }

  // A T-valued input makes this an identity/forwarding function, not a fresh
  // structural allocator. In particular this excludes finishNode<T>(node:T):T.
  for (const parameter of declaration.parameters) {
    const parameterType = eraseReadonlyView(ctx.checker.getTypeAtLocation(parameter));
    if (sameTypeParameter(parameterType, resultTypeParameter)) {
      memo.set(declaration, null);
      return null;
    }
  }

  const identityWrappedSource = identityWrappedFreshFactorySource(
    ctx,
    declaration,
    resultTypeParameter,
    sourceConstraint,
  );
  const wrapsFreshFactory = wrapperFactoryReturn(ctx, declaration, resultTypeParameter);
  const admitted =
    identityWrappedSource !== undefined ||
    directFactoryReturn(ctx, declaration, resultTypeParameter, sourceConstraint) ||
    wrapsFreshFactory;
  if (!admitted) {
    memo.set(declaration, null);
    return null;
  }

  const descriptor: GenericStructFactoryDeclaration = identityWrappedSource
    ? {
        declaration,
        resultTypeParameter,
        sourceConstraint: identityWrappedSource,
        sourceResultAbi: true,
      }
    : {
        declaration,
        resultTypeParameter,
        sourceConstraint,
        // A wrapper that initializes and returns a fresh T still owns only the
        // constraint's physical fields. Freezing its body ABI to the first
        // concrete instantiation makes the exact fresh constraint fail a
        // nominal downcast before callers can materialize their own layout.
        ...(wrapsFreshFactory ? { sourceResultAbi: true as const } : {}),
      };
  memo.set(declaration, descriptor);
  return descriptor;
}

/**
 * A declaration whose first call-site T cannot define its physical result ABI.
 * Only the identity-wrapped fresh-factory proof above can request this override;
 * ordinary generic factories retain their established ABI planning.
 */
export function genericStructFactorySourceResultAbi(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
): ts.Type | undefined {
  const factory = genericStructFactoryDeclaration(ctx, declaration);
  return factory?.sourceResultAbi ? factory.sourceConstraint : undefined;
}

/**
 * Resolve the physical base and logical destination for a proven generic
 * structural-factory call. The detector is deliberately semantic and
 * name-independent; ordinary generic identity functions fail its body/input
 * proof and retain their existing ABI.
 */
export function genericStructFactoryCall(
  ctx: CodegenContext,
  call: ts.CallExpression,
): GenericStructFactoryCall | null {
  const declaration = functionDeclarationForCall(ctx, call, true);
  if (!declaration) return null;
  const factory = genericStructFactoryDeclaration(ctx, declaration);
  if (!factory) return null;

  const signature = ctx.checker.getResolvedSignature(call);
  if (!signature) return null;
  // An explicit type argument is the authoritative destination for the
  // declaration-proven `T`-returning factory. Program-ABI replay retains the
  // original call syntax but can expose the declaration's constrained return
  // (`Declaration`) through getResolvedSignature instead of the explicit
  // refinement (`createBaseDeclaration<BinaryExpression>`). The syntax is
  // unambiguous here because the factory proof has already tied its result to
  // one owned type parameter.
  let target: ts.Type | undefined;
  if (factory.resultTypeParameter && call.typeArguments?.length && declaration.typeParameters?.length) {
    const resultParameterIndex = declaration.typeParameters.findIndex((parameter) =>
      sameTypeParameter(ctx.checker.getTypeAtLocation(parameter.name), factory.resultTypeParameter!),
    );
    const explicitTypeArgument = resultParameterIndex >= 0 ? call.typeArguments[resultParameterIndex] : undefined;
    if (explicitTypeArgument) target = eraseReadonlyView(ctx.checker.getTypeFromTypeNode(explicitTypeArgument));
  }
  target ??= eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  if (target.flags & ts.TypeFlags.TypeParameter) {
    const constraint = ctx.checker.getBaseConstraintOfType(target);
    if (!constraint) return null;
    target = constraint;
  }

  return { declaration, sourceConstraint: factory.sourceConstraint, target };
}

/**
 * Parameter index for a direct generic identity result (`value: T` -> `T`).
 *
 * Some identity-preserving structural helpers deliberately use an externref
 * implementation ABI so one body can carry every concrete object layout.
 * Their call sites still know the instantiated input carrier. Recovery is
 * admitted only when every outer value-return names that exact parameter and
 * its binding is never replaced (writes through its properties are harmless).
 * This narrow value-flow fact lets identifier-call lowering recover the
 * carrier after the opaque call instead of immediately casting the result to
 * an unrelated nominal sibling.
 */
export function genericIdentityReturnParamIndex(ctx: CodegenContext, call: ts.CallExpression): number | undefined {
  const declaration = functionDeclarationForCall(ctx, call, true);
  if (!declaration?.typeParameters?.length) return undefined;

  let memo = identityReturnParamMemo.get(ctx);
  if (!memo) {
    memo = new WeakMap();
    identityReturnParamMemo.set(ctx, memo);
  }
  const cached = memo.get(declaration);
  if (cached !== undefined) return cached === null ? undefined : cached;

  const signature = ctx.checker.getSignatureFromDeclaration(declaration);
  if (!signature || !declaration.body) {
    memo.set(declaration, null);
    return undefined;
  }
  const result = eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  if (!ownedTypeParameter(ctx, declaration, result)) {
    memo.set(declaration, null);
    return undefined;
  }

  const candidateIndices: number[] = [];
  declaration.parameters.forEach((parameter, index) => {
    const parameterType = eraseReadonlyView(ctx.checker.getTypeAtLocation(parameter));
    if (sameTypeParameter(parameterType, result)) candidateIndices.push(index);
  });

  const bindingContainsSymbol = (name: ts.BindingName, symbol: ts.Symbol): boolean => {
    if (ts.isIdentifier(name)) return ctx.checker.getSymbolAtLocation(name) === symbol;
    return name.elements.some(
      (element) => !ts.isOmittedExpression(element) && bindingContainsSymbol(element.name, symbol),
    );
  };

  const writeTargetContainsSymbol = (target: ts.Node, symbol: ts.Symbol): boolean => {
    if (ts.isIdentifier(target)) return ctx.checker.getSymbolAtLocation(target) === symbol;
    // Writing through the parameter is compatible with identity: `node.pos =`
    // mutates the object but does not replace the parameter binding.
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return false;
    if (
      ts.isParenthesizedExpression(target) ||
      ts.isNonNullExpression(target) ||
      ts.isAsExpression(target) ||
      ts.isTypeAssertionExpression(target)
    ) {
      return writeTargetContainsSymbol(target.expression, symbol);
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return writeTargetContainsSymbol(target.left, symbol);
    }

    let found = false;
    ts.forEachChild(target, (child) => {
      if (!found && writeTargetContainsSymbol(child, symbol)) found = true;
    });
    return found;
  };

  const provesExactIdentityReturn = (parameterIndex: number): boolean => {
    const parameter = declaration.parameters[parameterIndex];
    if (!parameter || !ts.isIdentifier(parameter.name)) return false;
    const parameterSymbol = ctx.checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) return false;

    let sawValueReturn = false;
    let valid = true;
    const visit = (node: ts.Node, checkReturns: boolean): void => {
      if (!valid) return;

      if (ts.isVariableDeclaration(node) && bindingContainsSymbol(node.name, parameterSymbol)) {
        valid = false;
        return;
      }
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        ctx.checker.getSymbolAtLocation(node.name) === parameterSymbol
      ) {
        valid = false;
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        writeTargetContainsSymbol(node.left, parameterSymbol)
      ) {
        valid = false;
        return;
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        writeTargetContainsSymbol(node.operand, parameterSymbol)
      ) {
        valid = false;
        return;
      }
      if (
        (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        writeTargetContainsSymbol(node.initializer, parameterSymbol)
      ) {
        valid = false;
        return;
      }
      if (ts.isReturnStatement(node)) {
        if (checkReturns) {
          sawValueReturn = true;
          const returned = node.expression ? unwrapExpression(node.expression) : undefined;
          if (
            !returned ||
            !ts.isIdentifier(returned) ||
            ctx.checker.getSymbolAtLocation(returned) !== parameterSymbol
          ) {
            valid = false;
          }
        } else if (node.expression) {
          visit(node.expression, false);
        }
        return;
      }

      const nestedScope = ts.isFunctionLike(node) || ts.isClassLike(node);
      ts.forEachChild(node, (child) => visit(child, nestedScope ? false : checkReturns));
    };

    visit(declaration.body!, true);
    return valid && sawValueReturn;
  };

  const index = candidateIndices.find(provesExactIdentityReturn);
  memo.set(declaration, index ?? null);
  return index;
}

/**
 * Recognize TypeScript's closed BaseNodeFactory contract at the assertion site:
 *
 *   baseFactory.createBaseIdentifierNode(kind) as Mutable<Identifier>
 *
 * An interface method body cannot prove freshness on its own, so this is
 * deliberately tied to the exact BaseNodeFactory/createBase*Node contract and
 * a Node-returning signature. The structural destination must narrow that Node
 * result. Arbitrary property-call assertions retain their ordinary guarded-cast
 * semantics.
 */
function directBaseNodeFactoryAssertion(
  ctx: CodegenContext,
  expression: ts.Expression,
): StructFactoryExpression | null {
  const asserted = unwrapExpression(expression);
  if (!ts.isAsExpression(asserted) && !ts.isTypeAssertionExpression(asserted)) return null;

  let owner: ts.Node | undefined = asserted.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (owner?.typeParameters && owner.typeParameters.length > 0) return null;

  const operand = unwrapExpression(asserted.expression);
  if (!ts.isCallExpression(operand)) return null;
  const callee = unwrapExpression(operand.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null;
  if (!/^createBase(?:[A-Z][A-Za-z0-9]*)?Node$/.test(callee.name.text)) return null;

  const signature = ctx.checker.getResolvedSignature(operand);
  const signatureDeclaration = signature?.getDeclaration();
  if (
    !signature ||
    !signatureDeclaration ||
    !ts.isMethodSignature(signatureDeclaration) ||
    !ts.isInterfaceDeclaration(signatureDeclaration.parent) ||
    signatureDeclaration.parent.name.text !== "BaseNodeFactory"
  ) {
    return null;
  }

  const sourceConstraint = eraseReadonlyView(ctx.checker.getReturnTypeOfSignature(signature));
  const target = eraseReadonlyView(ctx.checker.getTypeAtLocation(asserted));
  if (
    sourceConstraint === target ||
    sourceConstraint.symbol?.name !== "Node" ||
    sourceConstraint.getProperties().length === 0 ||
    target.getProperties().length === 0 ||
    !ctx.checker.isTypeAssignableTo(target, sourceConstraint)
  ) {
    return null;
  }
  return { sourceConstraint, target };
}

/** Resolve only the direct asserted BaseNodeFactory expression form. */
export function assertedStructFactoryExpression(
  ctx: CodegenContext,
  expression: ts.Expression,
): StructFactoryExpression | null {
  return directBaseNodeFactoryAssertion(ctx, expression);
}

/** Resolve a factory call through value-transparent expression wrappers. */
export function genericStructFactoryExpression(
  ctx: CodegenContext,
  expression: ts.Expression,
): StructFactoryExpression | null {
  const directAssertion = assertedStructFactoryExpression(ctx, expression);
  if (directAssertion) return directAssertion;

  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isCallExpression(current) ? genericStructFactoryCall(ctx, current) : null;
}
