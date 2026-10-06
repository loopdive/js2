// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H6) `Array.prototype.<slice|splice|copyWithin>.call(p, …)` where `p` is a Proxy
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
 * RangeError before copying; `copyWithin` gets the same treatment in
 * `array-copywithin-native.ts`. So a receiver that TRACES to a Proxy value
 * (`tracesToProxyValue`, the predicate every F-slice consumer uses) is routed
 * there instead. The route is correct for any value, so a false positive only
 * costs the typed fast path.
 *
 * ArraySpeciesCreate: the helpers build a plain `$ObjVec` (#6683's recorded
 * under-approximation), so for slice/splice the §10.4.2.3 read runs HERE, on
 * the ORIGINAL receiver — a proxy's `constructor` is read through its traps
 * (`{slice,splice}/create-proxy.js`) — and the species result swap republishes
 * the copied elements onto the constructed object, exactly as the typed
 * lowerings do. UNDER-APPROXIMATION, recorded in #6651: the spec creates `A`
 * BEFORE the element reads (slice step 8, splice step 12); here the
 * `constructor` read and the species call follow the helper. Only an observer
 * that logs both the receiver's traps and the constructor sees the order; the
 * result's identity and prototype are exact. A species-aware helper body is
 * the complete fix.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeArrayCopyWithin } from "./array/array-copywithin-native.js";
import { emitArraySpeciesCreate, emitArraySpeciesResultSwap, prepareArraySpeciesDeps } from "./array-species.js";
import { ensureNativeArrayProducer } from "./dyn-array-producers.js";
import { tracesToProxyValue } from "./proxy-value-provenance.js";
import { compileExpression, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Members whose generic array-like helper takes `(recv, argsVec) -> externref`. */
const PROXY_RECEIVER_GENERIC_METHODS: ReadonlySet<string> = new Set(["slice", "splice", "copyWithin"]);

/** Reserve the member's helper; `copyWithin` has its own body (array-copywithin-native.ts). */
function ensureProxyReceiverHelper(ctx: CodegenContext, methodName: string): number | undefined {
  return methodName === "copyWithin" ? ensureNativeArrayCopyWithin(ctx) : ensureNativeArrayProducer(ctx, methodName);
}

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
  return emitGenericHelperCall(ctx, fctx, methodName, receiverArg, args);
}

/**
 * (#6771 S1) `Array.prototype.copyWithin.call(<array-like>, …)` for ANY
 * receiver the typed lowering does not own (the borrow compiler's array-like
 * branch): the same §23.1.3.4 body a Proxy receiver takes. Before, the plain
 * array-like spelling fell to the reflective `.call` path and threw "not yet
 * callable".
 */
export function compileArrayLikeCopyWithinCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverArg: ts.Expression,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (!ctx.standalone || args.some((arg) => ts.isSpreadElement(arg))) return undefined;
  return emitGenericHelperCall(ctx, fctx, "copyWithin", receiverArg, args);
}

/** Receiver + arguments into an `$ObjVec`, one `call __arrprod_<m>`; species for slice/splice. */
function emitGenericHelperCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  receiverArg: ts.Expression,
  args: readonly ts.Expression[],
): ValType | undefined {
  // Reserve the helper (append-only defined funcs) before any operand compiles.
  if (ensureProxyReceiverHelper(ctx, methodName) === undefined) return undefined;
  if (ctx.funcMap.get("__objvec_new") === undefined || ctx.funcMap.get("__objvec_push") === undefined) {
    return undefined;
  }
  flushLateImportShifts(ctx, fctx);
  const speciesDeps = methodName === "copyWithin" ? undefined : prepareArraySpeciesDeps(ctx, fctx);

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
  if (speciesDeps === undefined) return EXTERNREF;
  // ArraySpeciesCreate(O, n) on the receiver, n = the copied element count.
  const copied = allocLocal(fctx, `__pxr_out_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: copied });
  const species = emitArraySpeciesCreate(
    ctx,
    fctx,
    speciesDeps,
    [{ op: "local.get", index: recv }],
    [
      { op: "local.get", index: copied },
      { op: "call", funcIdx: speciesDeps.externLength },
    ],
  );
  fctx.body.push({ op: "local.get", index: copied });
  return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, species, EXTERNREF);
}
