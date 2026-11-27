// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7488) The expressions a class's ClassDefinitionEvaluation may run: decorators, heritage clauses and computed keys.
// The inventory scans every one of them; the Prepared producer refuses a top-level class whose list holds one that runs
// code, because its `<module-init>` does not evaluate class definitions.

import { ts } from "../ts-api.js";

export interface ClassDefinitionExpression {
  readonly kind: "decorator" | "extends" | "implements" | "computed-key";
  readonly expression: ts.Expression;
}

function decorators(node: ts.Node): ClassDefinitionExpression[] {
  return ts.canHaveDecorators(node)
    ? (ts.getDecorators(node) ?? []).map((decorator) => ({ kind: "decorator", expression: decorator.expression }))
    : [];
}

/**
 * In the inventory's scan order: class decorators, heritage types, then per member its decorators, its parameter
 * decorators and its computed key.
 */
export function classDefinitionExpressions(
  node: ts.ClassDeclaration | ts.ClassExpression,
): readonly ClassDefinitionExpression[] {
  const entries = decorators(node);
  for (const clause of node.heritageClauses ?? []) {
    const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
    for (const type of clause.types) entries.push({ kind, expression: type.expression });
  }
  for (const member of node.members) {
    entries.push(...decorators(member));
    if (
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      for (const parameter of member.parameters) entries.push(...decorators(parameter));
    }
    if (member.name && ts.isComputedPropertyName(member.name))
      entries.push({ kind: "computed-key", expression: member.name.expression });
  }
  return entries;
}
