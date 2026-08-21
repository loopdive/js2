// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral selection contract for capturing a `with` Object Environment
 * Record in a closure.
 *
 * A supported closure captures the environment's receiver by reference. The
 * backend may use a struct ref for a proven closed object or an externref for a
 * dynamic object; either way the closure must rehydrate the same ordered scope
 * entry rather than snapshotting individual property values.
 *
 * This first slice deliberately accepts only ordinary synchronous function
 * expressions. Function declarations, arrows, classes, methods, generators,
 * constructors, and async functions remain explicit selector refusals until their own
 * creation/hoisting contracts can carry the environment record.
 */
import { forEachChild, ts } from "../ts-api.js";

/**
 * Representation required by a `with` target before any object allocation.
 *
 * `closed-fields` is the existing static fast path. `open-object` means the
 * body needs the ordinary Object Environment Record MOP: the target, the
 * dynamic `with` operations, and later ordinary property reads must all share
 * the same identity-bearing open object.
 */
export type IrWithTargetRepresentation = "closed-fields" | "open-object";

export type IrWithTargetPlanReason = "runtime-has-binding" | "runtime-delete-binding" | "runtime-set-binding";

export interface IrWithTargetPlan {
  readonly representation: IrWithTargetRepresentation;
  readonly reasons: readonly IrWithTargetPlanReason[];
}

const CLOSED_WITH_TARGET_PLAN: IrWithTargetPlan = { representation: "closed-fields", reasons: [] };
const DELETE_WITH_TARGET_PLAN: IrWithTargetPlan = {
  representation: "open-object",
  reasons: ["runtime-has-binding", "runtime-delete-binding"],
};
const SET_WITH_TARGET_PLAN: IrWithTargetPlan = {
  representation: "open-object",
  reasons: ["runtime-has-binding", "runtime-set-binding"],
};

/** Unwrap the transparent parentheses allowed around a `with` target. */
export function irWithTargetIdentifier(statement: ts.WithStatement): ts.Identifier | undefined {
  let target: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  return ts.isIdentifier(target) ? target : undefined;
}

/** Executable boundary: an inner callable/class owns its own `with` environment. */
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
 * The exact W1 trigger. A `delete <Identifier>` is a DeleteBinding operation,
 * so the static field projection cannot model its HasBinding cascade or its
 * post-delete readback. Parentheses do not alter that reference; member deletes
 * do. Nested functions/classes execute in their own environment and are not
 * attributed to this statement.
 */
function bodyContainsBareIdentifierDelete(body: ts.Statement): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== body && isFunctionOrClassBoundary(node)) return;
    if (ts.isDeleteExpression(node)) {
      let operand: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
      if (ts.isIdentifier(operand)) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * (#4206) The W2 trigger — a bare-identifier WRITE.
 *
 * §9.1.1.2.5 SetMutableBinding on an Object Environment Record is an ordinary
 * `Set(bindingObject, N, V, S)`: the value is arbitrary. The closed-fields
 * projection pins each field's representation from the LITERAL's initializer,
 * so it can only model the write when the value happens to fit that carrier —
 * and inside a `with` body the value is dynamically scoped by construction, so
 * nothing constrains it. Measured before this trigger existed,
 * `--target standalone`:
 *
 * ```js
 * var b = { p1: true };        // (field $p1 (mut i32))
 * with (b) { p1 = "x1"; }
 * b.p1                          // false   (spec: "x1")
 * ```
 *
 * The string was coerced into the boolean carrier and read back as `false`.
 * The same shape with a numeric or string field loses the value the same way.
 *
 * Compound assignments and `++`/`--` count: each performs SetMutableBinding
 * with the result of an abstract operation whose type the projection likewise
 * cannot pin. A MEMBER write (`o.p = v`) does not — that is an ordinary
 * property write on a resolved receiver, not a binding operation.
 *
 * Returns the NAMES rather than a boolean because this file cannot see the
 * target's shape. Both consumers supply the own-key set to
 * {@link planIrWithTarget}, and they MUST agree: the allocation pre-pass
 * (`declarations/dynamic-with-shape.ts`) decides the carrier and
 * `codegen/with-scope.ts` decides the lowering, so a plan that says
 * "open-object" to one and "closed-fields" to the other leaves a closed struct
 * being read through the Tier-2 host reflection that cannot see its fields —
 * `ReferenceError: p1 is not defined` (#3025's Tier-1 suite, measured).
 */
export function withBodyBareIdentifierWriteNames(body: ts.Statement): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionOrClassBoundary(node)) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const target = unwrapParens(node.left);
      if (ts.isIdentifier(target)) names.add(target.text);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrapParens(node.operand);
      if (ts.isIdentifier(operand)) names.add(operand.text);
    }
    // §13.3.2.4: `var x = v` inside the body does NOT create a binding here —
    // the `var` hoists to the enclosing function/script scope, and the
    // initializer is an ordinary assignment to the resolved reference, which
    // the Object Environment Record intercepts. `let`/`const` are excluded:
    // those DO create a fresh lexical binding in the block and never reach the
    // record.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const list = node.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) === 0
      ) {
        names.add(node.name.text);
      }
    }
    forEachChild(node, visit);
  };
  visit(body);
  return names;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function namesIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const name of a) if (b.has(name)) return true;
  return false;
}

/**
 * Plan only the W1 slice: a single identifier target whose directly executing
 * body uses bare-identifier DeleteBinding. This is intentionally independent
 * of host/standalone representation details; allocation consumes the plan in
 * the codegen pre-pass before it can create a closed struct.
 */
export function planIrWithTarget(statement: ts.WithStatement, ownKeys?: ReadonlySet<string>): IrWithTargetPlan {
  if (!irWithTargetIdentifier(statement)) return CLOSED_WITH_TARGET_PLAN;
  if (bodyContainsBareIdentifierDelete(statement.statement)) return DELETE_WITH_TARGET_PLAN;
  const written = withBodyBareIdentifierWriteNames(statement.statement);
  if (written.size === 0) return CLOSED_WITH_TARGET_PLAN;
  // A write to a name the target does not own is not SetMutableBinding on THIS
  // record — HasBinding answers false and the reference resolves outward — so it
  // must not cost the target its closed-fields representation. A caller that
  // cannot supply the key set gets the conservative plan.
  if (ownKeys !== undefined && !namesIntersect(written, ownKeys)) return CLOSED_WITH_TARGET_PLAN;
  return SET_WITH_TARGET_PLAN;
}

export type IrWithEnvironmentSelection =
  | { readonly ok: true; readonly closureCount: number }
  | { readonly ok: false; readonly reason: string };

export interface IrWithEnvironmentCapture {
  /** Hidden binding that carries the object-environment receiver. */
  readonly bindingName: string;
  /** Outer-to-inner ordering within the active `with` scope chain. */
  readonly scopeIndex: number;
}

/**
 * Select the exact nested-boundary surface supported by the first IR contract.
 * The walk is complete: an unseen nested boundary is never treated as safe.
 */
export function selectWithEnvironmentClosures(statement: ts.Statement): IrWithEnvironmentSelection {
  let closureCount = 0;
  let refusal: string | null = null;
  const closureBindingNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (refusal !== null) return;
    if (node !== statement) {
      if (ts.isFunctionExpression(node)) {
        if (node.asteriskToken) {
          refusal = "generator function expression capture is not in the with-environment IR slice";
          return;
        }
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          refusal = "async function expression capture is not in the with-environment IR slice";
          return;
        }
        closureCount++;
        let bindingExpression: ts.Expression = node;
        while (ts.isParenthesizedExpression(bindingExpression.parent)) bindingExpression = bindingExpression.parent;
        const parent = bindingExpression.parent;
        if (
          ts.isVariableDeclaration(parent) &&
          parent.initializer === bindingExpression &&
          ts.isIdentifier(parent.name)
        ) {
          closureBindingNames.add(parent.name.text);
        } else if (
          ts.isBinaryExpression(parent) &&
          parent.right === bindingExpression &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(parent.left)
        ) {
          closureBindingNames.add(parent.left.text);
        }
      } else if (ts.isArrowFunction(node)) {
        refusal = "arrow-function capture is not in the with-environment IR slice";
        return;
      } else if (ts.isFunctionDeclaration(node)) {
        refusal = "function-declaration hoisting is not in the with-environment IR slice";
        return;
      } else if (
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        refusal = "class or method capture is not in the with-environment IR slice";
        return;
      }
    }
    forEachChild(node, visit);
  };

  visit(statement);
  return refusal === null ? { ok: true, closureCount } : { ok: false, reason: refusal };
}

/** Create the ordered capture contract consumed by backend closure lowering. */
export function planWithEnvironmentCaptures(bindingNames: readonly string[]): readonly IrWithEnvironmentCapture[] {
  return bindingNames.map((bindingName, scopeIndex) => ({ bindingName, scopeIndex }));
}
