// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5156) §21.4.2.2 step 4 — the single-argument `new Date(value)` coercion,
 * for the standalone lane.
 *
 * The historical lowering compiled the argument straight to `f64`, which is
 * ToNumber. That is wrong twice:
 *
 *   - **A Date argument reads its [[DateValue]] slot directly**, with NO method
 *     call at all (step 4.a). `built-ins/Date/construct_with_date.js` poisons
 *     both `toString` and `valueOf` on the source Date and asserts the copy
 *     still works, so calling either is observable.
 *   - **Everything else runs ToPrimitive(value, default) FIRST** (step 4.b),
 *     which honours a user `@@toPrimitive` and passes it the hint string
 *     `"default"`. Only then does a String primitive parse as if by
 *     `Date.parse`, and any other primitive go through ToNumber.
 *
 * `__to_primitive` is the object runtime's own §7.1.1, so a user
 * `@@toPrimitive` — data or accessor — is found and invoked there rather than
 * re-implemented here.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { emitNativeDateParse } from "./date-parse-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

/** `new Date(<invalid>)`'s stored sentinel — the same i64 the ctor writes. */
const INVALID_DATE_SENTINEL = -9223372036854775808n;

/**
 * Emit `new Date(value)`'s argument as an `f64` millisecond count per
 * §21.4.2.2 step 4, leaving exactly that one value on the stack.
 *
 * Returns `false` — having emitted NOTHING — when the shape is one the historic
 * ToNumber lowering already handles (a statically numeric argument) or when the
 * object runtime cannot supply its helpers. The caller then keeps its previous
 * emission byte-for-byte.
 */
export function tryEmitStandaloneDateCtorValueArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  dateTypeIdx: number,
): boolean {
  if (!ctx.standalone) return false;
  // A statically numeric argument cannot carry a `@@toPrimitive`, a `valueOf`
  // override, or a [[DateValue]] slot: ToPrimitive is the identity on it, so
  // the direct `f64` compile is already the spec answer AND the cheap one.
  const staticTag = ctx.oracle.staticJsTypeOf(arg);
  if (staticTag === "number" || staticTag === "boolean") return false;

  ensureObjectRuntime(ctx);
  emitNativeDateParse(ctx);
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  const typeofStringIdx = ctx.funcMap.get("__typeof_string");
  const dateParseIdx = ctx.funcMap.get("__date_parse");
  if (
    toPrimitiveIdx === undefined ||
    unboxNumberIdx === undefined ||
    typeofStringIdx === undefined ||
    dateParseIdx === undefined
  ) {
    return false;
  }

  const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });

  const value = allocTempLocal(fctx, { kind: "externref" });
  const primitive = allocTempLocal(fctx, { kind: "externref" });
  const slot = allocTempLocal(fctx, { kind: "i64" });

  addStringConstantGlobal(ctx, "default");
  const defaultHint: Instr[] = [...stringConstantExternrefInstrs(ctx, "default")];

  // Step 4.a — a Date argument: copy [[DateValue]] without any method call.
  // The invalid sentinel must survive as NaN rather than becoming a huge
  // negative millisecond count.
  const readDateValue: Instr[] = [
    { op: "local.get", index: value },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: dateTypeIdx },
    { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
    { op: "local.tee", index: slot },
    { op: "i64.const", value: INVALID_DATE_SENTINEL },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: Number.NaN }],
      else: [{ op: "local.get", index: slot }, { op: "f64.convert_i64_s" }],
    },
  ];

  // Step 4.b — ToPrimitive(value, default), then String → Date.parse and every
  // other primitive → ToNumber.
  const coerceViaToPrimitive: Instr[] = [
    { op: "local.get", index: value },
    ...defaultHint,
    { op: "call", funcIdx: toPrimitiveIdx },
    { op: "local.tee", index: primitive },
    { op: "call", funcIdx: typeofStringIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: primitive },
        { op: "call", funcIdx: dateParseIdx },
      ],
      else: [
        { op: "local.get", index: primitive },
        { op: "call", funcIdx: unboxNumberIdx },
      ],
    },
  ];

  fctx.body.push(
    { op: "local.tee", index: value },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dateTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: readDateValue,
      else: coerceViaToPrimitive,
    },
  );

  releaseTempLocal(fctx, slot);
  releaseTempLocal(fctx, primitive);
  releaseTempLocal(fctx, value);
  return true;
}
