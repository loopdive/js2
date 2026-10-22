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
 * (#7127) Exception: once the module's brand companion is seeded (legacy's
 * pre-scan armed it for another reason), a `<Receiver>.prototype.<method>`
 * value read answers exactly as legacy does and is admitted.
 */
export function isMemberReadReceiver(node: ts.Identifier, protoCompanionSeeded: boolean): boolean {
  const access = memberAccessOf(node);
  if (access === undefined) return false;
  return !(protoCompanionSeeded && isExactProtoMethodValueRead(node.text, access));
}

/**
 * (#7127) Intrinsics whose `.prototype.<method>` value read is exact through
 * the dynamic `__extern_get` chain once the module's brand companion is
 * seeded. The NativeError constructors are left out: their prototypes inherit
 * `toString` from `Error.prototype`, and legacy itself answers
 * `RangeError.prototype.toString === Error.prototype.toString` false.
 */
const PROTO_METHOD_RECEIVERS: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "Function",
  "Error",
  "String",
  "Number",
  "Boolean",
  "Symbol",
]);

/**
 * (#7127) Methods measured exact as `<Receiver>.prototype.<m>` values (typeof
 * and identity against `Object.prototype.<m>`, standalone and gc, against
 * node). Data and accessor members stay refused: legacy itself mis-answers
 * `Function.prototype.length`, `String.prototype.length` and
 * `Symbol.prototype.description`, and `constructor` reads a different identity
 * from the global-object constructor through the IR.
 */
const PROTO_METHOD_NAMES: ReadonlySet<string> = new Set([
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "call",
  "apply",
  "bind",
  "push",
  "pop",
  "concat",
  "join",
  "slice",
  "splice",
  "indexOf",
  "lastIndexOf",
  "forEach",
  "map",
  "filter",
  "reduce",
  "every",
  "some",
  "charAt",
  "charCodeAt",
  "toFixed",
]);

function memberAccessOf(node: ts.Expression): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === child
    ? parent
    : undefined;
}

function staticMemberName(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  return ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
}

/**
 * (#7127) `<Receiver>.prototype.<method>` read as a plain VALUE: not called
 * (the receiver would become `this`), not read further (`.call(x)` keeps the
 * S1c `Object.prototype.toString.call` arm and the legacy call paths), not a
 * write, `delete` or update target.
 */
function isExactProtoMethodValueRead(
  name: string,
  protoAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if (!PROTO_METHOD_RECEIVERS.has(name) || staticMemberName(protoAccess) !== "prototype") return false;
  const methodAccess = memberAccessOf(protoAccess);
  const method = methodAccess && staticMemberName(methodAccess);
  if (methodAccess === undefined || method === undefined || !PROTO_METHOD_NAMES.has(method)) return false;
  let use: ts.Node = methodAccess;
  while (use.parent && ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  if (parent === undefined) return false;
  if (memberAccessOf(methodAccess) !== undefined) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === use) return false;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === use) return false;
  if (ts.isDeleteExpression(parent) || ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === use &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  return !(ts.isForInStatement(parent) || ts.isForOfStatement(parent)) || parent.expression === use;
}
