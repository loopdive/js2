// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4446) Wasm-native `Array.prototype.concat` for DYNAMIC operands — the
 * ECMA-262 §23.1.3.1 spec loop used by every target whose semantic provider is
 * `native-first` (`--target standalone` / `--target wasi` / an explicit
 * `semanticProviders: "native-first"` gc build).
 *
 * Extracted into its own module rather than added to `array-methods.ts`: that
 * file is a tracked god-file (`check:loc-budget` / `check:godfiles`), and the
 * gate's own advice is to put new code in a subsystem module. `array-methods.ts`
 * keeps only the two dispatch decisions that choose between this lowering and
 * the JS-host `__array_concat_any` bridge.
 *
 * `compileExpression` is imported from `./shared.js`, NOT `./expressions.js`,
 * for the same circular-dependency reason `array-methods.ts` documents.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitToBoolean } from "./coercion-engine.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/**
 * (#4446) Well-known `@@isConcatSpreadable` symbol handle — the id the object
 * runtime's native `$Symbol` carrier interns for `Symbol.isConcatSpreadable`
 * (mirrors `WELL_KNOWN_SYMBOLS` in literals.ts / builtin-value-read.ts).
 */
const SYMBOL_IS_CONCAT_SPREADABLE_ID = 6;

/** §23.1.3.1 step 5.c.iii — the 2^53-1 result-length ceiling. */
const MAX_SAFE_LENGTH = 9007199254740991;

/**
 * (#4446) Native, host-free `Array.prototype.concat` — the §23.1.3.1 spec loop
 * over DYNAMIC operands, for every target whose semantic provider is
 * `native-first` (`--target standalone` / `--target wasi` / an explicit
 * `semanticProviders: "native-first"` gc build).
 *
 * The JS-host fallback (`compileArrayConcatExternHost` in array-methods.ts)
 * delegates the
 * whole operation to `env::__array_concat_any` (plus `env::__js_array_new` /
 * `env::__js_array_push` for the argument list). Those are unsatisfiable
 * `env::*` imports host-free, so the #2961 strict leak guard turned every
 * dynamic-operand concat into a standalone compile error — ~28 of the 69
 * `built-ins/Array/prototype/concat` test262 files.
 *
 * This lowering walks the spec loop directly over the dynamic-object substrate
 * that the generic `Array.prototype.*` array-like paths (#1359/#1461) already
 * use, so no second dyn-array ABI is introduced:
 *
 * ```
 *   out = __objvec_new()                       // ArraySpeciesCreate(O, 0) — see below
 *   n   = 0
 *   for E in [receiver, ...args]:
 *     spreadable = IsConcatSpreadable(E):
 *       v = __extern_get(E, __box_symbol(@@isConcatSpreadable))
 *       v is null/undefined ? __extern_is_array(E) : ToBoolean(v)   // __is_truthy
 *     if spreadable:
 *       len = __extern_length(E)               // Get(E,"length") + ToLength (§7.1.20),
 *                                              // incl. the observable valueOf/toString
 *                                              // walk and its abrupt propagation
 *       if n + len > 2^53-1: throw TypeError   // step 5.c.iii
 *       for i in 0 .. len: __objvec_push(out, __extern_get_idx(E, i))
 *       n += len
 *     else:
 *       __objvec_push(out, E); n += 1
 *   return out                                  // a Wasm-owned $ObjVec — a real Array
 * ```
 *
 * Two deliberate under-approximations, both measured and recorded on #4446:
 *
 * - **ArraySpeciesCreate** is a plain `$ObjVec`, not a species-derived
 *   constructor call. The `create-species-*` bucket is a separate (already
 *   failing, not regressed) concern that needs the species protocol on the
 *   native constructor channel.
 * - **Holes are not preserved.** `$ObjVec` has no hole representation, so a
 *   skipped index materialises as `undefined` rather than an absent property.
 *   The VALUES are spec-correct (`Get` of an absent index is `undefined`, which
 *   is exactly what `__extern_get_idx` answers), so `compareArray`-style tests
 *   pass; only a `hasOwnProperty` probe on the result could tell the difference.
 *   That is why the loop does NOT gate on `__extern_has_idx`: the gate would buy
 *   nothing here and would actively DROP legitimately-present `null` elements
 *   (`__extern_has_idx` answers 0 for a field holding the externref null —
 *   see the #1382 note in array-prototype-borrow.ts).
 *
 * Returns `undefined` (nothing emitted) when the substrate is unavailable, so
 * the caller falls back to the host bridge unchanged.
 */
export function compileArrayConcatNativeSpec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null | undefined {
  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };

  const builders = ensureObjVecBuilders(ctx);
  // Register every helper BEFORE resolving any index; each of these is a
  // DEFINED native under the native-first provider, so a later registration
  // shifts the ones already resolved (the #2043 late-shift class). Every
  // per-operand emission below re-resolves by NAME after its own
  // `compileExpression`, which is the only other shift source in this body.
  ensureLateImport(ctx, "__extern_length", [externref], [f64]);
  ensureLateImport(ctx, "__extern_get_idx", [externref, f64], [externref]);
  ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  ensureLateImport(ctx, "__extern_is_array", [externref], [i32]);
  ensureLateImport(ctx, "__extern_is_undefined", [externref], [i32]);
  ensureLateImport(ctx, "__box_symbol", [i32], [externref]);
  ensureLateImport(ctx, "__is_truthy", [externref], [i32]);
  flushLateImportShifts(ctx, fctx);

  const required = [
    "__extern_length",
    "__extern_get_idx",
    "__extern_get",
    "__extern_is_array",
    "__extern_is_undefined",
    "__box_symbol",
    "__is_truthy",
  ];
  if (required.some((name) => ctx.funcMap.get(name) === undefined)) return undefined;

  const out = allocLocal(fctx, `__cat_spec_out_${fctx.locals.length}`, externref);
  const src = allocLocal(fctx, `__cat_spec_src_${fctx.locals.length}`, externref);
  const spv = allocLocal(fctx, `__cat_spec_spv_${fctx.locals.length}`, externref);
  const flag = allocLocal(fctx, `__cat_spec_flag_${fctx.locals.length}`, i32);
  const lenF = allocLocal(fctx, `__cat_spec_lenf_${fctx.locals.length}`, f64);
  const len = allocLocal(fctx, `__cat_spec_len_${fctx.locals.length}`, i32);
  const idx = allocLocal(fctx, `__cat_spec_i_${fctx.locals.length}`, i32);
  const total = allocLocal(fctx, `__cat_spec_n_${fctx.locals.length}`, f64);

  // out = ArraySpeciesCreate(O, 0) ≈ a fresh $ObjVec ; n = 0
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? builders.newIdx });
  fctx.body.push({ op: "local.set", index: out });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "local.set", index: total });

  for (const sourceExpr of [propAccess.expression, ...callExpr.arguments]) {
    const sourceType = compileExpression(ctx, fctx, sourceExpr, externref);
    if (sourceType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (sourceType.kind !== "externref") coerceType(ctx, fctx, sourceType, externref);
    fctx.body.push({ op: "local.set", index: src });

    // Build the overflow throw BEFORE resolving the helper indices: it can add
    // the `__new_TypeError` late import and a string-constant global, and it
    // flushes against `fctx.body` itself. Everything resolved after this point
    // is therefore stable for the rest of this operand's emission.
    const overflowThrow = buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      "Array.prototype.concat: resulting array length exceeds 2^53-1",
      { flush: fctx },
    );

    const pushIdx = ctx.funcMap.get("__objvec_push") ?? builders.pushIdx;
    const externLenIdx = ctx.funcMap.get("__extern_length")!;
    const getIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
    const externGetIdx = ctx.funcMap.get("__extern_get")!;
    const isArrayIdx = ctx.funcMap.get("__extern_is_array")!;
    const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined")!;
    const boxSymbolIdx = ctx.funcMap.get("__box_symbol")!;

    // ── IsConcatSpreadable(E) (§23.1.3.1.1) ──────────────────────────────
    // spv = Get(E, @@isConcatSpreadable); a null/undefined answer (which also
    // covers every non-Object E, whose reflective read misses) falls back to
    // IsArray(E), otherwise ToBoolean(spv).
    fctx.body.push({ op: "local.get", index: src });
    fctx.body.push({ op: "i32.const", value: SYMBOL_IS_CONCAT_SPREADABLE_ID });
    fctx.body.push({ op: "call", funcIdx: boxSymbolIdx });
    fctx.body.push({ op: "call", funcIdx: externGetIdx });
    fctx.body.push({ op: "local.tee", index: spv });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "local.get", index: spv });
    fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
    fctx.body.push({ op: "i32.or" });
    const toBool: Instr[] = [{ op: "local.get", index: spv }];
    emitToBoolean(ctx, externref, toBool);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: src },
        { op: "call", funcIdx: isArrayIdx },
      ],
      else: toBool,
    });
    fctx.body.push({ op: "local.set", index: flag });

    // ── Spreadable arm: append E's 0..ToLength(E.length) elements ─────────
    const spreadArm: Instr[] = [
      { op: "local.get", index: src },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: lenF },
      // step 5.c.iii — n + len > 2^53-1 ⇒ TypeError. Load-bearing beyond
      // conformance: it is what keeps `length = Number.MAX_SAFE_INTEGER`
      // (arg-length-exceeding-integer-limit.js) from entering a 2^31-iteration
      // copy loop after the i32 truncation below.
      { op: "local.get", index: total },
      { op: "local.get", index: lenF },
      { op: "f64.add" },
      { op: "f64.const", value: MAX_SAFE_LENGTH },
      { op: "f64.gt" },
      { op: "if", blockType: { kind: "empty" }, then: overflowThrow },
      { op: "local.get", index: total },
      { op: "local.get", index: lenF },
      { op: "f64.add" },
      { op: "local.set", index: total },
      { op: "local.get", index: lenF },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.set", index: len },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: idx },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: idx },
              { op: "local.get", index: len },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: out },
              { op: "local.get", index: src },
              { op: "local.get", index: idx },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: getIdxIdx },
              { op: "call", funcIdx: pushIdx },
              { op: "local.get", index: idx },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: idx },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];

    // ── Non-spreadable arm: append E itself ──────────────────────────────
    const singleArm: Instr[] = [
      { op: "local.get", index: out },
      { op: "local.get", index: src },
      { op: "call", funcIdx: pushIdx },
      { op: "local.get", index: total },
      { op: "f64.const", value: 1 },
      { op: "f64.add" },
      { op: "local.set", index: total },
    ];

    fctx.body.push({ op: "local.get", index: flag });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: spreadArm, else: singleArm });
  }

  fctx.body.push({ op: "local.get", index: out });
  return { kind: "externref" };
}
