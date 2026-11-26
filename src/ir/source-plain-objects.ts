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
 * `String` as a callee or the intercepted `Object.prototype.toString.call(v)` reaches none. (#7354 G1, W2) Which realm
 * constructors the program names is a fact of the whole program, every group's legalization reads the same one
 * (`readsConstructor`).
 */
import { ts } from "../ts-api.js";
import type { ProgramObjects } from "./program/dynamic-value-kinds.js";
import { nativeObjectStaticCall } from "./realm-static-call.js";
import { realmConstructorId } from "./program/builtin-prototype-keys.js";

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
  let namesSymbol = false;
  const constructors = new Set<string>();
  const visit = (node: ts.Node): void => {
    const id = ts.isIdentifier(node) ? realmConstructorId(node.text) : undefined;
    if (id !== undefined && readsConstructor(node as ts.Identifier, isPristineGlobal)) constructors.add(id);
    present ||=
      ts.isObjectLiteralExpression(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isCallExpression(node) && nativeObjectStaticCall(node, () => true) !== undefined);
    functions ||= ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isAccessor(node);
    namesSymbol ||= ts.isIdentifier(node) && node.text === "Symbol" && !isMemberName(node);
    ts.forEachChild(node, visit);
  };
  sourceFiles.forEach(visit);
  return { present: present || constructors.size > 0, functions, namesSymbol, constructors };
}

/**
 * (#7354 G1, W2) Whether `identifier` names the unchanged global realm constructor of its name where the front end may
 * read it as a value (`identifier-read.ts` `realmIntrinsicRead`, the same pristine test): a member name, a label or a
 * binding of the same spelling is none, and neither is `Object` as the receiver of a native static's call, which
 * `realm-static-call.ts` lowers by the same predicate without reading it. Any other mention counts, also one a front-end
 * arm happens to intercept (`String(v)`): holding a family no code reads costs bytes, never an answer, while a family
 * a function reads but this walk missed would answer wrong in every other function.
 */
function readsConstructor(
  identifier: ts.Identifier,
  isPristineGlobal: (identifier: ts.Identifier) => boolean,
): boolean {
  const parent = identifier.parent;
  if (isMemberName(identifier) || !isPristineGlobal(identifier)) return false;
  return !(
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === identifier &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent &&
    nativeObjectStaticCall(parent.parent, isPristineGlobal) !== undefined
  );
}
