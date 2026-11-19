// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2) Whether a Prepared program's ordinary objects are plain. On this path an object literal is the only
 * producer of a plain ordinary object (an array literal, #7352, makes the program unplain) (`js.object.create-default` on the realm's Object.prototype), so the program decides
 * what its objects can hold. They are plain when no object can hold a callable, none defines its own `toString` or
 * `valueOf`, and no code can reach a prototype to change it. Then OrdinaryToPrimitive of any of them answers
 * "[object Object]" for every hint, and a member read off a primitive meets only the specification's built-in
 * prototype properties: the dynamic-value legalization asks this one answer before it takes either shortcut.
 */
import { ts } from "../ts-api.js";
import { objectLiteralDataPropertyName } from "./property-key-fold.js";

export interface ProgramObjects {
  /** The program builds ordinary objects: the dynamic value admits the object kind. */
  readonly present: boolean;
  /** `undefined` when the objects and the built-in prototypes are plain, else the first reason they are not. */
  readonly unplain: string | undefined;
}

/** A program that builds no ordinary object. */
export const NO_OBJECTS: ProgramObjects = Object.freeze({ present: false, unplain: undefined });

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

/** The first reason a member write makes the objects unplain, if any. */
function memberWriteReason(checker: ts.TypeChecker, write: ts.BinaryExpression): string | undefined {
  const target = write.left;
  if (ts.isElementAccessExpression(target) && !ts.isStringLiteralLike(target.argumentExpression))
    return "a member write has a computed key";
  const key = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
      ? target.argumentExpression.text
      : undefined;
  if (key === undefined) return undefined;
  if (CONVERSION_KEYS.has(key)) return `a member write defines '${key}'`;
  return callable(checker, write.right) ? "a member write stores a function" : undefined;
}

export function programObjects(checker: ts.TypeChecker, sourceFiles: readonly ts.SourceFile[]): ProgramObjects {
  let present = false;
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
    // (#7352 arrays) An Array is an ordinary object whose OrdinaryToPrimitive calls `join`.
    if (ts.isArrayLiteralExpression(node)) {
      present = true;
      return "array ToPrimitive needs Array.prototype.join";
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
  return { present, unplain };
}
