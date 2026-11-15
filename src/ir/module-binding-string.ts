// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7346) When a read of a `string` module binding is an ordinary string
 * value. The slot is `(ref null $AnyString)`: it holds `null` until its first
 * write and after a write of anything that is not a string. The binding
 * qualifies when
 *   - it is initialized and every write anywhere in the source
 *     (`scriptVarWrites`) is a plain store (the initializer or `=`, never a
 *     compound assignment) of a value the primitive classifier proves a
 *     string, so a written slot never holds `null`;
 *   - no write reads a binding on the dynamic carrier: the checker types
 *     `" " + d` a string, but the IR lowers it on the carrier, which the
 *     string slot does not take (the rule `carrierLeafReads` states for a
 *     destructured leaf);
 *   - no write names a built-in the program redeclares: the checker reports a
 *     script's own `function String() {}` as the lib's (`isUnshadowedLibBinding`),
 *     so `String(1)` would classify as a string whatever the function returns;
 *   - module-init code declares the name for no other binding (a top-level
 *     `catch` parameter, a block's `let`): such a scope reads its own
 *     binding, which the proof does not cover.
 * A read of a qualifying binding is a string value when it is a module-init
 * use after the declaration (`scriptVarUseFollowsDeclaration`, so the slot
 * has been written) and
 *   - the checker types the read itself a string, or it is `typeof`'s operand:
 *     from-ast's operand proofs (the `+` rule) key on the checker type, which
 *     narrowing makes `never` in a branch `typeof x !== "string"` guards, while
 *     `typeof` folds from the IR type (`lowerTypeOf`);
 *   - it is not `delete`'s operand, and not a loose `==` / `!=` operand beside
 *     a value not proven a string (from-ast lowers that equality for two
 *     strings only).
 * Such a read is judged by the ordinary expression arms, exactly like a local
 * string; any other read keeps the opaque-reference discipline
 * (`isIrModuleReferenceValueKind`).
 */
import { ts } from "../ts-api.js";
import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import { isStoreTarget, outermostParenthesized } from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration, scriptVarWrites } from "./module-binding-script-var.js";
import type { IrLegacyModuleBindingIdentity } from "./module-bindings.js";
import type { ClassifyPrimitive } from "./regexp-match-uses.js";

type ResolveBinding = (node: ts.Identifier) => IrLegacyModuleBindingIdentity | undefined;
type IsLibOnlyBinding = (node: ts.Identifier) => boolean;

const qualifiesCache = new WeakMap<ts.VariableDeclaration, boolean>();

/** Whether any identifier under `node` satisfies `test`. */
function someIdentifier(node: ts.Node, test: (id: ts.Identifier) => boolean): boolean {
  if (ts.isIdentifier(node)) return test(node);
  return ts.forEachChild(node, (child) => someIdentifier(child, test) || undefined) === true;
}

/** A write to `target` stores its whole value: an initializer (of any `var` of the name), or a plain `=`. */
function isPlainStore(target: ts.Identifier): boolean {
  const store = outermostParenthesized(target).parent;
  if (ts.isVariableDeclaration(store)) return store.name === target;
  return ts.isBinaryExpression(store) && store.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/**
 * Whether module-init code declares the binding's name again for another binding (a top-level `catch`
 * parameter, a block's `let`): a read in that scope is not the binding's. A function's own parameters and
 * locals are another unit's.
 */
function nameIsReboundInModuleInit(checker: ts.TypeChecker, declaration: ts.VariableDeclaration): boolean {
  const name = declaration.name as ts.Identifier;
  const symbol = checker.getSymbolAtLocation(name);
  return someIdentifier(declaration.getSourceFile(), (id) => {
    const parent = id.parent;
    if (id.text !== name.text || !(ts.isVariableDeclaration(parent) || ts.isBindingElement(parent))) return false;
    if (parent.name !== id || ts.findAncestor(parent, ts.isFunctionLike) !== undefined) return false;
    return checker.getSymbolAtLocation(id) !== symbol;
  });
}

/** Whether the binding qualifies (see the module comment). */
function bindingQualifies(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
  resolve: ResolveBinding,
  classify: ClassifyPrimitive,
  isLibOnlyBinding: IsLibOnlyBinding,
): boolean {
  let cached = qualifiesCache.get(declaration);
  if (cached === undefined) {
    const writes = scriptVarWrites(checker, declaration);
    const shadowedBuiltin = (id: ts.Identifier) =>
      isLibOnlyBinding(id) && !isUnshadowedLibBinding(id, isLibOnlyBinding);
    cached =
      declaration.initializer !== undefined &&
      writes !== undefined &&
      writes.every(
        (write) =>
          write.kind === "value" &&
          isPlainStore(write.target) &&
          classify(write.expr) === "string" &&
          !someIdentifier(write.expr, (id) => resolve(id)?.valueKind.kind === "dynamic" || shadowedBuiltin(id)),
      ) &&
      !nameIsReboundInModuleInit(checker, declaration);
    qualifiesCache.set(declaration, cached);
  }
  return cached;
}

/** `node` is an operand of a loose `==` / `!=` whose other operand is not proven a string. */
function isLooseOperandBesideNonString(node: ts.Identifier, classify: ClassifyPrimitive): boolean {
  const operand = outermostParenthesized(node);
  const equality = operand.parent;
  if (!ts.isBinaryExpression(equality)) return false;
  const op = equality.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  return classify(equality.left === operand ? equality.right : equality.left) !== "string";
}

/** True when `node` reads a `string` binding and the read is an ordinary string value. */
export function stringBindingReadIsValue(
  checker: ts.TypeChecker,
  node: ts.Identifier,
  resolve: ResolveBinding,
  classify: ClassifyPrimitive,
  isLibOnlyBinding: IsLibOnlyBinding,
): boolean {
  const identity = resolve(node);
  if (identity?.valueKind.kind !== "string") return false;
  const declaration = identity.declaration;
  if (!ts.isVariableDeclaration(declaration) || node === declaration.name || isStoreTarget(node)) return false;
  const operator = outermostParenthesized(node).parent;
  if (ts.isDeleteExpression(operator) || isLooseOperandBesideNonString(node, classify)) return false;
  return (
    scriptVarUseFollowsDeclaration(node, declaration) &&
    (ts.isTypeOfExpression(operator) || classify(node) === "string") &&
    bindingQualifies(checker, declaration, resolve, classify, isLibOnlyBinding)
  );
}
