// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7292, lever V) Admission for a SCRIPT `var` initialized by a string array
 * literal (`var __expected = ["abc"]`). Legacy stores it in the native-string
 * vec `__mod_<name>` slot (`scriptVarHome`'s `vec` home); the IR reads it as
 * that vec. Like #7252's class instance, every IR read must see the written
 * slot:
 *   - the declaration's initializer is the binding's only write anywhere in the
 *     source (`scriptVarWrites`), its elements are all string literals, with no
 *     hole and no spread;
 *   - every use follows the declaration in module-init and is one the IR vec
 *     lowers (`vecUseSupported`).
 * A use anywhere else is refused at its site and stays on the direct path,
 * which reads the same slot.
 */
import { ts } from "../ts-api.js";
import { isStoreTarget, outermostParenthesized, stripParens } from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration, scriptVarWrites } from "./module-binding-script-var.js";
import type { IrModuleBindingValueKind } from "./module-binding-value-kinds.js";

export type VecValueKind = Extract<IrModuleBindingValueKind, { kind: "vec" }>;

/** Whether every element of `literal` is a string literal (no hole, no spread). */
function isStringLiteralList(literal: ts.ArrayLiteralExpression): boolean {
  return literal.elements.every((element) => {
    const value = stripParens(element);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
  });
}

/** The kind of a binding whose one write is a string array literal, or `undefined`. */
export function vecValueKind(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration | ts.BindingElement,
): VecValueKind | undefined {
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
  const literal = stripParens(declaration.initializer);
  if (!ts.isArrayLiteralExpression(literal) || literal.elements.length === 0 || !isStringLiteralList(literal)) {
    return undefined;
  }
  const writes = scriptVarWrites(checker, declaration);
  return writes?.every((write) => write.target === declaration.name) ? { kind: "vec", element: "string" } : undefined;
}

/** True when `node` writes a vec binding through its own (certified) initializer. */
export function vecWriteMatches(
  declaration: ts.VariableDeclaration | ts.BindingElement,
  value: ts.Expression,
): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    value === stripParens(declaration.initializer)
  );
}

/**
 * True when `node` is the declaration, or a use after it that the IR vec
 * lowers: an element read, `.length`, a plain `=` write of a named property
 * (an expando), or a named read of an expando an earlier top-level statement
 * wrote. An inherited `Array.prototype` name is not one: the dynamic reader
 * sees only the boxed vec's own properties. The element and expando reads
 * lower to the dynamic carrier; the selector types them so and judges their
 * key and consumer (`phase1ScriptVarVecRead`).
 */
export function vecUseSupported(node: ts.Identifier, declaration: ts.VariableDeclaration | ts.BindingElement): boolean {
  if (node === declaration.name) return true;
  if (!scriptVarUseFollowsDeclaration(node, declaration)) return false;
  const receiver = outermostParenthesized(node);
  const access = receiver.parent;
  if (!(ts.isElementAccessExpression(access) || ts.isPropertyAccessExpression(access))) return false;
  if (access.expression !== receiver) return false;
  const use = outermostParenthesized(access).parent;
  if (ts.isDeleteExpression(use) || (ts.isCallExpression(use) && use.expression === outermostParenthesized(access))) {
    return false;
  }
  if (ts.isElementAccessExpression(access) || access.name.text === "length") return !isStoreTarget(access);
  if (!isStoreTarget(access)) return expandoWrittenBefore(node, access.name.text);
  return ts.isBinaryExpression(use) && use.operatorToken.kind === ts.SyntaxKind.EqualsToken && !isStoreTarget(use);
}

/** Whether a top-level `<binding>.<name> = …;` statement runs before `node`'s statement. */
function expandoWrittenBefore(node: ts.Identifier, name: string): boolean {
  return node.getSourceFile().statements.some((statement) => {
    if (statement.end > node.pos || !ts.isExpressionStatement(statement)) return false;
    const write = stripParens(statement.expression);
    return (
      ts.isBinaryExpression(write) &&
      write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(write.left) &&
      write.left.name.text === name &&
      ts.isIdentifier(write.left.expression) &&
      write.left.expression.text === node.text
    );
  });
}
