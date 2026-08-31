// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { collectInstrs } from "./statements/shared.js";
import { coerceType, compileExpression } from "./shared.js";

const callbackContext = new WeakMap<CodegenContext, boolean>();
const nativeNextCalls = new WeakMap<CodegenContext, WeakSet<ts.CallExpression>>();
const nativeResultBuffers = new WeakMap<Instr[][], boolean>();

export function enterNativeIteratorResultCallback(ctx: CodegenContext, enabled: boolean): () => void {
  const hadPrevious = callbackContext.has(ctx);
  const previous = callbackContext.get(ctx);
  callbackContext.set(ctx, enabled);
  return () => {
    if (hadPrevious) callbackContext.set(ctx, previous === true);
    else callbackContext.delete(ctx);
  };
}

export function promiseReceiverHasNativeIteratorResult(ctx: CodegenContext, receiver: ts.Expression): boolean {
  return ts.isCallExpression(receiver) && nativeNextCalls.get(ctx)?.has(receiver) === true;
}

export function rememberNativeAsyncGenNextCall(ctx: CodegenContext, call: ts.CallExpression): void {
  let calls = nativeNextCalls.get(ctx);
  if (calls === undefined) {
    calls = new WeakSet();
    nativeNextCalls.set(ctx, calls);
  }
  calls.add(call);
}

export function markNativeIteratorResultBuffer(liveBuffers: Instr[][], enabled: boolean): void {
  if (enabled) nativeResultBuffers.set(liveBuffers, true);
}

export function consumeNativeIteratorResultBuffer(liveBuffers: Instr[][]): boolean {
  const enabled = nativeResultBuffers.get(liveBuffers) === true;
  nativeResultBuffers.delete(liveBuffers);
  return enabled;
}

export function nativeIteratorResultThenReceiver(ctx: CodegenContext, receiver: ts.Expression): boolean {
  if (!promiseReceiverHasNativeIteratorResult(ctx, receiver)) return false;
  return ts.isPropertyAccessExpression(receiver.parent) && receiver.parent.name.text === "then";
}

/** Emit the native async-generator `.next()` dispatch and remember its call AST. */
export function tryEmitAsyncGenNextDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  callExpr?: ts.CallExpression,
): ValType | null {
  const producers = ctx.asyncGenProducers;
  if (ctx.standalone !== true && ctx.wasi !== true) return null;
  if (producers === undefined || producers.size === 0) return null;
  const recvLocal = allocLocal(fctx, `__agen_recv_${fctx.locals.length}`, { kind: "externref" });
  const rt = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
  if (rt !== null && rt !== undefined && rt.kind !== "externref") coerceType(ctx, fctx, rt, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });
  const hostGenNext = ctx.asyncGenLegacyBufferEmitted === true ? ctx.funcMap.get("__gen_next") : undefined;
  let chain: Instr[] =
    hostGenNext === undefined
      ? [{ op: "ref.null.extern" }]
      : [
          { op: "local.get", index: recvLocal },
          { op: "call", funcIdx: hostGenNext },
        ];
  for (const p of [...producers.values()].reverse()) {
    const nextIdx = ctx.funcMap.get(p.nextHelperName);
    if (nextIdx === undefined) continue;
    chain = [
      { op: "local.get", index: recvLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: p.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: recvLocal },
          { op: "call", funcIdx: nextIdx },
        ],
        else: chain,
      },
    ];
  }
  fctx.body.push(...chain);
  if (callExpr !== undefined) rememberNativeAsyncGenNextCall(ctx, callExpr);
  return { kind: "externref" };
}

/** Directly bind `{done, value}` from the native async-generator result carrier. */
export function tryEmitNativeIteratorResultParam(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
  paramType: ValType,
): boolean {
  if (callbackContext.get(ctx) !== true || paramType.kind !== "externref" || pattern.elements.length === 0)
    return false;
  const elements = pattern.elements;
  if (
    !elements.every((element) => {
      if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return false;
      const key = element.propertyName ?? element.name;
      return ts.isIdentifier(key) && (key.text === "done" || key.text === "value");
    })
  ) {
    return false;
  }

  const typeIdx = ctx.structMap.get("__NativeGeneratorResult_externref");
  if (typeIdx === undefined) return false;
  const nativeType = ctx.mod.types[typeIdx];
  if (nativeType?.kind !== "struct") return false;
  for (const element of elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const key = element.propertyName ?? element.name;
    if (!ts.isIdentifier(key)) continue;
    const field = nativeType.fields.find((candidate) => candidate.name === key.text);
    if (field !== undefined) allocLocal(fctx, element.name.text, field.type);
  }
  fctx.body.push(
    ...collectInstrs(fctx, () => {
      for (const element of elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key)) continue;
        const fieldIdx = nativeType.fields.findIndex((candidate) => candidate.name === key.text);
        const localIdx = fctx.localMap.get(element.name.text);
        if (fieldIdx < 0 || localIdx === undefined) continue;
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }),
  );
  return true;
}
