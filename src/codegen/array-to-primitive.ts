/**
 * #2358 (#10 fold) — standalone Array → primitive (`Array.prototype.toString` =
 * `join(",")`) for the runtime `__to_primitive` engine.
 *
 * ## Why a reserve/fill driver
 *
 * `__to_primitive` (object-runtime.ts) only recognises the dynamic `$Object`
 * runtime struct via `ref.test objectTypeIdx`. A real array literal compiles to
 * a `__vec_<elemKind>` struct (subtyping the shared `$__vec_base` supertype);
 * when that vec is coerced to externref and handed to `__to_primitive` the
 * `ref.test objectTypeIdx` MISSES, so the array is returned unchanged and the
 * caller's `__unbox_number(array)` → NaN. That breaks `Number([1])`,
 * `"1,2" == [1,2]`, `1 + [2]`, etc. standalone.
 *
 * The fix routes a vec operand through `Array.prototype.toString` (`join(",")`)
 * inside `__to_primitive`'s `objectTypeIdx`-miss arm: `[42]` → `"42"` →
 * (the caller's hint then) `__str_to_number("42")` → 42.
 *
 * But the join needs `__extern_length` / `__extern_get_idx`, and those helpers
 * are registered AFTER `__to_primitive` in `ensureObjectRuntime`. So
 * `__to_primitive`'s arm can only `call` a RESERVED funcIdx: we reserve an
 * `__array_to_primitive_string` placeholder at `__to_primitive`-emit time (so
 * the call target is stable under the late-import funcIdx-shift machinery), and
 * fill the placeholder body in post-processing (`fillArrayToPrimitive`, after
 * `fillExternGetIdxVecArms`) once every dependency exists. Same reserve/fill
 * funcIdx-authority discipline as `reserveAccessorGetDriver` / the
 * `externGetIdxReserved` vec-arm fill (#2190).
 */

import type { CodegenContext } from "./context/types.js";
import type { Instr, WasmFunction, ValType } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)

export const ARRAY_TO_PRIMITIVE_STRING = "__array_to_primitive_string";

/**
 * Reserve the `__array_to_primitive_string(externref arr) -> externref`
 * placeholder and return its funcIdx. Body is a bare `unreachable` until
 * `fillArrayToPrimitive` patches it (after `__extern_length`/`__extern_get_idx`
 * are registered). Idempotent. Standalone only — the JS-host lane reduces arrays
 * via the host `__extern_toString` import, so this driver is never reached there.
 */
export function reserveArrayToPrimitiveString(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(ARRAY_TO_PRIMITIVE_STRING);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$array_to_primitive_string_type");
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name: ARRAY_TO_PRIMITIVE_STRING,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillArrayToPrimitive in post-processing. The bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (e.g. native string helpers unavailable).
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(ARRAY_TO_PRIMITIVE_STRING, funcIdx);
  ctx.arrayToPrimitiveReserved = true;
  return funcIdx;
}

/**
 * Fill the reserved `__array_to_primitive_string` body now that
 * `__extern_length` / `__extern_get_idx` / `$__any_to_string` / `__str_concat`
 * are all registered. Implements `Array.prototype.join(",")`:
 *
 *   result = ""                                   // empty native string
 *   len    = i32(__extern_length(arr))            // ToLength; non-array → 0 → ""
 *   for (i = 0; i < len; i++):
 *     if (i > 0) result = __str_concat(result, ",")
 *     elem = __extern_get_idx(arr, f64(i))        // externref (null for a hole)
 *     // §23.1.3.31: a null/undefined element stringifies to "" (NOT "null")
 *     if (elem != null) result = __str_concat(result, $__any_to_string(any(elem)))
 *   return extern.convert_any(result)
 *
 * No-op when the driver was not reserved or a dependency is missing — the
 * placeholder `unreachable` stays (unreachable from any live arm in that case).
 */
export function fillArrayToPrimitive(ctx: CodegenContext): void {
  if (!ctx.arrayToPrimitiveReserved) return;
  const driverIdx = ctx.funcMap.get(ARRAY_TO_PRIMITIVE_STRING);
  if (driverIdx === undefined) return;
  const fn = definedFuncAt(ctx, driverIdx);
  if (!fn) return;

  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const anyToStringIdx = ctx.nativeStrHelpers.get("__any_to_string") ?? ctx.funcMap.get("__any_to_string");
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (
    externLengthIdx === undefined ||
    externGetIdxIdx === undefined ||
    anyToStringIdx === undefined ||
    strConcatIdx === undefined ||
    ctx.anyStrTypeIdx < 0
  ) {
    return; // a dependency is unavailable — leave the unreachable stub.
  }
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Locals: 0=arr(externref param) ; 1=result(ref $AnyString) ; 2=len(i32) ;
  //         3=i(i32) ; 4=elem(externref)
  const L_ARR = 0;
  const L_RESULT = 1;
  const L_LEN = 2;
  const L_I = 3;
  const L_ELEM = 4;

  const emptyStr: Instr[] = nativeStringLiteralInstrs(ctx, "");
  const commaStr: Instr[] = nativeStringLiteralInstrs(ctx, ",");

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };

  const body: Instr[] = [
    // result = ""
    ...emptyStr,
    { op: "local.set", index: L_RESULT },
    // len = i32(ToLength(__extern_length(arr)))  — non-array → 0.0 → 0
    { op: "local.get", index: L_ARR },
    { op: "call", funcIdx: externLengthIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: L_LEN },
    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      // outer block (break target)
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if (i >= len) break
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 }, // → outer block end
            // if (i > 0) result = __str_concat(result, ",")
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 0 },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_RESULT },
                ...commaStr,
                { op: "call", funcIdx: strConcatIdx },
                { op: "local.set", index: L_RESULT },
              ],
            },
            // elem = __extern_get_idx(arr, f64(i))
            { op: "local.get", index: L_ARR },
            { op: "local.get", index: L_I },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "local.tee", index: L_ELEM },
            // §23.1.3.31: null/undefined element → "" (skip the concat).
            // (#2106 S1) under the singleton regime an undefined element is a
            // NON-null externref — test nullish, not bare null, or join would
            // render it as "undefined".
            ...(ctx.funcMap.has("__extern_is_nullish")
              ? ([{ op: "call", funcIdx: ctx.funcMap.get("__extern_is_nullish")! }] satisfies Instr[])
              : ([{ op: "ref.is_null" }] satisfies Instr[])),
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_RESULT },
                { op: "local.get", index: L_ELEM },
                { op: "any.convert_extern" },
                { op: "call", funcIdx: anyToStringIdx },
                { op: "call", funcIdx: strConcatIdx },
                { op: "local.set", index: L_RESULT },
              ],
            },
            // i++
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            // continue
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return extern.convert_any(result)
    { op: "local.get", index: L_RESULT },
    { op: "extern.convert_any" },
  ];

  fn.locals = [
    { name: "result", type: strRef },
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "elem", type: { kind: "externref" } },
  ];
  fn.body = body;
}
