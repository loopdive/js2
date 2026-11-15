// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7346) When a read of a `string` module binding is an ordinary string
 * value. The slot is `(ref null $AnyString)`: it holds `null` until its first
 * write and after a write of anything that is not a string. A read sees a
 * string when
 *   - the declaration has an initializer and every write of the binding
 *     anywhere in the source (`scriptVarWrites`) stores a value the primitive
 *     classifier proves a string, so a written slot never holds `null`, and
 *     that reads no binding on the dynamic carrier: the checker types
 *     `" " + d` a string, but the IR lowers it on the carrier, which the
 *     string slot does not take (the rule `carrierLeafReads` states for a
 *     destructured leaf);
 *   - the read is a module-init use after the declaration
 *     (`scriptVarUseFollowsDeclaration`), so the slot has been written.
 *     `typeof` reads it like any other use; `delete` is no read;
 *   - the checker types the read itself a string, or the read is `typeof`'s
 *     operand. from-ast's operand proofs (the `+` rule) key on the checker
 *     type, which narrowing makes `never` in a branch `typeof x !== "string"`
 *     guards; `typeof` folds from the IR type instead (`lowerTypeOf`).
 * Such a read is judged by the ordinary expression arms, exactly like a local
 * string; any other read keeps the opaque-reference discipline
 * (`isIrModuleReferenceValueKind`).
 */
import { ts } from "../ts-api.js";
import { isStoreTarget, outermostParenthesized } from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration, scriptVarWrites } from "./module-binding-script-var.js";
import type { ClassifyPrimitive } from "./regexp-match-uses.js";

/** The module binding an identifier resolves to (the resolver's identity), or `undefined`. */
type ResolveBinding = (
  node: ts.Identifier,
) =>
  | { readonly declaration: ts.VariableDeclaration | ts.BindingElement; readonly valueKind: { readonly kind: string } }
  | undefined;

const writesStringsCache = new WeakMap<ts.VariableDeclaration, boolean>();

function readsDynamicBinding(node: ts.Node, resolve: ResolveBinding): boolean {
  if (ts.isIdentifier(node)) return resolve(node)?.valueKind.kind === "dynamic";
  return ts.forEachChild(node, (child) => readsDynamicBinding(child, resolve) || undefined) === true;
}

/** Whether the binding is initialized and every one of its writes stores a proven string. */
function everyWriteIsString(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  classify: ClassifyPrimitive,
  resolve: ResolveBinding,
): boolean {
  let cached = writesStringsCache.get(declaration);
  if (cached === undefined) {
    const writes = scriptVarWrites(checker, declaration);
    cached =
      declaration.initializer !== undefined &&
      writes !== undefined &&
      writes.every(
        (write) =>
          write.kind === "value" && classify(write.expr) === "string" && !readsDynamicBinding(write.expr, resolve),
      );
    writesStringsCache.set(declaration, cached);
  }
  return cached;
}

/** True when `node` reads a `string` binding and the read is an ordinary string value. */
export function stringBindingReadIsValue(
  checker: ts.TypeChecker,
  node: ts.Identifier,
  resolve: ResolveBinding,
  classify: ClassifyPrimitive,
): boolean {
  const identity = resolve(node);
  if (identity?.valueKind.kind !== "string") return false;
  const declaration = identity.declaration;
  if (!ts.isVariableDeclaration(declaration) || node === declaration.name || isStoreTarget(node)) return false;
  const operator = outermostParenthesized(node).parent;
  if (ts.isDeleteExpression(operator)) return false;
  return (
    scriptVarUseFollowsDeclaration(node, declaration) &&
    (ts.isTypeOfExpression(operator) || classify(node) === "string") &&
    everyWriteIsString(checker, declaration, classify, resolve)
  );
}
