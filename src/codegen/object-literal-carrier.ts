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
  // Object literals use last-definition-wins semantics. Scan in evaluation
  // order backwards so a duplicate key cannot reuse the first literal's
  // carrier. A spread or computed key to the right may also overwrite the
  // requested property at runtime, so leave those cases to the generic path.
  for (let i = initializer.properties.length - 1; i >= 0; i--) {
    const candidate = initializer.properties[i]!;
    if (ts.isSpreadAssignment(candidate) || ts.isComputedPropertyName(candidate.name)) return undefined;
    const name = candidate.name;
    if (!(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return undefined;
    if (name.text !== propertyKey) continue;
    if (!ts.isPropertyAssignment(candidate) || !ts.isObjectLiteralExpression(candidate.initializer)) return undefined;
    return carriersByContext.get(ctx)?.get(candidate.initializer);
  }
  return undefined;
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
