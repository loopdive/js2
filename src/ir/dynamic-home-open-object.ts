// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7335 (lever D, slice 1) — a script's top-level `var o = {}` as the IR's
 * `dynamic` script-var home. Where legacy keeps such a binding as the open
 * `$Object` in its externref slot (the selector's `isOpenObjectBinding`, #7128
 * S1), the module-binding resolver already reads that slot as `dynamic`
 * (`scriptVarHome`, #7132), so an IR unit and a legacy unit share one store
 * whoever runs the initializer. The selector hooks in `select.ts`:
 *
 *   - admit the initializer, which lowers to the open carrier's
 *     `__new_plain_object`;
 *   - admit a U1 define statement on the binding from any unit;
 *   - admit `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)` through the
 *     `dyn.own_property` provider;
 *   - refuse the uses the dynamic operations do not serve
 *     ({@link useIsRefused}).
 */

import { ts } from "../ts-api.js";
import type { IrLegacyModuleBindingIdentity } from "./module-bindings.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

/** What the selector knows about the subject being scanned. */
export interface Scope {
  readonly resolve: ((id: ts.Identifier) => IrLegacyModuleBindingIdentity | undefined) | null;
  /** Legacy's answer (#7128 S1); present only on the raw standalone lane. */
  readonly isOpenObjectBinding: ((decl: ts.VariableDeclaration) => boolean) | undefined;
  readonly enclosingOwner: (node: ts.Node) => ts.Node | undefined;
}

/**
 * A script's top-level `var <id> = {}` whose binding only ever holds that
 * literal's object: an unannotated identifier, declared once, never the target
 * of a write or a second declaration. Every same-text identifier in the file
 * is checked, nested functions included, so a shadowing parameter or local of
 * that name also refuses. That over-approximates, which can only decline.
 */
function isSoleEmptyLiteralVar(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (decl.type !== undefined || !ts.isIdentifier(decl.name) || decl.initializer === undefined) return false;
  if (!ts.isObjectLiteralExpression(decl.initializer) || decl.initializer.properties.length > 0) return false;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return false;
  const file = decl.getSourceFile();
  if (!ts.isVariableStatement(list.parent) || list.parent.parent !== file || ts.isExternalModule(file)) return false;
  const name = decl.name;
  let sole = true;
  const visit = (node: ts.Node): void => {
    if (!sole) return;
    if (ts.isIdentifier(node)) {
      if (node !== name && node.text === name.text && !isPropertyNameSlot(node) && !isPlainRead(node)) sole = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sole;
}

/** `decl` is a dynamic-home open object that legacy keeps open in the slot the resolver reads as `dynamic`. */
export function isDeclaration(decl: ts.VariableDeclaration, scope: Scope): boolean {
  return (
    isSoleEmptyLiteralVar(decl) &&
    scope.isOpenObjectBinding?.(decl) === true &&
    scope.resolve?.(decl.name as ts.Identifier)?.valueKind.kind === "dynamic"
  );
}

/** `id` reads a dynamic-home open object ({@link isDeclaration}). */
export function isReference(id: ts.Identifier, scope: Scope): boolean {
  const declaration = scope.resolve?.(id)?.declaration;
  return declaration !== undefined && ts.isVariableDeclaration(declaration) && isDeclaration(declaration, scope);
}

/**
 * A use of a dynamic-home open object that the dynamic operations do not
 * serve:
 *   - `o.<key>` where `Object.prototype` owns `<key>`: the reader does not
 *     reach the inherited member (the #7128 U2 key screen);
 *   - a loose `==` / `!=`: a `null` operand has no lowering there;
 *   - a member write in a nested function's code: `dyn.member_set` takes
 *     PutValue's failure rule from a code strictness the lowering is told only
 *     for `<module-init>` and top-level functions.
 */
export function useIsRefused(id: ts.Identifier, scope: Scope): boolean {
  const parent = id.parent;
  const member =
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === id;
  const inheritedRead = member && ts.isPropertyAccessExpression(parent) && OBJECT_PROTOTYPE_KEYS.has(parent.name.text);
  const looseEquality =
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken);
  const owner = scope.enclosingOwner(id);
  const nestedWrite =
    member &&
    isWriteTarget(parent as ts.Expression) &&
    owner !== undefined &&
    !(ts.isFunctionDeclaration(owner) && ts.isSourceFile(owner.parent));
  return (inheritedRead || looseEquality || nestedWrite) && isReference(id, scope);
}

/** The `Object.prototype` own-property tests a dynamic-home open object answers through `dyn.own_property`. */
export type OwnPropertyMethod = "hasOwnProperty" | "propertyIsEnumerable";

/**
 * `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)` with one plain argument
 * on a dynamic-home open object, in a file that cannot have replaced the
 * inherited method: no `.<method>` write or delete and no `"<method>"` string
 * (a define key) anywhere in the source.
 */
export function ownPropertyMethod(call: ts.CallExpression, scope: Scope): OwnPropertyMethod | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  const method = callee.name.text;
  if (method !== "hasOwnProperty" && method !== "propertyIsEnumerable") return undefined;
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0]!)) return undefined;
  if (methodMayBeReplaced(call.getSourceFile(), method)) return undefined;
  return isReference(callee.expression, scope) ? method : undefined;
}

const replaceableNamesByFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Whether `file` writes, deletes or names (as a string) `method` anywhere. */
function methodMayBeReplaced(file: ts.SourceFile, method: OwnPropertyMethod): boolean {
  let names = replaceableNamesByFile.get(file);
  if (names === undefined) {
    const found = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) found.add(node.text);
      else if (ts.isPropertyAccessExpression(node) && isWriteTarget(node)) found.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    names = found;
    replaceableNamesByFile.set(file, names);
  }
  return names.has(method);
}

/** A property name (`a.<id>`, `{ <id>: v }`): not a reference to the binding. */
function isPropertyNameSlot(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
  );
}

/** A reference that neither declares nor writes the binding. */
function isPlainRead(node: ts.Identifier): boolean {
  return (node.parent as { readonly name?: ts.Node }).name !== node && !isWriteTarget(node);
}

/** An assignment target, an update or `delete` operand, or a `for-in` / `for-of` head. */
function isWriteTarget(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const op = parent.operatorToken.kind;
    return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isDeleteExpression(parent)) return true;
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node;
}
