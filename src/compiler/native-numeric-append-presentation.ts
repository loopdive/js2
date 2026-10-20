// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrProgram, EmittedPreparedIrProgram, PreparedIrBackendOptions } from "../ir/program.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import {
  emittedPhysicalSetupPlan,
  emittedSupportFunctionReceipts,
  emittedProgramBindingIndex,
  emittedNativeVectorLayouts,
} from "../ir/program-consumer.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import { preparedIrRuntimeCallableBindingId } from "../ir/program-runtime-abi.js";
import {
  NUMERIC_APPEND_DECLARATION,
  NUMERIC_APPEND_RUNTIME_PROVIDERS,
} from "../ir/runtime/numeric-vector-callables.js";
import { describeLinearNumericVectorAppend } from "../wasm/physical/linear-vector-append.js";
import { describeGcNumericVectorAppend } from "../wasm/physical/gc-vector-append.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";

export interface CompletedNumericAppendPresentation {
  readonly bindingId?: IrBindingId;
  readonly supportKeys: readonly string[];
}
/** Join canonical DATA to the actual completed, immutable emission; names alone admit nothing. */
export function completedNumericAppendPresentation(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
): CompletedNumericAppendPresentation | undefined {
  const physical = emittedPhysicalSetupPlan(emission);
  if (physical.backend !== backend.backend || physical.target !== backend.target) return undefined;
  const views = program.runtime.filter((view) => view.backend === backend.backend && view.target === backend.target);
  if (views.length !== 1) return undefined;
  const canonical = NUMERIC_APPEND_RUNTIME_PROVIDERS[0]!;
  const providers = views[0]!.prepared.manifest.providers.filter(
    (provider) =>
      provider.id === canonical.id ||
      provider.feature === canonical.feature ||
      (provider.implementation.kind === "runtime-callable" &&
        canonical.implementation.kind === "runtime-callable" &&
        provider.implementation.symbol === canonical.implementation.symbol),
  );
  const binding = physical.vectors.numericAppendHelper;
  if (!binding) return providers.length ? undefined : { supportKeys: [] };
  if (
    providers.length !== 1 ||
    preparedIrDataMismatch(providers[0], canonical) !== undefined ||
    binding.bindingId !== preparedIrRuntimeCallableBindingId(program.inventory, NUMERIC_APPEND_DECLARATION.ref)
  )
    return undefined;
  const entries = program.abi.entries.filter((entry) => entry.plan.id === binding.bindingId),
    entry = entries[0];
  if (
    entries.length !== 1 ||
    !entry ||
    entry.contract.kind !== "callable" ||
    entry.plan.structuralReferenceKey !== binding.referenceKey ||
    entry.plan.slotPolicy !== "required" ||
    entry.plan.slotSpace !== "function" ||
    entry.contract.promise !== undefined ||
    preparedIrDataMismatch(
      [entry.contract.ref, entry.contract.params, entry.contract.results],
      [NUMERIC_APPEND_DECLARATION.ref, NUMERIC_APPEND_DECLARATION.params, NUMERIC_APPEND_DECLARATION.results],
    ) !== undefined
  )
    return undefined;
  const slot = emittedProgramBindingIndex(emission, binding.bindingId);
  const descriptor = physical.linearMemory?.functions.find((row) => row.role === "append-f64");
  const key = backend.backend === "linear" ? descriptor?.key : binding.bindingId;
  const support = emittedSupportFunctionReceipts(emission).filter((row) => row.key === key);
  if (!key || slot?.space !== "function" || support.length !== 1 || support[0]!.index !== slot.index) return undefined;
  const layouts = emittedNativeVectorLayouts(emission).filter((row) => row.elementValType.kind === "f64");
  const recipe =
    backend.backend === "linear"
      ? describeLinearNumericVectorAppend()
      : layouts.length === 1
        ? describeGcNumericVectorAppend(layouts[0]!.vecStructTypeIdx, layouts[0]!.arrayTypeIdx)
        : undefined;
  const imported = emission.module.imports.filter((row) => row.desc.kind === "func").length;
  const fn = emission.module.functions[slot.index - imported];
  const signature = fn && indexPhysicalTypes(emission.module.types).entries[fn.typeIdx]?.definition;
  if (
    !recipe ||
    !fn ||
    fn.name !== binding.name ||
    !fn.body.length ||
    signature?.kind !== "func" ||
    preparedIrDataMismatch(
      [signature.params, signature.results, fn.locals],
      [recipe.params, recipe.results, recipe.locals],
    ) !== undefined
  )
    return undefined;
  return { bindingId: binding.bindingId, supportKeys: [key] };
}
