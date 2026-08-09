// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

export const IR_HOST_DATE_GETTERS = new Set(["getDate", "getMonth", "getFullYear"] as const);

export interface IrHostDateSnapshotCertification {
  readonly expression: ts.NewExpression;
  readonly getterCalls: ReadonlySet<ts.CallExpression>;
}

export type IrHostDateSnapshotResolver = (expression: ts.NewExpression) => IrHostDateSnapshotCertification | undefined;

type IrHostDateSnapshotOwner = ts.FunctionDeclaration | ts.SourceFile;

function containingTopLevelOwner(node: ts.Node): IrHostDateSnapshotOwner | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  if (current && ts.isSourceFile(current)) return current;
  return current && ts.isFunctionDeclaration(current) && current.body && ts.isSourceFile(current.parent)
    ? current
    : undefined;
}

function isExactGetterCall(
  receiver: ts.Expression,
  owner: IrHostDateSnapshotOwner,
  checker: ts.TypeChecker,
): ts.CallExpression | undefined {
  const access = receiver.parent;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== receiver ||
    access.questionDotToken ||
    !IR_HOST_DATE_GETTERS.has(access.name.text as "getDate" | "getMonth" | "getFullYear")
  ) {
    return undefined;
  }
  const call = access.parent;
  if (
    !ts.isCallExpression(call) ||
    call.expression !== access ||
    call.questionDotToken ||
    (call.typeArguments?.length ?? 0) !== 0 ||
    call.arguments.length !== 0 ||
    containingTopLevelOwner(call) !== owner
  ) {
    return undefined;
  }
  const declaration = checker.getResolvedSignature(call)?.getDeclaration();
  return declaration?.getSourceFile().isDeclarationFile === true ? call : undefined;
}

/**
 * Certify the intentionally tiny host Date snapshot surface used by Calendar.
 * A snapshot is either an immediate `new Date().get*()` receiver or a `const`
 * local used only by zero-argument getDate/getMonth/getFullYear calls in the
 * same top-level function. Module init additionally admits only the immediate
 * `new Date().get*()` form, so it needs no externref-backed module storage.
 * Aliases, escapes, writes, optional calls, arguments, unsupported methods,
 * nested-function uses, and shadowed Date constructors all reject before an
 * IR claim.
 */
export function makeIrHostDateSnapshotResolver(checker: ts.TypeChecker): IrHostDateSnapshotResolver {
  const cache = new WeakMap<ts.NewExpression, IrHostDateSnapshotCertification | null>();
  return (expression): IrHostDateSnapshotCertification | undefined => {
    const cached = cache.get(expression);
    if (cached !== undefined) return cached ?? undefined;
    try {
      if (
        !ts.isIdentifier(expression.expression) ||
        expression.expression.text !== "Date" ||
        expression.arguments === undefined ||
        expression.arguments.length !== 0 ||
        (expression.typeArguments?.length ?? 0) !== 0
      ) {
        cache.set(expression, null);
        return undefined;
      }
      const dateSymbol = checker.getSymbolAtLocation(expression.expression);
      const dateDeclarations = dateSymbol?.declarations ?? [];
      const constructorDeclaration = checker.getResolvedSignature(expression)?.getDeclaration();
      if (
        dateDeclarations.length === 0 ||
        !dateDeclarations.every((declaration) => declaration.getSourceFile().isDeclarationFile) ||
        constructorDeclaration?.getSourceFile().isDeclarationFile !== true
      ) {
        cache.set(expression, null);
        return undefined;
      }
      const owner = containingTopLevelOwner(expression);
      if (!owner) {
        cache.set(expression, null);
        return undefined;
      }

      const getterCalls = new Set<ts.CallExpression>();
      const variable =
        ts.isVariableDeclaration(expression.parent) && expression.parent.initializer === expression
          ? expression.parent
          : undefined;
      if (!variable) {
        const direct = isExactGetterCall(expression, owner, checker);
        if (!direct) {
          cache.set(expression, null);
          return undefined;
        }
        getterCalls.add(direct);
      } else {
        if (ts.isSourceFile(owner)) {
          cache.set(expression, null);
          return undefined;
        }
        if (!ts.isIdentifier(variable.name)) {
          cache.set(expression, null);
          return undefined;
        }
        const declarationList = variable.parent;
        if (!ts.isVariableDeclarationList(declarationList) || (declarationList.flags & ts.NodeFlags.Const) === 0) {
          cache.set(expression, null);
          return undefined;
        }
        const snapshotSymbol = checker.getSymbolAtLocation(variable.name);
        if (!snapshotSymbol) {
          cache.set(expression, null);
          return undefined;
        }
        let invalidUse = false;
        const visit = (node: ts.Node): void => {
          if (invalidUse) return;
          if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === snapshotSymbol) {
            if (node === variable.name) return;
            const call = isExactGetterCall(node, owner, checker);
            if (!call) {
              invalidUse = true;
              return;
            }
            getterCalls.add(call);
            return;
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(owner.body!, visit);
        if (invalidUse || getterCalls.size === 0) {
          cache.set(expression, null);
          return undefined;
        }
      }
      const certification = { expression, getterCalls } satisfies IrHostDateSnapshotCertification;
      cache.set(expression, certification);
      return certification;
    } catch {
      cache.set(expression, null);
      return undefined;
    }
  };
}
