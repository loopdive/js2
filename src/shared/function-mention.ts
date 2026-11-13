// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7343) The ONE answer to "can this mention of `Function` run code?", for
 * both places that ask it: dead-binding elision (`deadcode-elide.ts`), where
 * an unknown dynamic-code position revives the dropped `$262.evalScript` shim
 * and so puts the module in runtime-eval carrier mode, and the runtime-eval
 * boundary plan (`ir/runtime-eval-boundary-plan.ts`), where it is an
 * `intrinsic-value` site.
 *
 * A mention is inert when no value it yields is `%Function%` or
 * `%Function.prototype%` (whose own `constructor` is `%Function%`). An
 * ordinary function value is allowed: its inherited `constructor` reaches
 * `%Function%` exactly as every other function in the program does, through
 * the `<fn>.constructor` arm, not through this mention. The inert positions:
 *   - a member of `Function.prototype` other than `constructor`
 *     (`Function.prototype.call`, `["bind"]`, a destructure): an ordinary
 *     prototype method (`Function.prototype.call.bind(…)`, the receiver-uncurry
 *     idiom test262's propertyHelper.js opens with);
 *   - `Function` or `Function.prototype` only inspected: the right operand of
 *     `instanceof`, the operand of `typeof`, the argument of
 *     `Object.isSealed` / `isFrozen` / `isExtensible`;
 *   - `Object.getPrototypeOf(Function.prototype)`: `%Object.prototype%`;
 *   - a property descriptor read, `Object.getOwnPropertyDescriptor(R, "<k>")`,
 *     or a discarded `Object.defineProperty(R, "<k>", …)` statement, for the
 *     pairs whose descriptor holds neither intrinsic:
 *     - `R = Function`: any `<k>` but `"prototype"` (its value is
 *       `%Function.prototype%`) and `"constructor"`; `length` and `name` hold
 *       a number and a string, and every other key has no own descriptor;
 *     - `R = Function.prototype`: any `<k>` but `"constructor"`; the others
 *       hold ordinary functions (`call`, `apply`, `bind`, `toString`, the
 *       `caller` / `arguments` thrower), a number or a string.
 *     A source write cannot put either intrinsic under another key without a
 *     `Function` mention of its own that is a site (`Function.x = Function`).
 * Each position also needs the global `Function` and an unpatched global
 * `Object` (`objectStaticIsPristine`): a source that declares either name, or
 * writes `Object` or the static it calls (`Object = …`, `Object.isSealed = f`,
 * `globalThis.Object.isSealed = f`), may hand `%Function%` to its own code.
 * Every other position is a site: a call or `new`, a stored or passed value,
 * a `constructor` key, and an equality operand. An equality compares
 * identities, and only the provider-linked module keeps ONE `%Function%`
 * (#4442): without the provider, `(function () {}).constructor === Function`
 * answers false.
 */

import { ts } from "../ts-api.js";
import { isUndeclaredInFile } from "./ambient-intrinsics.js";
import { hasWithStatement } from "./binding-writes.js";
import { sourceWritesMemberNamed } from "./intrinsic-prototype-writes.js";
import { outermostTransparent, skipTransparentExpressions } from "./transparent-expressions.js";

/** The statics that read only the shape of their first argument. */
const SHAPE_QUERIES = new Set(["isSealed", "isFrozen", "isExtensible"]);

export function isInertFunctionMention(identifier: ts.Identifier): boolean {
  if (identifier.text !== "Function") return false;
  const prototype = prototypeRead(identifier);
  if (prototype !== undefined && readsPrototypeMethod(prototype)) return true;
  if (!isUndeclaredInFile(identifier)) return false;
  return prototype === undefined
    ? isInertFunctionUse(outermostTransparent(identifier))
    : isInertPrototypeUse(prototype);
}

/** `Function.prototype`, with every transparent wrapper around it, when `identifier` is its receiver. */
function prototypeRead(identifier: ts.Identifier): ts.Expression | undefined {
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
    return literalKey(member.argumentExpression, (key) => key !== "constructor");
  }
  if (ts.isVariableDeclaration(member) && member.initializer === prototype && ts.isObjectBindingPattern(member.name)) {
    return member.name.elements.every((element) => {
      const key = element.propertyName ?? element.name;
      return !(ts.isIdentifier(key) && key.text === "constructor");
    });
  }
  return false;
}

/** `Function` itself: inspected, or a descriptor of a key other than `prototype` / `constructor`. */
function isInertFunctionUse(value: ts.Expression): boolean {
  return isInspected(value) || describesKey(value, (key) => key !== "prototype" && key !== "constructor");
}

/** `Function.prototype`: inspected, its own prototype, or a descriptor of a key other than `constructor`. */
function isInertPrototypeUse(value: ts.Expression): boolean {
  return (
    isInspected(value) ||
    objectStaticCalledOn(value) === "getPrototypeOf" ||
    describesKey(value, (key) => key !== "constructor")
  );
}

/** `instanceof` right operand, `typeof` operand, or a shape query's argument. */
function isInspected(value: ts.Expression): boolean {
  const use = value.parent;
  if (ts.isTypeOfExpression(use)) return true;
  if (ts.isBinaryExpression(use)) {
    return use.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && use.right === value;
  }
  const query = objectStaticCalledOn(value);
  return query !== undefined && SHAPE_QUERIES.has(query);
}

/** `Object.getOwnPropertyDescriptor(value, "<k>")`, or a discarded `Object.defineProperty(value, "<k>", …)`, with `keyIsInert(k)`. */
function describesKey(value: ts.Expression, keyIsInert: (key: string) => boolean): boolean {
  const query = objectStaticCalledOn(value);
  if (query === undefined) return false;
  const call = value.parent as ts.CallExpression;
  const key = call.arguments[1];
  if (key === undefined || !literalKey(key, keyIsInert)) return false;
  if (query === "getOwnPropertyDescriptor") return true;
  return query === "defineProperty" && ts.isExpressionStatement(outermostTransparent(call).parent);
}

/** `<name>` when `value` is the first argument of `Object.<name>(…)` on the ambient, unpatched `Object`. */
function objectStaticCalledOn(value: ts.Expression): string | undefined {
  const call = value.parent;
  if (call === undefined || !ts.isCallExpression(call) || call.arguments[0] !== value) return undefined;
  const callee = skipTransparentExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = skipTransparentExpressions(callee.expression);
  return ts.isIdentifier(receiver) && receiver.text === "Object" && objectStaticIsPristine(receiver, callee.name.text)
    ? callee.name.text
    : undefined;
}

/**
 * `Object.<name>` is the realm's: nothing declares `Object`, nothing writes
 * `Object` or a member named `<name>` by any literal route (`Object = {…}`,
 * `Object.isSealed = f`, `globalThis.Object.isSealed = f`, an alias's
 * `O["isSealed"] = f`, `Object.defineProperty(Object, "isSealed", …)`,
 * `delete`), and no `with` resolves the name to an object's property. A
 * direct `eval` could patch either too, but it is a site of its own in both
 * readers, so the module keeps the provider and the shim either way. A write under a
 * computed name is outside this boundary, as for the object statics
 * (`objectStaticsArePristine`, #3776): test262's own `$262` prelude stores
 * `globalThis` and `globalThis.Object`, so a global-object or alias screen
 * would refuse every test. Syntactic: elision runs before a checker exists.
 */
function objectStaticIsPristine(object: ts.Identifier, name: string): boolean {
  const file = object.getSourceFile();
  return (
    isUndeclaredInFile(object) &&
    !sourceWritesMemberNamed(file, "Object") &&
    !sourceWritesMemberNamed(file, name) &&
    !hasWithStatement(file)
  );
}

function literalKey(key: ts.Expression, accept: (key: string) => boolean): boolean {
  const literal = skipTransparentExpressions(key);
  return ts.isStringLiteralLike(literal) && accept(literal.text);
}
