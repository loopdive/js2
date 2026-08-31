// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

type CheckerContext = Pick<CodegenContext, "checker" | "callableSourceFiles">;

/**
 * A body-bearing generic function whose result is supplied by one zero-argument
 * callback parameter (or by an explicit, constraint-backed `as T` fallback):
 *
 *     function tryParse<T>(callback: () => T): T
 *
 * The descriptor deliberately records the semantic type-parameter identity.
 * Textual names are insufficient because nested TypeScript compiler helpers
 * routinely reuse `T` in enclosing and sibling declarations.
 */
export interface GenericCallbackResultDeclaration {
  readonly declaration: ts.FunctionDeclaration;
  readonly callbackParameterIndex: number;
  readonly resultTypeParameter: ts.Type;
}

/** Concrete evidence available at one direct call of a proven declaration. */
export interface GenericCallbackResultCall extends GenericCallbackResultDeclaration {
  readonly call: ts.CallExpression;
  readonly callbackArgument: ts.Expression;
  /** Return type of the callback value supplied at this call site. */
  readonly callbackResultType: ts.Type;
  /** Instantiated return type selected for the generic call itself. */
  readonly resultType: ts.Type;
}

type DeclarationMemoEntry = GenericCallbackResultDeclaration | null | "visiting";

// The proof depends on `callableSourceFiles` membership, so checker-only
// memoization can leak a narrow-context admission into a wider program graph.
// Codegen passes one stable context object through recursive detection.
const declarationMemo = new WeakMap<CheckerContext, WeakMap<ts.FunctionDeclaration, DeclarationMemoEntry>>();

function sameTypeParameter(left: ts.Type, right: ts.Type): boolean {
  if (left === right) return true;
  return (
    (left.flags & ts.TypeFlags.TypeParameter) !== 0 &&
    (right.flags & ts.TypeFlags.TypeParameter) !== 0 &&
    left.symbol !== undefined &&
    left.symbol === right.symbol
  );
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return canonicalSymbol(checker, checker.getSymbolAtLocation(node));
}

function unwrapCallee(expression: ts.Expression): ts.Expression {
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

function implementationForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
): ts.FunctionDeclaration | undefined {
  if (!ts.isFunctionDeclaration(declaration)) return undefined;
  if (!declaration.name) return declaration.body ? declaration : undefined;
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(declaration.name));
  const implementations = symbol?.declarations?.filter(
    (candidate): candidate is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
  );
  if (implementations?.length !== 1) return undefined;
  return declaration.body && implementations[0] !== declaration ? undefined : implementations[0];
}

function directFunctionDeclarationForCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.FunctionDeclaration | undefined {
  const callee = unwrapCallee(call.expression);
  if (!ts.isIdentifier(callee)) return undefined;

  const resolved = checker.getResolvedSignature(call)?.getDeclaration();
  if (resolved) {
    const implementation = implementationForDeclaration(checker, resolved);
    if (implementation) return implementation;
  }

  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(callee));
  const implementations = symbol?.declarations?.filter(
    (candidate): candidate is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
  );
  return implementations?.length === 1 ? implementations[0] : undefined;
}

function zeroArgumentResult(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  if (type.getConstructSignatures().length !== 0) return undefined;
  const signatures = type.getCallSignatures();
  if (signatures.length !== 1) return undefined;
  const signature = signatures[0]!;
  if (signature.typeParameters?.length || signature.thisParameter || signature.getParameters().length !== 0) {
    return undefined;
  }
  return checker.getReturnTypeOfSignature(signature);
}

function declarationHasGlobalScriptReach(declaration: ts.Declaration): boolean {
  let current: ts.Node | undefined = declaration.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isModuleBlock(current)) return false;
    current = current.parent;
  }
  return !!current && !ts.isExternalModule(current);
}

function symbolSourceFiles(
  ctx: CheckerContext,
  symbols: Iterable<ts.Symbol>,
  fallback: ts.SourceFile,
): readonly ts.SourceFile[] {
  const symbolList = [...symbols];
  const files = new Set<ts.SourceFile>([fallback]);
  for (const symbol of symbolList) {
    for (const declaration of symbol.declarations ?? []) files.add(declaration.getSourceFile());
  }
  // A top-level binding in a script (rather than an external module) is shared
  // by every script in the program. Its write/escape proof therefore needs the
  // complete callable graph, not merely the declaration file.
  if (
    ctx.callableSourceFiles &&
    symbolList.some((symbol) => symbol.declarations?.some(declarationHasGlobalScriptReach))
  ) {
    for (const sourceFile of ctx.callableSourceFiles) files.add(sourceFile);
  }
  return [...files];
}

function unwrapRuntimeNoOps(expression: ts.Expression): ts.Expression {
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

function assignmentTargetContainsSymbol(checker: ts.TypeChecker, target: ts.Node, symbol: ts.Symbol): boolean {
  if (ts.isIdentifier(target)) return symbolAt(checker, target) === symbol;
  // A write through an object does not replace the local/parameter binding.
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return false;
  if (
    ts.isParenthesizedExpression(target) ||
    ts.isNonNullExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isTypeAssertionExpression(target)
  ) {
    return assignmentTargetContainsSymbol(checker, target.expression, symbol);
  }

  let found = false;
  ts.forEachChild(target, (child) => {
    if (!found && assignmentTargetContainsSymbol(checker, child, symbol)) found = true;
  });
  return found;
}

/** Includes illegal declarations/writes accepted when semantic diagnostics are skipped. */
function bindingIsStable(
  ctx: CheckerContext,
  symbol: ts.Symbol,
  fallback: ts.SourceFile,
  allowedDeclarations: ReadonlySet<ts.Declaration>,
): boolean {
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (
      ts.isVariableDeclaration(node) &&
      !allowedDeclarations.has(node) &&
      assignmentTargetContainsSymbol(ctx.checker, node.name, symbol)
    ) {
      // Redeclarations and destructuring declarations can replace a hoisted
      // parameter/function binding without an assignment expression.
      reassigned = true;
      return;
    }
    if (
      ts.isParameter(node) &&
      !allowedDeclarations.has(node) &&
      assignmentTargetContainsSymbol(ctx.checker, node.name, symbol)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      !allowedDeclarations.has(node) &&
      symbolAt(ctx.checker, node.name) === symbol
    ) {
      reassigned = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetContainsSymbol(ctx.checker, node.left, symbol)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetContainsSymbol(ctx.checker, node.operand, symbol)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      (ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.some((declaration) =>
            assignmentTargetContainsSymbol(ctx.checker, declaration.name, symbol),
          )
        : assignmentTargetContainsSymbol(ctx.checker, node.initializer, symbol))
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of symbolSourceFiles(ctx, [symbol], fallback)) visit(sourceFile);
  return !reassigned;
}

function functionBindingSyntaxIsStatic(declaration: ts.FunctionDeclaration, symbol: ts.Symbol): boolean {
  if (!declaration.name) return false;
  const bindingName = declaration.name.text;
  const allowedFunctions = new Set(symbol.declarations?.filter(ts.isFunctionDeclaration) ?? []);
  const scope = declaration.parent;
  if (hasDynamicBindingHazard(scope, false)) return false;
  let safe = true;
  const targetContainsName = (target: ts.Node): boolean => {
    if (ts.isIdentifier(target)) return target.text === bindingName;
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return false;
    let found = false;
    ts.forEachChild(target, (child) => {
      if (!found && targetContainsName(child)) found = true;
    });
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isVariableDeclaration(node) && bindingNameContainsText(node.name, bindingName)) {
      safe = false;
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === bindingName && !allowedFunctions.has(node)) {
      safe = false;
      return;
    }
    if (
      (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) &&
      node.name &&
      staticPropertyName(node.name) === bindingName
    ) {
      safe = false;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      targetContainsName(node.left)
    ) {
      safe = false;
      return;
    }
    if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return safe;
}

function functionBindingIsStable(
  ctx: CheckerContext,
  declaration: ts.FunctionDeclaration,
  fallback: ts.SourceFile,
): boolean {
  if (!declaration.name) return false;
  const symbol = symbolAt(ctx.checker, declaration.name);
  if (!symbol) return false;
  const functionDeclarations = symbol.declarations?.filter(ts.isFunctionDeclaration) ?? [];
  const implementations = functionDeclarations.filter((candidate) => candidate.body !== undefined);
  return (
    implementations.length === 1 &&
    implementations[0] === declaration &&
    functionBindingSyntaxIsStatic(declaration, symbol) &&
    bindingIsStable(ctx, symbol, fallback, new Set(functionDeclarations))
  );
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

function bindingNameContainsText(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameContainsText(element.name, text),
  );
}

function hasDynamicBindingHazard(node: ts.Node, includeArguments: boolean): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isWithStatement(current) || (includeArguments && ts.isIdentifier(current) && current.text === "arguments")) {
      found = true;
      return;
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapRuntimeNoOps(current.expression);
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

/**
 * The checker intentionally recovers from duplicate bindings because normal
 * compilation reports diagnostics. Codegen can skip those diagnostics, so
 * reject runtime binding hazards syntactically as well: a body-level `var` or
 * function declaration can replace a parameter even when the checker assigns
 * the duplicate declaration a different symbol. Mapped `arguments`, direct
 * eval, and `with` are likewise outside the static provenance model.
 */
function callbackBindingSyntaxIsStatic(
  declaration: ts.FunctionDeclaration,
  callbackParameter: ts.ParameterDeclaration,
): boolean {
  if (!declaration.body || !ts.isIdentifier(callbackParameter.name)) return false;
  const callbackName = callbackParameter.name.text;
  if (
    declaration.parameters.some(
      (parameter) => parameter !== callbackParameter && bindingNameContainsText(parameter.name, callbackName),
    )
  ) {
    return false;
  }

  // These constructs can rebind or alias the outer callback through runtime
  // scope machinery. Scan parameters, nested callables, class bodies, and the
  // function body: arrows and direct eval retain access to the outer binding.
  if (
    declaration.parameters.some((parameter) => hasDynamicBindingHazard(parameter, true)) ||
    hasDynamicBindingHazard(declaration.body, true)
  ) {
    return false;
  }

  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isVariableDeclaration(node) && bindingNameContainsText(node.name, callbackName)) {
      safe = false;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      staticPropertyName(node.name) === callbackName
    ) {
      safe = false;
      return;
    }
    if (node !== declaration.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return safe;
}

function localBindingSyntaxIsStatic(owner: ts.FunctionDeclaration, declaration: ts.VariableDeclaration): boolean {
  if (!owner.body || !ts.isIdentifier(declaration.name)) return false;
  const localName = declaration.name.text;
  if (owner.parameters.some((parameter) => bindingNameContainsText(parameter.name, localName))) return false;

  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isVariableDeclaration(node) && node !== declaration && bindingNameContainsText(node.name, localName)) {
      safe = false;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name &&
      staticPropertyName(node.name) === localName
    ) {
      safe = false;
      return;
    }
    if (node !== owner.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(owner.body);
  return safe;
}

function hasUniqueBodyImplementation(ctx: CheckerContext, declaration: ts.FunctionDeclaration): boolean {
  if (!declaration.name) return true;
  const symbol = symbolAt(ctx.checker, declaration.name);
  const implementations = symbol?.declarations?.filter(
    (candidate): candidate is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
  );
  return implementations?.length === 1 && implementations[0] === declaration;
}

function variableDeclaration(symbol: ts.Symbol): ts.VariableDeclaration | undefined {
  const valueDeclaration = symbol.valueDeclaration;
  if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration)) return valueDeclaration;
  return symbol.declarations?.find(ts.isVariableDeclaration);
}

function staticPropertyName(name: ts.Expression | ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function staticRuntimeKey(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const current = unwrapRuntimeNoOps(expression);
  if (ts.isStringLiteral(current) || ts.isNumericLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text;
  }
  return undefined;
}

function propertyReceiverAndName(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): { receiver: ts.Identifier; receiverSymbol: ts.Symbol; name: string } | undefined {
  const current = unwrapRuntimeNoOps(expression);
  let receiverExpression: ts.Expression;
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(current)) {
    receiverExpression = current.expression;
    name = current.name.text;
  } else if (ts.isElementAccessExpression(current)) {
    receiverExpression = current.expression;
    name = staticRuntimeKey(current.argumentExpression);
  } else {
    return undefined;
  }
  const receiver = unwrapRuntimeNoOps(receiverExpression);
  if (!name || !ts.isIdentifier(receiver)) return undefined;
  const receiverSymbol = symbolAt(checker, receiver);
  return receiverSymbol ? { receiver, receiverSymbol, name } : undefined;
}

function sourceBelongsToProgram(ctx: CheckerContext, sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return false;
  return (
    !ctx.callableSourceFiles ||
    ctx.callableSourceFiles.some((candidate) => candidate === sourceFile || candidate.fileName === sourceFile.fileName)
  );
}

function propertyWriteHitsSymbol(
  checker: ts.TypeChecker,
  target: ts.Node,
  receiverSymbol: ts.Symbol,
  propertyName: string,
): boolean {
  const current = ts.isExpression(target) ? unwrapRuntimeNoOps(target) : target;
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const receiver = unwrapRuntimeNoOps(current.expression);
    if (ts.isIdentifier(receiver) && symbolAt(checker, receiver) === receiverSymbol) {
      const key = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : staticRuntimeKey(current.argumentExpression);
      return key === undefined || key === propertyName;
    }
  }
  let found = false;
  ts.forEachChild(current, (child) => {
    if (!found && propertyWriteHitsSymbol(checker, child, receiverSymbol, propertyName)) found = true;
  });
  return found;
}

/** Prove the global builtin method used by the narrow exception was not replaced or escaped. */
function globalBuiltinPropertyIsStable(
  ctx: CheckerContext,
  receiverSymbol: ts.Symbol,
  receiverName: string,
  propertyName: string,
  fallback: ts.SourceFile,
): boolean {
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (ts.isIdentifier(node) && node.text === "globalThis") {
      stable = false;
      return;
    }
    if (ts.isWithStatement(node)) {
      stable = false;
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapRuntimeNoOps(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        stable = false;
        return;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (assignmentTargetContainsSymbol(ctx.checker, node.left, receiverSymbol) ||
        propertyWriteHitsSymbol(ctx.checker, node.left, receiverSymbol, propertyName))
    ) {
      stable = false;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (assignmentTargetContainsSymbol(ctx.checker, node.operand, receiverSymbol) ||
        propertyWriteHitsSymbol(ctx.checker, node.operand, receiverSymbol, propertyName))
    ) {
      stable = false;
      return;
    }
    if (
      ts.isDeleteExpression(node) &&
      (assignmentTargetContainsSymbol(ctx.checker, node.expression, receiverSymbol) ||
        propertyWriteHitsSymbol(ctx.checker, node.expression, receiverSymbol, propertyName))
    ) {
      stable = false;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingNameContainsText(node.name, receiverName) &&
      assignmentTargetContainsSymbol(ctx.checker, node.name, receiverSymbol)
    ) {
      stable = false;
      return;
    }
    if (ts.isIdentifier(node) && symbolAt(ctx.checker, node) === receiverSymbol) {
      const parent = node.parent;
      if (
        ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node) ||
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
        (ts.isTypeOfExpression(parent) && parent.expression === node)
      ) {
        return;
      }
      // Passing/returning/aliasing the constructor lets unmodelled code replace
      // the selected static member, so the builtin is no longer trusted.
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of ctx.callableSourceFiles ?? [fallback]) visit(sourceFile);
  return stable;
}

function globalObjectDefinePropertyCall(
  ctx: CheckerContext,
  call: ts.CallExpression,
): { receiver: ts.Expression; key: string } | undefined {
  const callee = unwrapRuntimeNoOps(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "defineProperty" ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object"
  ) {
    return undefined;
  }
  const objectSymbol = symbolAt(ctx.checker, callee.expression);
  if (
    !objectSymbol?.declarations?.some(
      (declaration) =>
        declaration.getSourceFile().isDeclarationFile &&
        /(?:^|\/)lib\..*\.d\.ts$/.test(declaration.getSourceFile().fileName),
    )
  ) {
    return undefined;
  }
  if (!globalBuiltinPropertyIsStable(ctx, objectSymbol, "Object", "defineProperty", call.getSourceFile())) {
    return undefined;
  }
  const receiver = call.arguments[0];
  const key = staticRuntimeKey(call.arguments[1]);
  const descriptorArgument = call.arguments[2];
  const descriptor =
    descriptorArgument && !ts.isSpreadElement(descriptorArgument) ? unwrapRuntimeNoOps(descriptorArgument) : undefined;
  return receiver &&
    key !== undefined &&
    !ts.isSpreadElement(receiver) &&
    descriptor &&
    ts.isObjectLiteralExpression(descriptor) &&
    objectLiteralCarrierIsStatic(ctx, descriptor)
    ? { receiver, key }
    : undefined;
}

function directIdentifierHasSymbol(checker: ts.TypeChecker, expression: ts.Expression, symbol: ts.Symbol): boolean {
  const current = unwrapRuntimeNoOps(expression);
  return ts.isIdentifier(current) && symbolAt(checker, current) === symbol;
}

/** Reject writes to the selected property, including computed-key writes. */
function propertyIsStable(
  ctx: CheckerContext,
  receiverSymbols: ReadonlySet<ts.Symbol>,
  propertyName: string,
  fallback: ts.SourceFile,
): boolean {
  let written = false;
  const writeHits = (target: ts.Node): boolean =>
    [...receiverSymbols].some((symbol) => propertyWriteHitsSymbol(ctx.checker, target, symbol, propertyName));
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isWithStatement(node)) {
      written = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      writeHits(node.left)
    ) {
      written = true;
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && writeHits(node.operand)) {
      written = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      writeHits(node.initializer)
    ) {
      written = true;
      return;
    }
    if (ts.isDeleteExpression(node) && writeHits(node.expression)) {
      written = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapRuntimeNoOps(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        written = true;
        return;
      }
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const receiver = unwrapRuntimeNoOps(callee.expression);
        const legacyMutator = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : staticRuntimeKey(callee.argumentExpression);
        if (
          ts.isIdentifier(receiver) &&
          receiverSymbols.has(symbolAt(ctx.checker, receiver)!) &&
          ((ts.isElementAccessExpression(callee) && legacyMutator === undefined) ||
            legacyMutator === "__defineGetter__" ||
            legacyMutator === "__defineSetter__")
        ) {
          written = true;
          return;
        }
      }
      const define = globalObjectDefinePropertyCall(ctx, node);
      if (
        define &&
        [...receiverSymbols].some((symbol) => directIdentifierHasSymbol(ctx.checker, define.receiver, symbol)) &&
        define.key === propertyName
      ) {
        written = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of symbolSourceFiles(ctx, receiverSymbols, fallback)) visit(sourceFile);
  return !written;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function receiverPropertyWriteHitsSymbol(checker: ts.TypeChecker, target: ts.Node, receiverSymbol: ts.Symbol): boolean {
  const current = ts.isExpression(target) ? unwrapRuntimeNoOps(target) : target;
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const receiver = unwrapRuntimeNoOps(current.expression);
    return ts.isIdentifier(receiver) && symbolAt(checker, receiver) === receiverSymbol;
  }
  if (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isSpreadElement(current)
  ) {
    return receiverPropertyWriteHitsSymbol(checker, current.expression, receiverSymbol);
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return receiverPropertyWriteHitsSymbol(checker, current.left, receiverSymbol);
  }
  let found = false;
  ts.forEachChild(current, (child) => {
    if (!found && receiverPropertyWriteHitsSymbol(checker, child, receiverSymbol)) found = true;
  });
  return found;
}

/**
 * A factory result may be used only through properties. The factory-local
 * carrier additionally has its one intentional return and TypeScript's debug
 * defineProperty on an unrelated static key.
 */
function receiverUseIsClosed(
  ctx: CheckerContext,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  returnedBy: ts.FunctionDeclaration | undefined,
  selectedProperty: string,
): boolean {
  let closed = true;
  const visit = (node: ts.Node): void => {
    if (!closed) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      receiverPropertyWriteHitsSymbol(ctx.checker, node.left, symbol)
    ) {
      closed = false;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      receiverPropertyWriteHitsSymbol(ctx.checker, node.operand, symbol)
    ) {
      closed = false;
      return;
    }
    if (ts.isDeleteExpression(node) && receiverPropertyWriteHitsSymbol(ctx.checker, node.expression, symbol)) {
      closed = false;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      (ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.some((item) => receiverPropertyWriteHitsSymbol(ctx.checker, item.name, symbol))
        : receiverPropertyWriteHitsSymbol(ctx.checker, node.initializer, symbol))
    ) {
      closed = false;
      return;
    }
    if (ts.isIdentifier(node) && symbolAt(ctx.checker, node) === symbol) {
      if (node === declaration.name) return;
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node
      ) {
        return;
      }
      if (
        returnedBy &&
        ts.isReturnStatement(parent) &&
        parent.expression === node &&
        enclosingFunction(parent) === returnedBy
      ) {
        return;
      }
      if (ts.isCallExpression(parent)) {
        const define = globalObjectDefinePropertyCall(ctx, parent);
        if (
          define &&
          directIdentifierHasSymbol(ctx.checker, define.receiver, symbol) &&
          define.key !== selectedProperty
        ) {
          return;
        }
      }
      closed = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of symbolSourceFiles(ctx, [symbol], declaration.getSourceFile())) visit(sourceFile);
  return closed;
}

function factoryObjectLiteral(
  ctx: CheckerContext,
  factory: ts.FunctionDeclaration,
): { literal: ts.ObjectLiteralExpression; symbol?: ts.Symbol; declaration?: ts.VariableDeclaration } | undefined {
  if (!factory.body) return undefined;
  const finalStatement = [...factory.body.statements]
    .reverse()
    .find(
      (statement) =>
        !ts.isFunctionDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isEmptyStatement(statement),
    );
  if (!finalStatement || !ts.isReturnStatement(finalStatement) || !finalStatement.expression) return undefined;
  const returns = outerReturns(factory.body);
  if (returns.length === 0) return undefined;
  let resolved:
    | { literal: ts.ObjectLiteralExpression; symbol?: ts.Symbol; declaration?: ts.VariableDeclaration }
    | undefined;
  for (const statement of returns) {
    if (!statement.expression) return undefined;
    const expression = unwrapRuntimeNoOps(statement.expression);
    let candidate: typeof resolved;
    if (ts.isObjectLiteralExpression(expression)) {
      candidate = { literal: expression };
    } else if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(ctx.checker, expression);
      const declaration = symbol ? variableDeclaration(symbol) : undefined;
      const initializer = declaration?.initializer ? unwrapRuntimeNoOps(declaration.initializer) : undefined;
      if (!symbol || !declaration || !initializer || !ts.isObjectLiteralExpression(initializer)) return undefined;
      candidate = { literal: initializer, symbol, declaration };
    } else {
      return undefined;
    }
    if (resolved && resolved.literal !== candidate.literal) return undefined;
    resolved = candidate;
  }
  return resolved;
}

function shorthandValueSymbol(
  checker: ts.TypeChecker,
  property: ts.ShorthandPropertyAssignment,
): ts.Symbol | undefined {
  const extended = checker as ts.TypeChecker & {
    getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
  };
  return canonicalSymbol(
    checker,
    extended.getShorthandAssignmentValueSymbol?.(property) ?? checker.getSymbolAtLocation(property.name),
  );
}

function containsThis(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function identifierBackedCallableIsStatic(ctx: CheckerContext, symbol: ts.Symbol, location: ts.Node): boolean {
  const type = ctx.checker.getTypeOfSymbolAtLocation(symbol, location);
  if (type.getCallSignatures().length === 0) return true;

  const functionDeclarations = symbol.declarations?.filter(ts.isFunctionDeclaration) ?? [];
  if (functionDeclarations.length > 0) {
    const implementations = functionDeclarations.filter((declaration) => declaration.body !== undefined);
    return (
      implementations.length === 1 &&
      implementations[0] !== undefined &&
      functionBindingIsStable(ctx, implementations[0], location.getSourceFile()) &&
      !containsThis(implementations[0].body!) &&
      !hasDynamicBindingHazard(implementations[0], true)
    );
  }

  const declaration = variableDeclaration(symbol);
  if (!declaration?.initializer) return false;
  const initializer = unwrapRuntimeNoOps(declaration.initializer);
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) return false;
  return (
    bindingIsStable(ctx, symbol, location.getSourceFile(), new Set([declaration])) &&
    !containsThis(initializer) &&
    !hasDynamicBindingHazard(initializer, true)
  );
}

function isStaticNonCallableLiteral(expression: ts.Expression): boolean {
  if (
    ts.isLiteralExpression(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return ts.isNumericLiteral(expression.operand);
  }
  return ts.isVoidExpression(expression) && ts.isNumericLiteral(expression.expression);
}

/**
 * Spreads/computed keys can replace the selected method without a visible
 * property assignment. `this` in any carrier callable can mutate the selected
 * slot through the runtime receiver even though no lexical receiver symbol is
 * present, so this deliberately rejects the entire such carrier family.
 */
function objectLiteralCarrierIsStatic(ctx: CheckerContext, literal: ts.ObjectLiteralExpression): boolean {
  for (const property of literal.properties) {
    const propertyName = staticPropertyName(property.name);
    if (ts.isSpreadAssignment(property) || propertyName === undefined || propertyName === "__proto__") return false;
    if (containsThis(property)) return false;

    let symbol: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(property)) {
      symbol = shorthandValueSymbol(ctx.checker, property);
    } else if (ts.isPropertyAssignment(property)) {
      const value = unwrapRuntimeNoOps(property.initializer);
      if (ts.isIdentifier(value)) {
        symbol = symbolAt(ctx.checker, value);
        if (!symbol && value.text !== "undefined") return false;
      } else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        if (containsThis(value) || hasDynamicBindingHazard(value, true)) return false;
      } else if (!isStaticNonCallableLiteral(value)) {
        // Calls, property reads, conditionals, object/array construction, and
        // other computed values can hide a callable that mutates the selected
        // carrier slot through its runtime `this`.
        return false;
      }
    }
    if (symbol && !identifierBackedCallableIsStatic(ctx, symbol, property)) return false;
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body && containsThis(declaration.body)) return false;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && containsThis(declaration.initializer)) {
        return false;
      }
    }
  }
  return true;
}

function objectPropertyFunction(
  ctx: CheckerContext,
  literal: ts.ObjectLiteralExpression,
  propertyName: string,
  factory: ts.FunctionDeclaration,
): ts.FunctionDeclaration | undefined {
  const matches = literal.properties.filter((property) => staticPropertyName(property.name) === propertyName);
  if (matches.length !== 1) return undefined;
  const property = matches[0]!;
  let symbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(property)) {
    symbol = shorthandValueSymbol(ctx.checker, property);
  } else if (ts.isPropertyAssignment(property)) {
    const value = unwrapRuntimeNoOps(property.initializer);
    if (ts.isIdentifier(value)) symbol = symbolAt(ctx.checker, value);
  }
  const implementation = symbol
    ?.getDeclarations()
    ?.find(
      (candidate): candidate is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
    );
  if (
    !implementation ||
    implementation.parent !== factory.body ||
    !functionBindingIsStable(ctx, implementation, factory.getSourceFile())
  ) {
    return undefined;
  }
  return implementation;
}

/** Follow `scanner = createScanner()` to its returned shorthand method body. */
function propertyForwardingDeclaration(
  ctx: CheckerContext,
  expression: ts.Expression,
): ts.FunctionDeclaration | undefined {
  const property = propertyReceiverAndName(ctx.checker, expression);
  if (!property) return undefined;
  const receiverDeclaration = variableDeclaration(property.receiverSymbol);
  const initializer = receiverDeclaration?.initializer
    ? unwrapRuntimeNoOps(receiverDeclaration.initializer)
    : undefined;
  if (!receiverDeclaration || !initializer || !ts.isCallExpression(initializer)) return undefined;
  if (
    !bindingIsStable(ctx, property.receiverSymbol, property.receiver.getSourceFile(), new Set([receiverDeclaration]))
  ) {
    return undefined;
  }

  const factory = directFunctionDeclarationForCall(ctx.checker, initializer);
  const factoryIsAsync = factory?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
  if (
    !factory?.body ||
    factory.asteriskToken ||
    factoryIsAsync ||
    hasDynamicBindingHazard(factory, true) ||
    !sourceBelongsToProgram(ctx, factory.getSourceFile())
  ) {
    return undefined;
  }
  if (!functionBindingIsStable(ctx, factory, initializer.getSourceFile())) return undefined;
  const object = factoryObjectLiteral(ctx, factory);
  if (!object || !objectLiteralCarrierIsStatic(ctx, object.literal)) return undefined;
  const implementation = objectPropertyFunction(ctx, object.literal, property.name, factory);
  if (!implementation) return undefined;

  if (
    !receiverUseIsClosed(ctx, property.receiverSymbol, receiverDeclaration, undefined, property.name) ||
    (object.symbol && object.declaration
      ? !bindingIsStable(ctx, object.symbol, factory.getSourceFile(), new Set([object.declaration])) ||
        !receiverUseIsClosed(ctx, object.symbol, object.declaration, factory, property.name)
      : false) ||
    !propertyIsStable(
      ctx,
      new Set([property.receiverSymbol, ...(object.symbol ? [object.symbol] : [])]),
      property.name,
      property.receiver.getSourceFile(),
    )
  ) {
    return undefined;
  }
  return implementation;
}

function exactCallbackIdentifier(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  callbackSymbol: ts.Symbol,
): boolean {
  const current = unwrapRuntimeNoOps(expression);
  return ts.isIdentifier(current) && symbolAt(checker, current) === callbackSymbol;
}

function forwardedDeclaration(ctx: CheckerContext, call: ts.CallExpression): ts.FunctionDeclaration | undefined {
  const direct = directFunctionDeclarationForCall(ctx.checker, call);
  if (direct) return functionBindingIsStable(ctx, direct, call.getSourceFile()) ? direct : undefined;
  return propertyForwardingDeclaration(ctx, call.expression);
}

function typeContainsUnprovenCarrier(type: ts.Type): boolean {
  if (
    (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)) !==
    0
  ) {
    return true;
  }
  if (type.isUnionOrIntersection()) return type.types.some(typeContainsUnprovenCarrier);
  return false;
}

/**
 * Admit the incremental-parser fallback shape without opening the generic
 * carrier proof to arbitrary assertions:
 *
 *     function parse<T extends Node | undefined>(callback: () => T): T {
 *       if (node) return consumeNode(node) as T;
 *       return callback();
 *     }
 *
 * The value beneath `as T` must already be assignable to T's declared
 * constraint. `unknown as T`, `any as T`, sibling type parameters, and an
 * unconstrained T therefore remain outside the proof. The assertion is useful
 * physical-ABI evidence: the shared result must retain the source value rather
 * than freezing the function to one concrete callback instantiation.
 */
function constraintBackedResultAssertion(
  checker: ts.TypeChecker,
  resultTypeParameter: ts.Type,
  expression: ts.Expression,
): boolean {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isAsExpression(current) && !ts.isTypeAssertionExpression(current)) return false;

  const assertedType = checker.getTypeAtLocation(current.type);
  if (!sameTypeParameter(assertedType, resultTypeParameter)) return false;

  const constraint = checker.getBaseConstraintOfType(resultTypeParameter);
  if (!constraint || typeContainsUnprovenCarrier(constraint)) return false;
  const sourceType = checker.getTypeAtLocation(current.expression);
  return !typeContainsUnprovenCarrier(sourceType) && checker.isTypeAssignableTo(sourceType, constraint);
}

function callbackDerivedExpression(
  ctx: CheckerContext,
  owner: ts.FunctionDeclaration,
  ownerResultTypeParameter: ts.Type,
  callbackSymbol: ts.Symbol,
  expression: ts.Expression,
  seenLocals: Set<ts.Symbol>,
): boolean {
  if (constraintBackedResultAssertion(ctx.checker, ownerResultTypeParameter, expression)) return true;
  const current = unwrapRuntimeNoOps(expression);
  if (ts.isConditionalExpression(current)) {
    return (
      callbackDerivedExpression(
        ctx,
        owner,
        ownerResultTypeParameter,
        callbackSymbol,
        current.whenTrue,
        new Set(seenLocals),
      ) &&
      callbackDerivedExpression(
        ctx,
        owner,
        ownerResultTypeParameter,
        callbackSymbol,
        current.whenFalse,
        new Set(seenLocals),
      )
    );
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapRuntimeNoOps(current.expression);
    if (
      ts.isIdentifier(callee) &&
      symbolAt(ctx.checker, callee) === callbackSymbol &&
      current.arguments.length === 0 &&
      !current.typeArguments?.length
    ) {
      return true;
    }

    const declaration = forwardedDeclaration(ctx, current);
    const descriptor = declaration ? genericCallbackResultDeclaration(ctx, declaration) : null;
    const argument = descriptor ? current.arguments[descriptor.callbackParameterIndex] : undefined;
    const resolved = ctx.checker.getResolvedSignature(current);
    const resultType = resolved ? ctx.checker.getReturnTypeOfSignature(resolved) : undefined;
    return (
      argument !== undefined &&
      !ts.isSpreadElement(argument) &&
      exactCallbackIdentifier(ctx.checker, argument, callbackSymbol) &&
      resultType !== undefined &&
      sameTypeParameter(resultType, ownerResultTypeParameter)
    );
  }

  if (!ts.isIdentifier(current)) return false;
  const localSymbol = symbolAt(ctx.checker, current);
  if (!localSymbol || seenLocals.has(localSymbol)) return false;
  const declaration = variableDeclaration(localSymbol);
  if (!declaration?.initializer || !ts.isIdentifier(declaration.name)) return false;
  const declarationList = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    (declarationList.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isVariableStatement(declarationList.parent) ||
    declarationList.parent.parent !== owner.body ||
    !bindingIsStable(ctx, localSymbol, owner.getSourceFile(), new Set([declaration])) ||
    !localBindingSyntaxIsStatic(owner, declaration)
  ) {
    return false;
  }
  seenLocals.add(localSymbol);
  return callbackDerivedExpression(
    ctx,
    owner,
    ownerResultTypeParameter,
    callbackSymbol,
    declaration.initializer,
    seenLocals,
  );
}

function bodyReturnsCallbackResult(
  ctx: CheckerContext,
  declaration: ts.FunctionDeclaration,
  callbackParameterIndex: number,
  resultTypeParameter: ts.Type,
): boolean {
  const body = declaration.body;
  const callbackParameter = declaration.parameters[callbackParameterIndex];
  if (!body || !callbackParameter || !ts.isIdentifier(callbackParameter.name)) return false;
  if (!callbackBindingSyntaxIsStatic(declaration, callbackParameter)) return false;
  const callbackSymbol = symbolAt(ctx.checker, callbackParameter.name);
  if (
    !callbackSymbol ||
    !bindingIsStable(ctx, callbackSymbol, declaration.getSourceFile(), new Set([callbackParameter]))
  ) {
    return false;
  }

  // A final explicit return avoids claiming a function with an implicit
  // undefined fallthrough. Every outer return must carry either the same
  // proven callback origin or a constraint-backed `as T` value; returns in
  // nested functions/classes do not count.
  const finalStatement = body.statements[body.statements.length - 1];
  if (!finalStatement || !ts.isReturnStatement(finalStatement) || !finalStatement.expression) return false;
  const returns = outerReturns(body);
  return (
    returns.length > 0 &&
    returns.every(
      (statement) =>
        statement.expression !== undefined &&
        callbackDerivedExpression(
          ctx,
          declaration,
          resultTypeParameter,
          callbackSymbol,
          statement.expression,
          new Set(),
        ),
    )
  );
}

/**
 * Recognize only the exact semantic `<T>(callback: () => T, ...): T` contract.
 *
 * This is intentionally narrower than "a generic function taking a callable":
 * the result must be one of this declaration's own type parameters; exactly
 * one required ordinary parameter must be a non-constructible, non-overloaded,
 * zero-argument callable returning that same type parameter. Optional/rest
 * callbacks, callback overloads, wrapped results (`T | undefined`), and a
 * callback returning a sibling type parameter all fail closed. Alternate
 * result paths are limited to explicit `as T` assertions whose source type is
 * already within T's declared constraint.
 */
export function genericCallbackResultDeclaration(
  ctx: CheckerContext,
  declaration: ts.FunctionDeclaration,
): GenericCallbackResultDeclaration | null {
  let checkerMemo = declarationMemo.get(ctx);
  if (!checkerMemo) {
    checkerMemo = new WeakMap();
    declarationMemo.set(ctx, checkerMemo);
  }
  const cached = checkerMemo.get(declaration);
  if (cached !== undefined) return cached === "visiting" ? null : cached;

  const isAsync = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
  if (
    !declaration.body ||
    !declaration.typeParameters?.length ||
    declaration.asteriskToken ||
    isAsync ||
    !ts.isExternalModule(declaration.getSourceFile()) ||
    !hasUniqueBodyImplementation(ctx, declaration) ||
    !functionBindingIsStable(ctx, declaration, declaration.getSourceFile())
  ) {
    checkerMemo.set(declaration, null);
    return null;
  }
  checkerMemo.set(declaration, "visiting");

  const signature = ctx.checker.getSignatureFromDeclaration(declaration);
  if (!signature) {
    checkerMemo.set(declaration, null);
    return null;
  }
  const resultTypeParameter = ctx.checker.getReturnTypeOfSignature(signature);
  if ((resultTypeParameter.flags & ts.TypeFlags.TypeParameter) === 0) {
    checkerMemo.set(declaration, null);
    return null;
  }

  const ownsResult = declaration.typeParameters.some((parameter) =>
    sameTypeParameter(ctx.checker.getTypeAtLocation(parameter.name), resultTypeParameter),
  );
  if (!ownsResult) {
    checkerMemo.set(declaration, null);
    return null;
  }

  const callbackParameterIndices: number[] = [];
  declaration.parameters.forEach((parameter, index) => {
    if (parameter.questionToken || parameter.dotDotDotToken || parameter.initializer) return;
    const callbackResult = zeroArgumentResult(ctx.checker, ctx.checker.getTypeAtLocation(parameter));
    if (callbackResult && sameTypeParameter(callbackResult, resultTypeParameter)) {
      callbackParameterIndices.push(index);
    }
  });

  if (callbackParameterIndices.length !== 1) {
    checkerMemo.set(declaration, null);
    return null;
  }

  const callbackParameterIndex = callbackParameterIndices[0]!;
  if (!bodyReturnsCallbackResult(ctx, declaration, callbackParameterIndex, resultTypeParameter)) {
    checkerMemo.set(declaration, null);
    return null;
  }

  const result: GenericCallbackResultDeclaration = {
    declaration,
    callbackParameterIndex,
    resultTypeParameter,
  };
  checkerMemo.set(declaration, result);
  return result;
}

/**
 * Resolve the concrete callback/result pair for a direct call of a proven
 * generic callback-result declaration.
 *
 * Both types are retained because they answer different integration questions:
 * callback lowering needs the producer's result, while expression lowering
 * needs the generic call's instantiated result. This helper does not claim the
 * two TypeScript type objects are identical (inference may widen a literal),
 * and it emits no coercion by itself.
 */
export function genericCallbackResultCall(
  ctx: CheckerContext,
  call: ts.CallExpression,
): GenericCallbackResultCall | null {
  const declaration = directFunctionDeclarationForCall(ctx.checker, call);
  if (!declaration || !functionBindingIsStable(ctx, declaration, call.getSourceFile())) return null;
  const descriptor = genericCallbackResultDeclaration(ctx, declaration);
  if (!descriptor) return null;

  const callbackArgument = call.arguments[descriptor.callbackParameterIndex];
  if (!callbackArgument || ts.isSpreadElement(callbackArgument)) return null;
  const callbackResultType = zeroArgumentResult(ctx.checker, ctx.checker.getTypeAtLocation(callbackArgument));
  if (!callbackResultType) return null;

  const resolved = ctx.checker.getResolvedSignature(call);
  if (!resolved) return null;
  const resultType = ctx.checker.getReturnTypeOfSignature(resolved);

  return {
    ...descriptor,
    call,
    callbackArgument,
    callbackResultType,
    resultType,
  };
}
