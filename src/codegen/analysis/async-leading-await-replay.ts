// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6846) A nested `await` that is the FIRST observable step of its statement.
//
// `lowerLinearStatements` accepts an await only DIRECTLY as a statement's
// return operand / identifier initializer / expression / assignment RHS, plus a
// few bounded nested shapes (`replaySafeNestedCallAwait`, the #6504 spill
// call). Every other nested await made the whole function fall back to the
// legacy synchronous pass-through, where `await` is an identity and the Promise
// OBJECT flows on as the value:
//
//   return show(await load());                 // show(<Promise>)
//   const [key, value] = await pair();         // "value is not iterable"
//   const init = { body: await req.text() };   // hono cloneRawRequest: body = Promise
//   return String(await getKey());             // "[object Promise]"
//
// The resume machine already has the substitution these need: a resume binding
// carrying `awaitTarget` makes the expression dispatcher read THAT exact
// AwaitExpression from the delivered local when the containing statement is
// compiled in the resume state (`asyncAwaitValueLocals`). Recompiling the
// statement after the resumption is sound exactly when everything the statement
// evaluated BEFORE the await is free of observable effects and reads only
// values the suspension cannot change — then evaluating it again after the
// resume is indistinguishable from having evaluated it once, before.
//
// This module decides that, by walking from the await up to the statement and,
// at each ancestor, checking the operands evaluated before the await's branch
// (§13 evaluation order). Admitted pre-await operands: literals; identifiers
// bound to a `const`, a function / class declaration or an import; a fixed set
// of ambient constructors/namespaces (`String`, `JSON`, …) and plain property
// reads off them (`JSON.parse`). An await that might NOT be evaluated (a
// conditional / short-circuit arm, an optional chain, a binding default) is
// declined — it is not "first", it is conditional, and the CFG hoister owns
// those shapes.
//
// (#7094) A `let`/`var` local of the awaiting function is also admitted when
// nothing can write it between the pre-await read and the resumption: no
// nested function / class scope references it (so no other code can run a
// write during the suspension) and the awaited operand neither names it nor
// calls `eval`. Its value is spilled across the suspension like every local,
// so the post-resume read observes exactly the pre-await value. This is what
// `r += await p` and `r = r + await p` need — the compound target is read
// before the right operand (§13.15.2), and declining dropped the function to
// the pass-through that added the Promise OBJECT instead of its value.

import { forEachChild, ts } from "../../ts-api.js";
import { isNestedFunctionScope } from "../async-cps-ast.js";

/**
 * Ambient bindings a program does not reassign in practice. Reading one before
 * the suspension and again after it observes the same value. User code that
 * reassigns `JSON` across an `await` is outside what this lane promises.
 */
const STABLE_AMBIENTS: ReadonlySet<string> = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "TypeError",
  "URL",
  "decodeURIComponent",
  "encodeURIComponent",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
]);

function isImmutableBinding(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (id.text === "undefined") return true;
  const symbol = checker.getSymbolAtLocation(id);
  const declarations = symbol?.getDeclarations() ?? [];
  if (declarations.length === 0) return STABLE_AMBIENTS.has(id.text);
  if (declarations.some((d) => d.getSourceFile().isDeclarationFile)) return STABLE_AMBIENTS.has(id.text);
  if (declarations.length !== 1) return false;
  const decl = declarations[0]!;
  if (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) return true;
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) return true;
  return (
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name) &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function isScopeBoundary(node: ts.Node): boolean {
  return isNestedFunctionScope(node) || ts.isClassLike(node) || ts.isClassStaticBlockDeclaration(node);
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isScopeBoundary(current)) current = current.parent;
  return current;
}

/**
 * Does `root` name `eval` anywhere, or name `symbol` (with `nestedOnly`: only
 * inside a function / class scope nested below `root`)?
 */
function referencesSymbol(root: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker, nestedOnly: boolean): boolean {
  let found = false;
  const walk = (node: ts.Node, nested: boolean): void => {
    if (found) return;
    const inNested = nested || isScopeBoundary(node);
    if (ts.isIdentifier(node)) {
      if (node.text === "eval" || ((inNested || !nestedOnly) && checker.getSymbolAtLocation(node) === symbol)) {
        found = true;
      }
      return;
    }
    forEachChild(node, (child) => walk(child, inNested));
  };
  forEachChild(root, (child) => walk(child, false));
  return found;
}

/**
 * (#7094) Is `id` a `let`/`var` local of the function that awaits `awaitNode`
 * that nothing can write between its pre-await read and the resumption?
 */
function isSuspensionStableLocal(id: ts.Identifier, awaitNode: ts.AwaitExpression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(id);
  const declarations = symbol?.getDeclarations() ?? [];
  if (symbol === undefined || declarations.length !== 1) return false;
  const decl = declarations[0]!;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !ts.isVariableDeclarationList(decl.parent)) {
    return false; // a catch binding is a VariableDeclaration too
  }
  const scope = enclosingScope(decl);
  if (scope === undefined || scope !== enclosingScope(awaitNode) || !isNestedFunctionScope(scope)) return false;
  if (referencesSymbol(scope, symbol, checker, true)) return false;
  return !referencesSymbol(awaitNode, symbol, checker, false);
}

/** May `expr`, evaluated before the suspension, be evaluated again after it? */
function isReplaySafeOperand(expr: ts.Expression, checker: ts.TypeChecker, awaitNode: ts.AwaitExpression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  switch (e.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
  }
  if (ts.isIdentifier(e)) return isImmutableBinding(e, checker) || isSuspensionStableLocal(e, awaitNode, checker);
  // `JSON.parse` — a plain read off a stable ambient namespace.
  if (ts.isPropertyAccessExpression(e) && e.questionDotToken === undefined && ts.isIdentifier(e.expression)) {
    const base = e.expression;
    const symbol = checker.getSymbolAtLocation(base);
    const declarations = symbol?.getDeclarations() ?? [];
    return (
      STABLE_AMBIENTS.has(base.text) &&
      (declarations.length === 0 || declarations.every((d) => d.getSourceFile().isDeclarationFile))
    );
  }
  return false;
}

function allReplaySafe(exprs: readonly ts.Node[], checker: ts.TypeChecker, awaitNode: ts.AwaitExpression): boolean {
  return exprs.every((x) => ts.isExpression(x) && isReplaySafeOperand(x, checker, awaitNode));
}

/**
 * The operands of `parent` evaluated before its child `child`, or `null` when
 * `child` might not be evaluated at all / the parent kind is not modelled.
 */
function operandsBefore(parent: ts.Node, child: ts.Node): readonly ts.Node[] | null {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent)
  ) {
    return [];
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    const op = parent.operator;
    return op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken ? null : [];
  }
  if (ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent)) return [];
  if (ts.isPropertyAccessExpression(parent)) {
    return parent.expression === child && parent.questionDotToken === undefined ? [] : null;
  }
  if (ts.isElementAccessExpression(parent)) {
    if (parent.questionDotToken !== undefined) return null;
    return parent.expression === child ? [] : [parent.expression];
  }
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    if (ts.isCallExpression(parent) && parent.questionDotToken !== undefined) return null;
    if (parent.expression === child) return [];
    const args: readonly ts.Expression[] = parent.arguments ?? [];
    const index = args.indexOf(child as ts.Expression);
    if (index < 0) return null;
    // The callee reference is read before any argument.
    const callee = parent.expression;
    const before: ts.Node[] = [];
    if (ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee.expression)) return null;
    before.push(callee);
    for (const arg of args.slice(0, index)) {
      if (ts.isSpreadElement(arg)) return null;
      before.push(arg);
    }
    return before;
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return parent.left === child ? [] : null;
    }
    if (op === ts.SyntaxKind.EqualsToken) {
      // `x = <…await…>`: resolving a plain identifier reference has no effect.
      return parent.right === child && ts.isIdentifier(parent.left) ? [] : null;
    }
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
      // (#7094) `x op= <…await…>`: the target's value is read before the right
      // operand. Logical assignments may skip the right operand entirely.
      if (
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        return null;
      }
      return parent.right === child && ts.isIdentifier(parent.left) ? [parent.left] : null;
    }
    return parent.left === child ? [] : [parent.left];
  }
  if (ts.isArrayLiteralExpression(parent)) {
    const index = parent.elements.indexOf(child as ts.Expression);
    if (index < 0) return null;
    const before = parent.elements.slice(0, index);
    return before.some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e)) ? null : before;
  }
  if (ts.isTemplateSpan(parent)) {
    const template = parent.parent;
    const index = template.templateSpans.indexOf(parent);
    return template.templateSpans.slice(0, index).map((span) => span.expression);
  }
  if (ts.isTemplateExpression(parent)) return [];
  if (ts.isPropertyAssignment(parent)) {
    if (parent.initializer !== child) return null;
    return ts.isComputedPropertyName(parent.name) ? [parent.name.expression] : [];
  }
  if (ts.isObjectLiteralExpression(parent)) {
    const index = parent.properties.indexOf(child as ts.ObjectLiteralElementLike);
    if (index < 0) return null;
    const before: ts.Node[] = [];
    for (const prop of parent.properties.slice(0, index)) {
      if (ts.isPropertyAssignment(prop)) {
        if (ts.isComputedPropertyName(prop.name)) before.push(prop.name.expression);
        before.push(prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.objectAssignmentInitializer !== undefined) return null;
        before.push(prop.name);
      } else {
        return null; // spread / accessor / method — not modelled
      }
    }
    return before;
  }
  return null;
}

/**
 * Is `awaitNode` the first observable step of `stmt` (a return, expression or
 * single-declarator variable statement), so the statement can be recompiled in
 * the resume state with the delivered value substituted for the await?
 */
export function isLeadingReplaySafeAwait(
  stmt: ts.Statement,
  awaitNode: ts.AwaitExpression,
  checker: ts.TypeChecker | undefined,
): boolean {
  if (checker === undefined) return false;
  let root: ts.Node;
  if (ts.isReturnStatement(stmt) || ts.isExpressionStatement(stmt)) {
    if (stmt.expression === undefined) return false;
    root = stmt.expression;
  } else if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length !== 1 || decls[0]!.initializer === undefined) return false;
    root = decls[0]!.initializer;
  } else {
    return false;
  }
  let current: ts.Node = awaitNode;
  while (current !== root) {
    const parent = current.parent;
    if (parent === undefined) return false;
    const before = operandsBefore(parent, current);
    if (before === null || !allReplaySafe(before, checker, awaitNode)) return false;
    current = parent;
  }
  return true;
}

/**
 * (#7094) The bare identifiers a leading-await replay re-reads after the
 * resumption: the pre-await operands on the path from `awaitNode` up to its
 * statement. They lexically PRECEDE the await, so the whole-remainder liveness
 * walk (`collectReferencedAfter`) misses them, and a local read only there was
 * not spilled — `const k = 10; return k + await p` resumed with `k` reset to 0.
 * Purely syntactic and a superset of what replay admits (an extra spill is only
 * a frame field); empty when the chain cannot be replayed at all.
 */
export function replayPreAwaitReads(awaitNode: ts.AwaitExpression): readonly string[] {
  const out: string[] = [];
  let current: ts.Node = awaitNode;
  for (;;) {
    const parent: ts.Node | undefined = current.parent;
    if (parent === undefined) return [];
    if (ts.isExpressionStatement(parent) || ts.isReturnStatement(parent)) return out;
    if (ts.isVariableDeclaration(parent)) return parent.initializer === current ? out : [];
    const before = operandsBefore(parent, current);
    if (before === null) return [];
    for (const operand of before) {
      let e = operand;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isIdentifier(e)) out.push(e.text);
    }
    current = parent;
  }
}
