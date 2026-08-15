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
 * Closure ABI: `this` = param 1, args at params 2… (the closure is sized to
 * `STRING_PROTO_METHOD_PARAM_SLOTS.concat` slots; the call path pads absent
 * args with null and truncates extras — see native-proto.ts). §22.1.3.5 step 3
 * appends only the args ACTUALLY passed, so a null pad is skipped, while the
 * canonical standalone `undefined` (a distinct non-null sentinel under the
 * #2106 singleton regime) correctly stringifies to "undefined"
 * (S15.5.4.6_A4_T1's `concat("two", x)` with `x` undefined → "onetwoundefined").
 * Calls with more args than the slot count silently drop the tail — the
 * 128-argument S15.5.4.6_A2 stays failing (documented residual), everything
 * ES5-shaped fits.
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
  const emitToStringOnto = (paramIdx: number): void => {
    if (ctx.symbolTypeIdx >= 0) {
      const symbolThrow = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
        flush: fctx,
      });
      fctx.body.push(
        { op: "local.get", index: paramIdx },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: symbolThrow, else: [] },
      );
    }
    fctx.body.push(
      { op: "local.get", index: paramIdx },
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
  emitToStringOnto(1);
  fctx.body.push({ op: "local.set", index: accLocal });

  // (3) For each padded arg slot: a null pad means "not passed" → skip
  // (§22.1.3.5 step 3 walks only the actual argument list); anything non-null
  // (including the undefined sentinel) is ToString'd and appended.
  for (let paramIdx = 2; paramIdx < fctx.params.length; paramIdx++) {
    const appendInstrs: Instr[] = [];
    const saved = fctx.body;
    fctx.body = appendInstrs;
    fctx.body.push({ op: "local.get", index: accLocal });
    emitToStringOnto(paramIdx);
    fctx.body.push({ op: "call", funcIdx: concatIdx }, { op: "local.set", index: accLocal });
    fctx.body = saved;
    fctx.body.push(
      { op: "local.get", index: paramIdx },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [], else: appendInstrs },
    );
  }

  fctx.body.push({ op: "local.get", index: accLocal }, { op: "extern.convert_any" });
  return { kind: "externref" };
}
