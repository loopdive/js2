// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { EmittedPreparedIrProgram, PreparedIrBackendOptions } from "../ir/program.js";
import type { PreparedIrProgram } from "../ir/program/prepared-contracts.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../shared/contracts/prepared-ir-invariant-error.js";
import { assertPreparedIrProgram } from "../ir/program/validation.js";
import {
  assertEmittedPreparedIrProgram,
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
} from "../ir/program-consumer.js";
import { planNativeNumberUndefinedPhysical } from "../ir/program-number-undefined-resources.js";
import { buildAnyValueType, buildUndefinedInitializer } from "../runtime/wasmgc/values/primitive-layouts.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";
import { JS_TAG_IDS } from "../ir/runtime/js-tag-domain.js";

export interface CompletedNativeNumberUndefinedPresentation {
  readonly bindingId: IrBindingId;
  readonly carrierTypeIndices: readonly number[];
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Number/Undefined presentation: ${detail}`);
}
function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) invalid(`non-DATA ${key}`);
  return descriptor.value;
}
/** Only physical artifact DATA, including genuine byte buffers; no executable/prototype waiver. */
function artifactData(value: unknown, active = new Set<object>()): void {
  if (typeof value === "function" || typeof value === "symbol") invalid("executable artifact DATA");
  if (value === null || typeof value !== "object") return;
  if (active.has(value)) invalid("cyclic artifact DATA");
  if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) invalid("byte-buffer shadow property");
      const byte = own(value, key);
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) invalid("byte DATA");
    }
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    invalid("artifact prototype");
  active.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid("artifact symbol property");
    if (Array.isArray(value) && key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) invalid("array shadow property");
    artifactData(own(value, key), active);
  }
  active.delete(value);
}

/** One internal support singleton, never a public dynamic ABI or a filling-capability revival. */
export function completedNativeNumberUndefinedPresentation(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
): CompletedNativeNumberUndefinedPresentation | undefined {
  assertPreparedIrData(backend);
  if (backend.target === "host") return undefined;
  assertPreparedIrData(program);
  const module = own(emission, "module") as EmittedPreparedIrProgram["module"];
  if (Object.getPrototypeOf(module) !== Object.prototype) invalid("module prototype");
  // Screen descriptors before the opaque layout replay reads any module property.
  for (const key of Reflect.ownKeys(module)) {
    if (typeof key !== "string") invalid("module symbol property");
    own(module, key);
  }
  for (const key of [
    "types",
    "imports",
    "functions",
    "globals",
    "tags",
    "tables",
    "elements",
    "exports",
    "stringPool",
    "memories",
    "dataSegments",
    "declaredFuncRefs",
    "funcOrdinalToPosition",
  ])
    artifactData(own(module, key));
  for (const key of ["startFuncIdx", "canonicalRuntimeRecGroup"]) {
    if (Object.hasOwn(module, key)) artifactData(own(module, key));
    else if (key in module) invalid(`inherited ${key}`);
  }
  assertPreparedIrProgram(program);
  assertEmittedPreparedIrProgram(program, emission);
  const physical = emittedPhysicalSetupPlan(emission);
  const projections = program.runtime.filter(
    (view) => view.backend === backend.backend && view.target === backend.target,
  );
  if (projections.length !== 1) invalid("current runtime projection");
  const actual = planNativeNumberUndefinedPhysical(program, projections[0]!);
  if (!actual) {
    if (physical.numberUndefined) invalid("unexpected physical singleton");
    return undefined;
  }
  if (
    physical.backend !== backend.backend ||
    physical.target !== backend.target ||
    preparedIrDataMismatch(actual, physical.numberUndefined) !== undefined
  )
    invalid("physical singleton plan");
  const entry = program.abi.entries.filter((row) => row.plan.id === actual.singletonBindingId);
  if (
    entry.length !== 1 ||
    entry[0]!.contract.kind !== "global" ||
    entry[0]!.contract.mutable ||
    entry[0]!.contract.type.kind !== "dynamic" ||
    entry[0]!.contract.type.tag !== undefined
  )
    invalid("canonical internal global");
  if (
    program.abi.entries.some(
      (row) =>
        (row.plan.slotPolicy === "alias" && row.plan.aliasOf === actual.singletonBindingId) ||
        (row.contract.kind === "export" && row.contract.targetId === actual.singletonBindingId),
    )
  )
    invalid("public singleton alias/export");
  if (
    program.startup.some((row) =>
      row.bindings.some(
        (binding) =>
          binding.globalBindingId === actual.singletonBindingId || binding.tdzBindingId === actual.singletonBindingId,
      ),
    )
  )
    invalid("source singleton storage");
  const binding = emittedProgramBindingIndex(emission, actual.singletonBindingId);
  if (binding?.space !== "global") invalid("singleton binding space");
  const offset = module.imports.filter((row) => row.desc.kind === "global").length;
  const global = module.globals[binding.index - offset];
  if (
    !global ||
    global.mutable ||
    module.exports.some((row) => row.desc.kind === "global" && row.desc.index === binding.index)
  )
    invalid("internal readonly global slot");
  const indices: number[] = [];
  if (backend.backend === "wasmgc") {
    if (global.type.kind !== "ref") invalid("GC singleton carrier");
    const index = global.type.typeIdx;
    const type = indexPhysicalTypes(module.types).entries[index]?.definition;
    if (
      preparedIrDataMismatch(buildAnyValueType(), type) !== undefined ||
      preparedIrDataMismatch(buildUndefinedInitializer(index), global.init) !== undefined
    )
      invalid("canonical GC type/initializer");
    indices.push(index);
  } else {
    const memory = physical.linearMemory,
      description = memory?.numberUndefined,
      singleton = description?.singleton;
    if (
      !singleton ||
      global.type.kind !== "i32" ||
      !Number.isSafeInteger(singleton.offset) ||
      singleton.offset < 1024 ||
      singleton.offset % 8 ||
      singleton.alignment !== 8 ||
      singleton.bytes.length !== 16 ||
      memory?.heapPointer?.floor !== singleton.offset + 16 ||
      !memory.memory ||
      memory.memory.min * 65536 < singleton.offset + 16
    )
      invalid("checked Linear singleton geometry");
    const bytes = new Uint8Array(16),
      view = new DataView(bytes.buffer);
    view.setInt32(0, Number(JS_TAG_IDS.Undefined), true);
    view.setInt32(4, 8, true);
    view.setFloat64(8, NaN, true);
    if (
      preparedIrDataMismatch([...bytes], singleton.bytes) !== undefined ||
      preparedIrDataMismatch([{ op: "i32.const", value: singleton.offset }], global.init) !== undefined ||
      module.dataSegments.length !== 1 ||
      module.dataSegments[0]!.offset !== singleton.offset ||
      preparedIrDataMismatch([...module.dataSegments[0]!.bytes], singleton.bytes) !== undefined
    )
      invalid("canonical Linear singleton data/initializer");
  }
  // Every opaque population/initializer receipt is replayed after all descriptor reads.
  assertEmittedPreparedIrProgram(program, emission);
  if (preparedIrDataMismatch(actual, planNativeNumberUndefinedPhysical(program, projections[0]!)) !== undefined)
    invalid("changed canonical singleton proof");
  return Object.freeze({ bindingId: actual.singletonBindingId, carrierTypeIndices: Object.freeze(indices) });
}
