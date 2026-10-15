// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7000) Devirtualisation soundness for instance-member dispatch.
 *
 * The IR lowers `recv.m(...)` / `recv.g` / `recv.s = v` on a class-typed
 * receiver to a STATIC call of the member resolved on the receiver's declared
 * class (`class.call` → `call $<Class>_<m>`). That is only correct when no
 * class below the declared one can supply a different `m` at runtime: a
 * `function callV(a: A) { return a.v(); }` handed a `B extends A` that
 * overrides `v` must run `B.v`. Legacy dispatches such sites on `__tag`
 * (#1299); the IR has no virtual-dispatch intent yet, so the selector refuses
 * the call shape and the unit keeps its legacy body.
 *
 * The scan is syntactic and conservative: every class-like node in the source
 * file (declarations, class expressions, nested classes) that `extends` the
 * receiver class transitively — by the parent's binding name — and declares an
 * own instance member of the same name (method, accessor, field, parameter
 * property, or a computed name that may produce it) counts as an override. A
 * class whose `extends` clause is not a plain identifier (`extends mix(A)`)
 * has an unknown parent, so any member it declares counts for every class.
 *
 * A receiver whose runtime class is KNOWN — `new C()` itself, or a `const`
 * bound to one — is exempt: its static binding is the member that runs.
 */
import { forEachChild, ts } from "../ts-api.js";

type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

interface SubclassIndex {
  readonly byParent: ReadonlyMap<string, readonly ClassLike[]>;
  readonly unknownParent: readonly ClassLike[];
}

const indexCache = new WeakMap<ts.SourceFile, SubclassIndex>();

/**
 * Every name another class may `extends` this one by: its own name AND, for a
 * class expression, the variable it is bound to. `const Alias = class Named
 * extends A {}` is reachable as `Alias` from outside and as `Named` inside its
 * own body, so a walk that kept only one of them would miss a subclass
 * declared through the other.
 */
export function classBindingNames(node: ClassLike): readonly string[] {
  const names: string[] = [];
  if (node.name) names.push(node.name.text);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && !names.includes(parent.name.text))
    names.push(parent.name.text);
  return names;
}

function subclassIndex(sourceFile: ts.SourceFile): SubclassIndex {
  const cached = indexCache.get(sourceFile);
  if (cached) return cached;
  const byParent = new Map<string, ClassLike[]>();
  const unknownParent: ClassLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const extendsClause = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
      const parent = extendsClause?.types[0]?.expression;
      if (parent && ts.isIdentifier(parent)) {
        const children = byParent.get(parent.text) ?? [];
        children.push(node);
        byParent.set(parent.text, children);
      } else if (parent) {
        unknownParent.push(node);
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const index = { byParent, unknownParent };
  indexCache.set(sourceFile, index);
  return index;
}

function isStaticMember(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

function declaresInstanceMember(cls: ClassLike, memberName: string): boolean {
  for (const member of cls.members) {
    if (ts.isConstructorDeclaration(member)) {
      const ownField = member.parameters.some(
        (param) =>
          ts.isParameterPropertyDeclaration(param, member) &&
          ts.isIdentifier(param.name) &&
          param.name.text === memberName,
      );
      if (ownField) return true;
      continue;
    }
    if (isStaticMember(member) || !member.name || ts.isPrivateIdentifier(member.name)) continue;
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)) {
      if (member.name.text === memberName) return true;
      continue;
    }
    // A computed name may evaluate to `memberName`.
    return true;
  }
  return false;
}

/**
 * Can a read or call of instance member `memberName` on a value whose STATIC
 * class is known by `classNames` reach a member declared by a class BELOW it?
 * `true` means a static (devirtualised) binding to that class's member is
 * unsound.
 */
function instanceMemberMayBeOverriddenBelow(
  sourceFile: ts.SourceFile,
  classNames: readonly string[],
  memberName: string,
): boolean {
  const index = subclassIndex(sourceFile);
  if (index.unknownParent.some((cls) => declaresInstanceMember(cls, memberName))) return true;
  const seen = new Set<string>();
  const pending = [...classNames];
  while (pending.length > 0) {
    const parentName = pending.pop()!;
    if (seen.has(parentName)) continue;
    seen.add(parentName);
    for (const subclass of index.byParent.get(parentName) ?? []) {
      if (declaresInstanceMember(subclass, memberName)) return true;
      pending.push(...classBindingNames(subclass));
    }
  }
  return false;
}

/** Strip parentheses and type-only wrappers; none of them change the runtime value. */
function skipTypeWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The class a receiver is EXACTLY an instance of: `new C()`, or a `const` initialised with one. */
function exactInstanceClassName(
  receiver: ts.Expression,
  resolveVariable: (node: ts.Identifier) => ts.VariableDeclaration | undefined,
): string | undefined {
  const candidate = skipTypeWrappers(receiver);
  if (ts.isNewExpression(candidate))
    return ts.isIdentifier(candidate.expression) ? candidate.expression.text : undefined;
  if (!ts.isIdentifier(candidate)) return undefined;
  const declaration = resolveVariable(candidate);
  if (!declaration?.initializer || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return undefined;
  const initializer = skipTypeWrappers(declaration.initializer);
  return ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)
    ? initializer.expression.text
    : undefined;
}

/**
 * Is it unsound to bind `receiver.memberName` STATICALLY to the member of the
 * receiver's static class, known by every name in `classNames`?
 * `resolveVariable` maps an identifier to its local variable declaration
 * (checker-backed by the caller).
 */
export function staticMemberBindingIsUnsound(
  receiver: ts.Expression,
  classNames: readonly string[],
  memberName: string,
  resolveVariable: (node: ts.Identifier) => ts.VariableDeclaration | undefined,
): boolean {
  const exact = exactInstanceClassName(receiver, resolveVariable);
  if (exact !== undefined && classNames.includes(exact)) return false;
  return instanceMemberMayBeOverriddenBelow(receiver.getSourceFile(), classNames, memberName);
}
