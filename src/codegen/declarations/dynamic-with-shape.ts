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
import {
  irWithTargetIdentifier,
  planIrWithTarget,
  withBodyBareIdentifierWriteNames,
} from "../../ir/with-environment.js";
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
  // (#4206) This target's own key set, so a write to an OUTER binding inside the
  // body does not disqualify the closed carrier. `undefined` when the pre-pass
  // cannot see a literal — nothing here can disprove ownership then.
  const declaredOwnKeys = declaredObjectLiteralKeys(declaration);

  let found = false;
  const visit = (node: ts.Node, isStatementRoot: boolean): void => {
    if (found) return;
    if (!isStatementRoot && !moduleBinding && isFunctionOrClassBoundary(node)) return;
    if (ts.isWithStatement(node) && planIrWithTarget(node, declaredOwnKeys).representation === "open-object") {
      const target = irWithTargetIdentifier(node);
      if (target && targetIsThisBinding(checker, target, bindingSymbol, declaration, moduleBinding)) {
        found = true;
        return;
      }
    }
    forEachChild(node, (child) => visit(child, false));
  };

  for (const statement of statements) visit(statement, true);
  return found;
}

/**
 * (#4206) The keys of the object literal `declaration` is initialized with, or
 * `undefined` when it has none the pre-pass can see. Feeds
 * {@link planIrWithTarget}'s SetMutableBinding proof.
 */
function declaredObjectLiteralKeys(declaration: ts.Identifier): ReadonlySet<string> | undefined {
  const parent = declaration.parent;
  if (!ts.isVariableDeclaration(parent) || parent.name !== declaration) return undefined;
  const initializer = parent.initializer;
  if (initializer === undefined) return undefined;
  const literal = unwrapTransparentExpression(initializer);
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  const keys = new Set<string>();
  for (const property of literal.properties) {
    const name = property.name;
    if (name === undefined) continue;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) keys.add(name.text);
  }
  return keys;
}

/**
 * (#4206) Does `target` name the same binding as `declaration`?
 *
 * Symbol identity is the rule. The ONE exception is a `with` target that is
 * itself nested inside another `with` body: §14.11's Object Environment Record
 * can bind any name at runtime, so TypeScript gives every identifier there
 * `any` and NO symbol, and the identity test degrades to `undefined === symbol`
 * — silently false. The inner target of `with (a) { with (b) { … } }` was
 * therefore never planned, and the inner write kept coercing into `b`'s closed
 * field carrier (`S12.10_A3.6_T{1,2}`).
 *
 * Bounded exactly like #4264's `withBodyAssignmentWidens`: it fires only when
 * the checker has already declined, only for a target genuinely inside a `with`
 * body, and only for a module-scoped declaration — whose one module-global
 * carrier is the same binding a nested `with` body could name.
 */
function targetIsThisBinding(
  checker: ts.TypeChecker,
  target: ts.Identifier,
  bindingSymbol: ts.Symbol,
  declaration: ts.Identifier,
  moduleBinding: boolean,
): boolean {
  const resolved = checker.getSymbolAtLocation(target);
  if (resolved !== undefined) return resolved === bindingSymbol;
  return moduleBinding && isInsideWithBody(target) && target.text === declaration.text;
}

/** True when `node` sits inside the BODY of a `with` statement. */
function isInsideWithBody(node: ts.Node): boolean {
  let prev: ts.Node | undefined;
  for (let cur: ts.Node | undefined = node; cur; prev = cur, cur = cur.parent) {
    if (prev !== undefined && ts.isWithStatement(cur) && cur.statement === prev) return true;
  }
  return false;
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
