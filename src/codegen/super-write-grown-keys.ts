// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5350 r2) An object whose method performs `super.x = v` can gain own keys
 * its static type does not declare.
 *
 * §13.15.2 PutValue on a SuperProperty reference creates the property on the
 * RECEIVER — ordinarily the literal itself (`obj.method()`), or `C.prototype`
 * for `C.prototype.method()`. A closed-struct literal stores such a key in its
 * expando sidecar and `C.prototype` is a `$Object`, so every runtime own-key
 * query finds it; only the compile-time `hasOwnProperty` fold
 * (`compilePropertyIntrospection`), which answers from the static type,
 * cannot (probes c2, b2). This leaf names the receivers for which that fold
 * must ask the runtime instead. Import-free beyond the TS API, so the fold's
 * module takes no dependency on the `super` lowering.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/** `super.x = v` / `super[k] = v` inside `root`, with `super` bound by the enclosing method (arrows transparent). */
function containsSuperWrite(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let left: ts.Expression = node.left;
      while (ts.isParenthesizedExpression(left)) left = left.expression;
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        left.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

/** Does a method or accessor of `literal` write through `super`? */
function objectLiteralHasSuperWrite(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (prop) =>
      (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) &&
      prop.body !== undefined &&
      containsSuperWrite(prop.body),
  );
}

/** Does a non-static member of class `name`, or of an ancestor, write through `super`? */
function classHierarchyHasSuperWrite(ctx: CodegenContext, name: string): boolean {
  for (let cur: string | undefined = name, hops = 0; cur !== undefined && hops < 64; hops++) {
    const decl = ctx.classDeclarationMap.get(cur);
    const found = decl?.members.some(
      (member) =>
        (ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member) ||
          ts.isConstructorDeclaration(member)) &&
        member.body !== undefined &&
        !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
        containsSuperWrite(member.body),
    );
    if (found) return true;
    cur = ctx.classParentMap.get(cur);
  }
  return false;
}

/**
 * Is `expr` such a literal (or a variable initialised with one), or `C.prototype`
 * / a `C` instance where a member of `C`'s hierarchy writes through `super`
 * (`C.prototype.method()` puts the key on `C.prototype`)? Standalone only —
 * the super write is standalone-only (`super-property-write.ts`).
 */
function receiverGainsKeysViaSuperWrite(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ctx.standalone) return false;
  if (ts.isObjectLiteralExpression(expr)) return objectLiteralHasSuperWrite(expr);
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "prototype" && ts.isIdentifier(expr.expression)) {
    const className = ctx.classExprNameMap.get(expr.expression.text) ?? expr.expression.text;
    if (ctx.classDeclarationMap.has(className)) return classHierarchyHasSuperWrite(ctx, className);
  }
  const fact = ctx.oracle.typeFactOf(expr);
  if (fact.kind === "class") return classHierarchyHasSuperWrite(ctx, fact.name);
  if (!ts.isIdentifier(expr)) return false;
  const init = ctx.oracle.variableInitializerOf(expr);
  return init !== undefined && ts.isObjectLiteralExpression(init) && objectLiteralHasSuperWrite(init);
}

/**
 * Must `hasOwnProperty(key)` on `receiver` ask the runtime rather than fold
 * from `receiverType`? Only for a LITERAL key the static type does not declare
 * — a declared key keeps the fold's answer — on a receiver a `super` write can
 * grow ({@link receiverGainsKeysViaSuperWrite}).
 */
export function superWriteMayAddKey(
  ctx: CodegenContext,
  receiver: ts.Expression,
  receiverType: ts.Type,
  key: ts.Expression | undefined,
): boolean {
  if (key === undefined || !(ts.isStringLiteral(key) || ts.isNumericLiteral(key))) return false;
  return receiverType.getProperty(key.text) === undefined && receiverGainsKeysViaSuperWrite(ctx, receiver);
}
