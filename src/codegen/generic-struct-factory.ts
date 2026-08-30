// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { readonlyErasureMappedAliasTarget } from "./readonly-erasure-mapped-type.js";

interface GenericStructFactoryDeclaration {
  declaration: ts.FunctionDeclaration;
  /** Present for the `T extends Struct` factory form used by wrapper chains. */
  resultTypeParameter?: ts.Type;
  sourceConstraint: ts.Type;
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

function functionDeclarationForCall(ctx: CodegenContext, call: ts.CallExpression): ts.FunctionDeclaration | undefined {
  const callee = unwrapExpression(call.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  // Prefer the checker symbol at this exact call site. Program-ABI replay can
  // compile nested same-named factories from different source components; the
  // lightweight binder's value declaration may then point at a sibling replay
  // declaration even though the checker still retains the source-qualified
  // identity (`baseNodeFactory.createBaseNode` vs nodeFactory's generic helper).
  const checkerDeclaration = ctx.checker
    .getSymbolAtLocation(callee)
    ?.getDeclarations()
    ?.find((candidate): candidate is ts.FunctionDeclaration => ts.isFunctionDeclaration(candidate) && !!candidate.body);
  if (checkerDeclaration) return checkerDeclaration;
  const declaration = ctx.oracle.valueDeclarationOf(callee);
  if (declaration && ts.isFunctionDeclaration(declaration)) return declaration;
  return undefined;
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

  const declaration = functionDeclarationForCall(ctx, call);
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
  return (
    ctx.checker.isTypeAssignableTo(operandType, sourceConstraint) ||
    ctx.checker.isTypeAssignableTo(sourceConstraint, operandType)
  );
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
 * call/new result whose asserted structural type narrows that source. Ordinary
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
  if (!ts.isCallExpression(operand) && !ts.isNewExpression(operand)) return undefined;
  if (ts.isCallExpression(operand) && !provenFreshFactoryCall(ctx, operand)) return undefined;
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
  const seedDeclaration = functionDeclarationForCall(ctx, initializer);
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

  const admitted =
    directFactoryReturn(ctx, declaration, resultTypeParameter, sourceConstraint) ||
    wrapperFactoryReturn(ctx, declaration, resultTypeParameter);
  if (!admitted) {
    memo.set(declaration, null);
    return null;
  }

  const descriptor = { declaration, resultTypeParameter, sourceConstraint };
  memo.set(declaration, descriptor);
  return descriptor;
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
  const declaration = functionDeclarationForCall(ctx, call);
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
