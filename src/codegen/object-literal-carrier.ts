// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

const carriersByContext = new WeakMap<CodegenContext, WeakMap<ts.ObjectLiteralExpression, number>>();

export function resolveObjectLiteralCarrier(
  ctx: CodegenContext,
  literal: ts.ObjectLiteralExpression,
  typeName: string,
): number | undefined {
  const typeIdx = ctx.structMap.get(typeName);
  if (typeIdx === undefined) return undefined;
  let carriers = carriersByContext.get(ctx);
  if (carriers === undefined) {
    carriers = new WeakMap();
    carriersByContext.set(ctx, carriers);
  }
  carriers.set(literal, typeIdx);
  return typeIdx;
}

/** Runtime carrier of a nested literal property in a variable initializer. */
function nestedObjectLiteralCarrier(
  ctx: CodegenContext,
  element: ts.BindingElement,
  propertyKey: string | undefined,
): number | undefined {
  if (propertyKey === undefined) return undefined;
  let node: ts.Node | undefined = element.parent;
  while (node !== undefined && !ts.isVariableDeclaration(node)) node = node.parent;
  if (node === undefined) return undefined;
  const initializer = node.initializer;
  if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) return undefined;
  const property = initializer.properties.find((candidate): candidate is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(candidate)) return false;
    const name = candidate.name;
    return (
      (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === propertyKey
    );
  });
  if (property === undefined || !ts.isObjectLiteralExpression(property.initializer)) return undefined;
  return carriersByContext.get(ctx)?.get(property.initializer);
}

export function nestedObjectPatternCarrier(ctx: CodegenContext, pattern: ts.ObjectBindingPattern): number | undefined {
  const element = pattern.parent;
  if (!ts.isBindingElement(element)) return undefined;
  const property = element.propertyName ?? element.name;
  const key =
    ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)
      ? property.text
      : undefined;
  return nestedObjectLiteralCarrier(ctx, element, key);
}
