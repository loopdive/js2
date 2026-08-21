// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";

export interface IrInjectedTimerShimCertification {
  readonly declaration: ts.FunctionDeclaration & { readonly name: ts.Identifier; readonly body: ts.Block };
  readonly hostDeclaration: ts.FunctionDeclaration & { readonly name: ts.Identifier };
  readonly call: ts.CallExpression;
}

export type IrPreparedTimerShimProof = (declaration: ts.FunctionDeclaration) => boolean;

interface IrPreparedTimerShimSelectionOptions {
  readonly isPreparedInjectedTimerShim?: IrPreparedTimerShimProof;
}

function symbolAt(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(node);
}

/** Prove the exact compiler-injected #1501 setTimeout wrapper. */
export function certifyExactInjectedTimerShim(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): IrInjectedTimerShimCertification | undefined {
  if (
    !ts.isFunctionDeclaration(declaration) ||
    !declaration.name ||
    declaration.name.text !== "setTimeout" ||
    declaration.asteriskToken ||
    (declaration.typeParameters?.length ?? 0) !== 0 ||
    declaration.modifiers?.length ||
    declaration.parameters.length !== 2 ||
    !declaration.body ||
    declaration.body.statements.length !== 1 ||
    !ts.isIdentifier(declaration.parameters[0]!.name) ||
    !ts.isIdentifier(declaration.parameters[1]!.name) ||
    declaration.parameters.some(
      (parameter) =>
        parameter.questionToken || parameter.dotDotDotToken || parameter.initializer || parameter.modifiers?.length,
    )
  ) {
    return undefined;
  }
  const sourceFile = declaration.getSourceFile();
  if (!sourceFile.text.startsWith("// #1501 timer host-import shim (auto-injected)")) return undefined;
  const callbackType = declaration.parameters[0]!.type;
  const delayType = declaration.parameters[1]!.type;
  if (
    !callbackType ||
    !ts.isFunctionTypeNode(callbackType) ||
    callbackType.parameters.length !== 0 ||
    callbackType.type.kind !== ts.SyntaxKind.VoidKeyword ||
    (callbackType.typeParameters?.length ?? 0) !== 0 ||
    delayType?.kind !== ts.SyntaxKind.NumberKeyword ||
    declaration.type?.kind !== ts.SyntaxKind.NumberKeyword
  ) {
    return undefined;
  }
  const statement = declaration.body.statements[0]!;
  if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isCallExpression(statement.expression)) {
    return undefined;
  }
  const call = statement.expression;
  if (
    call.questionDotToken ||
    (call.typeArguments?.length ?? 0) !== 0 ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "__timer_set_timeout" ||
    call.arguments.length !== 2 ||
    !ts.isIdentifier(call.arguments[0]!) ||
    !ts.isIdentifier(call.arguments[1]!)
  ) {
    return undefined;
  }
  const callbackSymbol = symbolAt(declaration.parameters[0]!.name, checker);
  const delaySymbol = symbolAt(declaration.parameters[1]!.name, checker);
  if (
    symbolAt(call.arguments[0]!, checker) !== callbackSymbol ||
    symbolAt(call.arguments[1]!, checker) !== delaySymbol
  ) {
    return undefined;
  }
  const hostSymbol = symbolAt(call.expression, checker);
  const hostDeclaration = hostSymbol?.valueDeclaration ?? hostSymbol?.declarations?.[0];
  if (
    !hostDeclaration ||
    !ts.isFunctionDeclaration(hostDeclaration) ||
    !hostDeclaration.name ||
    hostDeclaration.name.text !== "__timer_set_timeout" ||
    hostDeclaration.body ||
    hostDeclaration.getSourceFile() !== sourceFile ||
    hostDeclaration.parameters.length !== 2 ||
    hostDeclaration.parameters.some(
      (parameter) =>
        parameter.type?.kind !== ts.SyntaxKind.AnyKeyword ||
        parameter.questionToken ||
        parameter.dotDotDotToken ||
        parameter.initializer,
    ) ||
    hostDeclaration.type?.kind !== ts.SyntaxKind.AnyKeyword ||
    sourceFile.statements[0] !== hostDeclaration ||
    sourceFile.statements[1] !== declaration
  ) {
    return undefined;
  }
  return {
    declaration: declaration as typeof declaration & { readonly name: ts.Identifier; readonly body: ts.Block },
    hostDeclaration: hostDeclaration as typeof hostDeclaration & { readonly name: ts.Identifier },
    call,
  };
}

export function isExactInjectedTimerShim(declaration: ts.Declaration, checker: ts.TypeChecker): boolean {
  return certifyExactInjectedTimerShim(declaration, checker) !== undefined;
}

/** Bound prepared ownership to one direct call and no first-class escape. */
export function isPreparedInjectedTimerShimOwner(declaration: ts.Declaration, checker: ts.TypeChecker): boolean {
  const certified = certifyExactInjectedTimerShim(declaration, checker);
  if (!certified) return false;
  const shimSymbol = symbolAt(certified.declaration.name, checker);
  if (!shimSymbol) return false;
  let directCallCount = 0;
  let valid = true;
  const visit = (node: ts.Node): void => {
    if (!valid) return;
    if (ts.isIdentifier(node) && symbolAt(node, checker) === shimSymbol) {
      if (node === certified.declaration.name) {
        // The declaration itself is the one non-use occurrence.
      } else if (
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        !node.parent.questionDotToken &&
        (node.parent.typeArguments?.length ?? 0) === 0
      ) {
        directCallCount++;
      } else {
        valid = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(certified.declaration.getSourceFile());
  return valid && directCallCount === 1;
}

/** Pair the checker proof with the exact self-owned compiler terminal. */
export function isPreparedTimerShimSelectionCandidate(
  identityContext: IrPlanningIdentityContext,
  unitId: IrUnitId,
  declaration: ts.FunctionDeclaration,
  provePreparedOwner: IrPreparedTimerShimProof | undefined,
): boolean {
  const terminal = identityContext.terminalByUnitId.get(unitId);
  return (
    identityContext.inventory.sources.length === 1 &&
    terminal?.kind === "synthetic-support" &&
    terminal.syntheticRole === "compiler-unit:timer-shim:set-timeout" &&
    terminal.terminalOwnerId === terminal.id &&
    terminal.lexicalOwnerId === null &&
    identityContext.unitByUnitId.get(terminal.id) === terminal &&
    identityContext.declarationByUnitId.get(terminal.id) === declaration &&
    provePreparedOwner?.(declaration) === true
  );
}

/** Pre-claim exact timer terminals so the generic structural selector never sees their host call. */
export function claimPreparedTimerShims<T extends { readonly unitId: IrUnitId }>(
  identityContext: IrPlanningIdentityContext,
  functions: readonly { readonly unit: T; readonly declaration: ts.FunctionDeclaration }[],
  options: IrPreparedTimerShimSelectionOptions,
  claims: Map<IrUnitId, T>,
): ReadonlySet<IrUnitId> {
  const claimed = new Set<IrUnitId>();
  for (const indexed of functions) {
    if (
      !isPreparedTimerShimSelectionCandidate(
        identityContext,
        indexed.unit.unitId,
        indexed.declaration,
        options.isPreparedInjectedTimerShim,
      )
    ) {
      continue;
    }
    claimed.add(indexed.unit.unitId);
    claims.set(indexed.unit.unitId, indexed.unit);
  }
  return claimed;
}
