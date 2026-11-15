// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7346) When a read of a `string` module binding is an ordinary string
 * value. The slot is `(ref null $AnyString)`: it holds `null` until its first
 * write and after a write of anything that is not a string. A read sees a
 * string when
 *   - the declaration has an initializer and every write of the binding
 *     anywhere in the source (`scriptVarWrites`) stores a value the primitive
 *     classifier proves a string, so a written slot never holds `null`;
 *   - the read is a module-init use after the declaration
 *     (`scriptVarUseFollowsDeclaration`), so the slot has been written.
 *     `typeof` reads it like any other use; `delete` is no read.
 * Such a read is judged by the ordinary expression arms, exactly like a local
 * string; any other read keeps the opaque-reference discipline
 * (`isIrModuleReferenceValueKind`).
 */
import { ts } from "../ts-api.js";
import { isStoreTarget, outermostParenthesized } from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration, scriptVarWrites } from "./module-binding-script-var.js";
import type { ClassifyPrimitive } from "./regexp-match-uses.js";

const writesStringsCache = new WeakMap<ts.VariableDeclaration, boolean>();

/** Whether the binding is initialized and every one of its writes stores a proven string. */
function everyWriteIsString(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  classify: ClassifyPrimitive,
): boolean {
  let cached = writesStringsCache.get(declaration);
  if (cached === undefined) {
    const writes = scriptVarWrites(checker, declaration);
    cached =
      declaration.initializer !== undefined &&
      writes !== undefined &&
      writes.every((write) => write.kind === "value" && classify(write.expr) === "string");
    writesStringsCache.set(declaration, cached);
  }
  return cached;
}

/** True when `node`, a read of the `string` binding `declaration`, is an ordinary string value. */
export function stringBindingReadIsValue(
  checker: ts.TypeChecker,
  node: ts.Identifier,
  declaration: ts.VariableDeclaration | ts.BindingElement,
  classify: ClassifyPrimitive,
): boolean {
  if (!ts.isVariableDeclaration(declaration) || node === declaration.name || isStoreTarget(node)) return false;
  if (ts.isDeleteExpression(outermostParenthesized(node).parent)) return false;
  return scriptVarUseFollowsDeclaration(node, declaration) && everyWriteIsString(checker, declaration, classify);
}
