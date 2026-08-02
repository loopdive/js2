// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AsyncCfgPlan } from "./async-cps.js";
import { emitPreparedAsyncFrameStateMachine, type AsyncFrameInfo, type HostAsyncImports } from "./async-frame.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ERROR_FIELD, MODE_FIELD, PARAM_FIELD_OFFSET, SENT_FIELD, sanitizeTypeName } from "./frame-core.js";
import type { AsyncHostCapabilityId } from "../ir/async-runtime-providers.js";
import type { IrFuncRef, IrFunction } from "../ir/nodes.js";
import type { FieldDef, ValType, WasmFunction } from "../ir/types.js";

export interface PreparedIrAsyncFrameResolver {
  resolveFunc(ref: IrFuncRef): number;
}

function preparedHostImports(fn: IrFunction, resolver: PreparedIrAsyncFrameResolver): HostAsyncImports {
  if (fn.asyncRuntime?.kind !== "host-wasmgc") {
    throw new Error(`IR async function ${fn.name} has no prepared host/WasmGC runtime`);
  }
  const resolved = new Map<AsyncHostCapabilityId, number>();
  for (const adapter of fn.asyncRuntime.adapters) {
    if (resolved.has(adapter.capability)) {
      throw new Error(`IR async function ${fn.name} repeats adapter ${adapter.capability}`);
    }
    resolved.set(adapter.capability, resolver.resolveFunc(adapter.target));
  }
  const requireCapability = (capability: AsyncHostCapabilityId): number => {
    const index = resolved.get(capability);
    if (index === undefined) throw new Error(`IR async function ${fn.name} is missing adapter ${capability}`);
    return index;
  };
  return {
    makeCbIdx: requireCapability("async.callback.wrap"),
    newPendingIdx: requireCapability("async.promise.capability.create"),
    then2Idx: requireCapability("async.promise.react"),
    promiseResolveIdx: requireCapability("async.promise.resolve"),
    settleResolveIdx: requireCapability("async.promise.settle.fulfill"),
    settleRejectIdx: requireCapability("async.promise.settle.reject"),
  };
}

function exactSingleAwaitCall(fn: IrFunction) {
  const plan = fn.asyncPlan;
  const runtime = fn.asyncRuntime;
  if (
    fn.funcKind !== "async" ||
    !plan ||
    !runtime ||
    plan.states.length !== 2 ||
    runtime.states.length !== 2 ||
    plan.spills.length !== 0 ||
    plan.handlers.length !== 0
  ) {
    throw new Error(`IR async function ${fn.name} is outside the prepared single-await frame slice`);
  }
  const semanticEntry = plan.states[0]!;
  const entry = runtime.states[0]!;
  const continuation = plan.states[1]!;
  if (
    semanticEntry.id !== plan.entry ||
    entry.id !== semanticEntry.id ||
    entry.body.length !== 1 ||
    entry.body[0]?.kind !== "call" ||
    semanticEntry.terminator.kind !== "suspend" ||
    semanticEntry.terminator.awaited !== entry.body[0].result ||
    semanticEntry.terminator.live.length !== 0 ||
    semanticEntry.terminator.rejected.kind !== "reject" ||
    semanticEntry.terminator.resume.state !== continuation.id ||
    continuation.resume?.source !== "fulfilled" ||
    continuation.body.length !== 0 ||
    continuation.terminator.kind !== "resolve" ||
    continuation.terminator.value !== continuation.resume.value ||
    entry.body[0].args.length !== fn.params.length ||
    entry.body[0].args.some((value, index) => value !== fn.params[index]!.value)
  ) {
    throw new Error(`IR async function ${fn.name} has a malformed single-await plan`);
  }
  return entry.body[0];
}

function buildFrameInfo(
  ctx: CodegenContext,
  fn: IrFunction,
  params: readonly { readonly name: string; readonly type: ValType }[],
  hostImports: HostAsyncImports,
): AsyncFrameInfo {
  const functionName = `${fn.name}__ir`;
  const fields: FieldDef[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: { kind: "externref" }, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: { kind: "externref" }, mutable: true },
    { name: "error", type: { kind: "externref" }, mutable: true },
    ...params.map((param) => ({ name: `param_${param.name}`, type: param.type, mutable: false })),
    { name: "result_promise", type: { kind: "externref" }, mutable: true },
  ];
  const stateName = `$AsyncFrame_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, fields);
  const resultPromiseFieldIdx = PARAM_FIELD_OFFSET + params.length;
  return {
    functionName,
    stateTypeIdx,
    modeFieldIdx: MODE_FIELD,
    sentFieldIdx: SENT_FIELD,
    errorFieldIdx: ERROR_FIELD,
    paramNames: params.map((param) => param.name),
    paramTypes: params.map((param) => param.type),
    paramFieldOffset: PARAM_FIELD_OFFSET,
    spillNames: [],
    spillTypes: [],
    spillFieldOffset: resultPromiseFieldIdx,
    resultPromiseFieldIdx,
    promiseTypeIdx: -1,
    host: true,
    hostImports,
  };
}

function preparedCfg(fn: IrFunction, helperFuncIdx: number): AsyncCfgPlan {
  return {
    handlers: [],
    states: [
      {
        id: 0,
        resumeFrom: null,
        lead: [],
        terminator: {
          kind: "suspend",
          resumeState: 1,
          handler: 0,
          awaited: {
            emit: (_ctx, fctx) => {
              for (const param of fn.params) {
                const local = fctx.localMap.get(param.name ?? "");
                if (local === undefined) throw new Error(`IR async frame lost parameter ${param.name ?? "<unnamed>"}`);
                fctx.body.push({ op: "local.get", index: local });
              }
              fctx.body.push({ op: "call", funcIdx: helperFuncIdx });
              return { kind: "externref" };
            },
          },
        },
      },
      {
        id: 1,
        resumeFrom: { binding: null, handler: 0 },
        lead: [],
        terminator: { kind: "settleSent" },
      },
    ],
  };
}

/** Lower one prepared two-state async function through the shared frame engine. */
export function lowerPreparedIrAsyncFunction(
  ctx: CodegenContext,
  fn: IrFunction,
  resolver: PreparedIrAsyncFrameResolver,
  existing: WasmFunction,
): WasmFunction {
  const signature = ctx.mod.types[existing.typeIdx];
  if (
    !signature ||
    signature.kind !== "func" ||
    signature.params.length !== fn.params.length ||
    signature.results.length !== 1 ||
    signature.results[0]?.kind !== "externref"
  ) {
    throw new Error(`IR async function ${fn.name} does not match its Promise-returning allocated ABI`);
  }
  const helper = exactSingleAwaitCall(fn);
  const helperFuncIdx = resolver.resolveFunc(helper.target);
  const params = fn.params.map((param, index) => ({
    name: param.name ?? `p${index}`,
    type: signature.params[index]!,
  }));
  const fctx: FunctionContext = {
    name: fn.name,
    params,
    locals: [],
    localMap: new Map(params.map((param, index) => [param.name, index] as const)),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const info = buildFrameInfo(ctx, fn, params, preparedHostImports(fn, resolver));
  const previous = ctx.currentFunc;
  ctx.currentFunc = fctx;
  try {
    emitPreparedAsyncFrameStateMachine(ctx, fctx, info, preparedCfg(fn, helperFuncIdx));
  } finally {
    ctx.currentFunc = previous;
  }
  return {
    name: existing.name,
    typeIdx: existing.typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: existing.exported,
  };
}
