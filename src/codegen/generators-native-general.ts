// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#680) Statement-level desugarings that let the native generator planner
 * (`generators-native.ts`) lower a yield sitting in an EXPRESSION-STATEMENT
 * operator position it has no expression continuation for. Standalone/WASI
 * only — the JS-host lane keeps its eager buffer (byte-identical).
 *
 * Every rewrite here is exact because the statement's completion value is
 * discarded:
 *
 *   `A, B;`          ≡  `A; B;`                       (§13.16 — left then right)
 *   `A && B;`        ≡  `if (A) B;`                   (§13.13 — B only when ToBoolean(A))
 *   `A || B;`        ≡  `if (!A) B;`
 *   `A ? B : C;`     ≡  `if (A) B; else C;`           (§13.14)
 *
 * The condition operand `A` must be yield-free (a yield there would need the
 * condition's value to survive a suspension, which the branch terminator does
 * not model); `??` is not rewritten (its test is `A === undefined || A ===
 * null`, not ToBoolean). These are the shapes minified bundles use for
 * conditional yields — prettier's `o(s) && (yield s)` and `yield n, u.push(n)`.
 *
 * The rewritten statements are synthetic `ExpressionStatement`s wrapping the
 * ORIGINAL operand nodes, so checker queries on the operands still resolve;
 * the wrappers get the source range and parent of the statement they replace
 * so diagnostics keep a location.
 */
import { ts } from "../ts-api.js";
import { isFunctionLikeScope, nodeContainsYield } from "./generators-native-ast-scan.js";

export type YieldStatementDesugaring =
  | { kind: "sequence"; statements: ts.Statement[] }
  | {
      kind: "if";
      condition: ts.Expression;
      negate: boolean;
      thenStatements: ts.Statement[];
      elseStatements: ts.Statement[] | undefined;
    };

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function containsYield(expr: ts.Expression): boolean {
  return ts.isYieldExpression(expr) || nodeContainsYield(expr);
}

function synthStatement(expr: ts.Expression, origin: ts.Statement): ts.Statement {
  const stmt = ts.factory.createExpressionStatement(unwrapParens(expr));
  ts.setTextRange(stmt, origin);
  (stmt as { parent?: ts.Node }).parent = origin.parent;
  return stmt;
}

/** Every name a binding name binds (patterns flattened). */
function boundNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
}

/** Names a function scope declares (params, var/let/const, function/class declarations, catch params). */
function scopeDeclaredNames(fn: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  for (const p of fn.parameters) boundNames(p.name, names);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) boundNames(node.name, names);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    if (isFunctionLikeScope(node)) return;
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return names;
}

/** `id` names a binding, not a property / label / member key. */
function isReferencePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) {
    return false;
  }
  if (ts.isAccessor(p) && p.name === id) return false;
  return true;
}

/**
 * (#6731) A function DECLARATION nested directly in a generator body that
 * references no binding of the generator (other than its own name) — so it is
 * an ordinary lifted function whose instantiation time (hoisted to the start of
 * the body, §10.2.11 step 36) is unobservable. tailwindcss's variant walker
 * `function*Tt(e){function*i(r,t=null){…yield*i(…)}yield*i(e,null)}`.
 * A capturing one keeps the refusal: its captures would bind the resume
 * function's per-state copies, not the frame (measured: a mutation of a
 * captured param after a yield was not seen by the nested function).
 */
export function isSelfContainedNestedFunction(fn: ts.Statement, generator: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isFunctionDeclaration(fn) || !fn.name || !fn.body || fn.parent !== generator.body) return false;
  const outer = scopeDeclaredNames(generator);
  const own = scopeDeclaredNames(fn);
  const ownName = fn.name.text;
  let captures = false;
  const visit = (node: ts.Node): void => {
    if (captures) return;
    if (ts.isIdentifier(node) && node.text !== ownName && outer.has(node.text) && !own.has(node.text)) {
      captures = isReferencePosition(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const p of fn.parameters) visit(p);
  visit(fn.body);
  return !captures;
}

/**
 * (#6731) `if (A, B, C) S` ≡ `A; B; if (C) S` (§13.16: the comma operands are
 * evaluated left to right and all but the last discarded). Returned only when a
 * DISCARDED operand yields and the tested one does not — tailwindcss's
 * `if (r.add(i), yield {…}, p && (yield {…}), i.includes("/"))`.
 */
export function splitYieldingIfCondition(
  stmt: ts.IfStatement,
): { prefix: ts.Statement[]; condition: ts.Expression } | undefined {
  const operands: ts.Expression[] = [];
  const flatten = (expr: ts.Expression): void => {
    const e = unwrapParens(expr);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      flatten(e.left);
      flatten(e.right);
    } else operands.push(e);
  };
  flatten(stmt.expression);
  const condition = operands.pop();
  if (!condition || containsYield(condition) || !operands.some(containsYield)) return undefined;
  return { prefix: operands.map((operand) => synthStatement(operand, stmt)), condition };
}

/**
 * The desugaring of `stmt`, or `undefined` when it is not one of the shapes
 * above (or the rewrite would not help: no yield in a deferred operand).
 */
export function desugarYieldExpressionStatement(stmt: ts.Statement): YieldStatementDesugaring | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined;
  const root = unwrapParens(stmt.expression);
  if (!containsYield(root)) return undefined;
  if (ts.isBinaryExpression(root)) {
    const op = root.operatorToken.kind;
    if (op === ts.SyntaxKind.CommaToken) {
      return { kind: "sequence", statements: [synthStatement(root.left, stmt), synthStatement(root.right, stmt)] };
    }
    if (
      (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) &&
      !containsYield(root.left)
    ) {
      return {
        kind: "if",
        condition: root.left,
        negate: op === ts.SyntaxKind.BarBarToken,
        thenStatements: [synthStatement(root.right, stmt)],
        elseStatements: undefined,
      };
    }
    return undefined;
  }
  if (ts.isConditionalExpression(root) && !containsYield(root.condition)) {
    return {
      kind: "if",
      condition: root.condition,
      negate: false,
      thenStatements: [synthStatement(root.whenTrue, stmt)],
      elseStatements: [synthStatement(root.whenFalse, stmt)],
    };
  }
  return undefined;
}
