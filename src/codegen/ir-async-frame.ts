// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AsyncCfgPlan } from "./async-cps.js";
import { emitPreparedAsyncFrameStateMachine, type AsyncFrameInfo, type HostAsyncImports } from "./async-frame.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ERROR_FIELD, MODE_FIELD, PARAM_FIELD_OFFSET, SENT_FIELD, sanitizeTypeName } from "./frame-core.js";
import type { AsyncHostCapabilityId } from "../ir/async-runtime-providers.js";
import { irTypeBindingKey } from "../ir/abi-bindings.js";
import { asVal, type IrFuncRef, type IrFunction, type IrInstr, type IrType } from "../ir/nodes.js";
import type { FieldDef, ValType, WasmFunction } from "../ir/types.js";
import { coerceType } from "./shared.js";
import { definedFuncAt } from "./func-space.js";

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

type IrCall = Extract<IrInstr, { readonly kind: "call" }>;

interface ExactSingleAwaitCalls {
  readonly entry: IrCall;
  readonly continuation: {
    readonly call: IrCall;
    readonly paramType: IrType;
    readonly resultType: IrType;
  } | null;
}

function exactSingleAwaitCalls(fn: IrFunction): ExactSingleAwaitCalls {
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
    continuation.terminator.kind !== "resolve" ||
    entry.body[0].args.length !== fn.params.length ||
    entry.body[0].args.some((value, index) => value !== fn.params[index]!.value)
  ) {
    throw new Error(`IR async function ${fn.name} has a malformed single-await plan`);
  }
  const continuationCall =
    continuation.body.length === 1 && continuation.body[0]?.kind === "call" ? continuation.body[0] : null;
  const identityContinuation =
    continuation.body.length === 0 && continuation.terminator.value === continuation.resume.value;
  const calledContinuation =
    continuationCall !== null &&
    continuationCall.args.length === 1 &&
    continuationCall.args[0] === continuation.resume.value &&
    continuationCall.result !== null &&
    continuationCall.resultType !== null &&
    continuation.terminator.value === continuationCall.result;
  if (!identityContinuation && !calledContinuation) {
    throw new Error(`IR async function ${fn.name} has a malformed single-await continuation`);
  }
  let preparedContinuation: ExactSingleAwaitCalls["continuation"] = null;
  if (continuationCall) {
    const resultType = continuationCall.resultType;
    if (resultType === null) {
      throw new Error(`IR async function ${fn.name} has an untyped prepared continuation call`);
    }
    preparedContinuation = {
      call: continuationCall,
      paramType: continuation.resume.type,
      resultType,
    };
  }
  return {
    entry: entry.body[0],
    continuation: preparedContinuation,
  };
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

interface PreparedContinuation {
  readonly funcIdx: number;
  readonly paramType: ValType;
  readonly resultType: ValType;
  readonly fromExternFuncIdx: number | null;
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

function preparedAsyncValueType(ctx: CodegenContext, fn: IrFunction, type: IrType): ValType {
  const scalar = asVal(type);
  if (scalar && scalar.kind !== "ref" && scalar.kind !== "ref_null") return scalar;
  if (type.kind === "extern" || type.kind === "callable") return { kind: "externref" };
  if (type.kind !== "vec") {
    throw new Error(`IR async function ${fn.name} has unsupported continuation type ${type.kind}`);
  }
  const attachment = fn.asyncRuntime?.typeLayouts?.find((entry) => entry.logicalType === type);
  const session = ctx.programAbiSession;
  if (!attachment || !session) {
    throw new Error(`IR async function ${fn.name} has no exact prepared layout for its continuation vector`);
  }
  return {
    kind: type.nullable ? "ref_null" : "ref",
    typeIdx: session.resolveCurrentIndex(
      attachment.layout.carrierType.binding.bindingId,
      "type",
      irTypeBindingKey(attachment.layout.carrierType.binding),
    ),
  };
}

function preparedAsyncFromExternFuncIdx(
  ctx: CodegenContext,
  fn: IrFunction,
  type: IrType,
  paramType: ValType,
  resolver: PreparedIrAsyncFrameResolver,
): number | null {
  if (type.kind !== "vec") return null;
  const attachment = fn.asyncRuntime?.typeLayouts?.find((entry) => entry.logicalType === type);
  if (!attachment?.fromExtern) throw new Error(`IR async function ${fn.name} has no sealed vector materializer`);
  const funcIdx = resolver.resolveFunc(attachment.fromExtern);
  const target = definedFuncAt(ctx, funcIdx);
  const signature = target ? ctx.mod.types[target.typeIdx] : undefined;
  if (
    !target ||
    !signature ||
    signature.kind !== "func" ||
    signature.params.length !== 1 ||
    signature.params[0]?.kind !== "externref" ||
    signature.results.length !== 1 ||
    !sameValType(signature.results[0]!, paramType)
  ) {
    throw new Error(`IR async function ${fn.name} has a malformed sealed vector materializer ABI`);
  }
  return funcIdx;
}

function preparedCfg(
  fn: IrFunction,
  helperFuncIdx: number,
  continuation: PreparedContinuation | null,
  info: AsyncFrameInfo,
): AsyncCfgPlan {
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
        ...(continuation
          ? {
              emit: (ctx: CodegenContext, fctx: FunctionContext): void => {
                const frameLocal = fctx.localMap.get("__frame");
                if (frameLocal === undefined) throw new Error(`IR async frame ${fn.name} lost its frame parameter`);
                fctx.body.push({ op: "local.get", index: frameLocal });
                fctx.body.push({ op: "local.get", index: frameLocal });
                fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
                if (continuation.fromExternFuncIdx === null) {
                  coerceType(ctx, fctx, { kind: "externref" }, continuation.paramType);
                } else {
                  fctx.body.push({ op: "call", funcIdx: continuation.fromExternFuncIdx });
                }
                fctx.body.push({ op: "call", funcIdx: continuation.funcIdx });
                coerceType(ctx, fctx, continuation.resultType, { kind: "externref" });
                fctx.body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
              },
            }
          : {}),
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
  const calls = exactSingleAwaitCalls(fn);
  const helperFuncIdx = resolver.resolveFunc(calls.entry.target);
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
  const continuation = calls.continuation
    ? (() => {
        const funcIdx = resolver.resolveFunc(calls.continuation.call.target);
        const target = definedFuncAt(ctx, funcIdx);
        const targetType = target ? ctx.mod.types[target.typeIdx] : undefined;
        if (
          !target ||
          !targetType ||
          targetType.kind !== "func" ||
          targetType.params.length !== 1 ||
          targetType.results.length !== 1
        ) {
          throw new Error(`IR async function ${fn.name} has a malformed prepared continuation callable ABI`);
        }
        const paramType = preparedAsyncValueType(ctx, fn, calls.continuation.paramType);
        const resultType = preparedAsyncValueType(ctx, fn, calls.continuation.resultType);
        if (!sameValType(targetType.params[0]!, paramType) || !sameValType(targetType.results[0]!, resultType)) {
          throw new Error(`IR async function ${fn.name} continuation layout disagrees with its callable ABI`);
        }
        return {
          funcIdx,
          paramType,
          resultType,
          fromExternFuncIdx: preparedAsyncFromExternFuncIdx(ctx, fn, calls.continuation.paramType, paramType, resolver),
        };
      })()
    : null;
  const previous = ctx.currentFunc;
  ctx.currentFunc = fctx;
  try {
    emitPreparedAsyncFrameStateMachine(ctx, fctx, info, preparedCfg(fn, helperFuncIdx, continuation, info));
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
