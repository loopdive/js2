// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Compatibility adapter from declaration collection to the IR-owned W1 `with`
 * target planner.
 *
 * The planner deliberately lives in `ir/with-environment.ts`: it describes the
 * language-level reason a target needs an identity-bearing open object, without
 * choosing a host or standalone carrier. This adapter adds the one codegen-only
 * proof needed before allocation: the `with` target must resolve to this exact
 * declaration symbol, not merely share its spelling.
 */
import { irWithTargetIdentifier, planIrWithTarget } from "../../ir/with-environment.js";
import { forEachChild, ts } from "../../ts-api.js";

/** Function/class bodies run under a separate declaration scan. */
function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * Does this declaration own a W1-planned `with` target in the same executable
 * statement list? Name equality is deliberately insufficient: a shadowed `o`
 * must not cause an unrelated literal to be widened. Function-local bodies are
 * scanned by their own declaration pass; a module binding is the intentional
 * exception because its module-global carrier is shared with nested functions.
 */
export function bindingHasIrPlannedOpenWithTarget(
  statements: readonly ts.Statement[],
  checker: ts.TypeChecker,
  declaration: ts.Identifier,
): boolean {
  const bindingSymbol = checker.getSymbolAtLocation(declaration);
  if (!bindingSymbol) return false;
  const moduleBinding = isModuleScopedDeclaration(declaration);

  let found = false;
  const visit = (node: ts.Node, isStatementRoot: boolean): void => {
    if (found) return;
    if (!isStatementRoot && !moduleBinding && isFunctionOrClassBoundary(node)) return;
    if (ts.isWithStatement(node) && planIrWithTarget(node).representation === "open-object") {
      const target = irWithTargetIdentifier(node);
      if (target && checker.getSymbolAtLocation(target) === bindingSymbol) {
        found = true;
        return;
      }
    }
    forEachChild(node, (child) => visit(child, false));
  };

  for (const statement of statements) visit(statement, true);
  return found;
}

/** Module globals retain their one carrier across ordinary nested functions. */
function isModuleScopedDeclaration(declaration: ts.Identifier): boolean {
  let current: ts.Node | undefined = declaration.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return current !== undefined;
}

/**
 * W1 must decline before allocation unless every observable use is already
 * covered by the canonical open-object carrier. An alias, return, assignment,
 * or ordinary call could retain the concrete struct ABI; this pre-pass does not
 * guess at conversions or split identity. The narrow accepted surface is the
 * target itself, direct dot operations, and callers the supplied MOP predicate
 * explicitly recognizes.
 */
export function bindingUsesOnlyIrPlannedOpenObjectOperations(
  checker: ts.TypeChecker,
  statements: readonly ts.Statement[],
  declaration: ts.Identifier,
  isOpenObjectPropertyReceiver: (id: ts.Identifier) => boolean,
  isObjectMopCallArg: (id: ts.Identifier) => boolean,
): boolean {
  const symbol = checker.getSymbolAtLocation(declaration);
  if (!symbol) return false;
  // A function-local object can be captured by a nested callable/class that
  // still expects its original concrete carrier. W1 has no capture-ABI proof,
  // so decline before allocation. Module bindings are the narrow exception:
  // their one module-global carrier is shared with nested ordinary functions.
  const moduleBinding = isModuleScopedDeclaration(declaration);

  let safe = true;
  const visit = (node: ts.Node, crossedNestedCallable: boolean): void => {
    if (!safe) return;
    const insideNestedCallable = crossedNestedCallable || isFunctionOrClassBoundary(node);
    if (ts.isIdentifier(node) && node !== declaration && checker.getSymbolAtLocation(node) === symbol) {
      if (
        (insideNestedCallable && !moduleBinding) ||
        (!isIrWithTargetIdentifier(node) && !isOpenObjectPropertyReceiver(node) && !isObjectMopCallArg(node))
      ) {
        safe = false;
        return;
      }
    }
    forEachChild(node, (child) => visit(child, insideNestedCallable));
  };

  for (const statement of statements) visit(statement, false);
  return safe;
}

function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Is `id` the (possibly parenthesized) target of a `with` statement? */
function isIrWithTargetIdentifier(id: ts.Identifier): boolean {
  let current: ts.Expression = id;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent as ts.Expression;
  }
  return ts.isWithStatement(current.parent) && unwrapTransparentExpression(current.parent.expression) === id;
}
