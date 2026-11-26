// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2, O2b) What a Prepared program's source allows its ordinary objects (`ProgramObjects`), in one walk. On
 * this path an object literal, (F1b) a constructor's `prototype` and (O1) a native `Object` static (`Object.create`'s
 * object, `Object.getOwnPropertyDescriptor`'s record) are the only producers of an ordinary object, so
 * the source decides whether the object kind is admitted. OrdinaryToPrimitive is decided at run time (`ordinary-to-primitive.ts`) and needs to know only
 * whether `@@toPrimitive` is reachable, i.e. whether the program names `Symbol`.
 *
 * (#7354 M1, C1) No question about the built-in prototypes is asked here: no Prepared program can obtain one as a
 * value (tests/issue-7354-m-prototype-premise.test.ts pins every route), so code cannot change one, and naming
 * `String` as a callee or the intercepted `Object.prototype.toString.call(v)` reaches none.
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";
import { nativeObjectStaticCall } from "./realm-static-call.js";
import { errorConstructorId } from "./program/builtin-prototype-keys.js";

/** `node` names a member (`x.Symbol`, `{ Symbol: 1 }`), not a binding. */
const isMemberName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node);

/**
 * `readsDeclarationValue`: (#7354 F1b) a function declaration is read as a value (`function-declaration-values.ts`).
 * Such a function, like a function expression, is a constructor whose `prototype` is an ordinary object the source
 * spells nowhere, so either one admits the object kind too.
 */
export function programObjects(
  sourceFiles: readonly ts.SourceFile[],
  readsDeclarationValue: boolean,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): ProgramObjects {
  let present = readsDeclarationValue;
  let functions = readsDeclarationValue;
  let nonConstructors = false;
  let namesSymbol = false;
  let namesErrors = false;
  const visit = (node: ts.Node): void => {
    // (#7354 G1) A read of the unchanged global Error constructor (`identifier-read.ts` reads it the same way, through
    // `realmIntrinsicRead`): a member name, a label or a binding of the same spelling is no such read.
    namesErrors ||=
      ts.isIdentifier(node) &&
      errorConstructorId(node.text) !== undefined &&
      !isMemberName(node) &&
      isPristineGlobal(node);
    present ||=
      ts.isObjectLiteralExpression(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isCallExpression(node) && nativeObjectStaticCall(node, () => true) !== undefined);
    functions ||= ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isAccessor(node);
    nonConstructors ||= ts.isAccessor(node);
    namesSymbol ||= ts.isIdentifier(node) && node.text === "Symbol" && !isMemberName(node);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present: present || namesErrors, functions, nonConstructors, namesSymbol, namesErrors };
}
