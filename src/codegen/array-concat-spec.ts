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
import { ensureHoleType, holeSentinelInstrs } from "./array-holes.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { emitArraySpeciesCreate, emitArraySpeciesResultSwap, prepareArraySpeciesDeps } from "./array-species.js"; // (#5145)

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
 * - **Holes use the shared absence marker.** `$ObjVec` stores externrefs, so a
 *   `$Hole` sentinel preserves the distinction between an absent source index
 *   and an explicit `undefined`/`null` value. The output readers map the marker
 *   back to `undefined`, while the output presence helpers keep the index
 *   absent. `__extern_has_idx` is therefore consulted before `Get`: it answers
 *   HasProperty (including inherited numeric properties), not merely whether a
 *   value happens to be non-null.
 *
 * Returns `undefined` (nothing emitted) when the substrate is unavailable, so
 * the caller falls back to the host bridge unchanged.
 */
interface ConcatLocals {
  out: number;
  src: number;
  spv: number;
  flag: number;
  lenF: number;
  len: number;
  idx: number;
  total: number;
  present: number;
}

interface ConcatDeps {
  builders: ReturnType<typeof ensureObjVecBuilders>;
  externLenIdx: number;
  getIdxIdx: number;
  hasIdxIdx: number;
  externGetIdx: number;
  isArrayIdx: number;
  isUndefinedIdx: number;
  boxSymbolIdx: number;
  pushIdx: number;
}

function prepareConcatSpec(ctx: CodegenContext, fctx: FunctionContext): ConcatDeps | undefined {
  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };

  // `$ObjVec` is the native concat result carrier. Register the shared hole
  // marker before the runtime builders are first requested; if the object
  // runtime was already emitted, its finalize fills below still see the same
  // context-owned type/global and patch the existing readers in place.
  ensureHoleType(ctx);
  const builders = ensureObjVecBuilders(ctx);
  // Register every helper BEFORE resolving any index; each of these is a
  // DEFINED native under the native-first provider, so a later registration
  // shifts the ones already resolved (the #2043 late-shift class). Every
  // per-operand emission below re-resolves by NAME after its own
  // `compileExpression`, which is the only other shift source in this body.
  ensureLateImport(ctx, "__extern_length", [externref], [f64]);
  ensureLateImport(ctx, "__extern_get_idx", [externref, f64], [externref]);
  ensureLateImport(ctx, "__extern_has_idx", [externref, f64], [i32]);
  ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  ensureLateImport(ctx, "__extern_is_array", [externref], [i32]);
  ensureLateImport(ctx, "__extern_is_undefined", [externref], [i32]);
  ensureLateImport(ctx, "__box_symbol", [i32], [externref]);
  ensureLateImport(ctx, "__is_truthy", [externref], [i32]);
  flushLateImportShifts(ctx, fctx);

  const required = [
    "__extern_length",
    "__extern_get_idx",
    "__extern_has_idx",
    "__extern_get",
    "__extern_is_array",
    "__extern_is_undefined",
    "__box_symbol",
    "__is_truthy",
  ];
  if (required.some((name) => ctx.funcMap.get(name) === undefined)) return undefined;

  return {
    builders,
    externLenIdx: ctx.funcMap.get("__extern_length")!,
    getIdxIdx: ctx.funcMap.get("__extern_get_idx")!,
    hasIdxIdx: ctx.funcMap.get("__extern_has_idx")!,
    externGetIdx: ctx.funcMap.get("__extern_get")!,
    isArrayIdx: ctx.funcMap.get("__extern_is_array")!,
    isUndefinedIdx: ctx.funcMap.get("__extern_is_undefined")!,
    boxSymbolIdx: ctx.funcMap.get("__box_symbol")!,
    pushIdx: ctx.funcMap.get("__objvec_push") ?? builders.pushIdx,
  };
}

function allocateConcatLocals(fctx: FunctionContext): ConcatLocals {
  return {
    out: allocLocal(fctx, `__cat_spec_out_${fctx.locals.length}`, { kind: "externref" }),
    src: allocLocal(fctx, `__cat_spec_src_${fctx.locals.length}`, { kind: "externref" }),
    spv: allocLocal(fctx, `__cat_spec_spv_${fctx.locals.length}`, { kind: "externref" }),
    flag: allocLocal(fctx, `__cat_spec_flag_${fctx.locals.length}`, { kind: "i32" }),
    lenF: allocLocal(fctx, `__cat_spec_lenf_${fctx.locals.length}`, { kind: "f64" }),
    len: allocLocal(fctx, `__cat_spec_len_${fctx.locals.length}`, { kind: "i32" }),
    idx: allocLocal(fctx, `__cat_spec_i_${fctx.locals.length}`, { kind: "i32" }),
    total: allocLocal(fctx, `__cat_spec_n_${fctx.locals.length}`, { kind: "f64" }),
    present: allocLocal(fctx, `__cat_spec_present_${fctx.locals.length}`, { kind: "i32" }),
  };
}

function emitConcatSource(
  ctx: CodegenContext,
  fctx: FunctionContext,
  locals: ConcatLocals,
  deps: ConcatDeps,
  emitSource: () => void,
): void {
  emitSource();
  fctx.body.push({ op: "local.set", index: locals.src });

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

  // ── IsConcatSpreadable(E) (§23.1.3.1.1) ──────────────────────────────
  // spv = Get(E, @@isConcatSpreadable); a null/undefined answer (which also
  // covers every non-Object E, whose reflective read misses) falls back to
  // IsArray(E), otherwise ToBoolean(spv).
  fctx.body.push({ op: "local.get", index: locals.src });
  fctx.body.push({ op: "i32.const", value: SYMBOL_IS_CONCAT_SPREADABLE_ID });
  fctx.body.push({ op: "call", funcIdx: deps.boxSymbolIdx });
  fctx.body.push({ op: "call", funcIdx: deps.externGetIdx });
  fctx.body.push({ op: "local.tee", index: locals.spv });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: locals.spv });
  fctx.body.push({ op: "call", funcIdx: deps.isUndefinedIdx });
  fctx.body.push({ op: "i32.or" });
  const toBool: Instr[] = [{ op: "local.get", index: locals.spv }];
  emitToBoolean(ctx, { kind: "externref" }, toBool);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: locals.src },
      { op: "call", funcIdx: deps.isArrayIdx },
    ],
    else: toBool,
  });
  fctx.body.push({ op: "local.set", index: locals.flag });

  // ── Spreadable arm: append E's 0..ToLength(E.length) elements ─────────
  const spreadArm: Instr[] = [
    { op: "local.get", index: locals.src },
    { op: "call", funcIdx: deps.externLenIdx },
    { op: "local.set", index: locals.lenF },
    // step 5.c.iii — n + len > 2^53-1 ⇒ TypeError. Load-bearing beyond
    // conformance: it is what keeps `length = Number.MAX_SAFE_INTEGER`
    // (arg-length-exceeding-integer-limit.js) from entering a 2^31-iteration
    // copy loop after the i32 truncation below.
    { op: "local.get", index: locals.total },
    { op: "local.get", index: locals.lenF },
    { op: "f64.add" },
    { op: "f64.const", value: MAX_SAFE_LENGTH },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: overflowThrow },
    { op: "local.get", index: locals.total },
    { op: "local.get", index: locals.lenF },
    { op: "f64.add" },
    { op: "local.set", index: locals.total },
    { op: "local.get", index: locals.lenF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: locals.len },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: locals.idx },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: locals.idx },
            { op: "local.get", index: locals.len },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // HasProperty decides whether concat creates an own result index.
            // Inherited entries are copied; genuine holes stay absent through
            // the shared internal sentinel.
            { op: "local.get", index: locals.src },
            { op: "local.get", index: locals.idx },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: deps.hasIdxIdx },
            { op: "local.set", index: locals.present },
            { op: "local.get", index: locals.out },
            { op: "local.get", index: locals.present },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [
                { op: "local.get", index: locals.src },
                { op: "local.get", index: locals.idx },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: deps.getIdxIdx },
              ],
              else: holeSentinelInstrs(ctx),
            },
            { op: "call", funcIdx: deps.pushIdx },
            { op: "local.get", index: locals.idx },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: locals.idx },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  // ── Non-spreadable arm: append E itself ──────────────────────────────
  const singleArm: Instr[] = [
    { op: "local.get", index: locals.out },
    { op: "local.get", index: locals.src },
    { op: "call", funcIdx: deps.pushIdx },
    { op: "local.get", index: locals.total },
    { op: "f64.const", value: 1 },
    { op: "f64.add" },
    { op: "local.set", index: locals.total },
  ];

  fctx.body.push({ op: "local.get", index: locals.flag });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: spreadArm, else: singleArm });
}

function emitConcatOutputInit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: ConcatDeps,
  locals: ConcatLocals,
): void {
  // out = ArraySpeciesCreate(O, 0) ≈ a fresh $ObjVec ; n = 0
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? deps.builders.newIdx });
  fctx.body.push({ op: "local.set", index: locals.out });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "local.set", index: locals.total });
}

/** Emit the existing AST-driven concat lowering. */
export function compileArrayConcatNativeSpec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null | undefined {
  return compileArrayConcatNativeSpecFromExprs(ctx, fctx, propAccess.expression, [...callExpr.arguments]);
}

/**
 * (#5145) The receiver/args-EXPRESSION entry to the same §23.1.3.1 loop.
 *
 * `Array.prototype.concat.call(obj, …)` reaches the compiler with the receiver
 * as `arguments[0]`, not as the property-access target, so the AST-driven entry
 * above cannot express it. Before this, that spelling fell through to the
 * reflective `.call` lowering, which invokes the concat proto-closure's VARIADIC
 * `(this, argsVec)` ABI through an arity-shaped `call_ref` and pushes one
 * operand too few — an INVALID MODULE ("not enough arguments on the stack for
 * call_ref (need 3, got 2)"), i.e. a compile-time failure, not a wrong answer.
 */
export function compileArrayConcatNativeSpecFromExprs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  argExprs: readonly ts.Expression[],
): ValType | null | undefined {
  const externref: ValType = { kind: "externref" };
  const deps = prepareConcatSpec(ctx, fctx);
  if (deps === undefined) return undefined;
  ctx.usesNativeConcatHoleSubstrate = true;
  const locals = allocateConcatLocals(fctx);
  emitConcatOutputInit(ctx, fctx, deps, locals);

  // §23.1.3.1 step 2 — `A = ArraySpeciesCreate(O, 0)`. The receiver is the FIRST
  // operand and must be evaluated before the species read, so the prologue is
  // emitted from the receiver's own stashed value.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  let speciesLocal: number | undefined;

  let first = true;
  for (const sourceExpr of [receiverExpr, ...argExprs]) {
    if (first && speciesDeps !== undefined) {
      const recvTmp = allocLocal(fctx, `__cat_spec_recv_${fctx.locals.length}`, externref);
      const sourceType = compileExpression(ctx, fctx, sourceExpr, externref);
      if (sourceType === null) fctx.body.push({ op: "ref.null.extern" });
      else if (sourceType.kind !== "externref") coerceType(ctx, fctx, sourceType, externref);
      fctx.body.push({ op: "local.set", index: recvTmp });
      speciesLocal = emitArraySpeciesCreate(
        ctx,
        fctx,
        speciesDeps,
        [{ op: "local.get", index: recvTmp }],
        [{ op: "f64.const", value: 0 }],
      );
      emitConcatSource(ctx, fctx, locals, deps, () => {
        fctx.body.push({ op: "local.get", index: recvTmp });
      });
      first = false;
      continue;
    }
    first = false;
    emitConcatSource(ctx, fctx, locals, deps, () => {
      const sourceType = compileExpression(ctx, fctx, sourceExpr, externref);
      if (sourceType === null) fctx.body.push({ op: "ref.null.extern" });
      else if (sourceType.kind !== "externref") coerceType(ctx, fctx, sourceType, externref);
    });
  }

  fctx.body.push({ op: "local.get", index: locals.out });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, { kind: "externref" });
  }
  return { kind: "externref" };
}

/**
 * Emit concat for the receiver-aware variadic native-proto ABI. `receiverIdx`
 * is the closure's first user parameter (`thisValue`); `argsVecIdx` is the
 * trailing `(ref null $vec_externref)` carrying exactly the call-site args.
 * Keeping the vector length separate from the closure's `.length` is what
 * makes both `x.concat()` and heterogeneous five-argument calls spec-shaped.
 */
export function compileArrayConcatNativeSpecFromReceiverAndArgsVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverIdx: number,
  argsVecIdx: number,
): ValType | null | undefined {
  const deps = prepareConcatSpec(ctx, fctx);
  if (deps === undefined) return undefined;
  const locals = allocateConcatLocals(fctx);
  emitConcatOutputInit(ctx, fctx, deps, locals);

  // (#5145) ArraySpeciesCreate(this, 0) — the receiver is already a parameter
  // here, so no extra evaluation is needed.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  const speciesLocal =
    speciesDeps === undefined
      ? undefined
      : emitArraySpeciesCreate(
          ctx,
          fctx,
          speciesDeps,
          [{ op: "local.get", index: receiverIdx }],
          [{ op: "f64.const", value: 0 }],
        );

  emitConcatSource(ctx, fctx, locals, deps, () => {
    fctx.body.push({ op: "local.get", index: receiverIdx });
  });

  // Read the typed vector directly. Going through the generic externref
  // `__extern_get_idx` carrier loses Wasm-owned object values on this native
  // closure boundary (primitive vector elements happened to survive, masking
  // the bug); the vector layout is already canonical here.
  const argsParam = fctx.params[argsVecIdx]?.type;
  if (!argsParam || (argsParam.kind !== "ref" && argsParam.kind !== "ref_null")) return undefined;
  const argsArrTypeIdx = getArrTypeIdxFromVec(ctx, argsParam.typeIdx);
  const argsArrDef = ctx.mod.types[argsArrTypeIdx];
  if (argsArrDef?.kind !== "array" || argsArrDef.element.kind !== "externref") return undefined;
  const argsData = allocLocal(fctx, `__cat_spec_args_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: argsArrTypeIdx,
  });
  const argsLen = allocLocal(fctx, `__cat_spec_args_len_${fctx.locals.length}`, { kind: "i32" });
  const argsIdx = allocLocal(fctx, `__cat_spec_args_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: argsVecIdx }, { op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: argsVecIdx },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: argsParam.typeIdx, fieldIdx: 1 },
      { op: "local.set", index: argsData },
      { op: "local.get", index: argsVecIdx },
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
              // Build one operand body in a detached buffer so it can sit
              // inside this dynamic loop without changing the existing
              // source-expression lowering or its local allocation scheme.
              ...((): Instr[] => {
                const savedBody = fctx.body;
                const sourceBody: Instr[] = [];
                fctx.body = sourceBody;
                const savedBodyWasLive = ctx.liveBodies.has(savedBody);
                ctx.liveBodies.add(savedBody);
                try {
                  emitConcatSource(ctx, fctx, locals, deps, () => {
                    fctx.body.push(
                      { op: "local.get", index: argsData },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: argsIdx },
                      { op: "array.get", typeIdx: argsArrTypeIdx },
                    );
                  });
                } finally {
                  fctx.body = savedBody;
                  if (!savedBodyWasLive) ctx.liveBodies.delete(savedBody);
                }
                return sourceBody;
              })(),
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

  fctx.body.push({ op: "local.get", index: locals.out });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, { kind: "externref" });
  }
  return { kind: "externref" };
}
