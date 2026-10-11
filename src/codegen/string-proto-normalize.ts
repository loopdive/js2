// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native body for `String.prototype.normalize` and its shared form coercion.
 *
 * The Unicode algorithm itself lives in `normalize-native.ts`. This module
 * owns the observable String-prototype boundary: RequireObjectCoercible,
 * ToString, omitted/undefined form defaulting, and the RangeError form gate.
 * Keeping that boundary separate lets the direct syntax path and the
 * reflective `.call`/`.apply` closure share exactly one runtime form rule.
 */
import type { Instr, ValType } from "../ir/types.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { pushBody, popBody } from "./context/bodies.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers, flatStringType } from "./native-strings.js";
import {
  ensureNormalizeErrorSurface,
  ensureStrNormalize,
  emitNormalizeFormMode,
  NORMALIZE_NULLISH_RECEIVER_ERROR,
} from "./normalize-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";
import { flushLateImportShifts } from "./shared.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/**
 * Emit NormalizeString's strict ToString boundary for an already staged
 * externref. In particular, an object whose ToPrimitive result is a Symbol
 * must throw TypeError rather than flow into the generic printable renderer.
 * Callers must have provisioned {@link ensureNormalizeErrorSurface} first.
 */
export function emitNormalizeToFlatString(ctx: CodegenContext, fctx: FunctionContext, valueLocal: number): boolean {
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (anyToStrIdx === undefined || flattenIdx === undefined) return false;
  emitStringProtoToStringFlat(ctx, fctx, valueLocal, anyToStrIdx, flattenIdx, {
    rejectPostPrimitiveSymbol: true,
  });
  return true;
}

/**
 * Direct native calls stage their receiver before argument evaluation, so they
 * need the same RequireObjectCoercible guard as the reflective closure body.
 * The caller has already made the staged value an externref and installed the
 * native undefined predicate through {@link ensureObjectRuntime}.
 */
export function emitNormalizeRequireObjectCoercible(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverLocal: number,
): boolean {
  const tracksUndefined = undefinedSingletonActive(ctx);
  if (tracksUndefined && ctx.funcMap.get("__extern_is_undefined") === undefined) return false;
  const throwNullish = buildThrowJsErrorInstrs(ctx, "TypeError", NORMALIZE_NULLISH_RECEIVER_ERROR, {
    flush: fctx,
    forceInModuleCtor: true,
  });
  // The constructor builder above may settle a late-import batch; resolve the
  // predicate afterwards rather than retaining a pre-flush numeric index.
  const isUndefinedIdx = tracksUndefined ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (tracksUndefined && isUndefinedIdx === undefined) return false;
  fctx.body.push({ op: "local.get", index: receiverLocal }, { op: "ref.is_null" });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push(
      { op: "local.get", index: receiverLocal },
      { op: "call", funcIdx: isUndefinedIdx },
      { op: "i32.or" },
    );
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwNullish });
  return true;
}

/**
 * Emit NormalizeString's form operation for an already evaluated externref.
 *
 * `undefined` is the sole defaulting value (NFC / mode 0); explicit `null`
 * reaches the ToString branch and therefore becomes `"null"`, which then
 * throws RangeError. The caller must have installed `__extern_is_undefined`
 * before calling this helper.
 */
export function emitNormalizeFormModeFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  formLocal: number,
): number | undefined {
  // Resolve every helper at the call boundary, after callers have evaluated
  // their receiver and argument expressions. Those expressions may provision
  // late imports, so a handle captured in the caller cannot be trusted here.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (anyToStrIdx === undefined || flattenIdx === undefined || ctx.funcMap.get("__extern_is_undefined") === undefined)
    return undefined;
  const modeLocal = allocLocal(fctx, `__normalize_mode_${fctx.locals.length}`, { kind: "i32" });
  const flatFormLocal = allocLocal(fctx, `__normalize_form_${fctx.locals.length}`, flatStringType(ctx));

  // Build the non-undefined arm in a tracked nested body. Form validation can
  // provision a RangeError constructor; `pushBody` keeps this arm visible to
  // the late-import shifter while that happens.
  const outer = pushBody(fctx);
  emitStringProtoToStringFlat(ctx, fctx, formLocal, anyToStrIdx, flattenIdx, {
    rejectPostPrimitiveSymbol: true,
  });
  fctx.body.push({ op: "local.set", index: flatFormLocal });
  const emitted = emitNormalizeFormMode(ctx, fctx, flatFormLocal);
  const nonUndefined: Instr[] = fctx.body;
  popBody(fctx, outer);
  if (!emitted) return undefined;

  // `emitNormalizeFormMode` can provision the RangeError path while it builds
  // the nested arm. Resolve the predicate only after that final producer.
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (isUndefinedIdx === undefined) return undefined;

  fctx.body.push(
    { op: "local.get", index: formLocal },
    { op: "call", funcIdx: isUndefinedIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }], // NFC
      else: nonUndefined,
    },
    { op: "local.set", index: modeLocal },
  );
  return modeLocal;
}

/**
 * Reflective `String.prototype.normalize` closure body. Its ABI is
 * `(self, thisValue, form)`; the extra `form` slot is intentional even though
 * the builtin's advertised `.length` remains zero.
 */
export function emitStringNormalizeMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  emitRequireObjectCoercible: () => void,
): ValType | null {
  // Host/native-first output retains its existing bridge. This body owns only
  // no-JS-host standalone/WASI semantics.
  if (!(ctx.standalone || ctx.wasi) || !ctx.nativeStrings) return null;

  // Complete every import-capable prerequisite before taking helper handles.
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx); // installs __extern_is_undefined
  flushLateImportShifts(ctx, fctx);
  ensureNormalizeErrorSurface(ctx, fctx);

  const normalizeIdx = ensureStrNormalize(ctx);
  if (normalizeIdx === undefined) return null;

  emitRequireObjectCoercible();

  // S = ? ToString(this), preserving the Symbol-after-ToPrimitive TypeError
  // required by NormalizeString's ToString operation.
  if (!emitNormalizeToFlatString(ctx, fctx, 1)) return null;
  const subjectLocal = allocLocal(fctx, `__normalize_subject_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: subjectLocal });

  const modeLocal = emitNormalizeFormModeFromExternref(ctx, fctx, 2);
  if (modeLocal === undefined) return null;

  // The form body was constructed after all prerequisites, but resolve the
  // normalizer one last time at the actual call boundary rather than carrying
  // a capture across nested error-body construction.
  const finalNormalizeIdx = ctx.nativeStrHelpers.get("__str_normalize");
  if (finalNormalizeIdx === undefined) return null;

  fctx.body.push(
    { op: "local.get", index: subjectLocal },
    { op: "local.get", index: modeLocal },
    { op: "call", funcIdx: finalNormalizeIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
