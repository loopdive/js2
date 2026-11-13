// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7343) The ONE answer to "can this mention of `Function` run code?", for
 * both places that ask it: dead-binding elision (`deadcode-elide.ts`), where
 * an unknown dynamic-code position revives the dropped `$262.evalScript` shim
 * and so puts the module in runtime-eval carrier mode, and the runtime-eval
 * boundary plan (`ir/runtime-eval-boundary-plan.ts`), where it is an
 * `intrinsic-value` site.
 *
 * A mention is inert when its value cannot reach code evaluation:
 *   - `Function.prototype.<key>`, `Function.prototype["<key>"]` or a
 *     destructure of `Function.prototype`, with no `constructor` key: the value
 *     is an ordinary prototype method (`Function.prototype.call.bind(…)`, the
 *     receiver-uncurry idiom test262's propertyHelper.js opens with);
 *   - `Function` or `Function.prototype` whose value is only inspected, with
 *     `Function` and `Object` the ambient globals (nothing in the file
 *     declares either name): the right operand of `instanceof`, the operand of
 *     `typeof`, the first argument of `Object.isSealed` / `isFrozen` /
 *     `isExtensible`, of `Object.getPrototypeOf` (for `Function.prototype`,
 *     whose answer is `%Object.prototype%`), of
 *     `Object.getOwnPropertyDescriptor`, or of a discarded
 *     `Object.defineProperty` statement, the last two with a literal key other
 *     than `"constructor"`.
 * Every other position is a site: a call or `new`, a stored or passed value,
 * a `constructor` key, and an equality operand. An equality compares
 * identities, and only the provider-linked module keeps ONE `%Function%`
 * (#4442): without the provider, `(function () {}).constructor === Function`
 * answers false.
 */

import { ts } from "../ts-api.js";
import { isUndeclaredInFile } from "./ambient-intrinsics.js";
import { outermostTransparent, skipTransparentExpressions } from "./transparent-expressions.js";

/** The statics that read only the shape of their first argument. */
const SHAPE_QUERIES = new Set(["isSealed", "isFrozen", "isExtensible"]);

export function isInertFunctionMention(identifier: ts.Identifier): boolean {
  if (identifier.text !== "Function") return false;
  const prototype = prototypeRead(identifier);
  if (prototype !== undefined && readsPrototypeMethod(prototype)) return true;
  return (
    isUndeclaredInFile(identifier) &&
    isInertPosition(prototype ?? outermostTransparent(identifier), prototype !== undefined)
  );
}

/** `Function.prototype`, with every transparent wrapper around it, when `identifier` is its receiver. */
export function prototypeRead(identifier: ts.Identifier): ts.Expression | undefined {
  const read = outermostTransparent(identifier).parent;
  return read !== undefined &&
    ts.isPropertyAccessExpression(read) &&
    skipTransparentExpressions(read.expression) === identifier &&
    read.name.text === "prototype"
    ? outermostTransparent(read)
    : undefined;
}

function readsPrototypeMethod(prototype: ts.Expression): boolean {
  const member = prototype.parent;
  if (ts.isPropertyAccessExpression(member) && member.expression === prototype) {
    return member.name.text !== "constructor";
  }
  if (ts.isElementAccessExpression(member) && member.expression === prototype) {
    return isLiteralKeyOtherThanConstructor(member.argumentExpression);
  }
  if (ts.isVariableDeclaration(member) && member.initializer === prototype && ts.isObjectBindingPattern(member.name)) {
    return member.name.elements.every((element) => {
      const key = element.propertyName ?? element.name;
      return !(ts.isIdentifier(key) && key.text === "constructor");
    });
  }
  return false;
}

/** `value` (`Function`, or `Function.prototype` when `isPrototype`) is only inspected. */
function isInertPosition(value: ts.Expression, isPrototype: boolean): boolean {
  const use = value.parent;
  if (ts.isTypeOfExpression(use)) return true;
  if (ts.isBinaryExpression(use)) {
    return use.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && use.right === value;
  }
  if (!ts.isCallExpression(use) || use.arguments[0] !== value) return false;
  const query = objectStaticName(use);
  if (query === undefined) return false;
  if (SHAPE_QUERIES.has(query)) return true;
  if (query === "getPrototypeOf") return isPrototype;
  const key = use.arguments[1];
  if (key === undefined || !isLiteralKeyOtherThanConstructor(key)) return false;
  if (query === "getOwnPropertyDescriptor") return true;
  return query === "defineProperty" && ts.isExpressionStatement(outermostTransparent(use).parent);
}

/** `<name>` of a call `Object.<name>(…)` on the ambient `Object`. */
function objectStaticName(call: ts.CallExpression): string | undefined {
  const callee = skipTransparentExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = skipTransparentExpressions(callee.expression);
  return ts.isIdentifier(receiver) && receiver.text === "Object" && isUndeclaredInFile(receiver)
    ? callee.name.text
    : undefined;
}

function isLiteralKeyOtherThanConstructor(key: ts.Expression): boolean {
  const literal = skipTransparentExpressions(key);
  return ts.isStringLiteralLike(literal) && literal.text !== "constructor";
}
