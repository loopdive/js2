// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7292, lever V) Admission for a SCRIPT `var` initialized by a string array
 * literal (`var __expected = ["abc"]`). Legacy stores it in the native-string
 * vec `__mod_<name>` slot (`scriptVarHome`'s `vec` home); the IR reads it as
 * that vec. Like #7252's class instance, every IR read must see the written
 * slot:
 *   - the declaration's initializer is the binding's only write anywhere in the
 *     source, its elements are all string literals, with no hole and no
 *     spread, and no `with` / direct `eval` resolves a name outside checker
 *     identity;
 *   - every use is a module-init use after the declaration (the shared
 *     `scriptVarUseFollowsDeclaration`), and one the IR vec lowers: an element
 *     read, `.length`, or a named (expando) property read or write, which goes
 *     through the dynamic carrier as legacy's does.
 * A use anywhere else is refused at its site and stays on the direct path,
 * which reads the same slot.
 */
import { ts } from "../ts-api.js";
import {
  hasDynamicScope,
  identifierWritesOf,
  isStoreTarget,
  outermostParenthesized,
  stripParens,
} from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration } from "./module-binding-class-instance.js";
import type { IrModuleBindingValueKind } from "./module-binding-value-kinds.js";

export type VecValueKind = Extract<IrModuleBindingValueKind, { kind: "vec" }>;

const vecKindCache = new WeakMap<ts.VariableDeclaration, VecValueKind | null>();

/** Whether every element of `literal` is a string literal (no hole, no spread). */
function isStringLiteralList(literal: ts.ArrayLiteralExpression): boolean {
  return literal.elements.every((element) => {
    const value = stripParens(element);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
  });
}

function computeVecKind(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): VecValueKind | undefined {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return undefined;
  const literal = stripParens(declaration.initializer);
  if (!ts.isArrayLiteralExpression(literal) || literal.elements.length === 0 || !isStringLiteralList(literal)) {
    return undefined;
  }
  const sourceFile = declaration.getSourceFile();
  if (hasDynamicScope(sourceFile)) return undefined;
  const bindingSymbol = checker.getSymbolAtLocation(declaration.name);
  let onlyWrite = true;
  const visit = (node: ts.Node): void => {
    if (!onlyWrite) return;
    for (const write of identifierWritesOf(node)) {
      if (write.target !== declaration.name && checker.getSymbolAtLocation(write.target) === bindingSymbol) {
        onlyWrite = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return onlyWrite ? { kind: "vec", element: "string" } : undefined;
}

/** The kind of a binding whose one write is a string array literal, or `undefined`. */
export function vecValueKind(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration | ts.BindingElement,
): VecValueKind | undefined {
  if (!ts.isVariableDeclaration(declaration)) return undefined;
  let cached = vecKindCache.get(declaration);
  if (cached === undefined) {
    cached = computeVecKind(checker, declaration) ?? null;
    vecKindCache.set(declaration, cached);
  }
  return cached ?? undefined;
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

/** True when `node` is the declaration, or a use after it that the IR vec lowers. */
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
  // A named property is an expando on the array object: a read, or a plain `=` write.
  return (
    !isStoreTarget(access) ||
    (ts.isBinaryExpression(use) && use.operatorToken.kind === ts.SyntaxKind.EqualsToken && !isStoreTarget(use))
  );
}
