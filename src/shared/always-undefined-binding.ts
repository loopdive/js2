// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 lever SR) Expressions that always evaluate to `undefined` and have no
 * effect, proven from the AST alone so the selector and the builder ask the
 * same question and get the same answer:
 *
 *   - an empty IIFE, `function () {}()` ({@link isEmptyFunctionCall});
 *   - a read of a `var` that only ever holds `undefined`
 *     ({@link isAlwaysUndefinedVar}).
 *
 * The `var` proof is whole-file and name-based on purpose, like codegen's
 * `bindingIsUniqueAndNeverWritten`: every binding site of the name must be an
 * initializer-less `var` declarator, and a binding of another kind, a write of
 * the name, or a route that writes it unseen declines. The read must also sit
 * inside the function (or script) that declares one of those declarators, so
 * it cannot fall through to an undeclared global.
 */
import { GLOBAL_VALUE_NAMES } from "../checker/inhouse-globals.js";
import { forEachChild, ts } from "../ts-api.js";
import { hasDynamicScope, isBindingSiteName, stripParens } from "./binding-writes.js";
import {
  sourceMayWriteGlobalObject,
  sourceNamesReflectiveRoute,
  sourceWritesMemberNamed,
} from "./intrinsic-prototype-writes.js";

/** `function () {}()`: a call with no arguments of a function expression with no parameters and an empty body. */
export function isEmptyFunctionCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = stripParens(expression.expression);
  return (
    ts.isFunctionExpression(callee) &&
    callee.asteriskToken === undefined &&
    callee.modifiers === undefined &&
    callee.parameters.length === 0 &&
    callee.body.statements.length === 0
  );
}

/** Per file and name: the scopes whose `var` declarators prove the name, or `undefined` when it is not proven. */
const cache = new WeakMap<ts.SourceFile, Map<string, ReadonlySet<ts.Node> | undefined>>();

/**
 * A read of a `var` that is declared without a value and never written. A
 * script-level declarator binds a property of the global object, so a name the
 * host already defines (`NaN`, `Array`, `print`) keeps its value, and a write
 * through `this` / `globalThis` under a computed name reaches it: both
 * decline. `arguments` is never proven, since every function binds it.
 */
export function isAlwaysUndefinedVar(identifier: ts.Identifier): boolean {
  if (identifier.text === "arguments") return false;
  const sourceFile = identifier.getSourceFile();
  let names = cache.get(sourceFile);
  if (names === undefined) {
    names = new Map();
    cache.set(sourceFile, names);
  }
  if (!names.has(identifier.text)) names.set(identifier.text, provingScopes(sourceFile, identifier.text));
  const scopes = names.get(identifier.text);
  if (scopes === undefined) return false;
  for (let node: ts.Node | undefined = identifier; node !== undefined; node = node.parent) {
    if (scopes.has(node)) return true;
  }
  return false;
}

function provingScopes(sourceFile: ts.SourceFile, name: string): ReadonlySet<ts.Node> | undefined {
  if (
    hasDynamicScope(sourceFile) ||
    sourceNamesReflectiveRoute(sourceFile) ||
    sourceWritesMemberNamed(sourceFile, name)
  ) {
    return undefined;
  }
  const scopes = new Set<ts.Node>();
  let declined = false;
  const visit = (node: ts.Node): void => {
    if (declined) return;
    if (ts.isIdentifier(node)) {
      // `(0, eval)(…)` and `Function(…)` run code that may write the name unseen.
      if (node.text === "eval" || node.text === "Function") declined = true;
      if (node.text === name && isBindingSiteName(node)) {
        const scope = undefinedVarScope(node.parent);
        if (scope === undefined) declined = true;
        else scopes.add(scope);
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declined || scopes.size === 0) return undefined;
  if (scopes.has(sourceFile) && (GLOBAL_VALUE_NAMES.has(name) || sourceMayWriteGlobalObject(sourceFile))) {
    return undefined;
  }
  return scopes;
}

/** The function or script whose variable an initializer-less `var` declarator declares, or `undefined` for any other binding. */
function undefinedVarScope(declaration: ts.Node): ts.Node | undefined {
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== undefined) return undefined;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return undefined;
  // A `for-in` / `for-of` head writes its `var` on every iteration.
  if (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)) return undefined;
  let scope: ts.Node = list.parent;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope) && !ts.isClassStaticBlockDeclaration(scope)) {
    scope = scope.parent;
  }
  return scope;
}
