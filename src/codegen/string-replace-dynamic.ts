// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6662) `String.prototype.replace` / `replaceAll` whose search value or
 * replacement value is only known at RUNTIME, `--target standalone`.
 *
 * Every other standalone replace arm decides its lowering from a compile-time
 * PROOF about the operands: a static RegExp (`regexp-standalone.ts`), a string
 * or plain-`ToString` search value (`string-search-value.ts`), a proven closure
 * or proven non-callable replacement (`regex-replace-fn.ts`,
 * `string-proto-replace.ts`). An operand the checker cannot classify — every
 * `any` in an untyped `.js` package — fell through to a compile-time refusal
 * (`#1474` / `#1913 follow-up`), which failed the WHOLE module even when the
 * call was never reached. That is what kept hono, marked, moment and
 * styled-components out of the standalone lane:
 *
 * ```js
 * paths[j].replace(mark, groups[i][1]);        // hono: both operands `any`
 * output.replace(/%d/i, number);               // moment: `any` replacement
 * s.replace(re, (m) => …);  re = new RegExp(…) // styled-components: dynamic flags
 * function A(e, r, a) { return e.replace(r, a); }   // stylis
 * ```
 *
 * This module answers the question at RUNTIME, with one shared helper
 * `__str_replace_dyn(subject, searchValue, replaceValue, isAll) → string`:
 *
 *  - **searchValue is a backend RegExp** (`ref.test $__StandaloneRegExp`):
 *    §22.1.3.19 step 2 calls `searchValue[@@replace](string, replaceValue)`,
 *    which for a genuine RegExp is §22.2.6.11 — emitted here as the generic
 *    `RegExp.prototype[@@replace]` body the reflective proto glue already uses
 *    (`regexp-replace-protocol.ts`). That body reads `flags`/`exec`/`lastIndex`
 *    through `[[Get]]`, handles `g`/`y`/`u` from the runtime flags, and calls a
 *    functional replacer with `(matched, ...captures, position, S[, groups])`
 *    through `__apply_closure`. `replaceAll` first performs §22.1.3.20 step 2.b:
 *    a RegExp whose `flags` lacks `"g"` throws a TypeError.
 *  - **any other Object**: §22.1.3.19 step 2 proper — `GetMethod(searchValue,
 *    @@replace)`, and when it is not `undefined`/`null`,
 *    `Call(method, searchValue, «string, replaceValue»)` (result `ToString`ed:
 *    every caller of this lowering consumes a string).
 *  - **anything else** (and an Object without the method): steps 3-14 of the
 *    string path — `ToString(searchValue)`, then either `ToString(replaceValue)`
 *    + the native GetSubstitution helpers (`__str_replace` / `__str_replaceAll`,
 *    #1822), or, when `IsCallable(replaceValue)`, a per-occurrence
 *    `Call(replaceValue, undefined, «searchString, position, string»)`.
 *
 * Residuals, each previously a compile error: a RegExp INSTANCE whose own
 * `@@replace` was overridden still runs the builtin body (the symbol read on a
 * `$__StandaloneRegExp` carrier is not wired), and a RegExp built at runtime
 * hands the replacer no `groups` object (a STATIC named-group pattern therefore
 * keeps its refusal, see `tryCompileRuntimeReplacer`).
 *
 * The arm is taken only where the existing lowering would have REFUSED, so
 * every call site that compiled before keeps its byte-identical code.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { getWellKnownSymbolId } from "./literals.js";
import { ensureNativeStringHelpers, nativeStringType, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import {
  buildFlagsContainInstrs,
  buildGetInstrs,
  captureInto,
  flagsContainAvailable,
  prepareMatchLoopDeps,
  prepareRegExpExecProtocol,
} from "./regexp-exec-protocol.js";
import { emitRegExpSymbolReplaceBody } from "./regexp-replace-protocol.js";
import {
  emitRegExpBuiltinExecFromLocal,
  ensureStandaloneRegExpStruct,
  hasStandaloneRegExpEngine,
  isStringLikeArg,
  staticRegExpGroupNames,
  usesNativeRegExpProvider,
} from "./regexp-standalone.js";
import { isPlainToStringReplacement } from "./string-proto-replace.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const HELPER_NAME = "__str_replace_dyn";
const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** Params of `__str_replace_dyn`. */
const P_SUBJECT = 0;
const P_SEARCH = 1;
const P_REPLACE = 2;
const P_ALL = 3;

/** Is the runtime-dispatch replace arm available in this module at all? */
function dynamicReplaceAvailable(ctx: CodegenContext): boolean {
  return ctx.standalone === true && usesNativeRegExpProvider(ctx) && hasStandaloneRegExpEngine(ctx);
}

/**
 * Lower `subject.replace(a, b)` / `subject.replaceAll(a, b)` through the runtime
 * dispatcher. `emitSubject` (or, when absent, `subjectExpr` compiled against
 * a native-string expectation) must leave a `ref $AnyString` (nullable is
 * narrowed here). Returns `undefined` — nothing emitted — when this module
 * cannot serve the call, so the caller's existing refusal stays in charge.
 */
export function tryCompileStandaloneDynamicReplace(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
  emitSubject: (() => ValType | null) | undefined,
  subjectExpr?: ts.Expression,
): ValType | null | undefined {
  if ((method !== "replace" && method !== "replaceAll") || !dynamicReplaceAvailable(ctx)) return undefined;
  if (expr.arguments.length !== 2 || expr.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;
  // Mint the helper BEFORE emitting anything at the call site: building it
  // registers late natives, and those shifts must not straddle a half-built
  // call expression.
  if (ensureDynamicReplaceHelper(ctx) === undefined) return undefined;

  // Operand order is the call's own: receiver, then the argument list.
  const subjType = emitSubject
    ? emitSubject()
    : subjectExpr && compileExpression(ctx, fctx, subjectExpr, nativeStringType(ctx));
  if (!subjType) return null;
  if (subjType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
  if (subjType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg, EXTERNREF);
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
  }
  fctx.body.push({ op: "i32.const", value: method === "replaceAll" ? 1 : 0 });
  // Read by NAME at the end: the argument emission above may have shifted it.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME)! });
  fctx.body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
  return nativeStringType(ctx);
}

/**
 * The RegExp-typed search value arm (`regexp-standalone.ts`): take the runtime
 * dispatcher only when the replacement is neither provably a string nor
 * provably non-callable — exactly the case that used to refuse with
 * `#1913 follow-up`. A static pattern WITH named groups keeps that refusal: the
 * runtime exec result the `@@replace` body reads carries no `groups` object
 * yet, so `$<name>` and a replacer's trailing `groups` argument would be lost.
 */
export function tryCompileRuntimeReplacer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: string,
  reExpr: ts.Expression,
  receiverOverride: (() => ValType | null) | undefined,
  subjectExpr: ts.Expression,
): ValType | null | undefined {
  const replExpr = expr.arguments[1];
  if (!dynamicReplaceAvailable(ctx) || replExpr === undefined) return undefined;
  if (isStringLikeArg(ctx, replExpr) || isPlainToStringReplacement(ctx, replExpr)) return undefined;
  if ((staticRegExpGroupNames(ctx, reExpr)?.size ?? 0) > 0) return undefined;
  return tryCompileStandaloneDynamicReplace(ctx, fctx, expr, method, receiverOverride, subjectExpr);
}

/**
 * Build (once per module) `__str_replace_dyn(externref subject, externref
 * searchValue, externref replaceValue, i32 isAll) → externref`. Returns
 * `undefined` without minting anything when a prerequisite is unavailable.
 */
function ensureDynamicReplaceHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(HELPER_NAME);
  if (existing !== undefined) return existing;
  ensureNativeStringHelpers(ctx);
  if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0 || !flagsContainAvailable(ctx)) return undefined;
  const reStructTypeIdx = ensureStandaloneRegExpStruct(ctx);

  const fctx: FunctionContext = {
    name: HELPER_NAME,
    params: [
      { name: "subject", type: EXTERNREF },
      { name: "searchValue", type: EXTERNREF },
      { name: "replaceValue", type: EXTERNREF },
      { name: "isAll", type: I32 },
    ],
    locals: [],
    localMap: new Map([
      ["subject", P_SUBJECT],
      ["searchValue", P_SEARCH],
      ["replaceValue", P_REPLACE],
      ["isAll", P_ALL],
    ]),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Every native either arm reads, registered (and flushed) before any index
  // is captured. A decline here mints nothing.
  for (const key of ["flags", "g", ""]) addStringConstantGlobal(ctx, key);
  if (prepareRegExpExecProtocol(ctx, fctx) === undefined || prepareMatchLoopDeps(ctx, fctx) === undefined) {
    return undefined;
  }

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF, I32], [EXTERNREF], "$str_replace_dyn_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER_NAME, funcIdx);

  // RegExp arm first, spliced out of the body and kept LIVE (so a late-import
  // shift during the string arm still rewrites it) until both arms are placed.
  const regexpArm = captureInto(fctx, () => emitRegExpArm(ctx, fctx));
  ctx.liveBodies.add(regexpArm);
  let stringArm: Instr[];
  try {
    stringArm = captureInto(fctx, () => emitStringArm(ctx, fctx));
  } finally {
    ctx.liveBodies.delete(regexpArm);
  }

  fctx.body.push(
    { op: "local.get", index: P_SEARCH },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: reStructTypeIdx },
    { op: "if", blockType: { kind: "val", type: EXTERNREF }, then: regexpArm, else: stringArm },
  );

  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER_NAME,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return ctx.funcMap.get(HELPER_NAME);
}

/** `[] → [externref]` — the §22.2.6.11 arm for a backend RegExp search value. */
function emitRegExpArm(ctx: CodegenContext, fctx: FunctionContext): void {
  const deps = prepareRegExpExecProtocol(ctx, fctx)!;
  // §22.1.3.20 step 2.b — replaceAll: `flags` must contain "g".
  const flagsLocal = allocLocal(fctx, `__rdyn_flags_${fctx.locals.length}`, EXTERNREF);
  const throwNonGlobal = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "String.prototype.replaceAll called with a non-global RegExp argument",
    { flush: fctx },
  );
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: P_ALL },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      ...buildGetInstrs(ctx, deps, P_SEARCH, "flags"),
      { op: "call", funcIdx: deps.externToString },
      { op: "local.set", index: flagsLocal },
      ...buildFlagsContainInstrs(ctx, flagsLocal, "g"),
      { op: "br_if", depth: 0 },
      ...throwNonGlobal,
    ],
  });
  const result = emitRegExpSymbolReplaceBody(ctx, fctx, P_SEARCH, P_SUBJECT, P_REPLACE, (rx, s) =>
    emitRegExpBuiltinExecFromLocal(ctx, fctx, rx, s),
  );
  if (result === null) {
    // Unreachable in practice (every prerequisite was checked when the helper
    // was minted); keep the arm well-typed rather than emitting a broken body.
    fctx.body.push({ op: "local.get", index: P_SUBJECT });
  }
}

/** `[] → [externref]` — §22.1.3.19/.20 steps 3-14 for a non-RegExp search value. */
function emitStringArm(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  flushLateImportShifts(ctx, fctx);
  const deps = prepareRegExpExecProtocol(ctx, fctx)!;
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  const boxSymbol = ctx.funcMap.get("__box_symbol");
  const flatten = ctx.nativeStrHelpers.get("__str_flatten")!;
  const indexOf = ctx.nativeStrHelpers.get("__str_indexOf")!;
  const substring = ctx.nativeStrHelpers.get("__str_substring")!;
  const concat = ctx.nativeStrHelpers.get("__str_concat")!;
  const replaceOne = ctx.nativeStrHelpers.get("__str_replace")!;
  const replaceAll = ctx.nativeStrHelpers.get("__str_replaceAll")!;
  const anyStr = ctx.anyStrTypeIdx;
  const flatStr = ctx.nativeStrTypeIdx;
  const flatRef: ValType = { kind: "ref", typeIdx: flatStr };
  const local = (name: string, type: ValType): number => allocLocal(fctx, `__rdyn_${name}_${fctx.locals.length}`, type);
  const S = local("s", flatRef);
  const search = local("search", flatRef);
  const lenS = local("lens", I32);
  const lenSearch = local("lensearch", I32);
  const pos = local("pos", I32);
  const from = local("from", I32);
  const last = local("last", I32);
  const acc = local("acc", { kind: "ref", typeIdx: anyStr });
  const args = local("args", EXTERNREF);
  const toAnyStr = (): Instr[] => [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: anyStr }];
  const toFlat = (): Instr[] => [...toAnyStr(), { op: "call", funcIdx: flatten }];

  // Step 2 for an Object search value: GetMethod(searchValue, @@replace).
  const method = local("method", EXTERNREF);
  if (boxSymbol !== undefined && isUndefined !== undefined) {
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: P_SEARCH },
        { op: "call", funcIdx: deps.typeofObject },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: P_SEARCH },
        { op: "i32.const", value: getWellKnownSymbolId("replace")! },
        { op: "call", funcIdx: boxSymbol },
        { op: "call", funcIdx: deps.externGet },
        { op: "local.tee", index: method },
        { op: "ref.is_null" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: method },
        { op: "call", funcIdx: isUndefined },
        { op: "br_if", depth: 0 },
        { op: "call", funcIdx: deps.objVecNew },
        { op: "local.set", index: args },
        { op: "local.get", index: args },
        { op: "local.get", index: P_SUBJECT },
        { op: "call", funcIdx: deps.objVecPush },
        { op: "local.get", index: args },
        { op: "local.get", index: P_REPLACE },
        { op: "call", funcIdx: deps.objVecPush },
        { op: "local.get", index: method },
        { op: "local.get", index: P_SEARCH },
        { op: "local.get", index: args },
        { op: "call", funcIdx: deps.applyClosure },
        { op: "call", funcIdx: deps.externToString },
        { op: "return" },
      ],
    });
  }

  // string = ToString(O) (already a string); searchString = ? ToString(searchValue)
  fctx.body.push({ op: "local.get", index: P_SUBJECT }, ...toFlat(), { op: "local.set", index: S });
  fctx.body.push({ op: "local.get", index: P_SEARCH }, { op: "call", funcIdx: deps.externToString }, ...toFlat(), {
    op: "local.set",
    index: search,
  });

  // Non-callable: ? ToString(replaceValue), then GetSubstitution per occurrence.
  const replStr = local("repl", { kind: "ref", typeIdx: anyStr });
  const callReplace = (funcIdx: number): Instr[] => [
    { op: "local.get", index: S },
    { op: "local.get", index: search },
    { op: "local.get", index: replStr },
    { op: "call", funcIdx },
  ];
  const plainArm: Instr[] = [
    { op: "local.get", index: P_REPLACE },
    { op: "call", funcIdx: deps.externToString },
    ...toAnyStr(),
    { op: "local.set", index: replStr },
    { op: "local.get", index: P_ALL },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: anyStr } },
      then: callReplace(replaceAll),
      else: callReplace(replaceOne),
    },
    { op: "extern.convert_any" },
  ];

  // Callable: Call(replaceValue, undefined, «searchString, position, string»)
  // per occurrence; replaceAll advances by max(1, len(searchString)).
  const functionalArm: Instr[] = [
    { op: "local.get", index: S },
    { op: "struct.get", typeIdx: flatStr, fieldIdx: 0 },
    { op: "local.set", index: lenS },
    { op: "local.get", index: search },
    { op: "struct.get", typeIdx: flatStr, fieldIdx: 0 },
    { op: "local.set", index: lenSearch },
    ...stringConstantExternrefInstrs(ctx, ""),
    ...toAnyStr(),
    { op: "local.set", index: acc },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: last },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: from },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // StringIndexOf answers -1 once `from` passes the end.
            { op: "local.get", index: from },
            { op: "local.get", index: lenS },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: S },
            { op: "local.get", index: search },
            { op: "local.get", index: from },
            { op: "call", funcIdx: indexOf },
            { op: "local.tee", index: pos },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            { op: "call", funcIdx: deps.objVecNew },
            { op: "local.set", index: args },
            { op: "local.get", index: args },
            { op: "local.get", index: search },
            { op: "extern.convert_any" },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: args },
            { op: "local.get", index: pos },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: deps.boxNumber },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: args },
            { op: "local.get", index: P_SUBJECT },
            { op: "call", funcIdx: deps.objVecPush },
            // acc = acc + S[last, pos) + ToString(Call(...))
            { op: "local.get", index: acc },
            { op: "local.get", index: S },
            { op: "local.get", index: last },
            { op: "local.get", index: pos },
            { op: "call", funcIdx: substring },
            { op: "call", funcIdx: concat },
            { op: "local.get", index: P_REPLACE },
            // The `undefined` receiver travels as a null externref so the
            // callee's own §10.4.3 lowering decides sloppy vs strict `this`
            // (see replacer-apply-bridge.ts).
            { op: "ref.null.extern" },
            { op: "local.get", index: args },
            { op: "call", funcIdx: deps.applyClosure },
            { op: "call", funcIdx: deps.externToString },
            ...toAnyStr(),
            { op: "call", funcIdx: concat },
            { op: "local.set", index: acc },
            { op: "local.get", index: pos },
            { op: "local.get", index: lenSearch },
            { op: "i32.add" },
            { op: "local.set", index: last },
            { op: "local.get", index: P_ALL },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: pos },
            { op: "local.get", index: lenSearch },
            { op: "i32.const", value: 1 },
            { op: "local.get", index: lenSearch },
            { op: "i32.const", value: 1 },
            { op: "i32.gt_s" },
            { op: "select" },
            { op: "i32.add" },
            { op: "local.set", index: from },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: acc },
    { op: "local.get", index: S },
    { op: "local.get", index: last },
    { op: "local.get", index: lenS },
    { op: "call", funcIdx: substring },
    { op: "call", funcIdx: concat },
    { op: "extern.convert_any" },
  ];

  fctx.body.push(
    { op: "local.get", index: P_REPLACE },
    { op: "call", funcIdx: deps.isCallable },
    { op: "if", blockType: { kind: "val", type: EXTERNREF }, then: functionalArm, else: plainArm },
  );
}
