// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S1) `Object.assign` with a PRIMITIVE operand — the checker's static
 * type of the call is a lie about the runtime carrier.
 *
 * lib.es2015 types `Object.assign(target: T, source: U): T & U`. With object
 * operands the intersection is harmless: the runtime result IS the target
 * object. With a primitive operand it is not:
 *
 * ```js
 * var t = Object.assign({}, "ab");      // checker: "ab"            runtime: a plain object {0:"a",1:"b"}
 * var r = Object.assign(true, {a: 1});  // checker: true & {a:number} runtime: a Boolean WRAPPER
 * var n = Object.assign(12, "aaa");     // checker: never           runtime: a Number wrapper
 * ```
 *
 * Measured on main (standalone): the first binding received a native-string
 * slot, the `$Object` result failed the guarded store, and `t[0]` dereferenced
 * null; the second folded `r.valueOf()` to `r` itself (the blanket
 * `Object.prototype.valueOf` identity), so `sameValue(r.valueOf(), true)` saw
 * the wrapper object. §20.1.2.1 step 1 is `to = ToObject(target)` and the call
 * returns `to`, so both answers are wrong.
 *
 * Two narrow consequences, both keyed on the AMBIENT `Object` (a user
 * `function Object(){}` is a different function):
 *
 * - {@link objectAssignResultNeedsExternref}: an unannotated binding whose
 *   initializer is such a call keeps the externref the call returned, in every
 *   storage path (the `transferredArrayLikeResultNeedsExternref` hub consulted
 *   by module globals, function locals and hoisted vars alike).
 * - {@link objectAssignPrimitiveTargetOf}: the call with a primitive TARGET is
 *   a primitive-wrapper producer, the same fact `Object(<primitive>)` carries —
 *   so `r.valueOf()` / `r.constructor` take the runtime wrapper arms.
 */
import type { Instr } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { STRING_EXOTIC_PUSH_KEYS_FN } from "./native-names.js";

const PRIMITIVE_TAGS = new Set(["number", "string", "boolean", "bigint", "symbol"]);

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** `expr` as a call of the ambient global `Object.assign`, else `undefined`. */
export function ambientObjectAssignCall(ctx: CodegenContext, expr: ts.Expression): ts.CallExpression | undefined {
  const call = unwrap(expr);
  if (!ts.isCallExpression(call) || call.arguments.length === 0) return undefined;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name) || callee.name.text !== "assign") {
    return undefined;
  }
  const receiver = callee.expression;
  if (!ts.isIdentifier(receiver) || receiver.text !== "Object") return undefined;
  const decl = ctx.oracle.valueDeclarationOf(receiver);
  if (decl !== undefined && !decl.getSourceFile().isDeclarationFile) return undefined;
  return call;
}

function isStaticPrimitive(ctx: CodegenContext, expr: ts.Expression): boolean {
  return PRIMITIVE_TAGS.has(ctx.oracle.staticJsTypeOf(expr));
}

/**
 * The primitive TARGET of an ambient `Object.assign(<primitive>, …)` call —
 * the value whose ToObject wrapper the call returns — else `undefined`.
 */
export function objectAssignPrimitiveTargetOf(ctx: CodegenContext, expr: ts.Expression): ts.Expression | undefined {
  const call = ambientObjectAssignCall(ctx, expr);
  if (call === undefined) return undefined;
  const target = call.arguments[0]!;
  if (ts.isSpreadElement(target)) return undefined;
  return isStaticPrimitive(ctx, target) ? target : undefined;
}

/**
 * Does an unannotated binding initialized by `initializer` need the externref
 * carrier because the initializer is an ambient `Object.assign` call with any
 * primitive operand? Standalone-only: the host lane's import returns a real JS
 * object and its bindings are already dynamic.
 */
export function objectAssignResultNeedsExternref(ctx: CodegenContext, initializer: ts.Expression | undefined): boolean {
  if (!ctx.standalone || initializer === undefined) return false;
  const call = ambientObjectAssignCall(ctx, initializer);
  if (call === undefined) return false;
  // A `new String(…)` operand lies the same way: `{} & String` is `String`.
  return call.arguments.some(
    (arg) => !ts.isSpreadElement(arg) && (isStaticPrimitive(ctx, arg) || isPrimitiveWrapperOperand(ctx, arg)),
  );
}

function isPrimitiveWrapperOperand(ctx: CodegenContext, expr: ts.Expression): boolean {
  const name = ctx.oracle.builtinReceiverOf(expr);
  return name === "String" || name === "Number" || name === "Boolean";
}

/**
 * Is `expr` an identifier whose binding holds such an `Object.assign` result?
 * Its checker type (`"ab"` for `Object.assign({}, "ab")`, `String` for a
 * `new String` source) would route a `t[0]` read to the String-exotic index
 * lowering, which reads [[StringData]] off what is really an ordinary object.
 * Such a consumer must decline and take the dynamic externref read instead.
 */
export function isObjectAssignPrimitiveResultBinding(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ctx.standalone) return false;
  const id = unwrap(expr);
  if (!ts.isIdentifier(id)) return false;
  return objectAssignResultNeedsExternref(ctx, ctx.oracle.variableInitializerOf(id));
}

/**
 * The String-exotic SOURCE arm of the native `__object_assign` per-source loop.
 *
 * §20.1.2.1 step 4.a is `from = ToObject(nextSource)`, and a String's ToObject
 * has own enumerable index properties `"0" … "len-1"` (§10.4.3). The native
 * loop only walked `$Object` table entries, so a primitive string source
 * contributed nothing (`Object.assign({}, "ab")` → `{}`) and a `new String`
 * source contributed only its expandos. `__strexo_push_keys` already answers
 * both shapes (the enumeration half of #4491); copy each index key with the
 * same `Get(from, key)` + strict `Set(to, key, v, true)` pair the `$Object` arm
 * uses. The ordinary `$Object` arm then adds a wrapper's expandos, which is the
 * §10.4.3.6 order (indices first). Number / Boolean / Symbol sources have no
 * own enumerable properties and keep being skipped.
 *
 * Reuses the closed-struct arm's scratch locals (key list / count / index /
 * key): the two arms run one after the other, each re-initializing them.
 * Returns `[]` (byte-inert) when any dependency is absent.
 */
export function stringExoticAssignSourceInstrs(
  ctx: CodegenContext,
  locals: { target: number; source: number; keys: number; count: number; index: number; key: number },
): Instr[] {
  const pushKeysIdx = ctx.funcMap.get(STRING_EXOTIC_PUSH_KEYS_FN);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const lengthIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const getIdx = ctx.funcMap.get("__extern_get");
  const strictSetIdx = ctx.funcMap.get("__extern_set_strict");
  if (
    !ctx.standalone ||
    pushKeysIdx === undefined ||
    objVecNewIdx === undefined ||
    lengthIdx === undefined ||
    getIdxIdx === undefined ||
    getIdx === undefined ||
    strictSetIdx === undefined
  ) {
    return [];
  }
  const { target, source, keys, count, index, key } = locals;
  return [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: keys },
    { op: "local.get", index: source },
    { op: "local.get", index: keys },
    { op: "call", funcIdx: pushKeysIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: keys },
        { op: "call", funcIdx: lengthIdx },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.set", index: count },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: index },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: index },
                { op: "local.get", index: count },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: keys },
                { op: "local.get", index: index },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: getIdxIdx },
                { op: "local.set", index: key },
                // Set(to, key, Get(from, key), true)
                { op: "local.get", index: target },
                { op: "local.get", index: key },
                { op: "local.get", index: source },
                { op: "local.get", index: key },
                { op: "call", funcIdx: getIdx },
                { op: "call", funcIdx: strictSetIdx },
                { op: "local.get", index: index },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: index },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}
