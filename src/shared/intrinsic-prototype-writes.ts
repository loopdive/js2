// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * What a program does to `Array.prototype` and `Object.prototype`, from one
 * pure-AST walk over every mention of them. Two consumers ask two questions:
 *
 *   - {@link sourceWritesPrototype}: the legacy array-iteration brand (#1719,
 *     `sourceOverridesArrayIterator`) asks whether the program writes a member
 *     with `=`, deletes one, or passes the prototype to
 *     `Object.defineProperty`/`defineProperties`. Its byte-identity contract
 *     pins exactly that set.
 *   - {@link sourceMayPatchPrototype}: the IR's destructuring readers (#7106)
 *     assume the realm's own prototypes, so they ask the conservative
 *     question. A prototype (`Array.prototype`, `globalThis.Object.prototype`,
 *     …) may be patched unless every mention of it is the object of a plain
 *     member read (`Array.prototype.map.call(…)`). A stored-into member
 *     (compound, logical and destructuring targets included), a deleted one, a
 *     call with the prototype as `this` (`Object.prototype.__defineGetter__`)
 *     and any escape (`Reflect.set(Array.prototype, …)`, `Object.assign`,
 *     `Object.setPrototypeOf`, an alias, an operand) all count. A patch that
 *     never names the prototype (`%ArrayIteratorPrototype%` reached through
 *     `Object.getPrototypeOf`) is not seen.
 */
import { forEachChild, ts } from "../ts-api.js";
import { isStoreTarget, skipOuterExpressions } from "./binding-writes.js";

export type PatchableIntrinsic = "Array" | "Object";

interface PrototypeUse {
  readonly writes: Set<PatchableIntrinsic>;
  readonly mayPatch: Set<PatchableIntrinsic>;
}

const cache = new WeakMap<ts.SourceFile, PrototypeUse>();

export function sourceWritesPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).writes.has(intrinsic);
}

export function sourceMayPatchPrototype(sourceFile: ts.SourceFile, intrinsic: PatchableIntrinsic): boolean {
  return prototypeUse(sourceFile).mayPatch.has(intrinsic);
}

function prototypeUse(sourceFile: ts.SourceFile): PrototypeUse {
  let use = cache.get(sourceFile);
  if (!use) {
    use = { writes: new Set(), mayPatch: new Set() };
    const found = use;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const owner = prototypeOwner(node);
        if (owner && !owner.viaGlobalThis && isLegacyWrite(node)) found.writes.add(owner.intrinsic);
        if (owner && !isPlainMemberRead(node)) found.mayPatch.add(owner.intrinsic);
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
    cache.set(sourceFile, use);
  }
  return use;
}

/** `Array` for `Array.prototype` / `globalThis.Array.prototype`, `Object` likewise. */
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
  if (!ts.isIdentifier(owner) || (owner.text !== "Array" && owner.text !== "Object")) return undefined;
  return { intrinsic: owner.text, viaGlobalThis };
}

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
