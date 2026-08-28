// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5156) Native body for `Date.prototype[Symbol.toPrimitive]` (§21.4.4.45)
 * under `--target standalone`.
 *
 * The algorithm is short and entirely delegating:
 *
 *   1. `O` is the `this` value; if it is not an Object, throw a TypeError.
 *   2. `hint` must be exactly one of `"string"` / `"number"` / `"default"`;
 *      anything else (including a non-string) throws a TypeError.
 *   3. `"string"` AND `"default"` run OrdinaryToPrimitive with
 *      `tryFirst = "string"`; only `"number"` runs it valueOf-first. Mapping
 *      "default" to the STRING order is the ONE place Date departs from the
 *      ordinary rule, and it is why `new Date() + ""` concatenates the date
 *      text instead of adding its time value.
 *
 * Step 3 is the object runtime's `__to_primitive(value, hint)`, whose hint
 * parameter selects those same two orders. Its own `@@toPrimitive` probe is an
 * OWN-property lookup (`__obj_find`), so a receiver that merely INHERITS this
 * method — every ordinary Date — cannot re-enter here.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureExternStrictEqHelper } from "./any-helpers.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * Emit the standalone `Date.prototype[Symbol.toPrimitive]` closure body.
 * Returns `null` (a refusal the factory turns into the catchable
 * not-implemented body) when the object runtime cannot supply its helpers.
 */
export function emitDateProtoToPrimitiveBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  ensureObjectRuntime(ctx);
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const strEqIdx = ensureExternStrictEqHelper(ctx);
  if (
    toPrimitiveIdx === undefined ||
    typeofObjectIdx === undefined ||
    typeofFunctionIdx === undefined ||
    strEqIdx === undefined
  ) {
    return null;
  }

  const isStringHint = allocLocal(fctx, `__dtp_isstr_${fctx.locals.length}`, { kind: "i32" });
  const result = allocLocal(fctx, `__dtp_result_${fctx.locals.length}`, { kind: "externref" });

  const literal = (value: string): Instr[] => {
    addStringConstantGlobal(ctx, value);
    return stringConstantExternrefInstrs(ctx, value);
  };
  const hintIs = (value: string): Instr[] => [
    { op: "local.get", index: 2 },
    ...literal(value),
    { op: "call", funcIdx: strEqIdx },
  ];
  const typeError = (message: string): Instr[] => {
    const body: Instr[] = [];
    emitBrandCheckTypeError(ctx, body, message);
    return body;
  };

  // Steps 1-2 — `this` must be an Object. A callable object counts.
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofObjectIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: typeError("Date.prototype[Symbol.toPrimitive] called on a non-object"),
    },
  );

  // Step 3 — recognised hint → OrdinaryToPrimitive in the matching order.
  // `__extern_strict_eq` compares strings by content and answers 0 for any
  // non-string hint, so an unrecognised hint simply falls to the TypeError.
  fctx.body.push(
    ...hintIs("string"),
    ...hintIs("default"),
    { op: "i32.or" },
    { op: "local.tee", index: isStringHint },
    ...hintIs("number"),
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "local.get", index: isStringHint },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: literal("string"),
          // Only "number" reaches here: `__to_primitive` runs the valueOf-first
          // order for every non-"string" hint.
          else: [{ op: "ref.null.extern" }],
        },
        { op: "call", funcIdx: toPrimitiveIdx },
        { op: "local.tee", index: result },
        // §7.1.1.1 step 3 — OrdinaryToPrimitive throws when neither method
        // yielded a primitive. `__to_primitive` hands a closed-struct receiver
        // back UNCHANGED in that case (its own TypeError tail is only reached
        // for the open `$Object` carrier), so the object result is the signal.
        { op: "call", funcIdx: typeofObjectIdx },
        { op: "local.get", index: result },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: typeError("Cannot convert object to primitive value"),
        },
        { op: "local.get", index: result },
        { op: "return" },
      ],
    },
  );

  emitBrandCheckTypeError(ctx, fctx.body, "Date.prototype[Symbol.toPrimitive] called with an invalid hint");
  return { kind: "externref" };
}
