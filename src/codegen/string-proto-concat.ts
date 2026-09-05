// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native body for a reflective `String.prototype.concat` closure (§22.1.3.5) —
 * retires the standalone refusal
 * `String.prototype.concat is not yet implemented in --target standalone`
 * for the borrowed-method shape (`obj.concat = String.prototype.concat`,
 * test262 S15.5.4.6_A1_T1/T2/T10, A4_T1). The DIRECT `"a".concat(b)` call on a
 * string-typed receiver never reaches this body — it lowers through the native
 * string method dispatch in string-ops.ts and already works.
 *
 * Closure ABI: `this` = param 1, complete argument list = the canonical
 * `(ref null $vec_externref)` at param 2. Keeping the vector length separate
 * from the closure's spec `.length` preserves omitted-vs-explicit-undefined
 * and allows the unbounded argument list required by §22.1.3.5.
 *
 * Follows the sibling reflective-body discipline (string-proto-substring.ts):
 * every late-import-adding op runs FIRST, helper funcIdxs are fetched by name
 * AFTER the flush, and ToString goes ToPrimitive("string")-first through the
 * shared `$__any_to_string` walker. The result stays a cons `$AnyString`
 * (no flatten — `__str_concat` builds/accepts cons nodes) and crosses the
 * closure boundary as externref like every sibling.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { getToPrimitiveProvider } from "./coercion-engine.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { flushLateImportShifts } from "./shared.js";
import type { Instr } from "../ir/types.js";

export function emitStringConcatMemberBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx); // registers `__extern_is_undefined` + `__to_primitive`
  if (undefinedSingletonActive(ctx)) flushLateImportShifts(ctx, fctx);

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const toPrimitiveIdx = getToPrimitiveProvider(ctx);
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (toPrimitiveIdx === undefined || concatIdx === undefined || ctx.anyStrTypeIdx < 0) {
    emitThrowTypeError(ctx, fctx, "String.prototype.concat is not yet implemented in --target standalone");
    return null;
  }

  // (1) ? RequireObjectCoercible(this) [param 1] — null OR the undefined
  // sentinel throws a catchable TypeError (the sibling-body pattern).
  const rocThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, rocThrow, "String.prototype.concat called on null or undefined");
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rocThrow });

  // (2) R = ? ToString(this) — ToPrimitive("string") first, Symbol rejected.
  addStringConstantGlobal(ctx, "string");
  const emitToStringValue = (emitValue: () => void): void => {
    if (ctx.symbolTypeIdx >= 0) {
      const symbolThrow = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
        flush: fctx,
      });
      emitValue();
      fctx.body.push(
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: symbolThrow, else: [] },
      );
    }
    emitValue();
    fctx.body.push(
      ...stringConstantExternrefInstrs(ctx, "string"),
      { op: "call", funcIdx: toPrimitiveIdx },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStrIdx },
    );
  };

  const accLocal = allocLocal(fctx, `__str_concat_acc_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.anyStrTypeIdx,
  });
  emitToStringValue(() => fctx.body.push({ op: "local.get", index: 1 }));
  fctx.body.push({ op: "local.set", index: accLocal });

  // (3) Append every actually supplied argument. The vector is null only for
  // an empty argument list; explicit `undefined` remains its non-null singleton.
  const argsParam = fctx.params[2]?.type;
  if (!argsParam || (argsParam.kind !== "ref" && argsParam.kind !== "ref_null")) return null;
  const argsArrTypeIdx = getArrTypeIdxFromVec(ctx, argsParam.typeIdx);
  const argsArrDef = ctx.mod.types[argsArrTypeIdx];
  if (argsArrDef?.kind !== "array" || argsArrDef.element.kind !== "externref") return null;
  const argsData = allocLocal(fctx, `__str_concat_args_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: argsArrTypeIdx,
  });
  const argsLen = allocLocal(fctx, `__str_concat_args_len_${fctx.locals.length}`, { kind: "i32" });
  const argsIdx = allocLocal(fctx, `__str_concat_args_i_${fctx.locals.length}`, { kind: "i32" });
  const emitCurrentArg = (): void => {
    fctx.body.push(
      { op: "local.get", index: argsData },
      { op: "ref.as_non_null" },
      { op: "local.get", index: argsIdx },
      { op: "array.get", typeIdx: argsArrTypeIdx },
    );
  };
  const appendCurrent: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = appendCurrent;
  fctx.body.push({ op: "local.get", index: accLocal });
  emitToStringValue(emitCurrentArg);
  fctx.body.push({ op: "call", funcIdx: concatIdx }, { op: "local.set", index: accLocal });
  fctx.body = savedBody;

  fctx.body.push({ op: "local.get", index: 2 }, { op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: argsParam.typeIdx, fieldIdx: 1 },
      { op: "local.set", index: argsData },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: argsParam.typeIdx, fieldIdx: 0 },
      { op: "local.set", index: argsLen },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: argsIdx },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: argsIdx },
              { op: "local.get", index: argsLen },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...appendCurrent,
              { op: "local.get", index: argsIdx },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: argsIdx },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ],
  });

  fctx.body.push({ op: "local.get", index: accLocal }, { op: "extern.convert_any" });
  return { kind: "externref" };
}
