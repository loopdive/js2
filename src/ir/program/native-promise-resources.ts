// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunction } from "../core/nodes.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { RuntimeProviderDefinition } from "../runtime/contracts/manifest.js";
import { ASYNC_RUNTIME_PROVIDERS } from "../runtime/async-providers.js";
import { assertPreparedIrAsyncRuntimeCurrent } from "../runtime/async-attachment.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { PreparedIrFunction } from "../runtime/contracts/prepared.js";
import type { ProgramAbiDerivedUnitRecord } from "./abi.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface NativePromiseOwner {
  readonly unitId: IrUnitId;
  readonly calls: readonly { readonly region: string; readonly ordinal: number; readonly bindingKey: string }[];
}
export interface NativePromiseConfiguration {
  readonly hooks: "disabled" | "dispatch";
  readonly unhandledRejections: "disabled" | "track";
}
export interface NativePromiseResourceInput {
  readonly anchor: string;
  readonly functions: readonly IrFunction[];
  readonly selectedFunctions: readonly PreparedIrFunction[];
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly abiEntries: readonly PreparedIrAbiEntry[];
  readonly policy: RuntimeManifestPolicy;
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  /** Supplied from selected runtime configuration, never inferred from missing bindings. */
  readonly configuration: NativePromiseConfiguration;
}
export interface NativePromiseResourcePlan {
  readonly anchor: string;
  readonly owners: readonly NativePromiseOwner[];
  readonly selectedOwners: readonly NativePromiseOwner[];
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly required: boolean;
  readonly configuration: NativePromiseConfiguration;
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly callableBindings: readonly PreparedIrAbiEntry[];
  readonly dependencies: readonly string[];
}
export const NATIVE_PROMISE_DEPENDENCIES = Object.freeze([
  "shared-externref-vector-array",
  "exception-tag",
  "number-box",
  "number-unbox",
  "number-classification",
  "canonical-tag-1-undefined",
  "type-error-constructor",
  "self-resolution-string",
  "then-string",
  "argument-vector-new",
  "argument-vector-push",
  "apply-closure",
  "then-vararg-dispatch",
  "settle-closure-root",
  "settle-closure-metadata",
  "finalized-object-closure-inventory",
] as const);

function fail(message: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Promise resources: ${message}`);
}

/** Derives requirements only. Whole-program/current-attachment authentication belongs to the checked parent wrapper. */
export function deriveNativePromiseResourcePlan(input: NativePromiseResourceInput): NativePromiseResourcePlan {
  if (!input.anchor) fail("missing source anchor");
  if (
    !input.configuration ||
    !["disabled", "dispatch"].includes(input.configuration.hooks) ||
    !["disabled", "track"].includes(input.configuration.unhandledRejections)
  )
    fail("missing explicit runtime configuration");
  const census = (functions: readonly PreparedIrFunction[], selected: boolean): NativePromiseOwner[] => {
    const seen = new Set<IrUnitId>();
    return functions.map((fn): NativePromiseOwner => {
      if (seen.has(fn.unitId)) fail("duplicate owner");
      seen.add(fn.unitId);
      const calls: NativePromiseOwner["calls"][number][] = [];
      const buffers = [
        ...fn.blocks.map((block, i) => ({ region: `block:${i}`, body: block.instrs })),
        ...((selected ? fn.asyncRuntime?.states : fn.asyncPlan?.states)?.map((state) => ({
          region: `state:${state.id}`,
          body: state.body,
        })) ?? []),
      ];
      for (const { region, body } of buffers) {
        let ordinal = 0;
        for (const root of body)
          forEachInstrDeep(root, (instr) => {
            const position = ordinal++;
            if (instr.kind === "call")
              calls.push({ region, ordinal: position, bindingKey: irCallableBindingKey(instr.target.binding) });
          });
      }
      return { unitId: fn.unitId, calls };
    });
  };
  if (!Array.isArray(input.selectedFunctions) || !Array.isArray(input.derivedUnits))
    fail("missing selected/derived population");
  const owners = census(input.functions, false),
    selectedOwners = census(input.selectedFunctions, true);
  if (
    preparedIrDataMismatch(
      owners.map((owner) => owner.unitId),
      selectedOwners.map((owner) => owner.unitId),
    ) !== undefined
  )
    fail("selected owner population/order differs");
  for (const [index, fn] of input.functions.entries()) {
    const selected = input.selectedFunctions[index]!;
    if (fn.asyncPlan) {
      // Projection preparation recreates the semantic plan. Compare those two
      // values, but authenticate identity against the selected owner's own plan.
      if (!selected.asyncPlan || preparedIrDataMismatch(selected.asyncPlan, fn.asyncPlan) !== undefined)
        fail("selected semantic async plan differs");
      const current = assertPreparedIrAsyncRuntimeCurrent(
        selected.unitId,
        selected.name,
        selected.asyncPlan,
        selected.asyncRuntime,
      );
      if (current.kind !== "standalone-native-wasmgc") fail("selected async attachment is not native");
    } else if (selected.asyncPlan || selected.asyncRuntime) {
      fail("selected async attachment has no semantic owner");
    }
  }
  const derived = new Set<IrUnitId>();
  for (const unit of input.derivedUnits) {
    if (derived.has(unit.id) || !owners.some((owner) => owner.unitId === unit.id))
      fail("derived owner is duplicate or absent");
    derived.add(unit.id);
  }
  const required =
    input.functions.some((fn) => fn.asyncPlan !== undefined) ||
    input.providers.some(
      (provider) => provider.feature.startsWith("promise.") || provider.feature.startsWith("scheduler."),
    );
  const providers: RuntimeProviderDefinition[] = [];
  if (required) {
    if (
      input.backend !== "wasmgc" ||
      input.target !== "standalone" ||
      input.policy.backend !== "wasmgc" ||
      input.policy.target !== "standalone"
    )
      fail("Promise pack requires selected standalone WasmGC policy");
    const demanded = new Set<string>([
      "promise.resolve",
      "promise.settle.fulfill",
      "promise.settle.reject",
      "scheduler.enqueue",
      "scheduler.drain",
    ]);
    for (const fn of input.functions) for (const feature of fn.asyncPlan?.runtimeIntents ?? []) demanded.add(feature);
    for (const provider of input.providers) {
      demanded.add(provider.feature);
      for (const feature of provider.dependencies) demanded.add(feature);
    }
    for (const canonical of ASYNC_RUNTIME_PROVIDERS.filter(
      (provider) => provider.id.startsWith("native.") && demanded.has(provider.feature),
    )) {
      const feature = canonical.feature;
      const rows = input.providers.filter((provider) => provider.feature === feature || provider.id === canonical.id);
      if (rows.length !== 1 || preparedIrDataMismatch(rows[0], canonical) !== undefined)
        fail(`noncanonical ${feature} provider`);
      providers.push(rows[0]!);
    }
  }
  const keys = new Set(owners.flatMap((owner) => owner.calls.map((call) => call.bindingKey)));
  const callableBindings = input.abiEntries.filter(
    (entry) => entry.contract.kind === "callable" && keys.has(irCallableBindingKey(entry.contract.ref.binding)),
  );
  return freezePreparedIrValue({
    anchor: input.anchor,
    owners,
    selectedOwners,
    derivedUnits: input.derivedUnits,
    required,
    configuration: input.configuration,
    providers,
    callableBindings,
    dependencies: required ? NATIVE_PROMISE_DEPENDENCIES : [],
  }) as NativePromiseResourcePlan;
}
