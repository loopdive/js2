// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T6) `String.fromCharCode` as a first-class, CALLABLE value in
 * `--target standalone`.
 *
 * `var f = String.fromCharCode; f(65, 66, 66, 65)` (test262
 * `built-ins/String/fromCharCode/S15.5.3.2_A3_T2`) needs a reified closure whose
 * BODY actually builds the string. The generic `default:` arm of
 * `ensureStandaloneBuiltinStaticMethodClosure` reifies at the DECLARED arity
 * (one), so a four-argument call matches no funcref candidate and the guarded
 * `ref.cast` yields null — the failure arrives from the DISPATCH and the body
 * never runs.
 *
 * This module owns the variadic body. It follows the #2933 `Math.max`/`Math.min`
 * convention exactly: ONE `(ref null $vec_externref)` args parameter carrying
 * every call-site argument, and an `externref` result. That makes all three
 * share ONE lifted func type, so the single `ref.test` arm in
 * `call-identifier.ts` serves them all and `call_ref` picks the right body from
 * the funcref value.
 *
 * Per element: `__any_from_extern` → `__any_to_f64` (the engine ToNumber
 * pipeline — no hand-rolled coercion matrix), then §7.1.8 ToUint16 in the f64
 * domain BEFORE the i32 conversion (NaN/±Inf → 0; |x| ≥ 2^31 keeps its true
 * modulo — a bare `trunc_sat` saturates first and gets both wrong), then the
 * pure-Wasm `__str_fromCharCode` one-char helper folded left-to-right with
 * `__str_concat`. Zero arguments yield `""` (§22.1.2.1 empty code-unit list).
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { nativeStringRepr } from "./builtin-scaffold.js";
import { ensureAnyFromExternHelper, ensureAnyHelpers } from "./any-helpers.js";

/**
 * Builtin statics reified with the #2933 VARIADIC value-closure convention
 * (one `(ref null $vec_externref)` args param → `externref`).
 *
 * Load-bearing at the CALL site, not just the value read: the TypeScript lib
 * signature for each of these is a REST parameter (`...values: number[]` /
 * `...codes: number[]`), and the generic slot-by-slot argument loop compiles
 * call-site argument 0 against that single `number[]` vec slot — the guarded
 * cast NULLS it. Measured on the pre-fix base: `var n = Math.min; n(4,2,9)`
 * answered `0` and `var m = Math.max; m(5)` answered `0`, because argument 0
 * was destroyed and only arguments 1..k survived through the separately-boxed
 * extras path. So `Math.max` "working" as a value was a numeric accident of
 * that mis-compiled slot, not a working reference.
 */
export const VARIADIC_VALUE_STATICS: ReadonlySet<string> = new Set(["Math.max", "Math.min", "String.fromCharCode"]);

/** True when `<builtinName>.<propName>` reifies with the variadic convention. */
export function isVariadicValueStatic(builtinName: string, propName: string): boolean {
  return VARIADIC_VALUE_STATICS.has(`${builtinName}.${propName}`);
}

/**
 * Pre-register every native the `String.fromCharCode` variadic body needs,
 * BEFORE the wrapper/func creation (a first registration mid-body desyncs
 * codegen — #2704). Returns false when the substrate is unavailable, in which
 * case the caller degrades to the generic catchable-TypeError body (identity
 * and reflective `.name`/`.length` still hold).
 */
export function prepareStringFromCharCodeValueRead(ctx: CodegenContext): boolean {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return false;
  ensureNativeStringHelpers(ctx);
  if (nativeStringRepr(ctx) === undefined) return false;
  if (ctx.nativeStrHelpers.get("__str_fromCharCode") === undefined) return false;
  if (ensureAnyFromExternHelper(ctx) === undefined) return false;
  ensureAnyHelpers(ctx); // __any_to_f64
  return (
    ctx.funcMap.get("__any_from_extern") !== undefined &&
    ctx.funcMap.get("__any_to_f64") !== undefined &&
    ctx.anyStrTypeIdx >= 0
  );
}

/**
 * Emit the variadic `String.fromCharCode` closure body.
 *
 * Closure params: 0 = self, 1 = argsVec `(ref null $vec_externref)` whose
 * field 0 is the i32 length and field 1 the externref backing array. Leaves one
 * `externref` (the native `$AnyString` result carried across the any-call
 * boundary via `extern.convert_any`).
 *
 * Returns false when a required native is missing — the caller then declines
 * the whole closure rather than emitting a half-built body.
 */
export function emitStringFromCharCodeValueBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTypeIdx: number,
  arrTypeIdx: number,
): boolean {
  const repr = nativeStringRepr(ctx);
  const fromCharIdx = ctx.nativeStrHelpers.get("__str_fromCharCode");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const fromExternIdx = ctx.funcMap.get("__any_from_extern");
  const toF64Idx = ctx.funcMap.get("__any_to_f64");
  if (
    repr === undefined ||
    fromCharIdx === undefined ||
    concatIdx === undefined ||
    fromExternIdx === undefined ||
    toF64Idx === undefined ||
    arrTypeIdx < 0
  ) {
    return false;
  }
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const accType: ValType = repr.resultType;

  const iLocal = allocLocal(fctx, "fcc_i", { kind: "i32" });
  const nLocal = allocLocal(fctx, "fcc_n", { kind: "i32" });
  const accLocal = allocLocal(fctx, "fcc_acc", accType);
  const arrLocal = allocLocal(fctx, "fcc_arr", { kind: "ref_null", typeIdx: arrTypeIdx });
  const codeLocal = allocLocal(fctx, "fcc_code", { kind: "f64" });

  // acc = ""
  fctx.body.push(...repr.literal(""));
  fctx.body.push({ op: "local.set", index: accLocal });

  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: nLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    // acc (left operand of __str_concat)
    { op: "local.get", index: accLocal },
    // element → f64 through the engine ToNumber pipeline
    { op: "local.get", index: arrLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: iLocal },
    { op: "array.get", typeIdx: arrTypeIdx },
    { op: "call", funcIdx: fromExternIdx },
    { op: "call", funcIdx: toF64Idx },
    // §7.1.8 ToUint16 in the f64 domain (NaN/±Inf → 0; true modulo for |x| ≥ 2^31).
    { op: "f64.trunc" },
    { op: "local.tee", index: codeLocal },
    { op: "local.get", index: codeLocal },
    { op: "f64.const", value: 65536 },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "f64.const", value: 65536 },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "i32.trunc_sat_f64_s" },
    // one-char native string, widened to $AnyString for __str_concat
    { op: "call", funcIdx: fromCharIdx },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: accLocal },
    { op: "local.get", index: iLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iLocal },
    { op: "br", depth: 0 },
  ];

  fctx.body.push(
    // argsVec null → empty code-unit list → ""
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: nLocal },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: arrLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
        },
      ],
    },
    { op: "local.get", index: accLocal },
    { op: "extern.convert_any" },
  );
  return true;
}
