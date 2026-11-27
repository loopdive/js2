// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Whether an identifier reads the global built-in its name names, unchanged: the checker's symbol is
 * declared in lib files only, no source declares a binding of that name at any level (a `var`, `let`, `const`,
 * `function`, `class`, parameter or pattern element: the checker resolves a script's top-level `function Object(){}`
 * reference to the lib's symbol, so the declaration is looked for by name), and no source assigns the name:
 * `Object = …`, a compound assignment, `++` / `--`, `delete`, a destructuring target, or a write through a global-object
 * alias (`globalThis.Object = …`).
 * The one answer for "this is the global `Object`" of the native statics' call form and of the flow rule beside it.
 */
import { ts } from "../ts-api.js";
import { makeIrAmbientBindingPredicate } from "./module-bindings.js";
import { skipOuterExpressions } from "../shared/binding-writes.js";
import { REALM_GLOBAL_NAMES } from "./program/builtin-prototype-keys.js";

/** The names a global-object alias reaches the global bindings through. */
export const GLOBAL_ALIASES: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);

const isAssignment = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** The names an assignment target writes: identifiers of a destructuring pattern, a global alias's member. */
function targetNames(written: ts.Expression, into: Set<string>): void {
  // (#7350 B3a) A type assertion (`(String as any) = …`) writes what it asserts, like a parenthesis.
  const target = skipOuterExpressions(written);
  if (ts.isIdentifier(target)) into.add(target.text);
  else if (ts.isPropertyAccessExpression(target)) {
    const object = skipOuterExpressions(target.expression);
    if (object.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(object) && GLOBAL_ALIASES.has(object.text)))
      into.add(target.name.text);
  } else if (ts.isArrayLiteralExpression(target))
    target.elements.forEach((element) => targetNames(ts.isSpreadElement(element) ? element.expression : element, into));
  else if (ts.isObjectLiteralExpression(target))
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) into.add(property.name.text);
      else if (ts.isPropertyAssignment(property)) targetNames(property.initializer, into);
      else if (ts.isSpreadAssignment(property)) targetNames(property.expression, into);
    }
  else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    targetNames(target.left, into);
}

/** The names a binding pattern or name declares. */
function boundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) boundNames(element.name, into);
}

/** Every name any of `sourceFiles` declares (at any level) or assigns. */
function boundOrWrittenNames(sourceFiles: readonly ts.SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name)
      names.add(node.name.text);
    else if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
      boundNames(node.name, names);
    else if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) targetNames(node.left, names);
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      targetNames(node.operand, names);
    else if (ts.isDeleteExpression(node)) targetNames(node.expression, names);
    else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      targetNames(node.initializer, names);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return names;
}

const predicates = new WeakMap<readonly ts.SourceFile[], (identifier: ts.Identifier) => boolean>();

/** The predicate for the program of `sourceFiles`, built once per source list. */
export function pristineBuiltinGlobal(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
): (identifier: ts.Identifier) => boolean {
  const known = predicates.get(sourceFiles);
  if (known) return known;
  const libOnly = makeIrAmbientBindingPredicate(checker, "every");
  const taken = boundOrWrittenNames(sourceFiles);
  const predicate = (identifier: ts.Identifier) => !taken.has(identifier.text) && libOnly(identifier);
  predicates.set(sourceFiles, predicate);
  return predicate;
}

/**
 * (#7354 G1) The first script-level `var` without an initializer declaring a global the realm serves a built-in for
 * (`REALM_GLOBAL_NAMES`): such a `var` binds the global object's existing property (§16.1.7
 * GlobalDeclarationInstantiation), so the name keeps reading the built-in, while this path gives a script `var` its
 * own home starting at `undefined`. The name is no pristine global either (`boundOrWrittenNames`); the Prepared path
 * refuses the program by this declaration rather than read either value. A `var` with an initializer replaces the
 * built-in where it runs (a read before it still sees the home's `undefined`: not handled here, as before G1); a `var`
 * inside a function binds a local.
 */
export function scriptVarOfRealmGlobal(sourceFiles: readonly ts.SourceFile[]): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.initializer === undefined &&
      REALM_GLOBAL_NAMES.has(node.name.text)
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return found;
}
