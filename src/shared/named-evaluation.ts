// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * NamedEvaluation's trigger, shared below codegen and the IR: legacy property
 * and binding naming (#1049) and the IR's literal destructuring planner, which
 * refuses a default that would be named after its leaf (#7106).
 */
import { ts } from "../ts-api.js";

/**
 * ES spec IsAnonymousFunctionDefinition: returns true when the expression is
 * an anonymous FunctionExpression / ArrowFunction / ClassExpression (with
 * optional parentheses around it). Used by NamedEvaluation to decide whether
 * a binding name is assigned to the function's .name. (#1049)
 */
export function isAnonymousFunctionDefinition(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isFunctionExpression(expr) && !expr.name) return true;
  if (ts.isArrowFunction(expr)) return true;
  if (ts.isClassExpression(expr) && !expr.name) return true;
  return false;
}

/**
 * (#5149 cluster B) §10.2.9 step 1: when the property key is a SYMBOL, the
 * function's `name` is the symbol's description wrapped in brackets —
 * `{ [Symbol('test262')]() {} }` is named `"[test262]"`, and a symbol with NO
 * description is named `""` (not `"[]"`, not the compiler's internal
 * `"__computed"`).
 *
 * Only the two statically decidable spellings are answered here:
 *   • a well-known `Symbol.foo` key                → `"[Symbol.foo]"`
 *   • an identifier bound ONCE to `Symbol("desc")` → `"[desc]"` / `""`
 *
 * The binding walk is syntactic on purpose — the question ("which literal built
 * this symbol") is about SYNTAX, not about a type, so no type query belongs
 * here at all. It is deliberately conservative:
 * more than one declaration of the name, any later assignment to it, or a
 * non-literal description all decline, and declining leaves the pre-existing
 * answer untouched.
 *
 * Returns `undefined` when the key is not a statically decidable symbol.
 */
export function symbolComputedKeyFunctionName(key: ts.Expression): string | undefined {
  let expr = key;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  // `[Symbol.iterator]() {}` → "[Symbol.iterator]".
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Symbol" &&
    ts.isIdentifier(expr.name)
  ) {
    return `[Symbol.${expr.name.text}]`;
  }
  if (!ts.isIdentifier(expr)) return undefined;
  const name = expr.text;
  const file = expr.getSourceFile?.();
  if (file === undefined) return undefined;
  let decls = 0;
  let initializer: ts.Expression | undefined;
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      decls++;
      initializer = node.initializer;
    } else if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      reassigned = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (decls !== 1 || reassigned || initializer === undefined) return undefined;
  let init: ts.Expression = initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== "Symbol") {
    return undefined;
  }
  const arg = init.arguments[0];
  // §20.4.1.1: an absent or `undefined` description leaves [[Description]]
  // undefined, and §10.2.9 then names the function `""`.
  if (arg === undefined || (ts.isIdentifier(arg) && arg.text === "undefined")) return "";
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return `[${arg.text}]`;
  return undefined;
}

/**
 * (#5149, #7354 F1b) §10.2.9 for a property key: an identifier, private name, string or number key's text; a
 * constant computed key's value (`['k']`, `[1]`); a decidable symbol's bracketed description
 * ({@link symbolComputedKeyFunctionName}); `undefined` for any other computed key; `""` for any other key.
 */
export function propertyKeyFunctionName(key: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(key) || ts.isPrivateIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))
    return key.text;
  if (!ts.isComputedPropertyName(key)) return "";
  let expr = key.expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return String(Number(expr.text));
  return symbolComputedKeyFunctionName(key.expression);
}

/**
 * §10.2.9 SetFunctionName for a function-like declaration, as far as it is
 * statically decidable at the closure's mint site.
 *
 * A named declaration/expression uses its own name. An ANONYMOUS function or
 * arrow inherits the binding it is being defined into (NamedEvaluation) — the
 * variable, property, binding element or simple assignment target. Anything
 * else answers `""`, which is also the spec answer for a genuinely anonymous
 * function value. (#7354 F1b) A computed key whose value is not statically
 * decidable answers `undefined`: the caller decides (codegen's `""`, or the
 * Prepared path's refusal).
 */
export function functionInstanceName(decl: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isClassDeclaration(decl)) &&
    decl.name !== undefined
  ) {
    return decl.name.text;
  }
  if (ts.isClassExpression(decl) && decl.name !== undefined) return decl.name.text;
  if (
    ts.isFunctionDeclaration(decl) &&
    decl.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    return "default";
  }

  // NamedEvaluation: the anonymous definition takes the name of what it is
  // being bound to. Only the syntactic forms that carry an identifier/literal
  // key are resolvable here; computed keys are runtime values. Private names
  // are syntactic keys too, and their `#` spelling is the observable function
  // name (the class-field layout's `__priv_` spelling must not leak here).
  //
  // Parentheses are TRANSPARENT to NamedEvaluation — the CoverParenthesized
  // production keeps `var cover = (function () {});` anonymous, so the binding
  // name still applies (`language/*/fn-name-cover.js`). A COMMA expression is
  // not: `var xCover = (0, function () {});` is not an anonymous function
  // DEFINITION, and those files assert the name is NOT taken. Walking only
  // through `ParenthesizedExpression` keeps the two apart.
  let node: ts.Node = decl;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return "";
  if (
    (ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
    ts.isExportAssignment(parent) &&
    !parent.isExportEquals &&
    parent.expression === node
  ) {
    return "default";
  }
  if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.initializer === node) {
    return ts.isIdentifier(parent.name) ? parent.name.text : "";
  }
  // (#5144 cluster F) Shorthand DEFAULT in an object ASSIGNMENT pattern —
  // `for ({ fn = function () {} } of [{}])`. §13.15.5.4 step 6.d applies
  // NamedEvaluation with the property key, which is also the shorthand's own
  // identifier. (The binding-pattern twin arrives as a BindingElement above.)
  if (ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer === node) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return propertyKeyFunctionName(parent.name);
  // (#5146 cluster E) `({ x = function () {} } = {})` — the shorthand
  // property's assignment initializer is an AssignmentElement default, and
  // §13.15.5.5 applies NamedEvaluation with the shorthand's own name.
  if (ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer === node) {
    return parent.name.text;
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) return propertyKeyFunctionName(parent.name);
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return "";
}
