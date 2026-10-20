// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { EmittedPreparedIrProgram, PreparedIrBackendOptions, PreparedIrProgram } from "../ir/program.js";
import {
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedReferenceErrorResourceReceipt,
  emittedSupportFunctionReceipts,
} from "../ir/program-consumer.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import { REFERENCE_ERROR_DECLARATION, referenceErrorProviderMismatch } from "../ir/runtime/reference-error-callable.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";

export interface CompletedErrorPresentation {
  readonly bindingId?: IrBindingId;
  readonly supportKeys: readonly string[];
  readonly ownedRecords: ReadonlySet<object>;
}

/** Only an authenticated completed canonical Error pack can extend numeric presentation. */
export function completedErrorPresentation(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
): CompletedErrorPresentation | undefined {
  const physical = emittedPhysicalSetupPlan(emission);
  const receipt = emittedReferenceErrorResourceReceipt(emission);
  const plan = physical.referenceError;
  if (!plan) return receipt ? undefined : { supportKeys: [], ownedRecords: new Set() };
  if (
    !receipt ||
    physical.backend !== backend.backend ||
    physical.target !== backend.target ||
    (backend.target !== "standalone" && backend.target !== "wasi") ||
    receipt.bindingId !== plan.bindingId ||
    receipt.referenceKey !== plan.referenceKey
  )
    return undefined;
  const runtime = program.runtime.filter((row) => row.backend === backend.backend && row.target === backend.target);
  const providers = runtime
    .flatMap((row) => row.prepared.manifest.providers)
    .filter((row) => row.feature === REFERENCE_ERROR_DECLARATION.feature);
  const entries = program.abi.entries.filter((row) => row.plan.id === plan.bindingId);
  const entry = entries[0];
  const binding = emittedProgramBindingIndex(emission, plan.bindingId);
  if (
    runtime.length !== 1 ||
    providers.length !== 1 ||
    providers[0]!.id !== "native.error.reference.construct" ||
    referenceErrorProviderMismatch(providers[0]!) ||
    !providers[0]!.supportedBackends.includes(backend.backend) ||
    entries.length !== 1 ||
    !entry ||
    entry.contract.kind !== "callable" ||
    entry.plan.structuralReferenceKey !== plan.referenceKey ||
    preparedIrDataMismatch(entry.contract.ref, REFERENCE_ERROR_DECLARATION.ref) !== undefined ||
    preparedIrDataMismatch(entry.contract.params, REFERENCE_ERROR_DECLARATION.params) !== undefined ||
    preparedIrDataMismatch(entry.contract.results, REFERENCE_ERROR_DECLARATION.results) !== undefined ||
    entry.contract.promise !== undefined ||
    binding?.space !== "function" ||
    binding.index !== receipt.constructor.index
  )
    return undefined;
  const support = emittedSupportFunctionReceipts(emission);
  const keys = receipt.functions.map((row) => row.supportKey);
  if (
    new Set(keys).size !== keys.length ||
    receipt.functions.some(
      (row) => support.filter((actual) => actual.key === row.supportKey && actual.index === row.index).length !== 1,
    )
  )
    return undefined;
  const mod = emission.module;
  const types = indexPhysicalTypes(mod.types).entries;
  const ownedRecords = new Set<object>();
  for (const row of receipt.types) {
    const definition = types[row.index]!.definition;
    ownedRecords.add(definition);
    if (definition.kind === "sub") ownedRecords.add(definition.type);
  }
  const functionOffset = mod.imports.filter((row) => row.desc.kind === "func").length;
  const globalOffset = mod.imports.filter((row) => row.desc.kind === "global").length;
  for (const row of receipt.functions) ownedRecords.add(mod.functions[row.index - functionOffset]!);
  for (const row of receipt.globals) ownedRecords.add(mod.globals[row.index - globalOffset]!);
  return { bindingId: plan.bindingId, supportKeys: keys, ownedRecords };
}
