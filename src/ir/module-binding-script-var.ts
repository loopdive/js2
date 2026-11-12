// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The source facts a write-certified SCRIPT `var` home rests on, shared by
 * every certifier of one (#7252's class instance, #7292's string vec, #7274's
 * native buffers): where the binding is written, and whether a use reads a slot
 * that has been written.
 */
import { ts } from "../ts-api.js";
import {
  hasDynamicScope,
  identifierWritesOf,
  outermostParenthesized,
  type IdentifierWrite,
} from "../shared/binding-writes.js";

const scriptVarWritesCache = new WeakMap<ts.VariableDeclaration, readonly IdentifierWrite[] | null>();

/**
 * Every write of the script var `declaration` anywhere in its source (the
 * declaration's own included), or `undefined` when a `with` / direct `eval`
 * could write it outside checker identity.
 */
export function scriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): readonly IdentifierWrite[] | undefined {
  let cached = scriptVarWritesCache.get(declaration);
  if (cached === undefined) {
    cached = collectScriptVarWrites(checker, declaration) ?? null;
    scriptVarWritesCache.set(declaration, cached);
  }
  return cached ?? undefined;
}

function collectScriptVarWrites(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): IdentifierWrite[] | undefined {
  const sourceFile = declaration.getSourceFile();
  if (!ts.isIdentifier(declaration.name) || hasDynamicScope(sourceFile)) return undefined;
  const bindingSymbol = checker.getSymbolAtLocation(declaration.name);
  const writes: IdentifierWrite[] = [];
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node)) {
      if (checker.getSymbolAtLocation(write.target) === bindingSymbol) writes.push(write);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return writes;
}

/**
 * True when `node` is the declaration itself or a module-init use that runs
 * after it, so the script var's slot has been written: a top-level statement
 * after it, outside every function and class body, and not the operand of
 * `typeof` / `delete`.
 */
export function scriptVarUseFollowsDeclaration(
  node: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.BindingElement,
): boolean {
  if (node === declaration.name) return true;
  const statement = ts.findAncestor(declaration, ts.isVariableStatement);
  if (statement === undefined || node.pos < statement.end) return false;
  const parent = outermostParenthesized(node).parent;
  if (ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent)) return false;
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return false;
  }
  return true;
}
