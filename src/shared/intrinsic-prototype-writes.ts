// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * What a program does to `Array.prototype`, `Object.prototype` and
 * `String.prototype`, from one pure-AST walk over every mention of them. Two
 * consumers ask two questions:
 *
 *   - {@link sourceWritesPrototype}: the legacy array-iteration brand (#1719,
 *     `sourceOverridesArrayIterator`) asks whether the program writes a member
 *     with `=`, deletes one, or passes the prototype to
 *     `Object.defineProperty`/`defineProperties`. Its byte-identity contract
 *     pins exactly that set.
 *   - {@link sourceMayPatchPrototype}: the IR's destructuring readers and its
 *     `String.prototype.<m>.call` borrow (#7106) assume the realm's own
 *     prototypes, so they ask the conservative question. A prototype
 *     (`Array.prototype`, `globalThis.Object.prototype`,
 *     …) may be patched unless every mention of it is the object of a plain
 *     member read (`Array.prototype.map.call(…)`). A stored-into member
 *     (compound, logical and destructuring targets included), a deleted one, a
 *     call with the prototype as `this` (`Object.prototype.__defineGetter__`)
 *     and any escape (`Reflect.set(Array.prototype, …)`, `Object.assign`,
 *     `Object.setPrototypeOf`, an alias, an operand) all count. A patch that
 *     never names the prototype (`%ArrayIteratorPrototype%` reached through
 *     `Object.getPrototypeOf`) is not seen by it; a consumer that must also
 *     exclude those routes asks {@link sourceNamesReflectiveRoute}, and
 *     {@link sourceWritesMemberNamed} for a member it reads by name.
 */
import { forEachChild, ts } from "../ts-api.js";
import { isStoreTarget, skipOuterExpressions } from "./binding-writes.js";

export type PatchableIntrinsic = "Array" | "Function" | "Object" | "String";

interface PrototypeUse {
  readonly writes: Set<PatchableIntrinsic>;
  readonly mayPatch: Set<PatchableIntrinsic>;
  /** Names the source stores into, deletes or defines on anything: `x.call = f`, `String = v`. */
  readonly writtenNames: Set<string>;
  /** The source names a {@link REFLECTIVE_NAMES} route or has a `with` statement. */
  reflective: boolean;
}

/**
 * Names that reach a prototype without spelling `X.prototype`:
 * `Object.getPrototypeOf(v)`, `v.__proto__`, `Reflect.set(…)`,
 * `v.constructor.prototype`. (#7106 lever O refuses the same names for
 * `Object`'s statics; the two lists merge into one helper.)
 */
const REFLECTIVE_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "getPrototypeOf",
  "setPrototypeOf",
  "__proto__",
  "Reflect",
]);

const cache = new WeakMap<ts.SourceFile, PrototypeUse>();

export function sourceWritesPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).writes.has(intrinsic);
}

export function sourceMayPatchPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).mayPatch.has(intrinsic);
}

/**
 * Whether the source names a route to a prototype that does not spell it: a
 * {@link REFLECTIVE_NAMES} name (an observed `constructor` aside) or `with`.
 */
export function sourceNamesReflectiveRoute(sourceFile: ts.SourceFile): boolean {
  return prototypeUse(sourceFile).reflective;
}

/** Whether the source writes, deletes or defines a member or binding named `name` (`x.call = f`, `String = v`). */
export function sourceWritesMemberNamed(sourceFile: ts.SourceFile, name: string): boolean {
  return prototypeUse(sourceFile).writtenNames.has(name);
}

function prototypeUse(sourceFile: ts.SourceFile): PrototypeUse {
  let use = cache.get(sourceFile);
  if (!use) {
    use = { writes: new Set(), mayPatch: new Set(), writtenNames: new Set(), reflective: false };
    const found = use;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const owner = prototypeOwner(node);
        if (owner && !owner.viaGlobalThis && isLegacyWrite(node)) found.writes.add(owner.intrinsic);
        if (owner && !isPlainMemberRead(node)) found.mayPatch.add(owner.intrinsic);
      }
      const written = writtenName(node);
      if (written !== undefined) found.writtenNames.add(written);
      const name = nameText(node);
      if (
        ts.isWithStatement(node) ||
        (name !== undefined && REFLECTIVE_NAMES.has(name) && !isObservedConstructor(node))
      ) {
        found.reflective = true;
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
    cache.set(sourceFile, use);
  }
  return use;
}

/** `Array` for `Array.prototype` / `globalThis.Array.prototype`, `Object` and `String` likewise. */
function prototypeOwner(
  expression: ts.PropertyAccessExpression,
): { readonly intrinsic: PatchableIntrinsic; readonly viaGlobalThis: boolean } | undefined {
  if (expression.name.text !== "prototype") return undefined;
  const receiver = expression.expression;
  const viaGlobalThis =
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === "globalThis";
  const owner = viaGlobalThis ? receiver.name : receiver;
  if (!ts.isIdentifier(owner)) return undefined;
  const intrinsic = owner.text;
  if (intrinsic !== "Array" && intrinsic !== "Function" && intrinsic !== "Object" && intrinsic !== "String") {
    return undefined;
  }
  return { intrinsic, viaGlobalThis };
}

/** The text of an identifier or a literal member key (`o["k"]`), if `node` is one. */
function nameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

/** The name `node` stores into, deletes or defines: `x.k = v`, `delete x.k`, `k = v`, `Object.defineProperty(x, "k", …)`. */
function writtenName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return isOwnWriteTarget(node) ? node.name.text : undefined;
  if (ts.isElementAccessExpression(node)) {
    return isOwnWriteTarget(node) ? nameText(skipOuterExpressions(node.argumentExpression)) : undefined;
  }
  if (ts.isIdentifier(node)) return isOwnWriteTarget(node) ? node.text : undefined;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const key = node.arguments[1];
  return node.expression.name.text === "defineProperty" && key !== undefined ? nameText(key) : undefined;
}

/** `target` is itself what a store or `delete` writes, not a member's object or name (`x` and `k` in `x.k = v`). */
function isOwnWriteTarget(target: ts.Expression): boolean {
  const use = outermost(target);
  if (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) return false;
  return isStoreTarget(target) || ts.isDeleteExpression(use.parent);
}

/**
 * `x.constructor` used only as an identity (`x.constructor !== C`) or for its
 * `name`, as assert.js's `assert.throws` reads it: neither reaches a prototype.
 */
function isObservedConstructor(name: ts.Node): boolean {
  const access = name.parent;
  if (!ts.isIdentifier(name) || name.text !== "constructor" || !ts.isPropertyAccessExpression(access)) return false;
  if (access.name !== name) return false;
  const use = outermost(access);
  const user = use.parent;
  if (ts.isBinaryExpression(user)) return EQUALITY_OPERATORS.has(user.operatorToken.kind);
  return (
    ts.isPropertyAccessExpression(user) &&
    user.expression === use &&
    user.name.text === "name" &&
    !isStoreTarget(user) &&
    !ts.isDeleteExpression(outermost(user).parent)
  );
}

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** `node` with the parentheses and type wrappers around it. */
function outermost(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isExpression(current.parent) && skipOuterExpressions(current.parent) !== current.parent) {
    current = current.parent;
  }
  return current;
}

/** The member access whose object is `prototype` (through wrappers), if any. */
function memberOn(prototype: ts.Expression): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  const object = outermost(prototype);
  const member = object.parent;
  return member &&
    (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
    member.expression === object
    ? member
    : undefined;
}

/** #1719's set: `<P>.k = v`, `delete <P>.k`, `Object.defineProperty(<P>, …)` / `defineProperties`. */
function isLegacyWrite(prototype: ts.PropertyAccessExpression): boolean {
  const member = memberOn(prototype);
  if (member) {
    const user = member.parent;
    if (ts.isBinaryExpression(user) && user.operatorToken.kind === ts.SyntaxKind.EqualsToken && user.left === member) {
      return true;
    }
    return ts.isDeleteExpression(outermost(member).parent);
  }
  const call = prototype.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== prototype) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
  );
}

/** The prototype is only the object of a member read: not stored into, deleted, or called on. */
function isPlainMemberRead(prototype: ts.PropertyAccessExpression): boolean {
  const member = memberOn(prototype);
  if (!member) return false;
  const user = member.parent;
  if (ts.isDeleteExpression(user)) return false;
  if (ts.isCallExpression(user) && user.expression === member) return false;
  if (ts.isTaggedTemplateExpression(user) && user.tag === member) return false;
  return !isStoreTarget(member);
}
