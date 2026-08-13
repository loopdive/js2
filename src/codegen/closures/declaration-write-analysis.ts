// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import { collectWrittenIdentifiers } from "../closures.js";

/** Captures a declaration closure must observe after it is created. */
export function collectOwnerBindingsWrittenAfterDeclaration(stmt: ts.FunctionDeclaration): Set<string> {
  let owner: ts.Node | undefined = stmt.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  const ownerBody = owner && ts.isFunctionLike(owner) ? (owner as ts.FunctionLikeDeclarationBase).body : undefined;
  const body = ts.isSourceFile(owner) ? owner : ownerBody && ts.isBlock(ownerBody) ? ownerBody : undefined;
  const written = new Set<string>();
  if (!body) return written;

  const collectInitializedNames = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (node.end <= stmt.end) return;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      written.add(node.name.text);
    }
    ts.forEachChild(node, collectInitializedNames);
  };
  for (const statement of body.statements) {
    if (statement.end <= stmt.end) continue;
    collectWrittenIdentifiers(statement, written);
    collectInitializedNames(statement);
  }
  return written;
}
