// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { EmittedPreparedIrProgram, PreparedIrBackendOptions } from "../ir/program.js";
import { emittedPhysicalSetupPlan, emittedSupportFunctionReceipts } from "../ir/program-consumer.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";

/** Only the actual completed numeric memory pack may enlarge the support census. */
export function completedLinearMemorySupportKeys(
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
): readonly string[] | undefined {
  const physical = emittedPhysicalSetupPlan(emission);
  const plan = physical.linearMemory;
  if (!plan) return [];
  if (
    backend.backend !== "linear" ||
    (backend.target !== "standalone" && backend.target !== "wasi") ||
    physical.backend !== backend.backend ||
    physical.target !== backend.target ||
    plan.schema !== "prepared-linear-memory-v1"
  )
    return undefined;
  const mod = emission.module;
  const support = emittedSupportFunctionReceipts(emission);
  const keys = plan.functions.map((row) => row.key);
  if (new Set(keys).size !== keys.length || new Set(support.map((row) => row.index)).size !== support.length)
    return undefined;
  const importedFunctions = mod.imports.filter((row) => row.desc.kind === "func").length;
  for (const expected of plan.functions) {
    const rows = support.filter((row) => row.key === expected.key);
    if (rows.length !== 1) return undefined;
    const fn = mod.functions[rows[0]!.index - importedFunctions];
    if (!fn || fn.name !== expected.name || !fn.body.length) return undefined;
    const signature = mod.types[fn.typeIdx];
    if (
      !signature ||
      signature.kind !== "func" ||
      preparedIrDataMismatch(signature.params, expected.params) !== undefined ||
      preparedIrDataMismatch(signature.results, expected.results) !== undefined ||
      preparedIrDataMismatch(fn.locals, expected.locals) !== undefined
    )
      return undefined;
  }
  if (!plan.memory)
    return !plan.heapPointer &&
      !keys.length &&
      !plan.exports.length &&
      !plan.demand.occurrences.length &&
      !mod.memories.length
      ? keys
      : undefined;
  if (
    !plan.heapPointer ||
    !plan.demand.occurrences.length ||
    mod.memories.length !== 1 ||
    mod.memories[0]!.min !== plan.memory.min ||
    mod.memories[0]!.max !== plan.memory.max
  )
    return undefined;
  const heaps = mod.globals.filter((row) => row.name === plan.heapPointer!.name);
  if (
    heaps.length !== 1 ||
    heaps[0]!.type.kind !== "i32" ||
    !heaps[0]!.mutable ||
    preparedIrDataMismatch(heaps[0]!.init, [{ op: "i32.const", value: plan.heapPointer.floor }]) !== undefined
  )
    return undefined;
  const exports = mod.exports.filter((row) => row.desc.kind === "memory");
  if (exports.length !== plan.exports.length || plan.exports.length !== 1) return undefined;
  for (const expected of plan.exports) {
    if (
      expected.kind !== "memory" ||
      expected.targetKey !== plan.memory.key ||
      exports.filter((row) => row.name === expected.externalName && row.desc.index === 0).length !== 1
    )
      return undefined;
  }
  return keys;
}
