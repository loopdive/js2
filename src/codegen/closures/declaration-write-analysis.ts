// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../../ts-api.js";
import { collectWrittenIdentifiers } from "../closures.js";

/** Names a statement writes or initializes after offset `after`. */
function collectStatementWrites(statement: ts.Statement, after: number, written: Set<string>): void {
  const collectInitializedNames = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (node.end <= after) return;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      written.add(node.name.text);
    }
    ts.forEachChild(node, collectInitializedNames);
  };
  collectWrittenIdentifiers(statement, written);
  collectInitializedNames(statement);
}

// (#1058) Writes of a statement that lies wholly after a declaration do not
// depend on the declaration, so each is computed once. Rescanning every later
// statement for each nested function made large bodies (TypeScript's
// `createTypeChecker`: 2,000 nested functions) quadratic to compile.
const laterStatementWrites = new WeakMap<ts.Statement, ReadonlySet<string>>();

/** Captures a declaration closure must observe after it is created. */
export function collectOwnerBindingsWrittenAfterDeclaration(stmt: ts.FunctionDeclaration): Set<string> {
  let owner: ts.Node | undefined = stmt.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  const ownerBody = owner && ts.isFunctionLike(owner) ? (owner as ts.FunctionLikeDeclarationBase).body : undefined;
  const body = ts.isSourceFile(owner) ? owner : ownerBody && ts.isBlock(ownerBody) ? ownerBody : undefined;
  const written = new Set<string>();
  if (!body) return written;

  for (const statement of body.statements) {
    if (statement.end <= stmt.end) continue;
    if (statement.pos < stmt.end) {
      // The statement encloses the declaration: only its later part counts.
      collectStatementWrites(statement, stmt.end, written);
      continue;
    }
    let writes = laterStatementWrites.get(statement);
    if (writes === undefined) {
      const collected = new Set<string>();
      collectStatementWrites(statement, -1, collected);
      writes = collected;
      laterStatementWrites.set(statement, writes);
    }
    for (const name of writes) written.add(name);
  }
  return written;
}

const scopeVariableDeclarationCache = new WeakMap<ts.Node, Map<string, ts.VariableDeclaration>>();

/**
 * (#1058) First `VariableDeclaration` per identifier name in `scope`, in
 * pre-order, without entering nested functions or classes. Built once per
 * scope: scanning the enclosing body again for every capture of every nested
 * function made TypeScript's `createTypeChecker` (about 380 captures, 2,000
 * nested functions) cubic to compile.
 */
export function scopeVariableDeclarations(scope: ts.Node): Map<string, ts.VariableDeclaration> {
  let names = scopeVariableDeclarationCache.get(scope);
  if (names !== undefined) return names;
  const found = new Map<string, ts.VariableDeclaration>();
  const scan = (node: ts.Node): void => {
    if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !found.has(node.name.text)) {
      found.set(node.name.text, node);
    }
    ts.forEachChild(node, scan);
  };
  scan(scope);
  names = found;
  scopeVariableDeclarationCache.set(scope, names);
  return names;
}
