// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2071) May this function-style constructor's body `return` a FOREIGN
 * object — i.e. anything §10.2.1.3 step 13 would prefer over the
 * freshly-created receiver?
 *
 * Purely syntactic and deliberately conservative: any `return` operand that is
 * not OBVIOUSLY primitive / `this` counts, because the cost of a false
 * positive is one widened ctor ABI plus a dynamic instance representation,
 * while a false negative silently drops the spec override. Nested function
 * bodies are skipped — their `return`s belong to them.
 *
 * Two consumers must agree on this answer for the same declaration:
 *  - `compileNewFunctionDeclaration` (expressions/new-super.ts) mints the
 *    ctor ABI from it (externref result + runtime construct-return select);
 *  - `resolveWasmType` (index.ts) degrades the checker's INSTANCE shape for
 *    such a constructor to externref, because that inference is unsound: the
 *    constructed value may be an arbitrary object, so a closed struct shape
 *    (and every numeric member coercion derived from it) misreads the
 *    override (`obj.prop` answered ToNumber("A") = NaN).
 * Keeping it a pure function of the AST — no ctx, no cache — is what makes
 * the agreement unconditional and immune to compile order.
 */
import ts from "typescript";

/**
 * (#4610) The name this function-style constructor is reachable under, for the
 * three spellings the rest of this module already recognises: `function F(){…}`,
 * `var F = function(){…}` and `F = function(){…}`. Purely syntactic — it reads
 * the declaration's own parent, never the checker.
 */
function fnctorSelfName(funcDecl: ts.FunctionLikeDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(funcDecl) || ts.isFunctionExpression(funcDecl)) && funcDecl.name !== undefined) {
    return funcDecl.name.text;
  }
  const parent = funcDecl.parent as ts.Node | undefined;
  if (parent === undefined) return undefined;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === funcDecl) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left) &&
    parent.right === funcDecl
  ) {
    return parent.left.text;
  }
  return undefined;
}

export function fnctorBodyMayReturnForeignObject(funcDecl: ts.FunctionLikeDeclaration): boolean {
  if (!funcDecl.body) return false;
  // (#4610) `return new F(…)` inside F itself — the callable-as-function guard
  // (`if (!(this instanceof F)) return new F(x);`). See `obviouslyNonForeign`.
  const selfName = fnctorSelfName(funcDecl);
  let found = false;
  const obviouslyNonForeign = (e: ts.Expression): boolean => {
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    if (x.kind === ts.SyntaxKind.ThisKeyword) return true;
    // (#4610) SELF-CONSTRUCTION is not a foreign return. `new F(…)` written
    // inside F's own body yields a value drawn from exactly the set `new F(…)`
    // already yields at the OUTER construct site, so the override substitutes
    // nothing the caller's representation did not already have to admit —
    // formally, with S the value set of `new F(…)`, the body returns either the
    // fresh receiver (an F instance) or an element of S, and S = {F instances}
    // satisfies that. Treating it as foreign is what made the ubiquitous
    // callable-as-function guard
    //
    //     function Test262Error(message) {
    //       if (!(this instanceof Test262Error)) return new Test262Error(message);
    //       this.message = message || "";
    //     }
    //
    // (test262's own `harness/sta.js`) degrade EVERY Test262Error binding in
    // EVERY standalone test to externref — 12 asyncHelpers rows failed with
    // "Promise.prototype.then called on a non-Promise receiver" off the back of
    // it. Name-matched, exactly like `foreignReturnFunctionNames`: a runtime
    // rebinding of `F` is the same (already accepted) risk the `__fnctor_<name>`
    // mapping takes everywhere else. Any OTHER `return <object>` in the body
    // still trips the predicate, so a genuine override is never missed.
    if (
      selfName !== undefined &&
      ts.isNewExpression(x) &&
      ts.isIdentifier(x.expression) &&
      x.expression.text === selfName
    ) {
      return true;
    }
    if (ts.isNumericLiteral(x) || ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return true;
    if (
      x.kind === ts.SyntaxKind.TrueKeyword ||
      x.kind === ts.SyntaxKind.FalseKeyword ||
      x.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    if (ts.isIdentifier(x) && x.text === "undefined") return true;
    if (ts.isVoidExpression(x) || ts.isTypeOfExpression(x)) return true;
    if (ts.isPrefixUnaryExpression(x)) return true; // +v / -v / !v / ~v — always primitive
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n !== funcDecl && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression && !obviouslyNonForeign(n.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(funcDecl.body);
  return found;
}

const foreignNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * Names under which a foreign-return-capable function-style constructor is
 * reachable in `sf`: `function F(){…}` declarations, plus `var F =
 * function(){…}` initializers and `F = function(){…}` assignments (the
 * S13.2.2_A15_T3/T4 shapes). Purely syntactic, cached per file — consumers
 * use this to distrust `__fnctor_<name>` struct shapes wholesale.
 */
export function foreignReturnFunctionNames(sf: ts.SourceFile): ReadonlySet<string> {
  const cached = foreignNamesCache.get(sf);
  if (cached) return cached;
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && fnctorBodyMayReturnForeignObject(n)) {
      out.add(n.name.text);
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      ts.isFunctionExpression(n.initializer) &&
      fnctorBodyMayReturnForeignObject(n.initializer)
    ) {
      out.add(n.name.text);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      ts.isFunctionExpression(n.right) &&
      fnctorBodyMayReturnForeignObject(n.right)
    ) {
      out.add(n.left.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  foreignNamesCache.set(sf, out);
  return out;
}

/**
 * Is `tsType` the INSTANCE shape of a foreign-return-capable function-style
 * constructor? Member reads off such a receiver must not trust the checker's
 * member types either — the runtime value may be an arbitrary object, so the
 * inferred `prop: number` can misread an override (`"A"` → ToNumber = NaN).
 * Callable types are excluded: the function VALUE keeps its own lowering.
 */
export function typeIsForeignReturnFnctorInstance(tsType: ts.Type): boolean {
  const sym = tsType.getSymbol?.() ?? tsType.symbol;
  if (sym === undefined) return false;
  if (tsType.getCallSignatures().length > 0) return false;
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl === undefined) return false;
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) {
    return fnctorBodyMayReturnForeignObject(decl);
  }
  if (ts.isVariableDeclaration(decl) && decl.initializer !== undefined && ts.isFunctionExpression(decl.initializer)) {
    return fnctorBodyMayReturnForeignObject(decl.initializer);
  }
  // `var F; F = function(){…}` — the ctor is assigned later, so the symbol's
  // declaration is the bare var. Match by name against the file's scan.
  const sf = decl.getSourceFile();
  return sf !== undefined && foreignReturnFunctionNames(sf).has(sym.name);
}
