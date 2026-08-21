// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2875 wave-4 lane F) `<primitive string>.constructor` → the genuine `String`
 * constructor carrier.
 *
 * ## The defect
 *
 * `§10.5 (OrdinaryGet)` on a primitive string boxes it (`ToObject`) and walks
 * `String.prototype → Object.prototype`, where `constructor` is an own data
 * property whose value is the `String` constructor object. #3006/#4223 already
 * make that identity genuine for the OBJECT receivers — `String.prototype`
 * itself and `new String("x")` both fold to the `__builtin_ctor_String`
 * singleton — but the PRIMITIVE receiver was never routed anywhere. Measured on
 * this branch's base (`--target standalone`, `test262/test/probe/f-str-ctor2.js`):
 *
 * | expression                                   | base        | spec    |
 * | -------------------------------------------- | ----------- | ------- |
 * | `String.prototype.constructor === String`     | `true`      | `true`  |
 * | `new String("abc").constructor === String`    | `true`      | `true`  |
 * | `"abc".constructor === String`                | **`false`** | `true`  |
 * | `typeof "abc".constructor`                    | `undefined` | function|
 *
 * The primitive read fell through the whole `.constructor` ladder in
 * `tryConstructorPrototypeIdentity` (every arm there keys off a receiver type
 * with a SYMBOL — `String`/`Object`/a TypedArray interface — and the primitive
 * `string` type has none) and landed on the dynamic tail, which answers
 * `undefined`.
 *
 * ## Why an arm and not a repair of the tail
 *
 * The dynamic tail serves every unresolved receiver family; making it synthesize
 * a `String` carrier would be wrong for anything that is not a string. This arm
 * answers ONLY when the oracle proves the receiver is exactly the primitive
 * `string` type, and declines everywhere else, so no other lowering moves.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * - `ctx.oracle.typeFactOf(receiver).kind === "string"` — no union, no `any`, no
 *   `String` wrapper object (that is `{kind:"builtin"}`/`{kind:"object"}` and is
 *   already served by the #3006 arm).
 * - Standalone only. In gc/host mode the real `Object_get_constructor` host read
 *   is a genuine value and must stay.
 * - The read must not be an assignment target or a `delete` operand.
 * - The module must not touch a `.constructor` property anywhere
 *   ({@link moduleTouchesConstructorProp}) and must not extend
 *   `String.prototype` / `Object.prototype`, since either can make the answer
 *   something other than the builtin carrier.
 *
 * Rows flipped (standalone): `language/types/string/S8.4_A12`,
 * `S8.4_A9_T1`, `S8.4_A9_T2`, `S8.4_A9_T3`.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitBuiltinConstructorIdentity } from "./builtin-static-globals.js";
import { moduleTouchesConstructorProp } from "./property-access.js";
import { compileExpression } from "./shared.js";

const protoExtensionCache = new WeakMap<ts.SourceFile, boolean>();

/** `String.prototype` / `Object.prototype` as the base of a member expression. */
function isStringChainProtoTarget(expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "prototype") return false;
  const base = expr.expression;
  return ts.isIdentifier(base) && (base.text === "String" || base.text === "Object");
}

/**
 * Does this module write to, delete from, or `Object.define*` over
 * `String.prototype` / `Object.prototype`? Deliberately coarse — any such
 * mention disables the fold module-wide, because the fold's premise is that the
 * chain still carries the builtin `constructor`.
 */
function moduleExtendsStringChainProtos(sourceFile: ts.SourceFile): boolean {
  const cached = protoExtensionCache.get(sourceFile);
  if (cached !== undefined) return cached;
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const left = node.left;
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        isStringChainProtoTarget(left.expression)
      ) {
        found = true;
        return;
      }
      if (isStringChainProtoTarget(left)) {
        found = true;
        return;
      }
    }
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      isStringChainProtoTarget(node.expression.expression)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isStringChainProtoTarget(node.arguments[0]!)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  protoExtensionCache.set(sourceFile, found);
  return found;
}

/** True when this member expression is being written to or deleted. */
function isWriteOrDeleteTarget(expr: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const parent = expr.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isDeleteExpression(parent)) return true;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expr &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  return false;
}

/**
 * Emit the `String` constructor carrier for `<primitive string>.constructor`, or
 * return `undefined` to leave the expression to the existing lowerings.
 *
 * Stack on success: `[] → [externref]`.
 */
export function tryEmitPrimitiveStringConstructorRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (propName !== "constructor") return undefined;
  if (isWriteOrDeleteTarget(expr)) return undefined;

  if (ctx.oracle.typeFactOf(expr.expression).kind !== "string") return undefined;

  const sourceFile = expr.getSourceFile();
  if (moduleTouchesConstructorProp(sourceFile)) return undefined;
  if (moduleExtendsStringChainProtos(sourceFile)) return undefined;

  // Evaluate the receiver for its side effects (spec: the MemberExpression is
  // evaluated), then discard it — the constructor identity is static.
  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (recvType) fctx.body.push({ op: "drop" });
  return emitBuiltinConstructorIdentity(ctx, fctx, "String");
}
