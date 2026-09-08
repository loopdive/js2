// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { getFuncSignature } from "./closures/funcref-wrapper-types.js";
import { fixedSourceFunctionCallHandle } from "./source-function-call.js";

/** A structural collection returned by source code need not have native slots. */
export function sourceCollectionFactoryUsesObjectCarrier(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const receiver = ctx.oracle.builtinReceiverOf(expression);
  if (receiver !== "Set" && receiver !== "Map" && receiver !== "WeakMap" && receiver !== "WeakSet") return false;
  if (ts.isPropertyAccessExpression(expression.expression)) {
    const object = expression.expression.expression;
    if (ts.isIdentifier(object) && ctx.externrefAccessorVars.has(object.text)) return true;
  }
  const callee = ts.isPropertyAccessExpression(expression.expression)
    ? expression.expression.name
    : expression.expression;
  if (!ts.isIdentifier(callee)) return false;
  const handle = fixedSourceFunctionCallHandle(ctx, callee);
  if (handle === undefined) return false;
  const signature = getFuncSignature(ctx, handle);
  return signature?.results.length === 1 && signature.results[0]?.kind === "externref";
}
