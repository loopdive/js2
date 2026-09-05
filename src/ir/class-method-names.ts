// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

const ASCII_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_CLASS_METHOD_KEYS = new Set(["constructor", "new", "init"]);

function hasDeclareModifier(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const modifiers = (current as { modifiers?: readonly ts.Node[] }).modifiers;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return node.getSourceFile().isDeclarationFile;
}

function hasDecorators(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

function hasModifiers(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.length ?? 0) > 0;
}

function isPrimitiveTypeNode(type: ts.TypeNode | undefined, allowVoid: boolean): boolean {
  if (!type) return false;
  return (
    type.kind === ts.SyntaxKind.NumberKeyword ||
    type.kind === ts.SyntaxKind.StringKeyword ||
    type.kind === ts.SyntaxKind.BooleanKeyword ||
    (allowVoid && type.kind === ts.SyntaxKind.VoidKeyword)
  );
}

function isPlainMethod(method: ts.MethodDeclaration): boolean {
  return (
    method.body !== undefined &&
    method.typeParameters === undefined &&
    method.questionToken === undefined &&
    method.asteriskToken === undefined &&
    !hasModifiers(method) &&
    !hasDecorators(method) &&
    method.parameters.every(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.type !== undefined &&
        isPrimitiveTypeNode(parameter.type, false) &&
        parameter.questionToken === undefined &&
        parameter.dotDotDotToken === undefined &&
        parameter.initializer === undefined,
    ) &&
    isPrimitiveTypeNode(method.type, true)
  );
}

function methodKey(method: ts.MethodDeclaration): string | undefined {
  if (ts.isIdentifier(method.name)) return method.name.text;
  if (!ts.isComputedPropertyName(method.name) || !ts.isStringLiteral(method.name.expression)) return undefined;
  const key = method.name.expression.text;
  if (!ASCII_IDENTIFIER.test(key) || RESERVED_CLASS_METHOD_KEYS.has(key)) return undefined;
  return key;
}

function isPlainZeroArgumentConstructor(member: ts.ClassElement): boolean {
  return (
    ts.isConstructorDeclaration(member) &&
    member.body !== undefined &&
    member.parameters.length === 0 &&
    member.typeParameters === undefined &&
    !hasModifiers(member) &&
    !hasDecorators(member)
  );
}

function isAdmissibleClass(member: ts.MethodDeclaration): ts.ClassDeclaration | undefined {
  const owner = member.parent;
  if (!ts.isClassDeclaration(owner) || owner.parent !== owner.getSourceFile() || !owner.name) return undefined;
  if (owner.heritageClauses !== undefined && owner.heritageClauses.length > 0) return undefined;
  if (hasDeclareModifier(owner) || hasDecorators(owner)) return undefined;
  return owner;
}

/**
 * Resolve the exact key of a bounded computed instance method.
 *
 * `undefined` means that the declaration is outside this slice's proof. This
 * helper intentionally reads syntax only: it never evaluates a binding or a
 * computed expression and never infers a name from an unresolved sibling.
 */
export function literalComputedInstanceMethodKey(member: ts.MethodDeclaration): string | undefined {
  if (!ts.isComputedPropertyName(member.name) || !ts.isStringLiteral(member.name.expression)) return undefined;
  const owner = isAdmissibleClass(member);
  const candidateKey = methodKey(member);
  if (!owner || candidateKey === undefined || !isPlainMethod(member)) return undefined;

  const keys = new Set<string>();
  for (const sibling of owner.members) {
    if (ts.isSemicolonClassElement(sibling)) continue;
    if (ts.isConstructorDeclaration(sibling)) {
      if (!isPlainZeroArgumentConstructor(sibling)) return undefined;
      continue;
    }
    if (!ts.isMethodDeclaration(sibling) || !isPlainMethod(sibling)) return undefined;
    const siblingKey = methodKey(sibling);
    if (siblingKey === undefined || RESERVED_CLASS_METHOD_KEYS.has(siblingKey) || keys.has(siblingKey)) {
      return undefined;
    }
    keys.add(siblingKey);
  }
  return keys.has(candidateKey) ? candidateKey : undefined;
}
