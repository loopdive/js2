// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6704) `obj.f(x)` where the closed-struct field `f` is typed as the builtin
 * `Function` interface, under `--target standalone` / `wasi`.
 *
 * `Function` has no call signatures, so `compileCallablePropertyCall` cannot
 * build its funcref-dispatch candidates and used to decline; nothing later
 * claims a declared (non-expando) field, so the call reached the graceful
 * tail — callee and arguments evaluated, dropped, answer `undefined`. lodash-es
 * types every `createCompounder(...)` product `@returns {Function}`, so the
 * npm-compat driver's `__pkgNs.kebabCase(input)` answered `undefined` without
 * running (its `.length` read 0, or trapped on the null in the full graph).
 *
 * The lowering is the one the stored-member arm (#4096) and the dynamic spread
 * terminal (#6646) already use: `__apply_closure(f, obj, [args…])`, which
 * selects the callable's real arity and installs `obj` as `this`. The receiver
 * is evaluated once (kept in a local for both `this` and the field read), then
 * the member, then the arguments — §13.3.6.1 order.
 *
 * Gates: host-free lane only (the JS host has `emitWrapperDynamicMethodCall`),
 * an `externref` field carrier, the oracle's `builtin Function` fact for the
 * property, no spread, and at most `__apply_closure`'s arity cap.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { noJsHost } from "../js-errors.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { coerceType, compileExpression } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };
/** `fillApplyClosure` dispatches arities 0..8. */
const APPLY_CLOSURE_MAX_ARITY = 8;

export interface FunctionTypedPropertyReceiver {
  /** Compile the receiver expression once; leaves its value on the stack. */
  compile(): ValType | null;
  /** Push the field value (externref) read off the receiver held in `local`. */
  readField(local: number, type: ValType): void;
}

export function tryEmitFunctionTypedPropertyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  fieldType: ValType,
  receiver: FunctionTypedPropertyReceiver,
): ValType | undefined {
  if (!noJsHost(ctx) || fieldType.kind !== "externref") return undefined;
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return undefined;
  if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;
  const fact = ctx.oracle.typeFactOf(propAccess);
  if (fact.kind !== "builtin" || fact.name !== "Function") return undefined;

  // Register the bridge and the argv builders before emitting anything, so a
  // late import shifts indices while this call's instructions are not yet
  // baked (#1839/#1886 class).
  const applyIdx = reserveApplyClosure(ctx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);

  const pushAsExtern = (type: ValType | null): void => {
    if (type === null) fctx.body.push({ op: "ref.null.extern" });
    else if (type.kind !== "externref") coerceType(ctx, fctx, type, EXTERNREF);
  };

  const recvType = receiver.compile();
  if (recvType === null) return undefined; // nothing pushed; unreachable for a closed struct receiver
  const recvLocal = allocLocal(fctx, `__ftp_recv_${fctx.locals.length}`, recvType);
  fctx.body.push({ op: "local.set", index: recvLocal });

  receiver.readField(recvLocal, recvType);
  const calleeLocal = allocLocal(fctx, `__ftp_fn_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  const argvLocal = allocLocal(fctx, `__ftp_argv_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? newIdx });
  fctx.body.push({ op: "local.set", index: argvLocal });
  for (const argument of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argvLocal });
    pushAsExtern(compileExpression(ctx, fctx, argument, EXTERNREF));
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? pushIdx });
  }

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: recvLocal });
  pushAsExtern(recvType);
  fctx.body.push({ op: "local.get", index: argvLocal });
  // Argument compilation may register late imports — re-resolve by name.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx });
  return EXTERNREF;
}
