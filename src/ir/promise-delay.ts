// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2856) Exact checker-backed certification for the playground's Promise
// delay helper.  This is deliberately a leaf module: production planning and
// the fallback gate must ask the same question without importing codegen.

import { ts } from "../ts-api.js";
import { isExactInjectedTimerShim } from "./injected-timer-shim.js";

export interface IrPromiseDelayCertification {
  readonly owner: ts.FunctionDeclaration & { readonly name: ts.Identifier; readonly body: ts.Block };
  readonly construction: ts.NewExpression;
  readonly executor: ts.ArrowFunction & { readonly body: ts.Block };
  readonly timerCall: ts.CallExpression;
  readonly timerCallback: ts.ArrowFunction;
  readonly resolveCall: ts.CallExpression;
  /** Ordered exactly as closure fields must be materialised. */
  readonly executorCaptureNames: readonly string[];
  /** Ordered exactly as closure fields must be materialised. */
  readonly timerCaptureNames: readonly string[];
  /** Source-preorder lift ordinals; lowering rechecks the resulting names. */
  readonly executorOrdinal: number;
  readonly timerOrdinal: number;
}

export interface IrPromiseDelayResolver {
  resolve(construction: ts.NewExpression): IrPromiseDelayCertification | undefined;
  resolveOwner(owner: ts.FunctionDeclaration): IrPromiseDelayCertification | undefined;
}

function hasAsyncModifier(node: ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

function symbolAt(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(node);
}

function isVoidType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Void) !== 0;
}

function isExactlyNumberType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Number) !== 0;
}

function isPromiseNumberType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const nonNullable = checker.getNonNullableType(type);
  const symbol = nonNullable.aliasSymbol ?? nonNullable.getSymbol();
  if (symbol?.name !== "Promise" || (nonNullable.flags & ts.TypeFlags.Object) === 0) return false;
  try {
    const args = checker.getTypeArguments(nonNullable as ts.TypeReference);
    return args.length === 1 && isExactlyNumberType(args[0]!);
  } catch {
    return false;
  }
}

function isAmbientPromise(node: ts.Identifier, construction: ts.NewExpression, checker: ts.TypeChecker): boolean {
  const symbol = symbolAt(node, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !declaration.getSourceFile().isDeclarationFile) return false;
  const signature = checker.getResolvedSignature(construction);
  if (!signature?.declaration?.getSourceFile().isDeclarationFile) return false;
  return isPromiseNumberType(checker.getTypeAtLocation(construction), checker);
}

function isCertifiedTimerBinding(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "setTimeout") return false;
  const symbol = symbolAt(call.expression, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !signatureDeclaration) return false;
  if (declaration.getSourceFile().isDeclarationFile) {
    return signatureDeclaration.getSourceFile().isDeclarationFile;
  }
  return declaration === signatureDeclaration && isExactInjectedTimerShim(declaration, checker);
}

function symbolOccursOnlyAt(
  root: ts.Node,
  target: ts.Symbol,
  allowed: ReadonlySet<ts.Identifier>,
  checker: ts.TypeChecker,
): boolean {
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(node, checker) === target && !allowed.has(node)) {
      valid = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return valid;
}

function closureOrdinals(owner: ts.FunctionDeclaration): ReadonlyMap<ts.FunctionLikeDeclaration, number> {
  const ordinals = new Map<ts.FunctionLikeDeclaration, number>();
  let next = 0;
  const visit = (node: ts.Node): void => {
    if (
      node !== owner &&
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    ) {
      ordinals.set(node, next++);
    }
    ts.forEachChild(node, visit);
  };
  if (owner.body) visit(owner.body);
  return ordinals;
}

/**
 * Certify only this relationship (identifier spellings may differ):
 *
 *   function f(ms: number, value: number): Promise<number> {
 *     return new Promise<number>((resolve) => {
 *       setTimeout(() => resolve(value), ms);
 *     });
 *   }
 *
 * Symbol identity proves all three data edges.  Promise and setTimeout must
 * be ambient globals, except for the compiler's exact #1501 timer shim.
 */
export function makeIrPromiseDelayResolver(checker: ts.TypeChecker): IrPromiseDelayResolver {
  const byConstruction = new WeakMap<ts.NewExpression, IrPromiseDelayCertification | null>();

  const resolve = (construction: ts.NewExpression): IrPromiseDelayCertification | undefined => {
    const cached = byConstruction.get(construction);
    if (cached !== undefined) return cached ?? undefined;
    let certification: IrPromiseDelayCertification | undefined;
    try {
      const returnStatement = construction.parent;
      const ownerBody = returnStatement.parent;
      const owner = ownerBody.parent;
      if (
        !ts.isReturnStatement(returnStatement) ||
        returnStatement.expression !== construction ||
        !ts.isBlock(ownerBody) ||
        ownerBody.statements.length !== 1 ||
        !ts.isFunctionDeclaration(owner) ||
        !owner.name ||
        owner.body !== ownerBody ||
        !ts.isSourceFile(owner.parent) ||
        owner.asteriskToken ||
        hasAsyncModifier(owner) ||
        (owner.typeParameters?.length ?? 0) !== 0 ||
        owner.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword) ||
        owner.parameters.length !== 2 ||
        !ts.isIdentifier(owner.parameters[0]!.name) ||
        !ts.isIdentifier(owner.parameters[1]!.name) ||
        owner.parameters.some(
          (parameter) =>
            parameter.questionToken ||
            parameter.dotDotDotToken ||
            parameter.initializer ||
            parameter.type?.kind !== ts.SyntaxKind.NumberKeyword,
        ) ||
        !owner.type ||
        !ts.isTypeReferenceNode(owner.type) ||
        !ts.isIdentifier(owner.type.typeName) ||
        owner.type.typeName.text !== "Promise" ||
        owner.type.typeArguments?.length !== 1 ||
        owner.type.typeArguments[0]!.kind !== ts.SyntaxKind.NumberKeyword ||
        !ts.isIdentifier(construction.expression) ||
        construction.expression.text !== "Promise" ||
        construction.typeArguments?.length !== 1 ||
        construction.typeArguments[0]!.kind !== ts.SyntaxKind.NumberKeyword ||
        construction.arguments?.length !== 1 ||
        !ts.isArrowFunction(construction.arguments[0]!)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      const executor = construction.arguments[0]!;
      if (
        executor.parameters.length !== 1 ||
        !ts.isIdentifier(executor.parameters[0]!.name) ||
        executor.parameters[0]!.questionToken ||
        executor.parameters[0]!.dotDotDotToken ||
        executor.parameters[0]!.initializer ||
        executor.parameters[0]!.type ||
        executor.type ||
        (executor.typeParameters?.length ?? 0) !== 0 ||
        hasAsyncModifier(executor) ||
        !ts.isBlock(executor.body) ||
        executor.body.statements.length !== 1 ||
        !ts.isExpressionStatement(executor.body.statements[0]!) ||
        !ts.isCallExpression(executor.body.statements[0]!.expression)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      const timerCall = executor.body.statements[0]!.expression;
      if (
        timerCall.questionDotToken ||
        (timerCall.typeArguments?.length ?? 0) !== 0 ||
        !ts.isIdentifier(timerCall.expression) ||
        timerCall.expression.text !== "setTimeout" ||
        timerCall.arguments.length !== 2 ||
        !ts.isArrowFunction(timerCall.arguments[0]!) ||
        !ts.isIdentifier(timerCall.arguments[1]!)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }
      const timerCallback = timerCall.arguments[0]!;
      if (
        timerCallback.parameters.length !== 0 ||
        timerCallback.type ||
        (timerCallback.typeParameters?.length ?? 0) !== 0 ||
        hasAsyncModifier(timerCallback) ||
        ts.isBlock(timerCallback.body) ||
        !ts.isCallExpression(timerCallback.body)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }
      const resolveCall = timerCallback.body;
      if (
        resolveCall.questionDotToken ||
        (resolveCall.typeArguments?.length ?? 0) !== 0 ||
        !ts.isIdentifier(resolveCall.expression) ||
        resolveCall.arguments.length !== 1 ||
        !ts.isIdentifier(resolveCall.arguments[0]!)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      const msName = owner.parameters[0]!.name;
      const valueName = owner.parameters[1]!.name;
      const resolveName = executor.parameters[0]!.name;
      // The IR scope/capture materializer is spelling-keyed. Keep its keys
      // injective even though checker symbols would distinguish shadowed
      // declarations.
      if (new Set([msName.text, valueName.text, resolveName.text]).size !== 3) {
        byConstruction.set(construction, null);
        return undefined;
      }
      const msSymbol = symbolAt(msName, checker);
      const valueSymbol = symbolAt(valueName, checker);
      const resolveSymbol = symbolAt(resolveName, checker);
      if (
        !msSymbol ||
        !valueSymbol ||
        !resolveSymbol ||
        symbolAt(timerCall.arguments[1]!, checker) !== msSymbol ||
        symbolAt(resolveCall.expression, checker) !== resolveSymbol ||
        symbolAt(resolveCall.arguments[0]!, checker) !== valueSymbol ||
        !isAmbientPromise(construction.expression, construction, checker) ||
        !isCertifiedTimerBinding(timerCall, checker) ||
        !isPromiseNumberType(checker.getTypeFromTypeNode(owner.type), checker)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      const executorSignature = checker.getSignatureFromDeclaration(executor);
      const timerSignature = checker.getSignatureFromDeclaration(timerCallback);
      const resolveSignature = checker.getResolvedSignature(resolveCall);
      const ownerSignature = checker.getSignatureFromDeclaration(owner);
      if (
        !executorSignature ||
        executorSignature.parameters.length !== 1 ||
        !isVoidType(checker.getReturnTypeOfSignature(executorSignature)) ||
        !timerSignature ||
        timerSignature.parameters.length !== 0 ||
        !isVoidType(checker.getReturnTypeOfSignature(timerSignature)) ||
        !resolveSignature ||
        !isVoidType(checker.getReturnTypeOfSignature(resolveSignature)) ||
        !ownerSignature ||
        !isPromiseNumberType(checker.getReturnTypeOfSignature(ownerSignature), checker)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      // Exact syntax already prevents aliases/escapes; symbol occurrence
      // checks make that invariant explicit and protect against future AST
      // widening around this resolver.
      if (
        !symbolOccursOnlyAt(owner.body, msSymbol, new Set([msName, timerCall.arguments[1]!]), checker) ||
        !symbolOccursOnlyAt(owner.body, valueSymbol, new Set([valueName, resolveCall.arguments[0]!]), checker) ||
        !symbolOccursOnlyAt(owner.body, resolveSymbol, new Set([resolveName, resolveCall.expression]), checker)
      ) {
        byConstruction.set(construction, null);
        return undefined;
      }

      const ordinals = closureOrdinals(owner);
      const executorOrdinal = ordinals.get(executor);
      const timerOrdinal = ordinals.get(timerCallback);
      if (executorOrdinal === undefined || timerOrdinal === undefined) {
        byConstruction.set(construction, null);
        return undefined;
      }
      certification = {
        owner: owner as typeof owner & { readonly name: ts.Identifier; readonly body: ts.Block },
        construction,
        executor: executor as typeof executor & { readonly body: ts.Block },
        timerCall,
        timerCallback,
        resolveCall,
        executorCaptureNames: [msName.text, valueName.text],
        timerCaptureNames: [resolveName.text, valueName.text],
        executorOrdinal,
        timerOrdinal,
      };
    } catch {
      certification = undefined;
    }
    byConstruction.set(construction, certification ?? null);
    return certification;
  };

  return {
    resolve,
    resolveOwner(owner: ts.FunctionDeclaration): IrPromiseDelayCertification | undefined {
      if (!owner.body || owner.body.statements.length !== 1) return undefined;
      const statement = owner.body.statements[0]!;
      return ts.isReturnStatement(statement) && statement.expression && ts.isNewExpression(statement.expression)
        ? resolve(statement.expression)
        : undefined;
    },
  };
}
