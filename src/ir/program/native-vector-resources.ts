// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { forEachInstrDeep, type IrFunction } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import {
  VECTOR_CALLABLE_DECLARATION,
  VECTOR_CALLABLE_RUNTIME_PROVIDERS,
  collectVectorCallableDemands,
  vectorProviderMismatch,
  vectorCallablePolicyMismatch,
  type IrVectorCallableDemand,
} from "../runtime/vector-callables.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { RuntimeProviderDefinition } from "../runtime/contracts/manifest.js";

export type NativeVectorElement = "f64" | "externref";
export interface NativeVectorResourcePlan {
  readonly anchor: string;
  readonly layouts: readonly NativeVectorElement[];
  /** Complete semantic owner population, including owners with no vector calls. */
  readonly demands: readonly IrVectorCallableDemand[];
  readonly helper?: {
    readonly bindingId: IrBindingId;
    readonly referenceKey: string;
    readonly name: string;
  };
  readonly exceptionRequired: boolean;
}

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native vector resources: ${detail}`);
}

export interface NativeVectorResourceInput {
  readonly anchor: string;
  readonly functions: readonly IrFunction[];
  readonly abiEntries: readonly PreparedIrAbiEntry[];
  readonly policy: RuntimeManifestPolicy;
  readonly providers: readonly RuntimeProviderDefinition[];
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
}

/** Pure bounded discovery, not program authentication or an emission acceptance capability. */
export function deriveNativeVectorResourcePlan(input: NativeVectorResourceInput): NativeVectorResourcePlan {
  if (!input.anchor) fail("missing entry-source anchor");
  const demands = collectVectorCallableDemands(input.functions);
  const layouts = new Set<NativeVectorElement>();
  const supported = input.backend === "wasmgc" && input.target === "standalone";
  const note = (type: IrType): void => {
    if (!supported || type.kind !== "vec" || type.layout || type.elementType.kind !== "val" || type.elementType.typeRef)
      return;
    const kind = type.elementType.val.kind;
    if (kind === "f64" || kind === "externref") layouts.add(kind);
  };
  for (const fn of input.functions) {
    fn.params.forEach((param) => note(param.type));
    fn.resultTypes.forEach(note);
    fn.asyncPlan?.values.forEach((value) => note(value.type));
    for (const block of fn.blocks) block.blockArgTypes.forEach(note);
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const instr of buffer)
        forEachInstrDeep(instr, (item) => {
          if (item.resultType) note(item.resultType);
        });
  }
  for (const abi of input.abiEntries) {
    if (abi.contract.kind === "callable") {
      abi.contract.params.forEach(note);
      abi.contract.results.forEach(note);
    }
  }
  let helper: NativeVectorResourcePlan["helper"];
  if (supported && demands.some((owner) => owner.uses.length > 0)) {
    const declaration = VECTOR_CALLABLE_DECLARATION;
    const policyError = vectorCallablePolicyMismatch(declaration.feature, input.policy);
    if (policyError) fail(policyError);
    const canonical = VECTOR_CALLABLE_RUNTIME_PROVIDERS[0]!;
    const providers = input.providers.filter(
      (provider) =>
        provider.feature === canonical.feature ||
        provider.id === canonical.id ||
        (provider.implementation.kind === "runtime-callable" &&
          canonical.implementation.kind === "runtime-callable" &&
          provider.implementation.symbol === canonical.implementation.symbol),
    );
    if (
      providers.length !== 1 ||
      providers[0]!.id !== canonical.id ||
      providers[0]!.feature !== canonical.feature ||
      vectorProviderMismatch(providers[0]!) !== undefined
    )
      fail("noncanonical selected vector provider");
    const referenceKey = irCallableBindingKey(declaration.ref.binding);
    const entries = input.abiEntries.filter(
      (abi) => abi.contract.kind === "callable" && irCallableBindingKey(abi.contract.ref.binding) === referenceKey,
    );
    const abi = entries[0];
    if (
      entries.length !== 1 ||
      !abi ||
      abi.contract.kind !== "callable" ||
      abi.plan.slotPolicy !== "required" ||
      abi.plan.slotSpace !== "function" ||
      preparedIrDataMismatch(declaration.params, abi.contract.params) !== undefined ||
      preparedIrDataMismatch(declaration.results, abi.contract.results) !== undefined
    )
      fail("noncanonical vector callable ABI declaration");
    helper = { bindingId: abi.plan.id, referenceKey, name: declaration.ref.name };
    layouts.add("externref");
  }
  return freezePreparedIrValue({
    anchor: input.anchor,
    layouts: (["f64", "externref"] as const).filter((element) => layouts.has(element)),
    demands,
    ...(helper ? { helper } : {}),
    exceptionRequired: helper !== undefined,
  }) as NativeVectorResourcePlan;
}
