// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B9) `Invoke(rx, @@<m>, args)` through a real
 * `[[Get]]`, for programs that REPLACE `RegExp.prototype[Symbol.<m>]`
 * (`regexp-proto-symbol-writes.ts` decides that, whole-file).
 *
 * In such a program no call site may assume the builtin §22.2.6 body: the
 * method is whatever the companion `$Object` holds when the call runs. The
 * companion is seeded with the builtin singleton (the B9 pre-scan arms
 * `protoMemberDirty`), the user's assignment overwrites that entry, and
 * `__extern_get` on a `$NativeRegExp` receiver reaches it through the
 * `__protoidx_get_r` terminal-miss consult — measured on the base tree
 * (`r[Symbol.match]` on both a typed and an `any` RegExp answered the user
 * function after the write). So the lowering is the ordinary §7.3.21 Invoke:
 *
 * ```
 *   F := __extern_get(rx, __box_symbol(<id>))   ; GetV
 *   …arguments…                                  ; caller-controlled, AFTER the Get
 *   if (!IsCallable(F)) throw TypeError          ; Call step 2
 *   __apply_closure(F, rx, «args»)
 * ```
 *
 * Three call shapes use it:
 *  - `String.prototype.{match,search}` on a non-RegExp argument
 *    (§22.1.3.11/.17 steps 4-5: `rx := RegExpCreate(…)`, then this Invoke),
 *    from `string-search-value.ts`;
 *  - the same methods on an argument whose declared type carries the member
 *    (a RegExp): step 2's `Call(GetMethod(regexp, @@<m>), regexp, «O»)`, which
 *    the static lane answers with the builtin body. A GetMethod that finds
 *    `undefined` (the member was DELETED) throws the Call's TypeError here
 *    instead of running steps 3-5 first — those end in the same TypeError, so
 *    only a user `toString` on the receiver/argument could observe the
 *    difference (recorded narrowing);
 *  - the direct spelling `re[Symbol.<m>](…)` routed by B3's
 *    `emitRegExpSymbolProtocolApply`, which otherwise calls the builtin
 *    singleton.
 *
 * A program that never replaces the member never reaches this module, so its
 * bytes are unchanged.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { getWellKnownSymbolId, wellKnownSymbolName } from "./literals.js";
import { sourceWritesRegExpProtoSymbol } from "./regexp-proto-symbol-writes.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * Register every helper the Invoke needs; false when one is unavailable. Any
 * late import this adds is flushed into `fctx`'s body emitted so far.
 */
function ensureRegExpProtoSymbolInvoke(ctx: CodegenContext, fctx: FunctionContext): boolean {
  ensureObjectRuntime(ctx);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  return ["__extern_get", "__box_symbol", "__typeof_function", "__objvec_new", "__objvec_push"].every(
    (name) => ctx.funcMap.get(name) !== undefined,
  );
}

/** GetV(rx, @@<id>) into a fresh externref local; `rxLocal` holds rx as externref. */
function emitRegExpProtoSymbolGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rxLocal: number,
  symbolId: number,
): number {
  const fLocal = allocLocal(fctx, `__rpsi_f_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.get", index: rxLocal },
    { op: "i32.const", value: symbolId },
    { op: "call", funcIdx: ctx.funcMap.get("__box_symbol")! },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
    { op: "local.set", index: fLocal },
  );
  return fLocal;
}

/**
 * B3's direct spelling `re[Symbol.<m>](…)`: when the program replaces the
 * member, GetV it from the receiver (already in `rxLocal`, externref) BEFORE the
 * arguments are evaluated (§13.3.6.1). `undefined` = not replaced, nothing emitted.
 */
export function replacedRegExpProtoSymbolGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anchor: ts.Node,
  rxLocal: number,
  symbolId: number,
): { fLocal: number; name: string } | undefined {
  const name = wellKnownSymbolName(symbolId);
  if (name === undefined || !sourceWritesRegExpProtoSymbol(anchor, name)) return undefined;
  if (!ensureRegExpProtoSymbolInvoke(ctx, fctx)) return undefined;
  return { fLocal: emitRegExpProtoSymbolGet(ctx, fctx, rxLocal, symbolId), name };
}

/**
 * `if (!IsCallable(F)) throw TypeError; __apply_closure(F, rx, args)` — leaves
 * the externref result on the stack.
 */
export function emitRegExpProtoSymbolCheckedApply(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fLocal: number,
  rxLocal: number,
  argsLocal: number,
  symbolName: string,
): ValType {
  // Built first among the tail: its own registration is flushed into the body
  // emitted so far, and every index below is read after it.
  const typeError = buildThrowJsErrorInstrs(ctx, "TypeError", `Symbol.${symbolName} is not a function`, {
    flush: fctx,
  });
  const tail: Instr[] = [
    { op: "local.get", index: fLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__typeof_function")! },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: typeError, else: [] },
    { op: "local.get", index: fLocal },
    { op: "local.get", index: rxLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: reserveApplyClosure(ctx) },
  ];
  fctx.body.push(...tail);
  return EXTERNREF;
}

/**
 * §22.1.3.11/.17 step 5 — `Invoke(rx, @@<m>, «S»)` for the RegExpCreate lane.
 * `rxLocal` holds the created `$NativeRegExp` (a `ref`), `pushSubject` leaves S
 * as externref. Returns the externref result type, or `undefined` (nothing
 * emitted) when a helper is unavailable.
 */
export function emitRegExpCreateInvoke(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rxRefLocal: number,
  symbolId: number,
  symbolName: string,
  pushSubjectExternref: () => boolean,
): ValType | null | undefined {
  if (!ensureRegExpProtoSymbolInvoke(ctx, fctx)) return undefined;
  const rxLocal = allocLocal(fctx, `__rpsi_rx_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.get", index: rxRefLocal },
    { op: "extern.convert_any" },
    { op: "local.set", index: rxLocal },
  );
  const fLocal = emitRegExpProtoSymbolGet(ctx, fctx, rxLocal, symbolId);
  const argsLocal = allocLocal(fctx, `__rpsi_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
  );
  if (!pushSubjectExternref()) return null;
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! });
  return emitRegExpProtoSymbolCheckedApply(ctx, fctx, fLocal, rxLocal, argsLocal, symbolName);
}

/** Compile `e` to a fresh externref local; false on a compile failure. */
function compileToExternLocal(ctx: CodegenContext, fctx: FunctionContext, e: ts.Expression, local: number): boolean {
  const t = compileExpression(ctx, fctx, e, EXTERNREF);
  if (t === null) return false;
  if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  fctx.body.push({ op: "local.set", index: local });
  return true;
}

/**
 * §22.1.3.11/.17 step 2 for an argument whose declared type carries
 * `@@<protocol>` (a RegExp), in a program that replaces that member:
 * `Call(GetV(regexp, @@<m>), regexp, «O»)`, O the receiver as evaluated (not
 * ToString'd). `undefined` = not this case, nothing emitted.
 */
export function tryInvokeReplacedOnSearchValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  subjExpr: ts.Expression,
  argExpr: ts.Expression | undefined,
  protocol: "match" | "search",
  subjectOverride: (() => ValType | null) | undefined,
): ValType | null | undefined {
  if (argExpr === undefined || !sourceWritesRegExpProtoSymbol(argExpr, protocol)) return undefined;
  if (ctx.oracle.wellKnownSymbolMemberOf(argExpr, protocol) !== true) return undefined;
  const symbolId = getWellKnownSymbolId(protocol)!;
  if (!ensureRegExpProtoSymbolInvoke(ctx, fctx)) return undefined;
  const oLocal = allocLocal(fctx, `__rpsi_o_${fctx.locals.length}`, EXTERNREF);
  if (subjectOverride) {
    if (subjectOverride() === null) return null;
    fctx.body.push({ op: "extern.convert_any" }, { op: "local.set", index: oLocal });
  } else if (!compileToExternLocal(ctx, fctx, subjExpr, oLocal)) return null;
  const rxLocal = allocLocal(fctx, `__rpsi_rx_${fctx.locals.length}`, EXTERNREF);
  if (!compileToExternLocal(ctx, fctx, argExpr, rxLocal)) return null;
  const fLocal = emitRegExpProtoSymbolGet(ctx, fctx, rxLocal, symbolId);
  const argsLocal = allocLocal(fctx, `__rpsi_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: oLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
  );
  return emitRegExpProtoSymbolCheckedApply(ctx, fctx, fLocal, rxLocal, argsLocal, protocol);
}
