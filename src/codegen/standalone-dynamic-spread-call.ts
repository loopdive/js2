// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-dynamic-spread-call.ts — (#6646, #5383 S68) the STANDALONE twin of
// `emitDynamicSpreadCall`: a call whose callee is a runtime VALUE and whose
// argument list contains a SPREAD.
//
// ## The defect
//
// `calls.ts::emitDynamicSpreadCall` already repairs this shape, but its first
// line is `if (ctx.standalone || ctx.wasi || …) return null;` and its header
// states the reason:
//
// > This path is deliberately limited to the JS-host lane. Standalone/WASI
// > calls retain their native ObjVec/call_ref lowering, where the vector is a
// > first-class Wasm value and can be expanded without a host boundary.
//
// The second sentence is not true of the lowering that actually runs. Every
// dynamic-callee arm in the compiler — `tryEmitInlineDynamicCall`'s candidate
// ladder, `call-identifier.ts`'s matched-closure dispatch, the `#1298 fix #3`
// generic fallback in `call-tail-dispatch.ts` — sizes its argument list from
// `expr.arguments.length`, one local per AST node. A spread is ONE node, so it
// contributes exactly ONE value: the source array itself. Measured on the S67
// head, host-free, `.tmp/s68/probes/q1.js`:
//
// | expression | S67 head | correct |
// | --- | --- | --- |
// | `O.fwd(1,"s",[2],fn)` where `fwd(...args){return this.echo(...args)}` | `undefined` | `number/string/object/function/4` |
// | `callSpread(echoF,[1,"s",[2]])` where `callSpread(f,a){return f(...a)}` | `arr3/UNDEF/UNDEF/1` | `number/string/object/3` |
// | `var g=O.echo; g(...[1,"s",[2],4])` | `object/UNDEF/UNDEF/UNDEF/1` | `number/string/object/number/4` |
// | `echoF(...[1,"s",[2]])` (STATIC callee — control) | correct | correct |
// | `fwdPlain(...args){return echoF(...args)}` (STATIC callee — control) | correct | correct |
//
// The two controls are the point: a spread into a callee the compiler can
// RESOLVE is already exact (the rest-vector is folded into the callee's real
// formals). Only the dynamic-callee arms are fixed-arity, and they are the ones
// `temporalHelpers.js` uses — every `checkSubclassingIgnored*` entry point is
// reached through a `fwd(...args){ return this.<helper>(...args) }` forward, so
// the helper was called with its whole argument list packed into formal zero.
//
// ## The mechanism
//
// The same runtime-argv terminal the linked-static arms use (#6644/S67):
//
// ```
// argv = __objvec_new();           // a runtime vector, so a spread has an exact answer
// <tryEmitSpreadHostArgs>          // #6616's shared expander: one push per RUNTIME element
// __apply_closure(callee, receiver, argv)
// ```
//
// `__apply_closure` widens/clamps to the selected callable's declared arity
// (`buildApplyClosureArityWidening`) and installs `receiver` as `this`, which is
// exactly §7.3.14 + §13.3.6.2. It is already the innermost default arm of
// `tryEmitInlineDynamicCall`, so no carrier becomes reachable here that was not
// reachable before — only the ARGUMENT COUNT changes.
//
// ## Gates, and why each one is load-bearing
//
//  - **A spread must be PRESENT.** Without one the existing fixed-arity
//    lowering is exact, and declining keeps every call site in the byte corpus
//    instruction-identical. This is the same gate S67 used for the linked
//    computed call, for the same reason.
//  - **Host-free lane only** (`noJsHost`). The JS-host lane has its own repair
//    (`emitDynamicSpreadCall`) and `__apply_closure` is not reserved there.
//  - **A side-effect-free RECEIVER spelling**, when the callee is a member
//    expression. §13.3.6.1 evaluates the MemberExpression once; this terminal
//    reads the receiver for `this` and then compiles the whole callee
//    expression (which reads it a second time). A spelling that cannot run
//    user code — `this`, an identifier, or a property-access chain over those —
//    makes the duplicate read unobservable. Anything else declines and keeps
//    today's behaviour rather than duplicating an observable evaluation.
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { withSpeculativeCompile } from "./context/speculative.js"; // (#1919) transactional rollback
import { undefinedExternInstrs } from "./any-helpers.js";
import { tryEmitSpreadHostArgs } from "./host-method-args.js"; // (#6616) runtime-length spread
import { ensureGetUndefined } from "./expressions/late-imports.js";
import { noJsHost } from "./js-errors.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { coerceType, compileExpression } from "./shared.js";
import { hasSpreadArgument } from "./spread-arg-list.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * A receiver spelling whose evaluation cannot run user code, so reading it
 * twice is unobservable. Deliberately syntactic and small: `this`, a plain
 * identifier, and a property-access chain over either. An ELEMENT access is
 * excluded even with a literal key — its own receiver may not be one of these,
 * and the key expression would be evaluated twice.
 */
function isSideEffectFreeReceiver(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isIdentifier(expr)) return true;
  if (ts.isPropertyAccessExpression(expr)) return isSideEffectFreeReceiver(expr.expression);
  return false;
}

/**
 * The receiver a member-expression callee binds as `this`, or `undefined` when
 * the callee is not a member expression (a bare identifier call has
 * `this === undefined`, §13.3.6.2 step 2).
 *
 * Answers `null` — meaning "decline the whole terminal" — for a member callee
 * whose receiver spelling is NOT side-effect-free.
 */
function receiverOf(callee: ts.Expression): ts.Expression | undefined | null {
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const receiver = callee.expression;
  if (receiver.kind === ts.SyntaxKind.SuperKeyword) return null;
  return isSideEffectFreeReceiver(receiver) ? receiver : null;
}

/**
 * (#6646) `<dynamic callee>(…, ...spread, …)` on the host-free lane.
 *
 * Returns `{ kind: "externref" }` having emitted the call, or `undefined`
 * having emitted NOTHING (every partial compile is rolled back through
 * {@link withSpeculativeCompile}).
 */
export function tryEmitStandaloneDynamicSpreadCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!hasSpreadArgument(expr.arguments)) return undefined;
  if (!noJsHost(ctx)) return undefined;
  const receiver = receiverOf(expr.expression);
  if (receiver === null) return undefined;

  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  // `undefined` for the receiver of a bare call. Mirrors
  // `pushDynamicUndefinedExternref` in calls.ts: the (#2106 S1) singleton when
  // the module has one, else a null externref (which every host-free
  // `__extern_is_undefined` consumer treats as `undefined`).
  const undefinedIdx = receiver === undefined ? ensureGetUndefined(ctx) : undefined;
  const undefinedPad = receiver === undefined && undefinedIdx === undefined ? undefinedExternInstrs(ctx) : undefined;

  return withSpeculativeCompile<ValType | undefined>(ctx, fctx, () => {
    const calleeLocal = allocLocal(fctx, `__sds_callee_${fctx.locals.length}`, EXTERNREF);
    const recvLocal = allocLocal(fctx, `__sds_recv_${fctx.locals.length}`, EXTERNREF);

    // §13.3.6.1: the MemberExpression — receiver included — is evaluated before
    // the arguments.
    if (receiver === undefined) {
      if (undefinedIdx !== undefined) fctx.body.push({ op: "call", funcIdx: undefinedIdx });
      else if (undefinedPad !== undefined) for (const ins of undefinedPad) fctx.body.push({ ...ins });
      else fctx.body.push({ op: "ref.null.extern" });
    } else if (!pushAsExtern(ctx, fctx, receiver)) {
      return { commit: false, value: undefined };
    }
    fctx.body.push({ op: "local.set", index: recvLocal });

    if (!pushAsExtern(ctx, fctx, expr.expression)) return { commit: false, value: undefined };
    fctx.body.push({ op: "local.set", index: calleeLocal });

    const argvLocal = allocLocal(fctx, `__sds_argv_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: newIdx });
    fctx.body.push({ op: "local.set", index: argvLocal });
    // The gate above guarantees a spread is present, so this never answers
    // false for "no spread"; a `false` here means the expander itself declined
    // (no substrate) and the whole terminal rolls back.
    if (!tryEmitSpreadHostArgs(ctx, fctx, expr.arguments, argvLocal, "__objvec_push", pushIdx)) {
      return { commit: false, value: undefined };
    }

    fctx.body.push({ op: "local.get", index: calleeLocal });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: argvLocal });
    // Expanding a spread can register late imports, which shifts every
    // defined-function index captured before them — re-resolve by name.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
    return { commit: true, value: EXTERNREF };
  });
}

function pushAsExtern(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  const valueType = compileExpression(ctx, fctx, value, EXTERNREF);
  if (valueType === undefined) return false;
  if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, EXTERNREF);
  return true;
}

/**
 * (#6645) A positional argument that FOLLOWS a spread — `f(a, ...src, b)`.
 *
 * This is the one shape `compileSpreadCallArgs`'s static accounting cannot get
 * right. Its own header states the model: "each spread is assumed to cover
 * exactly the parameter slots left over after the trailing positional args are
 * reserved (#2053)" — an assumption that holds only while the spread's length
 * is known at compile time. `src.length` is a RUNTIME number, so with a
 * trailing argument present the binding shifts.
 *
 * Measured against the real Temporal provider (`.tmp/s68/probes/e2.js`), with
 * `EXP = [2000, 5, "M05", 2]`:
 *
 * | call | answer |
 * | --- | --- |
 * | `TemporalHelpers.assertPlainDate(D, ...EXP, "desc")` | `year result: SameValue(«2000», «"desc"»)` — formal `year` got the TRAILING argument |
 * | `TemporalHelpers.assertPlainDate(D, 2000, 5, "M05", 2, "desc")` | ok |
 *
 * That is exactly what `PlainDate/from/argument-object-valid.js` and
 * `…/argument-string.js` write (`assertPlainDate(result, ...expected, desc)`),
 * and misbinding `era` is what surfaced as `SameValue(«null», «undefined»)`
 * inside `canonicalizeCalendarEra`.
 *
 * Kept SEPARATE from {@link tryEmitStandaloneDynamicSpreadCall}'s own gate on
 * purpose: this entry point sits in front of a lowering that is already
 * spread-AWARE and correct for a trailing-free list, so claiming every spread
 * there would re-lower working call sites for no measured gain. Only the shape
 * the static accounting provably cannot express is taken.
 */
export function tryEmitStandaloneTrailingSpreadCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!argumentFollowsSpread(expr.arguments)) return undefined;
  return tryEmitStandaloneDynamicSpreadCall(ctx, fctx, expr);
}

/** True when some non-spread argument appears after a spread one. */
function argumentFollowsSpread(args: ts.NodeArray<ts.Expression>): boolean {
  let seenSpread = false;
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) seenSpread = true;
    else if (seenSpread) return true;
  }
  return false;
}
