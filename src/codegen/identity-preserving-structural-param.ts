// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

interface IdentityPreservingStructuralCarrier {
  open: true;
  compoundStructDispatch?: true;
}

const identityPreservingParams = new WeakMap<
  CodegenContext,
  WeakMap<ts.ParameterDeclaration, IdentityPreservingStructuralCarrier>
>();

export function markIdentityPreservingStructuralParam(
  ctx: CodegenContext,
  parameter: ts.ParameterDeclaration,
  carrier: IdentityPreservingStructuralCarrier = { open: true },
): void {
  let parameters = identityPreservingParams.get(ctx);
  if (!parameters) {
    parameters = new WeakMap();
    identityPreservingParams.set(ctx, parameters);
  }
  parameters.set(parameter, carrier);
}

/**
 * Whether this expression reads the exact parameter whose ABI was opened to
 * preserve an asserted structural object's JavaScript identity.
 */
export function identityPreservingStructuralParamCarrier(
  ctx: CodegenContext,
  expression: ts.Expression,
): IdentityPreservingStructuralCarrier | undefined {
  let receiver = expression;
  while (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAsExpression(receiver) ||
    ts.isTypeAssertionExpression(receiver) ||
    ts.isNonNullExpression(receiver) ||
    ts.isSatisfiesExpression(receiver)
  ) {
    receiver = receiver.expression;
  }
  if (!ts.isIdentifier(receiver)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(receiver);
  return declaration === undefined
    ? undefined
    : identityPreservingParams.get(ctx)?.get(declaration as ts.ParameterDeclaration);
}
