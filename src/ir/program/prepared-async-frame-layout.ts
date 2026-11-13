// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../core/types.js";
import { irTypeEquals } from "../core/types.js";
import type { ValType } from "../../wasm/model/instructions.js";
import { assertIrAsyncPlan } from "../analysis/async-plan.js";
import {
  assertPreparedIrAsyncRuntimeCurrent,
  preparedIrAsyncFrameCapabilityFailure,
} from "../runtime/async-attachment.js";
import type { CurrentPreparedIrAsyncRuntime } from "../runtime/contracts/prepared.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "../core/callable-bindings.js";
import { preparedIrCallableSignature } from "./abi-signatures.js";
import { preparedIrDataMismatch } from "./data.js";
import { preparedHostAsyncDynamicCarrier } from "./host-async-dynamic.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { PreparedFrameInput, FrameValue, PreparedAsyncFrameCallable } from "./prepared-async-frame-contracts.js";
const ext: ValType = { kind: "externref" };
const i32: ValType = { kind: "i32" };

export class FrameGap extends Error {
  constructor(
    message: string,
    readonly stateId?: number,
    readonly valueId?: number,
  ) {
    super(message);
  }
}

export function gap(detail: string, stateId?: number, valueId?: number): never {
  throw new FrameGap(detail, stateId, valueId);
}

/** The adapter's kind-only conversions cannot preserve branded/unsigned domains. */
export function scalar(type: IrType, where: string, mode: "host" | "native" = "host"): ValType {
  const dynamic = mode === "host" ? preparedHostAsyncDynamicCarrier(type) : undefined;
  if (dynamic) return dynamic;
  if (
    type.kind !== "val" ||
    type.typeRef ||
    type.signed === false ||
    !["i32", "i64", "f32", "f64", "externref"].includes(type.val.kind) ||
    Reflect.ownKeys(type.val).some((key) => key !== "kind")
  )
    return gap(`${where} requires an unsupported scalar/domain mapping`);
  return { ...type.val };
}

export function abiCallable(entry: PreparedIrAbiEntry): Extract<PreparedIrAbiEntry["contract"], { kind: "callable" }> {
  const contract = entry.contract;
  if (
    contract.kind !== "callable" ||
    entry.plan.intent.kind !== "callable" ||
    entry.plan.structuralReferenceKey !== irCallableBindingKey(contract.ref.binding) ||
    preparedIrDataMismatch(entry.plan.intent.signature, preparedIrCallableSignature(contract.params, contract.results))
  )
    return gap(`callable ABI contract mismatch for ${entry.plan.displayName}`);
  return contract;
}

export function authenticatedRuntime(
  input: PreparedFrameInput,
  mode: "host" | "native" = "host",
): CurrentPreparedIrAsyncRuntime {
  const { fn } = input;
  if (input.backend !== "wasmgc" || input.target !== (mode === "host" ? "host" : "standalone"))
    gap(`async frames do not support ${input.backend}:${input.target}`);
  const runtime = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
  assertIrAsyncPlan(runtime.plan);
  if (
    runtime.kind !== (mode === "host" ? "host-wasmgc" : "standalone-native-wasmgc") ||
    fn.funcKind !== "async" ||
    runtime.plan.entry !== 0 ||
    runtime.plan.handlers.length ||
    !runtime.plan.states.length ||
    runtime.states.length !== runtime.plan.states.length
  )
    gap("unsupported async state graph or handlers");
  const missing = preparedIrAsyncFrameCapabilityFailure(runtime);
  if (missing) gap(missing);
  if (
    fn.params.length !== runtime.plan.params.length ||
    fn.params.some((p, index) => {
      const expected = runtime.plan.params[index]!;
      return p.value !== expected.value || !irTypeEquals(p.type, expected.type);
    })
  )
    gap("physical function parameter mapping differs from the semantic plan");
  return runtime;
}

export function frameLayout(runtime: CurrentPreparedIrAsyncRuntime, mode: "host" | "native" = "host") {
  const semantic = runtime.plan;
  const fields = ["state", "sent", "mode", "abrupt", "error"].map((name, index) => ({
    name,
    type: index === 0 || index === 2 ? i32 : ext,
    mutable: true,
  }));
  const params = new Map(semantic.params.map((p, index) => [Number(p.value), index]));
  for (const [index, p] of semantic.params.entries())
    fields.push({
      name: `param_${index}`,
      type: scalar(p.type, `parameter ${index}`, mode),
      mutable: false,
    });
  const spills = new Map<number, number>();
  for (const spill of semantic.spills) {
    if (spill.storage !== "ssa" && spill.storage !== "slot")
      gap(`spill ${spill.value} requires ${spill.storage} semantics`);
    if (params.has(Number(spill.value))) continue;
    if (scalar(spill.type, `spill ${spill.value}`, mode).kind === "f32")
      gap(`spill ${spill.value} has no f32 frame default`);
    spills.set(Number(spill.value), fields.length);
    fields.push({
      name: `spill_${spill.value}`,
      type: scalar(spill.type, `spill ${spill.value}`, mode),
      mutable: true,
    });
  }
  const values: FrameValue[] = semantic.values.map((value) => ({
    id: Number(value.value),
    type: scalar(value.type, `value ${value.value}`, mode),
    ...(params.has(Number(value.value)) ? { param: params.get(Number(value.value))! } : {}),
    ...(spills.has(Number(value.value)) ? { spill: spills.get(Number(value.value))! } : {}),
  }));
  const resultField = fields.length;
  fields.push({ name: "result", type: ext, mutable: true });
  return { fields, values, resultField };
}

export function primary(
  input: PreparedFrameInput,
  runtime: CurrentPreparedIrAsyncRuntime,
  mode: "host" | "native" = "host",
): PreparedAsyncFrameCallable {
  const bindingId = irUnitCallableBindingId(input.fn.unitId);
  const own = input.abiEntries.find((row) => row.plan.id === bindingId);
  if (!own || own.plan.slotPolicy !== "required" || own.plan.slotSpace !== "function")
    return gap("missing primary callable ABI");
  const contract = abiCallable(own);
  if (
    contract.ref.binding.kind !== "unit" ||
    contract.ref.binding.unitId !== input.fn.unitId ||
    contract.params.length !== input.fn.params.length ||
    contract.params.some((p, i) => !irTypeEquals(p, input.fn.params[i]!.type)) ||
    preparedIrDataMismatch(contract.promise, runtime.plan.abi) ||
    contract.results.length !== 1 ||
    scalar(contract.results[0]!, "primary Promise result", mode).kind !== "externref"
  )
    return gap("primary callable ABI is not the exact Promise signature");
  return {
    reference: irUnitFuncRef(input.fn),
    bindingId,
    entry: own.plan,
    params: contract.params.map((p) => scalar(p, "primary parameter", mode)),
    results: [ext],
  };
}
