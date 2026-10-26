// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 module-init lever B) `__ir_number_from_value(externref) -> f64` — the
 * host-free provider of the IR's `js.number.from-value` intrinsic (`Number(v)`
 * under the source-bound conversion plan, `lowerPreparedNumberCall`).
 *
 * It is legacy's own `Number(v)` emission (`call-identifier.ts`: the symbol
 * guard, StringToNumber, the array and object ToPrimitive arms, the ToNumber
 * cascade), compiled once over a detached template whose only free name is
 * its externref parameter — the dynamic carrier of these lanes, legacy's
 * `any`. The intrinsic's contract (full ToNumeric with observable effects) is
 * therefore legacy's by construction. The helper context and publication are
 * `ir-helper-function.ts`'s (shared with every IR wrapper); the detached parse
 * is `template-wrapper.ts`'s.
 */
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { IR_NUMBER_FROM_VALUE_NATIVE_FN } from "../../ir/runtime/number-conversion-callable.js";
import { compileExpression, flushLateImportShifts } from "../shared.js";
import { coerceType } from "../type-coercion.js";
import { noJsHost } from "../js-errors.js";
import { helperFunctionContext, publishHelperFunction } from "./ir-helper-function.js";
import { parseDetachedTemplate } from "./template-wrapper.js";

const VALUE_PARAM = "__ir_nfv_value";

/** The lanes with this provider: host-free, non-fast (legacy's `any` is externref there). */
export function irNumberFromValueProviderLane(ctx: CodegenContext): boolean {
  return noJsHost(ctx) && !ctx.fast;
}

/**
 * Reserve the provider once. Returns its function index, or undefined off the
 * provider lanes or when legacy's emitter reports an error for the template
 * (its diagnostics are dropped).
 */
export function ensureIrNumberFromValueHelper(ctx: CodegenContext): number | undefined {
  if (!irNumberFromValueProviderLane(ctx)) return undefined;
  const existing = ctx.funcMap.get(IR_NUMBER_FROM_VALUE_NATIVE_FN);
  if (existing !== undefined) return existing;

  const externref: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };
  const helper = helperFunctionContext(IR_NUMBER_FROM_VALUE_NATIVE_FN, [{ name: VALUE_PARAM, type: externref }], f64);
  const [conversion] = parseDetachedTemplate(
    "__ir_number_from_value.js",
    `function __ir_nfv(${VALUE_PARAM}) {\n  Number(${VALUE_PARAM});\n}`,
    1,
  );
  const errorsBefore = ctx.errors.length;
  const result = compileExpression(ctx, helper, conversion!, f64);
  if (ctx.errors.length !== errorsBefore || result === null) {
    ctx.errors.length = errorsBefore;
    return undefined;
  }
  if (result.kind !== "f64") coerceType(ctx, helper, result, f64);
  flushLateImportShifts(ctx, helper);
  return publishHelperFunction(ctx, helper);
}
