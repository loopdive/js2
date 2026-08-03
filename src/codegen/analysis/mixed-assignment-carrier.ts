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
import { annexBDeclaringRange, enclosingVarScope } from "../annexb-cancel.js";
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

/**
 * Annex B assigns a block-level function object into an existing var binding
 * when control reaches the declaration. That assignment is implicit in the
 * source AST, so the ordinary binary-assignment scan below cannot see it.
 */
function hasAnnexBFunctionAssignment(decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const name = decl.name.text;
  const scope = containingScope(decl);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      annexBDeclaringRange(node) !== null &&
      enclosingVarScope(node) === scope
    ) {
      found = true;
      return;
    }
    // Inspect a nested FunctionDeclaration's declaration site above, but do
    // not search its body: declarations there belong to another var scope.
    if (node !== scope && ts.isFunctionLike(node)) return;
    forEachChild(node, visit);
  };

  forEachChild(scope, visit);
  return found;
}

export function bindingHasMixedAssignmentCarrier(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  if (hasAnnexBFunctionAssignment(decl)) return true;
  if (!decl.initializer) return false;

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
