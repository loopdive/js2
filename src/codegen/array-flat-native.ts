// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2717 — Wasm-native `Array.prototype.flat` / `Array.prototype.flatMap` for the
 * host-free lanes (`--target standalone`), over the dynamic array-like
 * substrate.
 *
 * Before this module the standalone lane had only two narrow arms: a depth-1
 * `array.copy` concatenation for a statically HOMOGENEOUS nested vec
 * (`number[][]`, #3363) and a `map` + that same concatenation for an
 * array-returning `flatMap` callback. Everything else either refused to
 * compile (`[path].flat()` over an `any` element — hono's first
 * standalone-dynamic blocker; any explicit `depth`) or, on a genuinely-`any`
 * receiver, fell through the closed-method dispatcher to
 * `__extern_method_call`, which answers `undefined` for a vec brand — so
 * `a.flat().length` was a SILENT `0`.
 *
 * One recursive helper implements ECMA-262 §23.1.3.13.1 FlattenIntoArray and
 * the two entry points are thin wrappers over it:
 *
 * ```
 *   __arr_flatten_into(target, source, depth: f64)          ;; FlattenIntoArray
 *     len = __extern_length(source)                          ;; LengthOfArrayLike
 *     for i in 0 .. len:
 *       if !__extern_has_idx(source, i): continue            ;; holes are skipped
 *       el = __extern_get_idx(source, i)
 *       if depth > 0 && __extern_is_array(el):
 *         __arr_flatten_into(target, el, depth - 1)          ;; +Infinity - 1 = +Infinity
 *       else __objvec_push(target, el)
 *
 *   __arrprod_flat(recv, args)                               ;; §23.1.3.13
 *     RequireObjectCoercible(recv)
 *     depth = args[0] absent/undefined ? 1 : max(ToIntegerOrInfinity(args[0]), 0)
 *     out = __objvec_new(); __arr_flatten_into(out, recv, depth); return out
 *
 *   __arrprod_flatMap(recv, args)                            ;; §23.1.3.14
 *     RequireObjectCoercible(recv); len = __extern_length(recv)
 *     IsCallable(args[0]) else TypeError
 *     for each present i: r = cb.call(thisArg, el, i, recv)
 *       __extern_is_array(r) ? __arr_flatten_into(out, r, 0) : __objvec_push(out, r)
 * ```
 *
 * Every read goes through `__extern_length` / `__extern_has_idx` /
 * `__extern_get_idx` / `__extern_is_array`, which serve every registered typed
 * `__vec_<k>` carrier, the boxed-any `$ObjVec`, and ordinary array-LIKE
 * `$Object`s — so nested vec carriers and externref `$ObjVec`s (and a mix of
 * both) flatten through the same loop. The result is a `$ObjVec`, the
 * established dynamic array carrier (`concat`/`map`/`Object.keys` produce the
 * same), because a flatten of `any` elements is heterogeneous by construction.
 *
 * Deliberate under-approximations (each recorded on #2717):
 *   - ArraySpeciesCreate is a plain `$ObjVec` (same as the #6447 `concat`
 *     producer); a subclass/species receiver gets an ordinary Array back.
 *   - ToNumber of the `depth` argument is `__unbox_number` — exact for
 *     number/boolean/string/null, while an OBJECT depth skips ToPrimitive and
 *     reads as NaN → 0 (the spec answer for `{}`; a `valueOf`-bearing object
 *     is not honoured).
 *   - The 2^53-1 target-index TypeError is not emitted: no carrier can hold
 *     that many elements, so it is unreachable in practice.
 *
 * Standalone-only (`ctx.standalone`): the array-like arms of
 * `__extern_get_idx` these bodies read through exist only there — the same
 * gate `ensureNativeArrayHof` and `ensureNativeArrayProducer` carry. Emitted
 * as append-only defined funcs (no funcIdx shift), idempotent per name.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, compileExpression, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** Method names served by {@link ensureNativeArrayFlat}. */
export const NATIVE_FLAT_METHODS: ReadonlySet<string> = new Set(["flat", "flatMap"]);

/**
 * Arity forms a dynamic-receiver dispatcher arm may claim: `flat([depth])`,
 * `flatMap(cb[, thisArg])`. A zero-arg `flatMap()` is admitted so the helper's
 * own IsCallable gate raises the spec TypeError.
 */
export function isNativeFlatForm(methodName: string, arity: number): boolean {
  if (methodName === "flat") return arity === 0 || arity === 1;
  if (methodName === "flatMap") return arity >= 0 && arity <= 2;
  return false;
}

interface FlatDeps {
  externLength: number;
  externGetIdx: number;
  externHasIdx: number;
  externIsArray: number;
  externIsUndefined: number;
  unboxNumber: number;
  boxNumber: number;
  objVecNew: number;
  objVecPush: number;
  applyClosure: number;
  typeofFunction: number | undefined;
}

function resolveDeps(ctx: CodegenContext): FlatDeps | undefined {
  // Append-only + idempotent; mirrors `ensureNativeArrayHof` so this helper
  // never depends on `ensureObjectRuntime`'s internal ordering.
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externLength = get("__extern_length");
  const externGetIdx = get("__extern_get_idx");
  const externHasIdx = get("__extern_has_idx");
  const externIsArray = get("__extern_is_array");
  const externIsUndefined = get("__extern_is_undefined");
  const unboxNumber = get("__unbox_number");
  const boxNumber = get("__box_number");
  const objVecNew = get("__objvec_new");
  const objVecPush = get("__objvec_push");
  if (
    externLength === undefined ||
    externGetIdx === undefined ||
    externHasIdx === undefined ||
    externIsArray === undefined ||
    externIsUndefined === undefined ||
    unboxNumber === undefined ||
    boxNumber === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined
  ) {
    return undefined;
  }
  return {
    externLength,
    externGetIdx,
    externHasIdx,
    externIsArray,
    externIsUndefined,
    unboxNumber,
    boxNumber,
    objVecNew,
    objVecPush,
    applyClosure,
    typeofFunction: get("__typeof_function"),
  };
}

function mintHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  build: (selfIdx: number) => { body: Instr[]; locals: ValType[] },
): number {
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  const { body, locals } = build(funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}

/** `for (i = 0; i < limit; i += 1) { if (HasProperty(src, i)) body }` over f64 locals. */
function presentIndexLoop(
  deps: FlatDeps,
  srcLocal: number,
  iLocal: number,
  limitLocal: number,
  body: Instr[],
): Instr[] {
  return [
    { op: "f64.const", value: 0 },
    { op: "local.set", index: iLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: limitLocal },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: srcLocal },
            { op: "local.get", index: iLocal },
            { op: "call", funcIdx: deps.externHasIdx },
            { op: "if", blockType: { kind: "empty" }, then: body },
            { op: "local.get", index: iLocal },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** Throw the §23.1.3.13/14 step-1 TypeError when `local` is null or undefined. */
function requireObjectCoercible(ctx: CodegenContext, deps: FlatDeps, local: number, method: string): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.externIsUndefined },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", `Array.prototype.${method} called on null or undefined`),
    },
  ];
}

/** `__arr_flatten_into(target, source, depth: f64) -> ()` — §23.1.3.13.1. */
function ensureFlattenInto(ctx: CodegenContext, deps: FlatDeps): number {
  const existing = ctx.funcMap.get("__arr_flatten_into");
  if (existing !== undefined) return existing;
  const EXTERNREF: ValType = { kind: "externref" };
  const F64: ValType = { kind: "f64" };
  return mintHelper(ctx, "__arr_flatten_into", [EXTERNREF, EXTERNREF, F64], [], (selfIdx) => {
    const TARGET = 0;
    const SOURCE = 1;
    const DEPTH = 2;
    const LEN = 3;
    const I = 4;
    const EL = 5;
    const body: Instr[] = [
      { op: "local.get", index: SOURCE },
      { op: "call", funcIdx: deps.externLength },
      { op: "local.set", index: LEN },
      ...presentIndexLoop(deps, SOURCE, I, LEN, [
        { op: "local.get", index: SOURCE },
        { op: "local.get", index: I },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "local.set", index: EL },
        // shouldFlatten = depth > 0 && IsArray(element)
        { op: "local.get", index: DEPTH },
        { op: "f64.const", value: 0 },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: EL },
            { op: "call", funcIdx: deps.externIsArray },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: TARGET },
            { op: "local.get", index: EL },
            { op: "local.get", index: DEPTH },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "call", funcIdx: selfIdx },
          ],
          else: [
            { op: "local.get", index: TARGET },
            { op: "local.get", index: EL },
            { op: "call", funcIdx: deps.objVecPush },
          ],
        },
      ]),
    ];
    return { body, locals: [F64, F64, EXTERNREF] };
  });
}

/** `__arrprod_flat(recv, args) -> externref` — §23.1.3.13. */
function buildFlatBody(ctx: CodegenContext, deps: FlatDeps, flattenIdx: number): { body: Instr[]; locals: ValType[] } {
  const RECV = 0;
  const ARGS = 1;
  const DEPTH = 2;
  const ARG = 3;
  const OUT = 4;
  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "flat"),
    // depthNum = 1 unless a non-undefined depth argument is present.
    { op: "f64.const", value: 1 },
    { op: "local.set", index: DEPTH },
    { op: "local.get", index: ARGS },
    { op: "call", funcIdx: deps.externLength },
    { op: "f64.const", value: 0 },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ARGS },
        { op: "f64.const", value: 0 },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "local.tee", index: ARG },
        { op: "call", funcIdx: deps.externIsUndefined },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ToIntegerOrInfinity(ToNumber(depth)): NaN → 0, ±∞ kept, else trunc.
            { op: "local.get", index: ARG },
            { op: "call", funcIdx: deps.unboxNumber },
            { op: "local.tee", index: DEPTH },
            { op: "local.get", index: DEPTH },
            { op: "f64.ne" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [{ op: "f64.const", value: 0 }],
              else: [{ op: "local.get", index: DEPTH }, { op: "f64.trunc" }],
            },
            // depthNum < 0 → 0 (also folds -0 and -∞).
            { op: "f64.const", value: 0 },
            { op: "f64.max" },
            { op: "local.set", index: DEPTH },
          ],
        },
      ],
    },
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.tee", index: OUT },
    { op: "local.get", index: RECV },
    { op: "local.get", index: DEPTH },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.get", index: OUT },
  ];
  return {
    body,
    locals: [{ kind: "f64" }, { kind: "externref" }, { kind: "externref" }],
  };
}

/** `__arrprod_flatMap(recv, args) -> externref` — §23.1.3.14. */
function buildFlatMapBody(
  ctx: CodegenContext,
  deps: FlatDeps,
  flattenIdx: number,
): { body: Instr[]; locals: ValType[] } {
  const RECV = 0;
  const ARGS = 1;
  const LEN = 2;
  const ALEN = 3;
  const CB = 4;
  const THIS = 5;
  const OUT = 6;
  const I = 7;
  const CALL_ARGS = 8;
  const RES = 9;
  const undef: Instr[] = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const argOrUndefined = (slot: number, into: number): Instr[] => [
    { op: "local.get", index: ALEN },
    { op: "f64.const", value: slot },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: ARGS },
        { op: "f64.const", value: slot },
        { op: "call", funcIdx: deps.externGetIdx },
      ],
      else: [...undef],
    },
    { op: "local.set", index: into },
  ];
  const callableGuard: Instr[] =
    deps.typeofFunction === undefined
      ? []
      : [
          { op: "local.get", index: CB },
          { op: "call", funcIdx: deps.typeofFunction },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: buildThrowJsErrorInstrs(ctx, "TypeError", "flatMap mapper function is not callable"),
          },
        ];
  const pushArg = (instrs: Instr[]): Instr[] => [
    { op: "local.get", index: CALL_ARGS },
    ...instrs,
    { op: "call", funcIdx: deps.objVecPush },
  ];
  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "flatMap"),
    // §23.1.3.14 step 2 — LengthOfArrayLike(O) precedes the IsCallable check.
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: LEN },
    { op: "local.get", index: ARGS },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: ALEN },
    ...argOrUndefined(0, CB),
    ...callableGuard,
    ...argOrUndefined(1, THIS),
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: OUT },
    ...presentIndexLoop(deps, RECV, I, LEN, [
      { op: "call", funcIdx: deps.objVecNew },
      { op: "local.set", index: CALL_ARGS },
      ...pushArg([
        { op: "local.get", index: RECV },
        { op: "local.get", index: I },
        { op: "call", funcIdx: deps.externGetIdx },
      ]),
      ...pushArg([
        { op: "local.get", index: I },
        { op: "call", funcIdx: deps.boxNumber },
      ]),
      ...pushArg([{ op: "local.get", index: RECV }]),
      { op: "local.get", index: CB },
      { op: "local.get", index: THIS },
      { op: "local.get", index: CALL_ARGS },
      { op: "call", funcIdx: deps.applyClosure },
      { op: "local.tee", index: RES },
      { op: "call", funcIdx: deps.externIsArray },
      {
        op: "if",
        blockType: { kind: "empty" },
        // FlattenIntoArray(target, mappedValue, depth 0): append its present elements.
        then: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: RES },
          { op: "f64.const", value: 0 },
          { op: "call", funcIdx: flattenIdx },
        ],
        else: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: RES },
          { op: "call", funcIdx: deps.objVecPush },
        ],
      },
    ]),
    { op: "local.get", index: OUT },
  ];
  const EXTERNREF: ValType = { kind: "externref" };
  const F64: ValType = { kind: "f64" };
  return {
    body,
    locals: [F64, F64, EXTERNREF, EXTERNREF, EXTERNREF, F64, EXTERNREF, EXTERNREF],
  };
}

/**
 * Reserve (or fetch) `__arrprod_<flat|flatMap>(recv: externref, args: externref)
 * -> externref`, where `args` is a `$ObjVec` of the call's arguments. Returns
 * `undefined` outside standalone or when the object-runtime substrate is
 * unavailable, in which case callers keep their previous behaviour.
 */
export function ensureNativeArrayFlat(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone || !NATIVE_FLAT_METHODS.has(methodName)) return undefined;
  const helperName = `__arrprod_${methodName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  const deps = resolveDeps(ctx);
  if (deps === undefined) return undefined;
  const flattenIdx = ensureFlattenInto(ctx, deps);
  const EXTERNREF: ValType = { kind: "externref" };
  return mintHelper(ctx, helperName, [EXTERNREF, EXTERNREF], [EXTERNREF], () =>
    methodName === "flat" ? buildFlatBody(ctx, deps, flattenIdx) : buildFlatMapBody(ctx, deps, flattenIdx),
  );
}

/**
 * Consume an array externref on the stack and leave `FlattenIntoArray(new, it,
 * 1)` — a fresh `$ObjVec` — in its place. Used by the typed `flatMap` arm once
 * its native `map` produced `any` elements (`flatMap(cb) ≡ map(cb).flat(1)`),
 * which must flatten per element on a runtime IsArray. Returns `false`
 * (nothing emitted, stack untouched) when the substrate is unavailable.
 */
export function emitFlattenDepth1Extern(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!ctx.standalone) return false;
  const deps = resolveDeps(ctx);
  if (deps === undefined) return false;
  const flattenIdx = ensureFlattenInto(ctx, deps);
  flushLateImportShifts(ctx, fctx);
  const EXTERNREF: ValType = { kind: "externref" };
  const src = allocLocal(fctx, `__arr_flat_src_${fctx.locals.length}`, EXTERNREF);
  const out = allocLocal(fctx, `__arr_flat_out_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: src });
  fctx.body.push({
    op: "call",
    funcIdx: ctx.funcMap.get("__objvec_new") ?? deps.objVecNew,
  });
  fctx.body.push({ op: "local.tee", index: out });
  fctx.body.push({ op: "local.get", index: src }, { op: "f64.const", value: 1 });
  fctx.body.push({
    op: "call",
    funcIdx: ctx.funcMap.get("__arr_flatten_into") ?? flattenIdx,
  });
  fctx.body.push({ op: "local.get", index: out });
  return true;
}

/**
 * Body of the first-class `Array.prototype.flat` / `.flatMap` closure value
 * (`Array.prototype.flat.call(arrayLike, depth)`). Both members use the
 * receiver-aware variadic native-proto ABI — param 1 is `this`, param 2 the
 * `(ref null $vec_externref)` of exactly the call-site arguments — which is
 * the `(recv, args)` shape the helpers already take. Returns `undefined` when
 * the helper is unavailable (the caller keeps its refusal).
 */
export function emitArrayFlatProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!NATIVE_FLAT_METHODS.has(member) || ensureNativeArrayFlat(ctx, member) === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "local.get", index: 1 }, { op: "local.get", index: 2 }, { op: "extern.convert_any" });
  fctx.body.push({
    op: "call",
    funcIdx: ctx.funcMap.get(`__arrprod_${member}`)!,
  });
  return { kind: "externref" };
}

/**
 * Emit `receiver.<flat|flatMap>(...args)` at a TYPED call site through the
 * native `__arrprod_<method>` helper: the receiver and each argument are
 * evaluated left to right as externrefs (a typed vec receiver is boxed by
 * `coerceType`), the arguments are packed into a `$ObjVec`, and the helper's
 * `$ObjVec` result is answered as `externref` — the same result kind the
 * JS-host `__array_flat` import answers, so downstream coercion is shared.
 * Returns `undefined` (nothing emitted) when the helper is unavailable.
 */
export function compileArrayFlatNativeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: "flat" | "flatMap",
  receiverExpr: ts.Expression,
  argExprs: readonly ts.Expression[],
): ValType | undefined {
  const EXTERNREF: ValType = { kind: "externref" };
  if (ensureNativeArrayFlat(ctx, methodName) === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);
  const compileAsExtern = (expr: ts.Expression): void => {
    const t = compileExpression(ctx, fctx, expr, EXTERNREF);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  };
  const recv = allocLocal(fctx, `__arr_flat_recv_${fctx.locals.length}`, EXTERNREF);
  const args = allocLocal(fctx, `__arr_flat_args_${fctx.locals.length}`, EXTERNREF);
  compileAsExtern(receiverExpr);
  fctx.body.push({ op: "local.set", index: recv });
  // Resolve by NAME after each compileExpression — the only shift source here.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! });
  fctx.body.push({ op: "local.set", index: args });
  for (const argExpr of argExprs) {
    fctx.body.push({ op: "local.get", index: args });
    compileAsExtern(argExpr);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! });
  }
  fctx.body.push({ op: "local.get", index: recv }, { op: "local.get", index: args });
  fctx.body.push({
    op: "call",
    funcIdx: ctx.funcMap.get(`__arrprod_${methodName}`)!,
  });
  return EXTERNREF;
}
