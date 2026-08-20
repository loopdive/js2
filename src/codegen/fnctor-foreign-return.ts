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

export function fnctorBodyMayReturnForeignObject(funcDecl: ts.FunctionDeclaration): boolean {
  if (!funcDecl.body) return false;
  let found = false;
  const obviouslyNonForeign = (e: ts.Expression): boolean => {
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    if (x.kind === ts.SyntaxKind.ThisKeyword) return true;
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

/**
 * Is `tsType` the INSTANCE shape of a foreign-return-capable function-style
 * constructor? Member reads off such a receiver must not trust the checker's
 * member types either — the runtime value may be an arbitrary object, so the
 * inferred `prop: number` can misread an override (`"A"` → ToNumber = NaN).
 * Callable types are excluded: the function VALUE keeps its own lowering.
 */
export function typeIsForeignReturnFnctorInstance(tsType: ts.Type): boolean {
  const sym = tsType.getSymbol?.() ?? tsType.symbol;
  const decl = sym?.valueDeclaration;
  if (decl === undefined || !ts.isFunctionDeclaration(decl)) return false;
  if (tsType.getCallSignatures().length > 0) return false;
  return fnctorBodyMayReturnForeignObject(decl);
}
