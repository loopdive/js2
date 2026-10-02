// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H6) `Array.prototype.<slice|splice>.call(p, …)` where `p` is a Proxy
 * VALUE, `--target standalone`.
 *
 * TypeScript types `new Proxy(t, h)` and `Proxy.revocable(t, h).proxy` as the
 * TARGET's type, so a proxy over an array is statically `never[]` and the
 * borrow compiler (`compileArrayPrototypeCall`) rewrites the call into the
 * typed `p.slice(…)` / `p.splice(…)` lowering. That lowering `ref.cast`s its
 * receiver to the checker's vec type: for a `$Proxy` the cast fails and the
 * module traps (`illegal cast`, `slice/create-revoked-proxy.js`), or — when the
 * receiver reached a vec-typed slot first — the call runs on a materialized
 * COPY and a revoked proxy never throws (`splice/create-revoked-proxy.js`).
 * Same defect shape as F2–F4: an admission keyed on the SPELLING's type where
 * the question is the VALUE.
 *
 * The generic §23.1.3.28 / §23.1.3.31 algorithms already exist on the
 * array-like substrate (`__arrprod_slice` / `__arrprod_splice`, #6683/#6701):
 * they read `length` through `__extern_length` (§7.3.18, proxy-aware since
 * #6651 H6), elements through `__extern_get_idx`, and throw the ArrayCreate
 * RangeError before copying. So a receiver that TRACES to a Proxy value
 * (`tracesToProxyValue`, the predicate every F-slice consumer uses) is routed
 * there instead. The route is correct for any value, so a false positive only
 * costs the typed fast path.
 *
 * Deliberately NOT covered: ArraySpeciesCreate. The helpers build a plain
 * `$ObjVec` (#6683's recorded under-approximation), so a species constructor
 * reached THROUGH a proxy (`{slice,splice}/create-proxy.js`) is still not
 * consulted — see the H6 record in #6651.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeArrayProducer } from "./dyn-array-producers.js";
import { tracesToProxyValue } from "./proxy-value-provenance.js";
import { compileExpression, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Members whose generic array-like helper takes `(recv, argsVec) -> externref`. */
const PROXY_RECEIVER_GENERIC_METHODS: ReadonlySet<string> = new Set(["slice", "splice"]);

/** Compile `expr` and leave it on the stack as an externref. */
function compileAsExternref(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  const type = compileExpression(ctx, fctx, expr, EXTERNREF);
  if (type === null) fctx.body.push({ op: "ref.null.extern" });
  else if (type.kind !== "externref") coerceType(ctx, fctx, type, EXTERNREF);
}

/**
 * Lower `Array.prototype.<methodName>.call(receiverArg, ...args)` through the
 * array-like helper when `receiverArg` traces to a Proxy value. Returns
 * `undefined` (emitting nothing) when the call is not that shape, so the caller
 * keeps its existing lowering.
 */
export function compileProxyReceiverArrayProtoCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  receiverArg: ts.Expression,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (!ctx.standalone || !PROXY_RECEIVER_GENERIC_METHODS.has(methodName)) return undefined;
  if (args.some((arg) => ts.isSpreadElement(arg))) return undefined;
  if (!tracesToProxyValue(ctx, receiverArg)) return undefined;
  // Reserve the helper (append-only defined funcs) before any operand compiles.
  if (ensureNativeArrayProducer(ctx, methodName) === undefined) return undefined;
  if (ctx.funcMap.get("__objvec_new") === undefined || ctx.funcMap.get("__objvec_push") === undefined) {
    return undefined;
  }
  flushLateImportShifts(ctx, fctx);

  // Operands in source order: the receiver, then each argument.
  const recv = allocLocal(fctx, `__pxr_recv_${fctx.locals.length}`, EXTERNREF);
  compileAsExternref(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.set", index: recv });
  const argLocals = args.map((arg) => {
    const local = allocLocal(fctx, `__pxr_arg_${fctx.locals.length}`, EXTERNREF);
    compileAsExternref(ctx, fctx, arg);
    fctx.body.push({ op: "local.set", index: local });
    return local;
  });

  // Indices are read AFTER the operands compiled: those compiles may register
  // natives, and only `funcMap` is kept current across that.
  const objVecNew = ctx.funcMap.get("__objvec_new")!;
  const objVecPush = ctx.funcMap.get("__objvec_push")!;
  const helper = ctx.funcMap.get(`__arrprod_${methodName}`)!;
  const argsVec = allocLocal(fctx, `__pxr_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: objVecNew }, { op: "local.set", index: argsVec });
  for (const local of argLocals) {
    fctx.body.push(
      { op: "local.get", index: argsVec },
      { op: "local.get", index: local },
      { op: "call", funcIdx: objVecPush },
    );
  }
  fctx.body.push(
    { op: "local.get", index: recv },
    { op: "local.get", index: argsVec },
    { op: "call", funcIdx: helper },
  );
  return EXTERNREF;
}
