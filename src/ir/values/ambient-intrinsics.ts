// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";

/**
 * (#7106) Ambient intrinsics the IR reads as VALUES — `assert.throws(TypeError,
 * fn)`, `typeof Symbol`. Each is a property of the realm's
 * global object (§19.1, §19.3), so the IR reads it as `dyn.member_get` off
 * `dyn.global_object`: the same object, and so the same constructor identity,
 * legacy's own `globalThis` read yields. Names outside this list keep the
 * existing refusal; the selector also requires the identifier to resolve to
 * its lib declaration (never a user binding of the same name). `globalThis`
 * itself is not listed: the checker synthesizes it without a lib declaration.
 */
const AMBIENT_INTRINSIC_VALUE_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Function",
]);

export function isAmbientIntrinsicName(name: string): boolean {
  return AMBIENT_INTRINSIC_VALUE_NAMES.has(name);
}

/**
 * (#7123) Is this ambient-intrinsic occurrence the receiver of a member read
 * (`Error.prototype`, `TypeError.call`, `Object["keys"]`)? The selector keeps
 * those on the legacy path. Legacy lowers `<Builtin>.prototype.<m>` and the
 * inherited `Function.prototype` members syntactically, so its pre-scan
 * (`isProtoMemberValueUse`, in the codegen proto pre-pass) seeds no runtime
 * companion for them; the IR's `__extern_get` chain then finds only some
 * members. Measured on standalone and gc: `typeof Error.prototype.toString`,
 * `TypeError.prototype.constructor === TypeError`, `typeof TypeError.call`,
 * `typeof Function.prototype` all answered differently from legacy and node.
 * Opaque uses (call argument, `typeof`, identity) are unaffected.
 */
export function isMemberReadReceiver(node: ts.Identifier): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return (
    parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === child
  );
}
