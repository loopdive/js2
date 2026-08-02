// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Detect bindings whose runtime values cross JavaScript representation domains.
 *
 * The TypeScript checker can keep the initializer's narrow type for JavaScript
 * sources even when a later assignment stores a different runtime kind. A Wasm
 * local cannot do that implicitly: an i32 boolean slot, for example, destroys a
 * later string assignment by coercing it to truthiness. Such bindings need the
 * boxed externref carrier.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { JsTag } from "../../checker/oracle.js";
import type { ValType } from "../../ir/types.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

function stripParens(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

function containingScope(decl: ts.VariableDeclaration): ts.Node {
  for (let node: ts.Node | undefined = decl.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) return node;
    if (ts.isSourceFile(node)) return node;
  }
  return decl.getSourceFile();
}

function carrierDomain(tag: JsTag): string {
  // Boolean and symbol both use i32 physically, but their boxing semantics are
  // distinct, so crossing between them still requires a dynamic carrier.
  return tag;
}

function literalPropertyNames(initializer: ts.ObjectLiteralExpression): Set<string> | null {
  const names = new Set<string>();
  for (const property of initializer.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    const name = property.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))) return null;
    names.add(name.text);
  }
  return names;
}

/**
 * A closed object local is widened by codegen when a later direct write adds a
 * property outside the literal's initial shape. Detect that before any nested
 * function signatures capture the local: changing the physical slot after a
 * lifted function has recorded `(ref $OldShape)` leaves a stale capture ABI and
 * turns the later externref value into an `illegal cast` during closure creation.
 *
 * The object itself may stay on the closed-struct path. Only its local carrier
 * is widened, so statically known consumers can recover the original struct by
 * casting the externref while the capture contract remains stable for the whole
 * enclosing activation.
 */
function bindingHasOutOfShapePropertyWrite(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return false;
  const initialProperties = literalPropertyNames(decl.initializer);
  if (!initialProperties) return false;

  const scope = containingScope(decl);
  let widens = false;
  const visit = (node: ts.Node): void => {
    if (widens) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      let receiver: ts.Expression = node.left.expression;
      while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      if (
        ts.isIdentifier(receiver) &&
        ctx.oracle.variableDeclarationOf(receiver) === decl &&
        !initialProperties.has(node.left.name.text)
      ) {
        widens = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  return widens;
}

export function bindingHasMixedAssignmentCarrier(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return false;

  if (bindingHasOutOfShapePropertyWrite(ctx, decl)) return true;

  const initialTag = ctx.oracle.staticJsTypeOf(decl.initializer);
  if (initialTag === "mixed") return false;
  const initialDomain = carrierDomain(initialTag);
  const scope = containingScope(decl);
  let mixed = false;

  const visit = (node: ts.Node): void => {
    if (mixed) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = stripParens(node.left);
      if (ts.isIdentifier(target) && target !== decl.name && ctx.oracle.variableDeclarationOf(target) === decl) {
        const assignedTag = ctx.oracle.staticJsTypeOf(node.right);
        if (assignedTag === "mixed" || carrierDomain(assignedTag) !== initialDomain) {
          mixed = true;
          return;
        }
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(scope, visit);
  return mixed;
}

export function effectiveLocalCarrier(fctx: FunctionContext, expression: ts.Expression, fallback: ValType): ValType {
  if (!ts.isIdentifier(expression)) return fallback;
  const localIdx = fctx.localMap.get(expression.text);
  return localIdx === undefined ? fallback : (getLocalType(fctx, localIdx) ?? fallback);
}
