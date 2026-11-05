// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7227) `this.#m(...)` inside a `static` method of a named class.
 *
 * A private name is not inherited and resolves only against the class whose
 * body declares it, so inside `static access() { return this.#m(); }` the one
 * method the call can reach is `C.#m` — any other receiver is a brand-check
 * TypeError. The direct backend lowers the call as that static call too (it
 * performs no brand check on `this`: `D.access()` / `C.access.call({})` return
 * `C.#m()`'s value on every lane, measured 2026-11-04), so the IR mirrors that
 * exact lowering: a `class.static_call` to `C___priv_m`.
 *
 * The selector (`select.ts`, private-call arm) and the lowerer (`from-ast.ts`,
 * static-call arm) both consult this one predicate, so a claim never meets a
 * lowering that reads the receiver differently. The selector passes the class
 * it is claiming as `expectedClassName`; a different owner answers undefined.
 *
 * Deliberately narrow: the nearest function-like ancestor must BE the static
 * method (an arrow or nested function in between rebinds or captures `this`),
 * and its owner must be a `ClassDeclaration` with a name (the identity the
 * static-call arm keys on). Public `this.m()` stays out: a subclass receiver
 * dispatches to its own override, which a static call would not.
 */
import { ts } from "../ts-api.js";

export function staticPrivateThisCallClassName(
  expr: ts.CallExpression,
  expectedClassName?: string | null,
): string | undefined {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isPrivateIdentifier(callee.name)) return undefined;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  let cursor: ts.Node | undefined = expr.parent;
  while (cursor && !ts.isFunctionLike(cursor) && !ts.isClassStaticBlockDeclaration(cursor)) cursor = cursor.parent;
  if (!cursor || !ts.isMethodDeclaration(cursor) || cursor.asteriskToken) return undefined;
  const isStatic = ts.getModifiers(cursor)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false;
  if (!isStatic) return undefined;
  const owner = cursor.parent;
  if (!ts.isClassDeclaration(owner) || !owner.name) return undefined;
  // The private method must be the owner's OWN static method — an enclosing
  // class's `#m` (or an inherited lookup) is a TypeError on this receiver.
  const name = callee.name.text;
  const ownsStaticMethod = owner.members.some(
    (member) =>
      ts.isMethodDeclaration(member) &&
      ts.isPrivateIdentifier(member.name) &&
      member.name.text === name &&
      (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false),
  );
  if (!ownsStaticMethod || classNameIsAmbiguous(owner, owner.name.text)) return undefined;
  return expectedClassName === undefined || expectedClassName === owner.name.text ? owner.name.text : undefined;
}

/**
 * (#7227) Does the private name read by `<recv>.#x` resolve to a METHOD or an
 * ACCESSOR rather than a field? The lowerer reads a private name only as the
 * `class.get` of a `__priv_x` struct slot; a private method/accessor has no
 * slot ("class C has no field __priv_x"), so the selector refuses the read
 * instead of claiming a body the lowerer must demote. The declaring class is
 * the nearest enclosing class that declares `#x` — private names resolve
 * lexically and are never inherited.
 */
export function privateNameReadsNonField(name: ts.PrivateIdentifier): boolean {
  for (let cursor: ts.Node | undefined = name.parent; cursor; cursor = cursor.parent) {
    if (!ts.isClassLike(cursor)) continue;
    const declaration = cursor.members.find(
      (member) => member.name !== undefined && ts.isPrivateIdentifier(member.name) && member.name.text === name.text,
    );
    if (declaration) return !ts.isPropertyDeclaration(declaration);
  }
  return false;
}

/**
 * (#7227) Is `name` declared by more than one class in `node`'s source file?
 * The static-call arm keys class shapes by NAME, so two same-named classes in
 * sibling scopes (`function f() { class C … }`, `function g() { class C … }`)
 * would resolve a private static call to whichever shape owns the name. The
 * private-static admissions refuse such a name rather than guess.
 */
export function classNameIsAmbiguous(node: ts.Node, name: string): boolean {
  let count = 0;
  const visit = (current: ts.Node): void => {
    if (count > 1) return;
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name?.text === name) count++;
    ts.forEachChild(current, visit);
  };
  visit(node.getSourceFile());
  return count > 1;
}

/**
 * (#7233) `this.#x` / `C.#x` naming a STATIC private FIELD of the named class
 * declaration `C`, read or written from inside one of `C`'s own synchronous
 * static methods. Legacy stores such a field in one module global
 * (`__static_C___priv_x`) and lowers both spellings to `global.get` /
 * `global.set` of it with no brand check on `this` (`D.m()` and `C.m.call({})`
 * reach the same global), so the IR may read and write that global too.
 *
 * Deliberately narrow, as {@link staticPrivateThisCallClassName}: the nearest
 * function-like ancestor must BE the static method, the owner a uniquely named
 * `ClassDeclaration`, and the field a plain `static #x` (no `accessor`, no
 * initializer that reads `this`). A bare `C` receiver must still be checked
 * for shadowing by the caller.
 */
export function staticPrivateFieldOwner(expr: ts.PropertyAccessExpression): ts.ClassDeclaration | undefined {
  if (!ts.isPrivateIdentifier(expr.name)) return undefined;
  let cursor: ts.Node | undefined = expr.parent;
  while (cursor && !ts.isFunctionLike(cursor) && !ts.isClassStaticBlockDeclaration(cursor)) cursor = cursor.parent;
  if (
    !cursor ||
    !ts.isMethodDeclaration(cursor) ||
    cursor.asteriskToken ||
    !hasModifier(cursor, ts.SyntaxKind.StaticKeyword)
  )
    return undefined;
  if (hasModifier(cursor, ts.SyntaxKind.AsyncKeyword)) return undefined;
  const owner = cursor.parent;
  if (!ts.isClassDeclaration(owner) || !owner.name) return undefined;
  const name = expr.name.text;
  const field = owner.members.find(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && member.name.text === name,
  );
  if (!field || !hasModifier(field, ts.SyntaxKind.StaticKeyword) || hasModifier(field, ts.SyntaxKind.AccessorKeyword))
    return undefined;
  if (field.initializer && readsThis(field.initializer)) return undefined;
  const receiver = expr.expression;
  const receiverIsOwner =
    receiver.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(receiver) && receiver.text === owner.name.text);
  if (!receiverIsOwner || classNameIsAmbiguous(owner, owner.name.text)) return undefined;
  return owner;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)) ?? false;
}

function readsThis(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.forEachChild(node, readsThis) ?? false;
}
