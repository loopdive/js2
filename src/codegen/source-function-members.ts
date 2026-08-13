// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

const functionMemberNames = new WeakMap<ts.SourceFile, Set<string>>();
const aliasedFunctionMembers = new WeakMap<ts.SourceFile, Map<string, Set<string>>>();

export function sourceDefinesFunctionMember(sourceFile: ts.SourceFile, name: string): boolean {
  let names = functionMemberNames.get(sourceFile);
  if (names) return names.has(name);
  names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right) || ts.isIdentifier(node.right))
    ) {
      names!.add(node.left.name.text);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) names!.add(property.name.text);
        else if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))
        ) {
          names!.add(property.name.text);
        }
      }
    } else if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) names!.add(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  functionMemberNames.set(sourceFile, names);
  return names.has(name);
}

export function sourceAssignsAliasedFunctionMember(
  sourceFile: ts.SourceFile,
  receiver: ts.Expression,
  name: string,
): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  let members = aliasedFunctionMembers.get(sourceFile);
  if (!members) {
    members = new Map<string, Set<string>>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        ts.isIdentifier(node.right)
      ) {
        const receivers = members!.get(node.left.name.text) ?? new Set<string>();
        receivers.add(node.left.expression.text);
        members!.set(node.left.name.text, receivers);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    aliasedFunctionMembers.set(sourceFile, members);
  }
  return members.get(name)?.has(receiver.text) === true;
}
