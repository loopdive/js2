// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitStandaloneArrayConstructor } from "./object-runtime.js";
import { flushLateImportShifts } from "./shared.js";
import { emitStandalonePromiseFromExecutorValue } from "./promise-executor.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { reserveBuiltinConstructorIdentityGlobal } from "./builtin-static-globals.js";

/** Retry an unclaimed dynamic new only for the canonical Array carrier.
 * Argument locals were already evaluated; this neither repeats their effects
 * nor treats an arbitrary function named Array as the intrinsic constructor.
 */
export function emitBuiltinArrayConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeAnyLocal: number,
  arguments_: readonly number[],
): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const global = ctx.builtinObjectGlobals.get("Array");
  if (global === undefined) return;
  const ctor = emitStandaloneArrayConstructor(ctx, arguments_.length);
  if (ctor === undefined) throw new Error("dynamic Array construction lacks its native constructor");
  flushLateImportShifts(ctx, fctx);
  const ctorIndex = ctx.funcMap.get(`__new_Array@${arguments_.length}`);
  if (ctorIndex === undefined) throw new Error("dynamic Array constructor disappeared after import flush");
  emitCanonicalConstructOnNull(fctx, calleeAnyLocal, global, [
    ...arguments_.map((index): Instr => ({ op: "local.get", index })),
    { op: "call", funcIdx: ctorIndex },
  ]);
}

/** Dynamic Promise construction uses the same synchronous executor machinery
 * as direct new Promise. Only the canonical intrinsic identity claims it.
 */
export function emitBuiltinPromiseConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeAnyLocal: number,
  arguments_: readonly number[],
): void {
  if (!isStandalonePromiseActive(ctx)) return;
  // Function compilation can precede the initializer that materializes the
  // carrier. Reserve the canonical slot now; a later value read fills it.
  const global = reserveBuiltinConstructorIdentityGlobal(ctx, "Promise");
  const saved = fctx.body;
  const body: Instr[] = [];
  const savedLive = ctx.liveBodies.has(saved);
  ctx.liveBodies.add(saved);
  ctx.liveBodies.add(body);
  fctx.body = body;
  try {
    if (
      !emitStandalonePromiseFromExecutorValue(ctx, fctx, () => {
        fctx.body.push(arguments_.length ? { op: "local.get", index: arguments_[0]! } : { op: "ref.null.extern" });
      })
    )
      throw new Error("dynamic Promise construction lacks native executor support");
    flushLateImportShifts(ctx, fctx);
  } finally {
    fctx.body = saved;
    ctx.liveBodies.delete(body);
    if (!savedLive) ctx.liveBodies.delete(saved);
  }
  emitCanonicalConstructOnNull(fctx, calleeAnyLocal, global, body);
}

function emitCanonicalConstructOnNull(
  fctx: FunctionContext,
  calleeAnyLocal: number,
  global: number,
  construct: Instr[],
): void {
  const ext: ValType = { kind: "externref" };
  const prior = allocLocal(fctx, "__native_construct_prior", ext);
  const get = (index: number): Instr => ({ op: "local.get", index });
  const globalAny: Instr[] = [{ op: "global.get", index: global }, { op: "any.convert_extern" }];
  fctx.body.push(
    { op: "local.tee", index: prior },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: ext },
      then: [
        get(calleeAnyLocal),
        { op: "ref.test", typeIdx: -19 },
        ...globalAny,
        { op: "ref.test", typeIdx: -19 },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: ext },
          then: [
            get(calleeAnyLocal),
            { op: "ref.cast", typeIdx: -19 },
            ...globalAny,
            { op: "ref.cast", typeIdx: -19 },
            { op: "ref.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: ext },
              then: construct,
              else: [get(prior)],
            },
          ],
          else: [get(prior)],
        },
      ],
      else: [get(prior)],
    },
  );
}
