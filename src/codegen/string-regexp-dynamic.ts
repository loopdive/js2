// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6665) `String.prototype.match` / `search` / `split` whose search value is
 * only known at RUNTIME, `--target standalone`.
 *
 * The standalone RegExp arms (`regexp-standalone.ts`) decide their lowering
 * from a compile-time PROOF: a static RegExp literal, or an operand the checker
 * types as `RegExp`. Library code almost never has that shape — the pattern is
 * a parameter, a `Map` entry or a rules-table property typed `any`:
 *
 * ```js
 * string.match(pattern)                  // lodash `words`, moment, hono
 * string.search(reHasComplexSymbol)      // lodash `truncate`, marked
 * this.split(e).join(t)                  // prettier's replaceAll polyfill
 * ```
 *
 * Every such call was a compile-time refusal (#1474) that failed the WHOLE
 * module. This module answers the question at RUNTIME with one helper per
 * method, the sibling of #6662's `__str_replace_dyn`:
 *
 *  - `__str_match_dyn(subject, regexp) → externref` (§22.1.3.13)
 *  - `__str_search_dyn(subject, regexp) → f64` (§22.1.3.16)
 *  - `__str_split_dyn(subject, separator, limit) → externref` (§22.1.3.23)
 *
 * Each dispatches on the value:
 *
 *  - **a backend RegExp** (`ref.test $__StandaloneRegExp`): step 2's
 *    `Call(regexp[@@X], regexp, «O»)` is, for a genuine RegExp, the generic
 *    `RegExp.prototype[@@X]` body the reflective proto glue already uses
 *    (`emitRegExpSymbol{Match,Search,Split}Body`, over
 *    `emitRegExpBuiltinExecFromLocal`). Runtime flags, `lastIndex` handling,
 *    captures, SpeciesConstructor for split — no second implementation.
 *  - **any other Object**: step 2 proper — `GetMethod(value, @@X)`, and when
 *    it is not `undefined`/`null`, `Call(method, value, «O[, limit]»)`.
 *  - **anything else** (and an Object without the method):
 *    - match / search: `RegExpCreate(value, undefined)` through the runtime
 *      pattern compiler (`__regex_compile_dynamic_simple`, #4065) — `undefined`
 *      is the empty pattern, anything else is `ToString`ed — then the same
 *      `@@X` body over the fresh RegExp. A pattern outside the runtime subset
 *      raises that compiler's catchable TypeError on first use.
 *    - split: the string path, steps 3-14 (ToUint32 limit, `ToString`
 *      separator, the empty-separator code-unit split, the `StringIndexOf`
 *      walk), producing the same `$ObjVec` the `@@split` body returns.
 *
 * Residual, as for #6662: a RegExp INSTANCE whose own `@@X` is overridden
 * still runs the builtin body (the symbol read on a `$__StandaloneRegExp`
 * carrier is not wired). `matchAll` keeps its refusal: its §22.2.6.9 body is a
 * lazy RegExpStringIterator, which the standalone runtime has no carrier for.
 *
 * The arm is taken only where the existing lowering REFUSED — the #1474
 * fall-through in `compileNativeStringMethodCall`, which the static match/split
 * arms in `regexp-standalone.ts` now also decline to for a `RegExp`-typed value
 * with runtime-only flags/pattern (their former `#1539 Phase 2a` refusal) — so
 * every call site that compiled before keeps its byte-identical code.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getWellKnownSymbolId } from "./literals.js";
import { ensureNativeStringHelpers, nativeStringType, stringConstantExternrefInstrs } from "./native-strings.js";
import {
  emitRegExpSymbolMatchBody,
  emitRegExpSymbolSearchBody,
  flagsContainAvailable,
  prepareMatchLoopDeps,
  prepareRegExpExecProtocol,
  type RegExpExecProtocolDeps,
} from "./regexp-exec-protocol.js";
import {
  buildToUint32Instrs,
  emitRegExpSymbolSplitBody,
  isUndefinedInstrs,
  prepareSplitDeps,
  type SplitDeps,
} from "./regexp-split-protocol.js";
import {
  emitRegExpBuiltinExecFromLocal,
  ensureDynamicStandaloneRegExpCompiler,
  ensureStandaloneRegExpStruct,
} from "./regexp-standalone.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { compileExpression } from "./shared.js";
import { dynamicReplaceAvailable, tryCompileStandaloneDynamicReplace } from "./string-replace-dynamic.js";
import { coerceType } from "./type-coercion.js";

type DynMethod = "match" | "search" | "split";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

const HELPER_NAME: Readonly<Record<DynMethod, string>> = {
  match: "__str_match_dyn",
  search: "__str_search_dyn",
  split: "__str_split_dyn",
};

/** Params of every helper: the subject string, the search value, split's limit. */
const P_SUBJECT = 0;
const P_VALUE = 1;
const P_LIMIT = 2;

/** 2^32 - 1, split's "no limit". */
const MAX_UINT32 = 4294967295;

function isDynMethod(method: string): method is DynMethod {
  return method === "match" || method === "search" || method === "split";
}

/**
 * The #1474 fall-through of `compileNativeStringMethodCall`: route a
 * `replace`/`replaceAll` (#6662) or `match`/`search`/`split` (#6665) call whose
 * search value the compiler could not classify through its runtime dispatcher.
 * `emitSubject` must leave a `ref $AnyString` (nullable is narrowed here).
 * Returns `undefined` — nothing emitted — when no dispatcher serves the call,
 * so the caller's refusal stays in charge.
 */
export function tryCompileStandaloneDynamicStringRegExpCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
  emitSubject: () => ValType | null,
): ValType | null | undefined {
  if (method === "replace" || method === "replaceAll") {
    return tryCompileStandaloneDynamicReplace(ctx, fctx, expr, method, emitSubject);
  }
  if (!isDynMethod(method) || !dynamicReplaceAvailable(ctx)) return undefined;
  const args = expr.arguments;
  if (args.some((a) => ts.isSpreadElement(a))) return undefined;
  // Mint the helper BEFORE emitting anything at the call site: building it
  // registers late natives, and those shifts must not straddle a half-built
  // call expression.
  if (ensureDynamicHelper(ctx, method) === undefined) return undefined;

  const subjType = emitSubject();
  if (!subjType) return null;
  if (subjType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
  if (subjType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  // The method's own parameters (a missing one is `undefined`), then every
  // surplus argument, evaluated in order and discarded.
  const arity = method === "split" ? 2 : 1;
  for (let i = 0; i < Math.max(arity, args.length); i++) {
    const arg = args[i];
    if (arg === undefined) {
      emitUndefined(ctx, fctx);
      continue;
    }
    const argType = compileExpression(ctx, fctx, arg, i < arity ? EXTERNREF : undefined);
    if (i >= arity) {
      if (argType !== null) fctx.body.push({ op: "drop" });
    } else if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
  }
  // Read by NAME at the end: the argument emission above may have shifted it.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME[method])! });
  return method === "search" ? F64 : EXTERNREF;
}

/**
 * Build (once per module) the helper for `method`. Returns `undefined` without
 * minting anything when a prerequisite is unavailable.
 */
function ensureDynamicHelper(ctx: CodegenContext, method: DynMethod): number | undefined {
  const name = HELPER_NAME[method];
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0 || !flagsContainAvailable(ctx)) return undefined;
  const reStructTypeIdx = ensureStandaloneRegExpStruct(ctx);
  const isSplit = method === "split";
  const paramNames = isSplit ? ["subject", "value", "limit"] : ["subject", "value"];
  const paramTypes = paramNames.map(() => EXTERNREF);

  const fctx: FunctionContext = {
    name,
    params: paramNames.map((n) => ({ name: n, type: EXTERNREF })),
    locals: [],
    localMap: new Map(paramNames.map((n, i) => [n, i])),
    returnType: method === "search" ? F64 : EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Every native any arm reads is registered (and flushed) before the first
  // index is captured. A decline here mints nothing.
  addStringConstantGlobal(ctx, "");
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  if (!isSplit) ensureDynamicStandaloneRegExpCompiler(ctx);
  flushLateImportShifts(ctx, fctx);
  if (prepareRegExpExecProtocol(ctx, fctx) === undefined || prepareMatchLoopDeps(ctx, fctx) === undefined) {
    return undefined;
  }
  if (isSplit && prepareSplitDeps(ctx, fctx) === undefined) return undefined;
  if (ctx.funcMap.get("__box_symbol") === undefined || ctx.funcMap.get("__extern_is_undefined") === undefined) {
    return undefined;
  }

  const typeIdx = addFuncType(ctx, paramTypes, [fctx.returnType!], `$str_${method}_dyn_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);

  if (isSplit) emitSplitHelperBody(ctx, fctx, reStructTypeIdx);
  else emitMatchSearchHelperBody(ctx, fctx, method, reStructTypeIdx);

  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return ctx.funcMap.get(name);
}

/** `[] → [i32]` — the RegExp-carrier test on the search value. */
function isBackendRegExpInstrs(reStructTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: P_VALUE },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: reStructTypeIdx },
  ];
}

/**
 * `[] → []`, may `return` — §22.1.3.x step 2 for a non-RegExp Object:
 * `GetMethod(value, @@<symbol>)`; when present, `Call(method, value, «args»)`
 * and return its result (`toResult` adapts it to the helper's return type).
 */
function buildObjectArmInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  symbol: DynMethod,
  argParams: readonly number[],
  toResult: Instr[],
): Instr[] {
  const methodLocal = allocLocal(fctx, `__sdyn_m_${fctx.locals.length}`, EXTERNREF);
  const argsLocal = allocLocal(fctx, `__sdyn_args_${fctx.locals.length}`, EXTERNREF);
  const pushes: Instr[] = argParams.flatMap((p): Instr[] => [
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: p },
    { op: "call", funcIdx: deps.objVecPush },
  ]);
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: P_VALUE },
        { op: "call", funcIdx: deps.typeofObject },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: P_VALUE },
        { op: "i32.const", value: getWellKnownSymbolId(symbol)! },
        { op: "call", funcIdx: ctx.funcMap.get("__box_symbol")! },
        { op: "call", funcIdx: deps.externGet },
        { op: "local.tee", index: methodLocal },
        { op: "ref.is_null" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: methodLocal },
        { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined")! },
        { op: "br_if", depth: 0 },
        { op: "call", funcIdx: deps.objVecNew },
        { op: "local.set", index: argsLocal },
        ...pushes,
        { op: "local.get", index: methodLocal },
        { op: "local.get", index: P_VALUE },
        { op: "local.get", index: argsLocal },
        { op: "call", funcIdx: deps.applyClosure },
        ...toResult,
        { op: "return" },
      ],
    },
  ];
}

/** `[] → [i32]` — `value is undefined` (not `null`, where the #2106 regime can tell them apart). */
function valueIsUndefinedInstrs(ctx: CodegenContext): Instr[] {
  const base: Instr[] = [
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined")! },
  ];
  if (!undefinedSingletonActive(ctx)) return base;
  return [...base, { op: "local.get", index: P_VALUE }, { op: "ref.is_null" }, { op: "i32.eqz" }, { op: "i32.and" }];
}

/** `[] → [ref $AnyString]` — an externref string narrowed to the native string plane. */
function toAnyStr(ctx: CodegenContext): Instr[] {
  return [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx }];
}

/** §22.1.3.13 / §22.1.3.16 — `match` and `search`. */
function emitMatchSearchHelperBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: "match" | "search",
  reStructTypeIdx: number,
): void {
  const deps = prepareRegExpExecProtocol(ctx, fctx)!;
  const compileIdx = ctx.funcMap.get("__regex_compile_dynamic_simple")!;
  const rxLocal = allocLocal(fctx, `__sdyn_rx_${fctx.locals.length}`, EXTERNREF);
  const toResult: Instr[] = method === "search" ? [{ op: "call", funcIdx: deps.unboxNumber }] : [];

  // step 4 — rx = RegExpCreate(value, undefined): P is "" for undefined, else ToString(value).
  const createArm: Instr[] = [
    ...valueIsUndefinedInstrs(ctx),
    {
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: [...stringConstantExternrefInstrs(ctx, ""), ...toAnyStr(ctx)],
      else: [{ op: "local.get", index: P_VALUE }, { op: "call", funcIdx: deps.externToString }, ...toAnyStr(ctx)],
    },
    ...stringConstantExternrefInstrs(ctx, ""),
    ...toAnyStr(ctx),
    { op: "call", funcIdx: compileIdx },
    { op: "extern.convert_any" },
    { op: "local.set", index: rxLocal },
  ];
  fctx.body.push(...isBackendRegExpInstrs(reStructTypeIdx), {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: P_VALUE },
      { op: "local.set", index: rxLocal },
    ],
    else: [...buildObjectArmInstrs(ctx, fctx, deps, method, [P_SUBJECT], toResult), ...createArm],
  });

  // step 5 — Invoke(rx, @@X, «S»): the generic body over the (possibly fresh) RegExp.
  const builtin = (rx: number, s: number): void => emitRegExpBuiltinExecFromLocal(ctx, fctx, rx, s);
  const result =
    method === "match"
      ? emitRegExpSymbolMatchBody(ctx, fctx, rxLocal, P_SUBJECT, builtin)
      : emitRegExpSymbolSearchBody(ctx, fctx, rxLocal, P_SUBJECT, builtin);
  if (result === null) {
    // Unreachable in practice (every prerequisite was checked when the helper
    // was minted); keep the body well-typed.
    fctx.body.push(method === "search" ? { op: "f64.const", value: -1 } : { op: "ref.null.extern" });
    return;
  }
  // Re-read by name: the body may have registered a late import.
  if (method === "search")
    fctx.body.push({ op: "call", funcIdx: (prepareRegExpExecProtocol(ctx, fctx) ?? deps).unboxNumber });
}

/** §22.1.3.23 — `split`. */
function emitSplitHelperBody(ctx: CodegenContext, fctx: FunctionContext, reStructTypeIdx: number): void {
  const deps = prepareRegExpExecProtocol(ctx, fctx)!;
  const split = prepareSplitDeps(ctx, fctx)!;
  // A backend RegExp falls through to the @@split body below; every other value
  // returns from the `else` arm.
  fctx.body.push(...isBackendRegExpInstrs(reStructTypeIdx), {
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      ...buildObjectArmInstrs(ctx, fctx, deps, "split", [P_SUBJECT, P_LIMIT], []),
      ...buildStringSplitInstrs(ctx, fctx, deps, split),
    ],
  });
  const builtin = (rx: number, s: number): void => emitRegExpBuiltinExecFromLocal(ctx, fctx, rx, s);
  if (emitRegExpSymbolSplitBody(ctx, fctx, P_VALUE, P_SUBJECT, P_LIMIT, builtin) === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

/** `[] → []`, always `return`s the `$ObjVec` — §22.1.3.23 steps 3-14 for a non-RegExp separator. */
function buildStringSplitInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  split: SplitDeps,
): Instr[] {
  const flatten = ctx.nativeStrHelpers.get("__str_flatten")!;
  const indexOf = ctx.nativeStrHelpers.get("__str_indexOf")!;
  const flatStr = ctx.nativeStrTypeIdx;
  const flatRef: ValType = { kind: "ref", typeIdx: flatStr };
  const local = (n: string, type: ValType): number => allocLocal(fctx, `__sdyn_${n}_${fctx.locals.length}`, type);
  const S = local("s", flatRef);
  const R = local("r", flatRef);
  const lim = local("lim", F64);
  const num = local("num", F64);
  const A = local("a", EXTERNREF);
  const lenS = local("lens", I32);
  const lenR = local("lenr", I32);
  const p = local("p", I32);
  const q = local("q", I32);
  const count = local("n", I32);

  /** `A.push(S[from, to))`. */
  const pushSub = (from: Instr[], to: Instr[]): Instr[] => [
    { op: "local.get", index: A },
    { op: "local.get", index: S },
    ...from,
    ...to,
    { op: "call", funcIdx: split.strSubstring },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: deps.objVecPush },
  ];
  // A builder, not an array: it is spliced at two sites, and one Instr object at
  // two body positions would be remapped twice by the finalize walks.
  const pushWhole = (): Instr[] => [
    { op: "local.get", index: A },
    { op: "local.get", index: S },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: deps.objVecPush },
  ];
  /** `[] → [i32]` — `f64(countLocal) >= lim`. */
  const atLimit = (countLocal: number): Instr[] => [
    { op: "local.get", index: countLocal },
    { op: "f64.convert_i32_u" },
    { op: "local.get", index: lim },
    { op: "f64.ge" },
  ];

  // steps 10 (empty separator: one element per code unit, at most lim).
  const emptySeparator: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: p },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: p },
            { op: "local.get", index: lenS },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            ...atLimit(p),
            { op: "br_if", depth: 1 },
            ...pushSub(
              [{ op: "local.get", index: p }],
              [{ op: "local.get", index: p }, { op: "i32.const", value: 1 }, { op: "i32.add" }],
            ),
            { op: "local.get", index: p },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: p },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  // steps 12-14 — the StringIndexOf walk. Depths: loop(0) > block $walk(1) > block $out(2).
  const walk: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: p },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: count },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: S },
            { op: "local.get", index: R },
            { op: "local.get", index: p },
            { op: "call", funcIdx: indexOf },
            { op: "local.tee", index: q },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            ...pushSub([{ op: "local.get", index: p }], [{ op: "local.get", index: q }]),
            { op: "local.get", index: count },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: count },
            ...atLimit(count),
            { op: "br_if", depth: 2 },
            { op: "local.get", index: q },
            { op: "local.get", index: lenR },
            { op: "i32.add" },
            { op: "local.set", index: p },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...pushSub([{ op: "local.get", index: p }], [{ op: "local.get", index: lenS }]),
  ];

  return [
    // step 3 — S = ToString(O): the subject is already a string.
    { op: "local.get", index: P_SUBJECT },
    ...toAnyStr(ctx),
    { op: "call", funcIdx: flatten },
    { op: "local.set", index: S },
    // step 4 — lim = limit undefined ? 2^32 - 1 : ToUint32(limit).
    ...isUndefinedInstrs(ctx, split, P_LIMIT),
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [{ op: "f64.const", value: MAX_UINT32 }],
      else: [{ op: "local.get", index: P_LIMIT }, ...buildToUint32Instrs(split, num)],
    },
    { op: "local.set", index: lim },
    // step 5 — R = ToString(separator), BEFORE the lim = 0 exit.
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: deps.externToString },
    ...toAnyStr(ctx),
    { op: "call", funcIdx: flatten },
    { op: "local.set", index: R },
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: A },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        // step 6 — lim = 0 ⇒ [].
        { op: "local.get", index: lim },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: S },
        { op: "struct.get", typeIdx: flatStr, fieldIdx: 0 },
        { op: "local.set", index: lenS },
        { op: "local.get", index: R },
        { op: "struct.get", typeIdx: flatStr, fieldIdx: 0 },
        { op: "local.set", index: lenR },
        // step 7 — separator undefined ⇒ [S].
        ...valueIsUndefinedInstrs(ctx),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...pushWhole(), { op: "br", depth: 1 }],
          else: [],
        },
        { op: "local.get", index: lenR },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...emptySeparator, { op: "br", depth: 1 }],
          else: [],
        },
        // step 11 — S empty ⇒ [S].
        { op: "local.get", index: lenS },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...pushWhole(), { op: "br", depth: 1 }],
          else: [],
        },
        ...walk,
      ],
    },
    { op: "local.get", index: A },
    { op: "return" },
  ];
}
