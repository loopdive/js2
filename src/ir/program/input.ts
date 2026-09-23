// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { AllocSiteRegistry, copyIrPreparationData } from "../analysis/alloc-registry.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { TypedIrProgramInput, TypedIrProgramOptions } from "./input-contracts.js";
import { assertIrRuntimeSupport } from "./runtime-support.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function fields(value: object, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("typed input requires a data record");
  const actual = Reflect.ownKeys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
  )
    invalid(`typed input has missing or foreign fields (expected ${required.join(",")})`);
}

function dense(value: readonly unknown[]): void {
  if (!Array.isArray(value)) invalid("typed input requires an array");
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i)) invalid("typed input has a missing population slot");
}

/** A string-shaped owner is not evidence of ownership by this source's startup. */
function assertGlobalStorage(input: TypedIrProgramInput): void {
  const storageIds = new Set<string>();
  for (const { binding, identity } of input.globals) {
    const source = input.inventory.sources.filter((record) => record.id === identity.sourceId);
    const startup = input.startup.filter((plan) => plan.sourceId === identity.sourceId);
    const originals = input.inventory.allUnits.filter((unit) => unit.id === identity.storageOwnerUnitId);
    const terminals = input.inventory.terminalUnits.filter((unit) => unit.id === identity.storageOwnerUnitId);
    if (
      source.length !== 1 ||
      startup.length !== 1 ||
      startup[0]!.unitId !== identity.storageOwnerUnitId ||
      originals.length !== 1 ||
      terminals.length !== 1 ||
      originals[0]!.kind !== "module-init" ||
      originals[0]!.sourceId !== identity.sourceId ||
      !originals[0]!.terminal ||
      originals[0]!.terminalOwnerId !== identity.storageOwnerUnitId ||
      preparedIrDataMismatch(originals[0], terminals[0]) !== undefined
    )
      invalid("typed global lacks its exact inventoried source storage owner");
    const value = binding.globalRef;
    const tdz = binding.tdzGlobalRef;
    if (
      value?.kind !== "global" ||
      value.binding?.kind !== "source" ||
      typeof value.binding.bindingId !== "string" ||
      (tdz !== null &&
        (tdz?.kind !== "global" || tdz.binding?.kind !== "source" || typeof tdz.binding.bindingId !== "string"))
    )
      invalid("typed global requires source-owned value/TDZ references");
    const plan = startup[0]!;
    dense(plan.bindings);
    const declarations = plan.bindings.filter((entry) => entry.globalBindingId === value.binding.bindingId);
    if (declarations.length !== 1 || declarations[0]!.tdzBindingId !== (tdz?.binding.bindingId ?? null))
      invalid("typed global value/TDZ pair contradicts its same-source startup binding");
    for (const ref of [value, tdz]) {
      if (ref === null) continue;
      if (storageIds.has(ref.binding.bindingId)) invalid("typed global duplicates a storage binding");
      storageIds.add(ref.binding.bindingId);
    }
  }
}

/** Admission is structural; population and allocation semantics are checked later. */
export function ownTypedIrProgramInput(input: TypedIrProgramInput): {
  readonly input: TypedIrProgramInput;
  readonly allocations: AllocSiteRegistry;
} {
  // Inspect descriptors before reading any caller-supplied field. No getters run.
  const captured = copyIrPreparationData(input);
  fields(
    captured,
    ["inventory", "ir", "derivedUnits", "startup", "callables", "globals", "allocations"],
    ["runtimeSupport"],
  );
  fields(captured.inventory, ["sources", "classes", "allUnits", "terminalUnits"]);
  for (const values of [
    captured.inventory.sources,
    captured.inventory.classes,
    captured.inventory.allUnits,
    captured.inventory.terminalUnits,
    captured.derivedUnits,
    captured.startup,
    captured.callables,
    captured.globals,
  ])
    dense(values);
  fields(captured.ir, ["functions"], ["declaredSignatures", "declaredGlobals"]);
  dense(captured.ir.functions);
  for (const fn of captured.ir.functions) {
    if (!fn || typeof fn !== "object" || Object.hasOwn(fn, "asyncRuntime"))
      invalid("typed input cannot carry prepared runtime attachments");
  }
  for (const global of captured.globals) {
    fields(global, ["binding", "identity"]);
    fields(global.binding, ["globalRef", "tdzGlobalRef", "type"]);
    fields(global.identity, ["sourceId", "storageOwnerUnitId"]);
    if (typeof global.identity.sourceId !== "string" || typeof global.identity.storageOwnerUnitId !== "string")
      invalid("typed global lacks source/storage ownership");
  }
  assertGlobalStorage(captured);
  if (Object.hasOwn(captured, "runtimeSupport")) {
    if (captured.runtimeSupport === undefined) invalid("typed input must omit absent runtime support");
    assertIrRuntimeSupport(captured, captured.runtimeSupport);
  }
  // Joint restoration retains sharing between IR, sites, and metadata values.
  const restored = AllocSiteRegistry.restorePreparationData(captured.allocations, captured);
  return { input: restored.data, allocations: restored.allocations };
}

export function ownTypedIrProgramOptions(options: TypedIrProgramOptions): TypedIrProgramOptions {
  const captured = copyIrPreparationData(options);
  fields(captured, ["policy", "runtimePolicies", "controls"]);
  const controls = captured.controls;
  fields(controls, ["gvnMode", "ownership", "escape", "verifyIntermediateAllocations", "verifyDominanceNaive"]);
  if (
    !["off", "on", "poison"].includes(controls.gvnMode) ||
    [controls.ownership, controls.escape, controls.verifyIntermediateAllocations, controls.verifyDominanceNaive].some(
      (value) => typeof value !== "boolean",
    )
  )
    invalid("typed preparation requires complete explicit controls");
  dense(captured.runtimePolicies);
  const keys = new Set(captured.runtimePolicies.map((policy) => `${policy.backend}:${policy.target}`));
  if (
    keys.size !== captured.runtimePolicies.length ||
    !captured.runtimePolicies.some((policy) => preparedIrDataMismatch(policy, captured.policy) === undefined)
  )
    invalid("runtime policies duplicate a backend/target pair or omit the source preparation policy");
  return captured;
}
