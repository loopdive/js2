// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2) Whether a Prepared program's ordinary objects are plain. On this path an object literal is the only
 * producer of a plain ordinary object (`js.object.create-default` on the realm's Object.prototype), and (#7352) an
 * array literal the only producer of an Array, so the program decides what its objects can hold. They are plain when
 * no object can hold a callable, none defines its own `toString` or `valueOf`, and no code can reach a prototype to
 * change it. Then OrdinaryToPrimitive of any of them but an Array answers "[object Object]" for every hint, and a
 * member read meets only the specification's built-in prototype properties: the dynamic-value legalization asks
 * this one answer before it takes either shortcut.
 */
import { ts } from "../ts-api.js";
import { objectLiteralDataPropertyName } from "../shared/property-key-fold.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";

/** Own keys whose definition changes what OrdinaryToPrimitive or a prototype lookup answers. */
const CONVERSION_KEYS: ReadonlySet<string> = new Set(["toString", "valueOf", "__proto__"]);
/** Global names through which a program reaches a built-in prototype (or Symbol.toPrimitive). */
const PROTOTYPE_GLOBALS: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Number",
  "Boolean",
  "String",
  "Symbol",
  "Reflect",
  "globalThis",
]);

/** `node` names a member (`x.Object`, `{ Object: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

const callable = (checker: ts.TypeChecker, node: ts.Expression): boolean =>
  checker.getTypeAtLocation(node).getCallSignatures().length > 0;

/** The first reason a literal member makes its object unplain, if any. */
function literalMemberReason(checker: ts.TypeChecker, member: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member))
    return "an object literal defines a method, accessor or spread";
  const key = objectLiteralDataPropertyName(member.name);
  if (key === null) return "an object literal has a computed key";
  if (CONVERSION_KEYS.has(key)) return `an object literal defines '${key}'`;
  const value = ts.isPropertyAssignment(member) ? member.initializer : member.name;
  return callable(checker, value) ? "an object property holds a function" : undefined;
}

/**
 * The first reason a member write makes the objects unplain, if any. (#7352) A number literal key names no
 * conversion key: its ToString is a number's.
 */
function memberWriteReason(checker: ts.TypeChecker, write: ts.BinaryExpression): string | undefined {
  const target = write.left;
  const element = ts.isElementAccessExpression(target) ? target.argumentExpression : undefined;
  if (element !== undefined && !ts.isStringLiteralLike(element) && !isNumberLiteral(element))
    return "a member write has a computed key";
  const key = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : element !== undefined && ts.isStringLiteralLike(element)
      ? element.text
      : undefined;
  if (key !== undefined && CONVERSION_KEYS.has(key)) return `a member write defines '${key}'`;
  return callable(checker, write.right) ? "a member write stores a function" : undefined;
}

/** A number literal, or its negation (`-1`). */
function isNumberLiteral(node: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand))
  );
}

export function programObjects(checker: ts.TypeChecker, sourceFiles: readonly ts.SourceFile[]): ProgramObjects {
  let present = false;
  let arrays = false;
  let unplain: string | undefined;
  const reasonAt = (node: ts.Node): string | undefined => {
    if (ts.isObjectLiteralExpression(node)) {
      present = true;
      for (const member of node.properties) {
        const reason = literalMemberReason(checker, member);
        if (reason !== undefined) return reason;
      }
      return undefined;
    }
    if (ts.isArrayLiteralExpression(node)) {
      present = arrays = true;
      return node.elements.some((element) => !ts.isOmittedExpression(element) && callable(checker, element))
        ? "an object property holds a function"
        : undefined;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      return memberWriteReason(checker, node);
    if (ts.isPropertyAccessExpression(node) && ["prototype", "__proto__"].includes(node.name.text))
      return `the program reads '${node.name.text}'`;
    if (ts.isIdentifier(node) && PROTOTYPE_GLOBALS.has(node.text) && !isMemberName(node))
      return `the program names '${node.text}'`;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const reason = reasonAt(node);
    unplain ??= reason;
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present, arrays, unplain };
}
