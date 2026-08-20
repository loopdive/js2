// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AsyncCfgPlan } from "./async-cps.js";
import { emitPreparedAsyncFrameStateMachine, type AsyncFrameInfo, type HostAsyncImports } from "./async-frame.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ERROR_FIELD, MODE_FIELD, PARAM_FIELD_OFFSET, SENT_FIELD, sanitizeTypeName } from "./frame-core.js";
import type { AsyncHostCapabilityId } from "../ir/async-runtime-providers.js";
import { irTypeBindingKey } from "../ir/abi-bindings.js";
import { asVal, type IrFuncRef, type IrFunction, type IrType } from "../ir/nodes.js";
import type { FieldDef, ValType, WasmFunction } from "../ir/types.js";
import { coerceType } from "./shared.js";
import { definedFuncAt } from "./func-space.js";
import { allocLocal } from "./context/locals.js";
import { ensureAsyncDriveRuntime } from "./async-scheduler.js";

export interface PreparedIrAsyncFrameResolver {
  resolveFunc(ref: IrFuncRef): number;
  callResultAdapter?(ref: IrFuncRef): "native-string-from-externref" | undefined;
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
    ...(resolved.has("async.value.undefined") ? { undefinedIdx: requireCapability("async.value.undefined") } : {}),
  };
}

interface PreparedIrAsyncFrameLayout {
  readonly info: AsyncFrameInfo;
  readonly valueNames: ReadonlyMap<number, string>;
  readonly valueTypes: ReadonlyMap<number, IrType>;
  readonly physicalSpillNames: ReadonlyMap<number, string>;
}

function buildFrameInfo(
  ctx: CodegenContext,
  fn: IrFunction,
  params: readonly { readonly name: string; readonly type: ValType }[],
  hostImports: HostAsyncImports | undefined,
  promiseTypeIdx: number,
): PreparedIrAsyncFrameLayout {
  const plan = fn.asyncPlan;
  if (!plan) throw new Error(`IR async function ${fn.name} has no prepared plan`);
  const valueTypes = new Map(plan.values.map((entry) => [Number(entry.value), entry.type] as const));
  const valueNames = new Map<number, string>();
  for (let index = 0; index < plan.params.length; index++) {
    valueNames.set(Number(plan.params[index]!.value), params[index]!.name);
  }
  const paramValues = new Set(plan.params.map((param) => Number(param.value)));
  const physicalSpillNames = new Map<number, string>();
  const physicalSpills = plan.spills.filter((spill) => !paramValues.has(Number(spill.value)));
  const spillNames = physicalSpills.map((spill) => `__ir_async_spill_${Number(spill.value)}`);
  const spillTypes = physicalSpills.map((spill) => preparedAsyncValueType(ctx, fn, spill.type));
  for (let index = 0; index < physicalSpills.length; index++) {
    const value = Number(physicalSpills[index]!.value);
    const name = spillNames[index]!;
    valueNames.set(value, name);
    physicalSpillNames.set(value, name);
  }
  const functionName = `${fn.name}__ir`;
  const fields: FieldDef[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: { kind: "externref" }, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: { kind: "externref" }, mutable: true },
    { name: "error", type: { kind: "externref" }, mutable: true },
    ...params.map((param) => ({ name: `param_${param.name}`, type: param.type, mutable: false })),
    ...spillNames.map((name, index) => ({ name: `spill_${name}`, type: spillTypes[index]!, mutable: true })),
    {
      name: "result_promise",
      type: hostImports ? { kind: "externref" } : { kind: "ref", typeIdx: promiseTypeIdx },
      mutable: true,
    },
  ];
  const stateName = `$AsyncFrame_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  // Prepared frames are compiler-private typed state. Keeping them out of the
  // source-visible struct-field registry prevents generic property dispatch
  // from retaining access ladders for private state/spill fields.
  const spillFieldOffset = PARAM_FIELD_OFFSET + params.length;
  const resultPromiseFieldIdx = spillFieldOffset + spillNames.length;
  const info: AsyncFrameInfo = {
    functionName,
    stateTypeIdx,
    modeFieldIdx: MODE_FIELD,
    sentFieldIdx: SENT_FIELD,
    errorFieldIdx: ERROR_FIELD,
    paramNames: params.map((param) => param.name),
    paramTypes: params.map((param) => param.type),
    paramFieldOffset: PARAM_FIELD_OFFSET,
    spillNames,
    spillTypes,
    spillFieldOffset,
    resultPromiseFieldIdx,
    promiseTypeIdx,
    host: hostImports !== undefined,
    canonicalUndefinedResult: hostImports === undefined && plan.runtimeIntents.includes("value.undefined"),
    alwaysAsyncAwait: hostImports === undefined,
    ...(hostImports ? { hostImports } : {}),
  };
  return { info, valueNames, valueTypes, physicalSpillNames };
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
  if (type.kind === "extern" || type.kind === "callable" || type.kind === "string" || type.kind === "dynamic") {
    return { kind: "externref" };
  }
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
  ctx: CodegenContext,
  fn: IrFunction,
  resolver: PreparedIrAsyncFrameResolver,
  layout: PreparedIrAsyncFrameLayout,
): AsyncCfgPlan {
  const plan = fn.asyncPlan;
  const runtime = fn.asyncRuntime;
  if (
    fn.funcKind !== "async" ||
    !plan ||
    !runtime ||
    plan.handlers.length !== 0 ||
    runtime.states.length !== plan.states.length ||
    plan.states.some((state, index) => state.id !== index || runtime.states[index]?.id !== state.id)
  ) {
    throw new Error(`IR async function ${fn.name} has a malformed prepared state graph`);
  }
  const typeOf = (value: number): IrType => {
    const type = layout.valueTypes.get(value);
    if (!type) throw new Error(`IR async frame ${fn.name} lost value ${value}`);
    return type;
  };
  const nameOf = (value: number): string => layout.valueNames.get(value) ?? `__ir_async_value_${value}`;
  const localOf = (fctx: FunctionContext, value: number): number => {
    const name = nameOf(value);
    const existing = fctx.localMap.get(name);
    if (existing !== undefined) return existing;
    return allocLocal(fctx, name, preparedAsyncValueType(ctx, fn, typeOf(value)));
  };
  const emitGet = (fctx: FunctionContext, value: number): ValType => {
    const type = preparedAsyncValueType(ctx, fn, typeOf(value));
    fctx.body.push({ op: "local.get", index: localOf(fctx, value) });
    return type;
  };
  const emitStateBody = (stateIndex: number, fctx: FunctionContext): void => {
    const semantic = plan.states[stateIndex]!;
    const state = runtime.states[stateIndex]!;
    for (const instr of state.body) {
      switch (instr.kind) {
        case "const": {
          if (instr.result === null || instr.resultType === null) {
            throw new Error(`IR async frame ${fn.name} has an untyped constant`);
          }
          if (instr.value.kind === "f64") fctx.body.push({ op: "f64.const", value: instr.value.value });
          else if (instr.value.kind === "i32") fctx.body.push({ op: "i32.const", value: instr.value.value });
          else if (instr.value.kind === "bool") fctx.body.push({ op: "i32.const", value: instr.value.value ? 1 : 0 });
          else if (instr.value.kind === "null") fctx.body.push({ op: "ref.null.extern" });
          else throw new Error(`IR async frame ${fn.name} cannot emit constant ${instr.value.kind}`);
          fctx.body.push({ op: "local.set", index: localOf(fctx, Number(instr.result)) });
          break;
        }
        case "call": {
          for (const arg of instr.args) emitGet(fctx, Number(arg));
          fctx.body.push({ op: "call", funcIdx: resolver.resolveFunc(instr.target) });
          if (resolver.callResultAdapter?.(instr.target) === "native-string-from-externref") {
            if (ctx.anyStrTypeIdx < 0) {
              throw new Error(`IR async frame ${fn.name} lost its native string carrier`);
            }
            fctx.body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
          }
          if (instr.result !== null) {
            if (instr.resultType === null) throw new Error(`IR async frame ${fn.name} has an untyped call result`);
            fctx.body.push({ op: "local.set", index: localOf(fctx, Number(instr.result)) });
          }
          break;
        }
        default:
          throw new Error(`IR async frame ${fn.name} cannot emit state instruction ${instr.kind}`);
      }
    }
    for (const update of semantic.updates ?? []) {
      emitGet(fctx, Number(update.value));
      fctx.body.push({ op: "local.set", index: localOf(fctx, Number(update.target)) });
    }
    if (semantic.terminator.kind === "resolve" && semantic.terminator.value !== undefined) {
      const identityResume =
        semantic.resume?.value === semantic.terminator.value && semantic.body.length === 0 && !semantic.updates?.length;
      if (!identityResume) {
        const frameLocal = fctx.localMap.get("__frame");
        if (frameLocal === undefined) throw new Error(`IR async frame ${fn.name} lost its frame parameter`);
        fctx.body.push({ op: "local.get", index: frameLocal });
        const from = emitGet(fctx, Number(semantic.terminator.value));
        coerceType(ctx, fctx, from, { kind: "externref" });
        fctx.body.push({ op: "struct.set", typeIdx: layout.info.stateTypeIdx, fieldIdx: SENT_FIELD });
      }
    }
  };
  const emitResume = (stateIndex: number, fctx: FunctionContext): void => {
    const state = plan.states[stateIndex]!;
    if (!state.resume) return;
    const identityResume =
      state.terminator.kind === "resolve" &&
      state.terminator.value === state.resume.value &&
      state.body.length === 0 &&
      !state.updates?.length;
    if (identityResume) return;
    const frameLocal = fctx.localMap.get("__frame");
    if (frameLocal === undefined) throw new Error(`IR async frame ${fn.name} lost its frame parameter`);
    fctx.body.push({ op: "local.get", index: frameLocal });
    fctx.body.push({ op: "struct.get", typeIdx: layout.info.stateTypeIdx, fieldIdx: SENT_FIELD });
    const targetType = preparedAsyncValueType(ctx, fn, state.resume.type);
    const fromExtern = preparedAsyncFromExternFuncIdx(ctx, fn, state.resume.type, targetType, resolver);
    if (fromExtern === null) coerceType(ctx, fctx, { kind: "externref" }, targetType);
    else fctx.body.push({ op: "call", funcIdx: fromExtern });
    fctx.body.push({ op: "local.set", index: localOf(fctx, Number(state.resume.value)) });
  };
  const restoreSpillNames = new Map<number, Set<string>>();
  for (const state of plan.states) {
    if (state.terminator.kind !== "suspend") continue;
    const target = Number(state.terminator.resume.state);
    const names = restoreSpillNames.get(target) ?? new Set<string>();
    for (const value of state.terminator.live) {
      const name = layout.physicalSpillNames.get(Number(value));
      if (name) names.add(name);
    }
    restoreSpillNames.set(target, names);
  }
  return {
    handlers: [],
    states: plan.states.map((state, index) => {
      const terminal = state.terminator;
      const terminator = (() => {
        switch (terminal.kind) {
          case "suspend":
            return {
              kind: "suspend" as const,
              resumeState: Number(terminal.resume.state),
              handler: 0,
              spillNames: terminal.live.flatMap((value) => {
                const name = layout.physicalSpillNames.get(Number(value));
                return name ? [name] : [];
              }),
              awaited: {
                emit: (_ctx: CodegenContext, fctx: FunctionContext): ValType => emitGet(fctx, Number(terminal.awaited)),
              },
            };
          case "goto":
            return { kind: "goto" as const, target: Number(terminal.target) };
          case "branch":
            return {
              kind: "condGoto" as const,
              cond: {
                emit: (_ctx: CodegenContext, fctx: FunctionContext): ValType =>
                  emitGet(fctx, Number(terminal.condition)),
              },
              whenTrue: Number(terminal.ifTrue),
              whenFalse: Number(terminal.ifFalse),
              handler: 0,
            };
          case "resolve":
            return terminal.value === undefined
              ? ({ kind: "settleUndefined" } as const)
              : ({ kind: "settleSent" } as const);
          default:
            throw new Error(`IR async frame ${fn.name} cannot emit terminator ${terminal.kind}`);
        }
      })();
      return {
        id: index,
        resumeFrom: state.resume ? { binding: null, handler: 0 } : null,
        ...(state.resume ? { restoreSpillNames: [...(restoreSpillNames.get(index) ?? [])] } : {}),
        lead: [],
        ...(state.resume
          ? { postDeliverEmit: (_ctx: CodegenContext, fctx: FunctionContext) => emitResume(index, fctx) }
          : {}),
        emit: (_ctx: CodegenContext, fctx: FunctionContext) => emitStateBody(index, fctx),
        terminator,
      };
    }),
  };
}

/** Lower one verified prepared async graph through the shared N-state frame engine. */
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
  const runtime = fn.asyncRuntime;
  if (!runtime) throw new Error(`IR async function ${fn.name} has no prepared runtime attachment`);
  const hostImports = runtime.kind === "host-wasmgc" ? preparedHostImports(fn, resolver) : undefined;
  const promiseTypeIdx = runtime.kind === "standalone-native-wasmgc" ? ensureAsyncDriveRuntime(ctx).promiseTypeIdx : -1;
  const layout = buildFrameInfo(ctx, fn, params, hostImports, promiseTypeIdx);
  const previous = ctx.currentFunc;
  ctx.currentFunc = fctx;
  try {
    emitPreparedAsyncFrameStateMachine(ctx, fctx, layout.info, preparedCfg(ctx, fn, resolver, layout));
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
