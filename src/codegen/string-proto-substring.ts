// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { ensureExternrefToNumberProvider, getToPrimitiveProvider } from "./coercion-engine.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { flushLateImportShifts } from "./shared.js";

function emitRefusal(ctx: CodegenContext, fctx: FunctionContext): null {
  emitThrowTypeError(ctx, fctx, "String.prototype.substring is not yet implemented in --target standalone");
  return null;
}

function emitRequireObjectCoercible(ctx: CodegenContext, fctx: FunctionContext): void {
  const rocThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, rocThrow, "String.prototype.substring called on null or undefined");
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rocThrow });
}

function unboxBoundToI32(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): number {
  const local = allocLocal(fctx, `__pm_arg_${fctx.locals.length}`, { kind: "i32" });
  const unboxIdx = ensureExternrefToNumberProvider(ctx, fctx);
  fctx.body.push({ op: "local.get", index: paramIdx });
  if (unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "drop" }, { op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: local });
  return local;
}

/**
 * Native body for a reflective `String.prototype.substring` closure.
 * Closure ABI: `this` = param 1, start = param 2, end = param 3. The body
 * preserves receiver/bound coercion order and delegates clamping plus swapped
 * bounds to the existing native substring core.
 */
export function emitStringSubstringMemberBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx);
  if (undefinedSingletonActive(ctx)) flushLateImportShifts(ctx, fctx);

  // Register the only late import before fetching helper indices. Bound
  // conversions happen after ToString(this), preserving observable order.
  ensureExternrefToNumberProvider(ctx, fctx);

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const toPrimitiveIdx = getToPrimitiveProvider(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  if (toPrimitiveIdx === undefined || flattenIdx === undefined || substringIdx === undefined) {
    return emitRefusal(ctx, fctx);
  }

  emitRequireObjectCoercible(ctx, fctx);

  // The abstract ToString operation rejects Symbols, unlike the printable
  // fallback intentionally provided by __any_to_string.
  if (ctx.symbolTypeIdx >= 0) {
    const symbolThrow = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
      flush: fctx,
    });
    fctx.body.push(
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: symbolThrow, else: [] },
    );
  }
  fctx.body.push({ op: "local.get", index: 1 });
  addStringConstantGlobal(ctx, "string");
  fctx.body.push(
    ...stringConstantExternrefInstrs(ctx, "string"),
    { op: "call", funcIdx: toPrimitiveIdx },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: anyToStrIdx },
    { op: "call", funcIdx: flattenIdx },
  );
  const flatLocal = allocLocal(fctx, `__str_pm_substring_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: flatLocal });

  const startLocal = unboxBoundToI32(ctx, fctx, 2);
  const endLocal = unboxBoundToI32(ctx, fctx, 3);

  // The reflective ABI pads an omitted end with null; canonical standalone
  // undefined is a distinct sentinel, so recognize both.
  fctx.body.push({ op: "local.get", index: 3 }, { op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 3 }, { op: "call", funcIdx: isUndefIdx }, { op: "i32.or" });
  }
  fctx.body.push(
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0x7fffffff }],
      else: [{ op: "local.get", index: endLocal }],
    },
    { op: "local.set", index: endLocal },
    { op: "local.get", index: flatLocal },
    { op: "local.get", index: startLocal },
    { op: "local.get", index: endLocal },
    { op: "call", funcIdx: substringIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
