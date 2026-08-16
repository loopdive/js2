// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4483) An ABSENT property read on a `number` / `boolean` PRIMITIVE receiver
 * answers `undefined`, not `null`.
 *
 * ## The defect
 *
 * `§9.1 (ToObject) + §10.5 (OrdinaryGet)`: `(1).touched` boxes the primitive,
 * walks `Number.prototype → Object.prototype`, finds nothing, and evaluates to
 * `undefined`. The legacy dynamic member-get tail had no arm for a primitive
 * receiver, so the read fell through to a `ref.null.extern` placeholder.
 * Measured on this branch's base with `runTest262File(…, "standalone")`
 * (`.tmp/probes/p6-missing-prop.js`, one module, six receivers):
 *
 * | receiver (`x.touched`, property never defined) | base    | spec        |
 * | ---------------------------------------------- | ------- | ----------- |
 * | `var n = 1`                                    | `null`  | `undefined` |
 * | `var b = true`                                 | `null`  | `undefined` |
 * | `var s = "abc"`                                | `undefined` | `undefined` |
 * | `var o = {}` / `var a = [1]` / `function fn(){}` | `undefined` | `undefined` |
 *
 * So the bug was exactly two receiver families — the two primitives with no
 * string-like or object-like fast path of their own. `typeof null === "object"`
 * is what makes it observable: `built-ins/Function/prototype/{apply,call}/
 * S15.3.4.{3,4}_A5_T{1,2}` assert `typeof obj.touched === "undefined"` after
 * `.apply(1)` / `.apply(true)`, and read `"object"`.
 *
 * ## Why an arm and not a repair of the null site
 *
 * The `ref.null.extern` placeholder at the tail of
 * `finalizeStructAndDynamicMemberGet` is shared by many receiver families
 * (unresolved class methods, missing prototypes, …) whose consumers compare
 * against null. Flipping it wholesale would be a wide, unmeasured change. This
 * arm instead answers only for the two receiver kinds where the spec's answer is
 * decidable at compile time, and DECLINES everywhere else — the null tail is
 * untouched for every other shape.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * - The oracle must prove the receiver is exactly `number` or `boolean` (no
 *   union, no `any`, no nullable). A boxed `new Number(1)` is an object type and
 *   never matches.
 * - The property must not be a member the wrapper chain really has
 *   ({@link WRAPPER_CHAIN_MEMBERS}); `n.toFixed` keeps its existing lowering.
 * - The module must not extend `Number.prototype` / `Boolean.prototype` /
 *   `Object.prototype`, since such a write makes the property PRESENT and the
 *   answer no longer decidable here ({@link moduleExtendsPrimitiveProtos}).
 * - The read must not be an assignment target or a `delete` operand — those are
 *   different operations with their own lowerings.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { compileExpression } from "./shared.js";

/**
 * Everything reachable from a number/boolean primitive through its wrapper
 * prototype chain (`Number.prototype`/`Boolean.prototype` → `Object.prototype`),
 * plus the `Symbol.toPrimitive`-adjacent spellings a receiver may be probed
 * with. A property in this set is PRESENT, so this module must not answer.
 */
const WRAPPER_CHAIN_MEMBERS = new Set([
  // Number.prototype / Boolean.prototype
  "toFixed",
  "toPrecision",
  "toExponential",
  "toString",
  "toLocaleString",
  "valueOf",
  // Object.prototype
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Reads the codegen gives its own meaning to
  "length",
  "name",
  "prototype",
  "caller",
  "arguments",
]);

const primitiveProtoExtensionCache = new WeakMap<ts.SourceFile, boolean>();

function isPrimitiveProtoTarget(expr: ts.Expression): boolean {
  // `Number.prototype` / `Boolean.prototype` / `Object.prototype` — as the
  // RECEIVER of a write (`Number.prototype.touched = …`) or as the direct
  // target of a defineProperty-style call.
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "prototype") return false;
  const base = expr.expression;
  return ts.isIdentifier(base) && (base.text === "Number" || base.text === "Boolean" || base.text === "Object");
}

/**
 * Does this module make a property of `Number.prototype` / `Boolean.prototype` /
 * `Object.prototype` PRESENT (or absent)? Recognition is deliberately coarse —
 * any write, delete or `Object.define*` naming one of those objects disables the
 * fold for the whole module, because the fold's premise is "this property is
 * provably absent from the chain".
 */
function moduleExtendsPrimitiveProtos(sourceFile: ts.SourceFile): boolean {
  const cached = primitiveProtoExtensionCache.get(sourceFile);
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
        isPrimitiveProtoTarget(left.expression)
      ) {
        found = true;
        return;
      }
      // `Number.prototype = …` itself.
      if (isPrimitiveProtoTarget(left)) {
        found = true;
        return;
      }
    }
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      isPrimitiveProtoTarget(node.expression.expression)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isPrimitiveProtoTarget(node.arguments[0]!)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  primitiveProtoExtensionCache.set(sourceFile, found);
  return found;
}

/** True when this member expression is being written to or deleted. */
function isWriteOrDeleteTarget(expr: ts.PropertyAccessExpression): boolean {
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
  if (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) {
    const op = (parent as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) return true;
  }
  return false;
}

/**
 * Emit `undefined` for a provably-absent property of a number/boolean primitive,
 * or return undefined to leave the expression to the existing lowerings.
 */
export function tryEmitPrimitiveAbsentPropertyRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (ts.isPrivateIdentifier(expr.name)) return undefined;
  if (WRAPPER_CHAIN_MEMBERS.has(propName)) return undefined;
  if (isWriteOrDeleteTarget(expr)) return undefined;

  const fact = ctx.oracle.typeFactOf(expr.expression);
  if (fact.kind !== "number" && fact.kind !== "boolean") return undefined;

  if (moduleExtendsPrimitiveProtos(expr.getSourceFile())) return undefined;

  // Evaluate the receiver for its side effects, then answer `undefined`.
  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (recvType) fctx.body.push({ op: "drop" });
  emitUndefined(ctx, fctx);
  return { kind: "externref" };
}
