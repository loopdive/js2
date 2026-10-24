// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { IrUnitKind } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrClassId, IrUnitId } from "../../shared/contracts/ir-identity.js";

export interface IrClassDefinitionExpressionOwner {
  readonly sourceFile: ts.SourceFile;
  readonly expression: ts.Expression;
  readonly classId: IrClassId;
  readonly terminalOwnerId: IrUnitId | null;
}

function decoratorExpressions(node: ts.Node): readonly ts.Expression[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node)?.map((decorator) => decorator.expression) ?? []) : [];
}

/** Scanner population at definition time, separate from callable bodies and field initialization. */
export function classDefinitionExpressions(node: ts.ClassDeclaration | ts.ClassExpression): readonly ts.Expression[] {
  const expressions: ts.Expression[] = [...decoratorExpressions(node)];
  for (const clause of node.heritageClauses ?? []) {
    for (const heritageType of clause.types) expressions.push(heritageType.expression);
  }
  for (const member of node.members) {
    expressions.push(...decoratorExpressions(member));
    if (
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      for (const parameter of member.parameters) expressions.push(...decoratorExpressions(parameter));
    }
    if (member.name && ts.isComputedPropertyName(member.name)) expressions.push(member.name.expression);
  }
  return expressions;
}

export function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

export function classMemberUnitKind(
  member: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
): IrUnitKind {
  const placement = hasStaticModifier(member) ? "static" : "instance";
  if (ts.isGetAccessorDeclaration(member)) return `class-${placement}-getter`;
  if (ts.isSetAccessorDeclaration(member)) return `class-${placement}-setter`;
  return `class-${placement}-method`;
}
