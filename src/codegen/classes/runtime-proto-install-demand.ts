// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7061) A member installed on `C.prototype` at RUNTIME must be visible to the
 * instances of `C`.
 *
 * ```js
 * class H {
 *   static add(n) { Object.defineProperty(this.prototype, "get" + n, { value() { return 7; } }); }
 * }
 * H.add("E");
 * typeof new H().getE;   // "function" — standalone answered "undefined"
 * ```
 *
 * axios builds `AxiosHeaders#getContentType`/`setContentType`/… exactly this
 * way, and calls them on instances.
 *
 * ## Why it missed
 *
 * The write lands: the prototype singleton is a real `$Object` (#3976) and
 * `typeof H.prototype.getE` already answers `"function"`. The instance read is
 * the miss. A closed `$H` struct serves its declared fields and members; the
 * dynamic `__extern_get` / `__extern_method_call` ladder reaches the class's
 * prototype `$Object` only through `__class_proto_lookup`, and that arm is
 * minted per class on DEMAND (`ctx.standaloneRuntimeKeyClassProtos`, #5383
 * S2h). The demand is recorded at runtime-KEY read sites (`o[k]`, `k in o`, a
 * dynamic `.prototype` read), never at a statically-named `h.getE` — so the
 * same probe answered correctly as soon as an unrelated `o[k]` appeared
 * anywhere in the module, and `undefined` otherwise.
 *
 * ## The rule
 *
 * The program is what makes a prototype mutable at runtime, so the demand is
 * recorded where the program MUTATES it: a static `C.prototype` /
 * `this.prototype` (static method) read that is
 *
 *  - the base of an assignment target — `C.prototype.m = f`,
 *    `C.prototype[k] = f`, compound forms included; or
 *  - the first argument of `Object.defineProperty` / `Object.defineProperties`
 *    / `Object.assign` / `Reflect.defineProperty` / `Reflect.set`.
 *
 * The record is per class (`recordStandaloneRuntimeKeyClassMemberRead` with the
 * class's struct widens it to the class's ancestors and descendants — a
 * `Derived` instance reaches a member installed on `Base.prototype` through the
 * §15.7.14 chain link). A module that never mutates a class prototype records
 * nothing and emits its previous bytes; the JS-host lane never records.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { recordStandaloneRuntimeKeyClassMemberRead } from "../standalone-class-dyn-member.js";

const MUTATING_STATIC_CALLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Object", new Set(["defineProperty", "defineProperties", "assign"])],
  ["Reflect", new Set(["defineProperty", "set"])],
]);

/** Walk up through the type-only / grouping wrappers that carry no runtime meaning. */
function transparentParent(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

function isAssignmentTarget(node: ts.Node): boolean {
  const outer = transparentParent(node);
  const parent = outer.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.left === outer &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Is `protoRead` (an `X.prototype` expression) the target of a runtime mutation? */
function isRuntimeProtoMutationTarget(protoRead: ts.Node): boolean {
  const outer = transparentParent(protoRead);
  const parent = outer.parent;
  if (parent === undefined) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) {
    return isAssignmentTarget(parent);
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === outer) {
    const callee = parent.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
    return MUTATING_STATIC_CALLS.get(callee.expression.text)?.has(callee.name.text) === true;
  }
  return false;
}

/**
 * Record the `__class_proto_lookup` demand for `className` when `protoRead` is
 * a `C.prototype` / `this.prototype` read that the program mutates through.
 */
export function recordRuntimeProtoInstallDemand(
  ctx: CodegenContext,
  protoRead: ts.Node | undefined,
  className: string,
): void {
  if (protoRead === undefined) return;
  if (!isRuntimeProtoMutationTarget(protoRead)) return;
  const structTypeIdx = ctx.structMap.get(className);
  // No struct, no instances to serve: recording would widen to every class.
  if (structTypeIdx === undefined) return;
  recordStandaloneRuntimeKeyClassMemberRead(ctx, structTypeIdx);
}
