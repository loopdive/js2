// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2, O2b) What a Prepared program's source allows its ordinary objects (`ProgramObjects`), in one walk. On
 * this path an object literal is the only producer of an ordinary object, so the source decides whether the object
 * kind is admitted. OrdinaryToPrimitive is decided at run time (`ordinary-to-primitive.ts`) and needs to know only
 * whether `@@toPrimitive` is reachable, i.e. whether the program names `Symbol`.
 *
 * (#7354 M1, C1) No question about the built-in prototypes is asked here: no Prepared program can obtain one as a
 * value (tests/issue-7354-m-prototype-premise.test.ts pins every route), so code cannot change one, and naming
 * `String` as a callee or the intercepted `Object.prototype.toString.call(v)` reaches none.
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";

/** `node` names a member (`x.Symbol`, `{ Symbol: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

export function programObjects(sourceFiles: readonly ts.SourceFile[]): ProgramObjects {
  let present = false;
  let functions = false;
  let namesSymbol = false;
  const visit = (node: ts.Node): void => {
    present ||= ts.isObjectLiteralExpression(node);
    functions ||= ts.isFunctionExpression(node) || ts.isArrowFunction(node);
    namesSymbol ||= ts.isIdentifier(node) && node.text === "Symbol" && !isMemberName(node);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present, functions, namesSymbol };
}
