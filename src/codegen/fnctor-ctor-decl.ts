// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Resolving a fnctor SYMBOL to the declaration that supplies its constructor
 * body. `fnctor-escape-gate.ts` owns the escape/approval analysis; this module
 * owns only the "which node is F's body?" question, so both of that file's
 * recognisers (`fnctorDeclFromSymbol` here, `resolveFnctorSymbol` there) can
 * share one admission rule.
 *
 * ## (#4653) The `var F; … F = function(){…};` spelling
 *
 * `var F = function(){}` is recognised by both recognisers off the
 * VariableDeclaration's own initializer. The Sputnik ES5 corpus overwhelmingly
 * writes the *separated* form instead (`var __CUBE, __FACTORY, __device;` then
 * `__FACTORY = function(){}`), and TypeScript records NO function declaration
 * for that symbol — `getDeclarations()` answers `[VariableDeclaration,
 * Identifier]`, the Identifier being the `F` of a later expando write, never the
 * assignment's right-hand function.
 *
 * The consequence was not a missed optimisation but the SPLIT BRAIN
 * `resolveUserFnctorName`'s gate comment names. That resolver reaches its
 * `neverConstructed` arm (the escape gate holds no ctor declaration for the
 * name, so "is it constructed?" answers no), mints `__fnctor_proto_F`, and
 * `F.prototype = {…}` / `F.prototype.p` read and write it consistently — while
 * `new F()` cannot route to the fnctor lowering at all and hands back an
 * instance whose [[Prototype]] is null. Measured on this branch's base:
 *
 *   var A; A = function(){}; A.prototype = {shape:"cube", printShape:…};
 *   var a = new A();
 *   A.prototype.shape        // "cube"   ← the write landed
 *   Object.getPrototypeOf(a) // null     ← the instance never saw it
 *
 * with the `var A = function(){}` spelling of the very same program correct on
 * the same run. Teaching BOTH recognisers this one shape is what keeps them in
 * lockstep; teaching only one would move the split rather than close it.
 *
 * Admission is deliberately narrow, because a wrong claim here is a miscompile
 * while a decline only forfeits today's behaviour:
 *   - the binding is a non-exported `var` with NO initializer, declared at the
 *     top level of its source file (a module-local `var` cannot be written from
 *     another file, so one file is the whole write set);
 *   - it is WRITTEN exactly once in that file, by a top-level
 *     `F = <FunctionExpression>` expression statement. A second write, a
 *     compound assignment, an update expression, or a for-in/of binding all
 *     decline — those are the shapes that could put a different value in the
 *     slot and re-open the split from the other side.
 */
import { ts } from "../ts-api.js";

/** Per-`ts.Symbol` memo; entries die with the program the symbols came from. */
const cache = new WeakMap<ts.Symbol, ts.FunctionExpression | null>();

/** Whether this identifier occurrence WRITES its binding. */
function isWritePosition(ident: ts.Identifier): boolean {
  const parent = ident.parent;
  if (ts.isBinaryExpression(parent) && parent.left === ident) {
    return (
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === ident) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === ident) return true;
  return false;
}

/** The single top-level `var` declaration behind `sym`, or `undefined`. */
function soleUninitializedTopLevelVar(sym: ts.Symbol): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  for (const decl of sym.getDeclarations() ?? []) {
    if (!ts.isVariableDeclaration(decl)) continue;
    if (decl.initializer !== undefined || !ts.isIdentifier(decl.name)) return undefined;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return undefined;
    const stmt = list.parent;
    if (!ts.isVariableStatement(stmt) || stmt.parent.kind !== ts.SyntaxKind.SourceFile) return undefined;
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return undefined;
    if (found) return undefined; // two `var F;` declarations — not worth proving
    found = decl;
  }
  return found;
}

/**
 * The `FunctionExpression` a once-assigned `var F;` binding holds, or
 * `undefined` when the shape is not provable. See the module header.
 */
export function lateAssignedFunctionExpression(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
): ts.FunctionExpression | undefined {
  const cached = cache.get(sym);
  if (cached !== undefined) return cached ?? undefined;

  const decide = (): ts.FunctionExpression | undefined => {
    const varDecl = soleUninitializedTopLevelVar(sym);
    if (!varDecl) return undefined;

    let found: ts.FunctionExpression | undefined;
    let writes = 0;
    const visit = (node: ts.Node): void => {
      if (writes > 1) return;
      if (ts.isIdentifier(node) && node.text === sym.name && isWritePosition(node)) {
        // Spelling alone does not prove identity — an inner scope may shadow
        // the name — so the symbol must match before the write is counted.
        if (checker.getSymbolAtLocation(node) === sym) {
          writes++;
          const parent = node.parent;
          const assignment =
            ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? parent
              : undefined;
          // Top-level `F = function(){…};` only: a write nested in a branch or
          // in a function body is not proof that the slot holds this value when
          // the module's `new F()` sites run.
          if (
            assignment &&
            ts.isExpressionStatement(assignment.parent) &&
            assignment.parent.parent.kind === ts.SyntaxKind.SourceFile
          ) {
            let rhs: ts.Expression = assignment.right;
            while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
            if (ts.isFunctionExpression(rhs) && rhs.body) found = rhs;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(varDecl.getSourceFile());
    return writes === 1 ? found : undefined;
  };

  const result = decide();
  cache.set(sym, result ?? null);
  return result;
}

/**
 * Resolve a fnctor symbol to the function-like declaration that supplies its
 * constructor body — a top-level `function F(){…}`, a `var F = function(){…}`, a
 * once-assigned `var F; F = function(){…}` (#4653, above), or a bare
 * `FunctionExpression`. Returns `undefined` for anything else (arrow, class —
 * those never reach here via `resolveFnctorSymbol`).
 *
 * `checker` is optional only so a caller without one keeps the pre-#4653
 * answers; every caller in `fnctor-escape-gate.ts` supplies it.
 */
export function fnctorDeclFromSymbol(
  sym: ts.Symbol,
  checker?: ts.TypeChecker,
): ts.FunctionDeclaration | ts.FunctionExpression | undefined {
  for (const decl of sym.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (ts.isFunctionExpression(decl) && decl.body) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) return init;
    }
  }
  return checker ? lateAssignedFunctionExpression(checker, sym) : undefined;
}
