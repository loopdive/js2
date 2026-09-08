// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { receiverIsRealmGlobalObject } from "./helpers/sloppy-this-global.js";

/** Include nested literal fields and transparent wrappers, but not aliases or call results. */
function publicationReceiver(literal: ts.ObjectLiteralExpression): ts.Expression | undefined {
  let value: ts.Expression = literal;
  for (;;) {
    const parent = value.parent;
    if (!parent) return undefined;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      value = parent;
      continue;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === value &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      value = parent.parent;
      continue;
    }
    if (
      !ts.isBinaryExpression(parent) ||
      parent.right !== value ||
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
      return undefined;
    const target = parent.left;
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return undefined;
    let receiver: ts.Expression = target.expression;
    while (
      ts.isParenthesizedExpression(receiver) ||
      ts.isAsExpression(receiver) ||
      ts.isTypeAssertionExpression(receiver) ||
      ts.isSatisfiesExpression(receiver) ||
      ts.isNonNullExpression(receiver)
    )
      receiver = receiver.expression;
    return receiver;
  }
}

/** Fresh literals published into a linked realm cannot use producer-only field metadata. */
export function isLinkedRealmPublicationLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  literal: ts.ObjectLiteralExpression,
): boolean {
  if (ctx.standaloneGlobalThisImport === undefined) return false;
  const receiver = publicationReceiver(literal);
  return (
    receiver !== undefined &&
    ts.isIdentifier(receiver) &&
    receiver.text === "globalThis" &&
    receiverIsRealmGlobalObject(ctx, fctx, receiver)
  );
}

/** Keep signatures inferred from a published literal on the same shared carrier. */
export function isLinkedRealmPublicationType(ctx: CodegenContext, type: ts.Type): boolean {
  if (ctx.standaloneGlobalThisImport === undefined) return false;
  const declaration = type.getSymbol()?.valueDeclaration;
  if (!declaration || !ts.isObjectLiteralExpression(declaration)) return false;
  const receiver = publicationReceiver(declaration);
  if (!receiver || !ts.isIdentifier(receiver) || receiver.text !== "globalThis") return false;
  // The oracle returns the reference itself when there is no declaration.
  // Actual local/parameter declarations must not acquire realm semantics.
  return (
    !ctx.moduleGlobals.has("globalThis") &&
    ctx.oracle.declarationsOf(receiver).every((d) => d === receiver || d.getSourceFile().isDeclarationFile)
  );
}
