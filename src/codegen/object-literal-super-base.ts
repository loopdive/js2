// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A13) `super.x` inside a method of a CLOSED-STRUCT object literal,
 * standalone.
 *
 * §12.3.5 reads `super.x` from `HomeObject.[[GetPrototypeOf]]()`. The #4688
 * lowering reaches the home object through a synthetic closure capture, which
 * only the open-`$Object` literal path installs (`emitObjectLiteralMethodFn`).
 * A literal that stays a closed struct compiles its methods as struct methods
 * with no such capture, so the read declined and answered a typed default:
 * `({ m() { return super.toString; } }).m()` was `null`
 * (`method-definition/{generator,name}-super-prop-{param,body}.js`,
 * `super/prop-poisoned-underscore-proto.js`).
 *
 * For such a literal the super base is known statically: its [[Prototype]] is
 * %Object.prototype%. The two ways to give a literal another prototype both
 * leave the closed-struct path first — a colon `__proto__:` key
 * (`objectLiteralHasColonProto`) and a proto-mutation receiver the #802
 * pre-scan marks (`ctx.dynamicProtoLiteralNodes`) are built as open
 * `$Object`s, which carry the capture — and both are excluded here as well, so
 * this never answers for a literal whose prototype can differ.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitEs5IntrinsicPrototype } from "./expressions/object-get-prototype-of.js";
import { objectLiteralHasColonProto } from "./literals.js";
import { coerceType } from "./type-coercion.js";

/** The object literal owning the method/accessor a `super` reference binds to (arrows are transparent). */
function superHomeLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isArrowFunction(cur)) continue;
    if (ts.isMethodDeclaration(cur) || ts.isGetAccessorDeclaration(cur) || ts.isSetAccessorDeclaration(cur)) {
      return ts.isObjectLiteralExpression(cur.parent) ? cur.parent : undefined;
    }
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return undefined;
  }
  return undefined;
}

/**
 * Push %Object.prototype% as the super base of `anchor` (a `super` property
 * access or call) when its home object is a literal whose [[Prototype]] is
 * statically %Object.prototype%. Returns false — emitting nothing — otherwise.
 */
export function emitClosedLiteralSuperBase(ctx: CodegenContext, fctx: FunctionContext, anchor: ts.Node): boolean {
  const literal = superHomeLiteral(anchor);
  if (literal === undefined || ctx.dynamicProtoLiteralNodes.has(literal) || objectLiteralHasColonProto(ctx, literal)) {
    return false;
  }
  const type = emitEs5IntrinsicPrototype(ctx, fctx, anchor, "Object");
  if (type !== null && typeof type === "object" && type.kind !== "externref") {
    coerceType(ctx, fctx, type, { kind: "externref" });
  }
  return true;
}
