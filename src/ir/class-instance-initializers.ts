// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/** Source-ordered field work owned by one class constructor `_init`. */
export interface IrClassInstanceInitializer {
  readonly declaration: ts.PropertyDeclaration;
  readonly expression: ts.Expression;
  readonly fieldName: string;
  readonly sourceOrdinal: number;
}

function hasStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

/**
 * Resolve only property names whose slot identity is fixed by syntax. Dynamic
 * computed names remain direct until their evaluation/side-table semantics are
 * represented explicitly in IR.
 */
export function irClassInstanceFieldName(name: ts.PropertyName): string | undefined {
  if (ts.isPrivateIdentifier(name)) return `__priv_${name.text.slice(1)}`;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

/** Build an exact source-order plan, or refuse the complete class atomically. */
export function collectIrClassInstanceInitializers(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
): readonly IrClassInstanceInitializer[] | undefined {
  const result: IrClassInstanceInitializer[] = [];
  for (let sourceOrdinal = 0; sourceOrdinal < declaration.members.length; sourceOrdinal++) {
    const member = declaration.members[sourceOrdinal]!;
    if (!ts.isPropertyDeclaration(member) || hasStaticModifier(member) || !member.initializer) continue;
    const fieldName = irClassInstanceFieldName(member.name);
    if (fieldName === undefined) return undefined;
    result.push({ declaration: member, expression: member.initializer, fieldName, sourceOrdinal });
  }
  return result;
}
