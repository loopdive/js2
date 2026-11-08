// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 lever SR) A `var` that only ever holds `undefined`: every binding
 * site of its name in the source is an initializer-less `var` declarator, and
 * nothing writes it — no store or `delete` of the name and no member of that
 * name stored, deleted or defined (`this.x = v` reaches a script `var`), with
 * no `with` or direct `eval` to do it unseen. Any read of it, before or after
 * its declaration, is `undefined` and has no effect.
 *
 * Whole-file and name-based on purpose, like codegen's
 * `bindingIsUniqueAndNeverWritten`: a same-named binding of another kind or a
 * write anywhere declines. Pure AST, so the selector and the builder ask the
 * same question and get the same answer.
 */
import { forEachChild, ts } from "../ts-api.js";
import { hasDynamicScope } from "./binding-writes.js";
import { sourceWritesMemberNamed } from "./intrinsic-prototype-writes.js";

const cache = new WeakMap<ts.SourceFile, Map<string, boolean>>();

export function isAlwaysUndefinedVar(identifier: ts.Identifier): boolean {
  const sourceFile = identifier.getSourceFile();
  let names = cache.get(sourceFile);
  if (names === undefined) {
    names = new Map();
    cache.set(sourceFile, names);
  }
  let answer = names.get(identifier.text);
  if (answer === undefined) {
    answer = computeAlwaysUndefined(sourceFile, identifier.text);
    names.set(identifier.text, answer);
  }
  return answer;
}

function computeAlwaysUndefined(sourceFile: ts.SourceFile, name: string): boolean {
  if (hasDynamicScope(sourceFile) || sourceWritesMemberNamed(sourceFile, name)) return false;
  let declared = false;
  let other = false;
  const visit = (node: ts.Node): void => {
    if (other) return;
    if (ts.isIdentifier(node) && node.text === name && isBindingName(node)) {
      const declaration = node.parent;
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer === undefined &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0 &&
        // A `for-in` / `for-of` head writes its `var` on every iteration.
        !ts.isForInStatement(declaration.parent.parent) &&
        !ts.isForOfStatement(declaration.parent.parent)
      ) {
        declared = true;
      } else {
        other = true;
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return declared && !other;
}

/** `node` is the name a declaration binds (a variable, parameter, function, class, import or catch binding). */
function isBindingName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    (parent as { readonly name?: ts.Node }).name === node
  );
}
