// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The runtime side of the Prepared presentation: the policy a presentation selects, and the census that
 * authenticates every selected runtime provider against the completed physical plan (the presentation's
 * `checkResourceDemand` asks it). A provider that does not join a completed physical row refuses.
 */

import { irRuntimeFuncRef } from "../ir/callable-bindings.js";
import type { EmittedPreparedIrProgram, PreparedIrBackendOptions, PreparedIrProgram } from "../ir/program.js";
import {
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedSupportFunctionReceipts,
} from "../ir/program-consumer.js";
import type { PhysicalSignatureType } from "../ir/program-physical-plan.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import type { RuntimeProviderDefinition } from "../ir/runtime/contracts/manifest.js";
import {
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
  irNumberRemainderCallableDeclaration,
} from "../ir/runtime/number-remainder-callables.js";
import type { ValType } from "../ir/types.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";

/**
 * (#7354 R) The runtime policy a Prepared presentation selects: on wasmgc standalone the number boundary is the
 * native value runtime (`__box_number` / `__unbox_number`), which the census below authenticates; every other
 * family and target keeps its default (unsupported).
 */
export function preparedPresentationPolicy(
  backend: PreparedIrBackendOptions["backend"],
  target: PreparedIrBackendOptions["target"],
): RuntimeManifestPolicy {
  return backend === "wasmgc" && target === "standalone"
    ? { backend, target, numberBoundary: { box: "native", unbox: "native" } }
    : { backend, target };
}

function physicalTypes(
  emission: EmittedPreparedIrProgram,
  types: readonly PhysicalSignatureType[],
): readonly ValType[] | undefined {
  const result: ValType[] = [];
  for (const type of types) {
    if (type.kind === "support-ref") {
      const slot = emittedProgramBindingIndex(emission, type.ref.binding.bindingId);
      if (slot?.space !== "type") return undefined;
      result.push({ kind: type.nullable ? "ref_null" : "ref", typeIdx: slot.index });
    } else if (
      type.kind === "vec" ||
      type.kind === "string" ||
      type.kind === "closure" ||
      type.kind === "callable" ||
      type.kind === "boxed"
    )
      return undefined;
    else result.push(type);
  }
  return result;
}
/** A completed function slot whose physical signature is `row`'s. */
export function physicalCallableMatches(
  emission: EmittedPreparedIrProgram,
  id: IrBindingId,
  row: { readonly params: readonly PhysicalSignatureType[]; readonly results: readonly PhysicalSignatureType[] },
): boolean {
  const slot = emittedProgramBindingIndex(emission, id);
  if (slot?.space !== "function") return false;
  const mod = emission.module;
  const imports = mod.imports.filter((entry) => entry.desc.kind === "func");
  const typeIdx = slot.index < imports.length ? imports[slot.index]!.desc : mod.functions[slot.index - imports.length];
  const signature = typeIdx && "typeIdx" in typeIdx ? mod.types[typeIdx.typeIdx] : undefined;
  const params = physicalTypes(emission, row.params),
    results = physicalTypes(emission, row.results);
  return Boolean(
    signature?.kind === "func" &&
    params &&
    results &&
    preparedIrDataMismatch(params, signature.params) === undefined &&
    preparedIrDataMismatch(results, signature.results) === undefined,
  );
}
/** Numeric finalization admits only exact completed canonical remainder supports. */
function numberRemainderSupportMatches(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  providers: readonly RuntimeProviderDefinition[],
): boolean {
  const physical = emittedPhysicalSetupPlan(emission);
  const support = emittedSupportFunctionReceipts(emission);
  if (
    !physical ||
    physical.numberRemainders.length !== providers.length ||
    new Set(physical.numberRemainders.map((row) => row.bindingId)).size !== providers.length ||
    new Set(providers.map((row) => row.id)).size !== providers.length
  )
    return false;
  return providers.every((provider) => {
    const canonical = NUMBER_REMAINDER_RUNTIME_PROVIDERS.find((row) => row.id === provider.id);
    if (
      !canonical ||
      preparedIrDataMismatch(canonical, provider) !== undefined ||
      canonical.implementation.kind !== "runtime-callable" ||
      provider.dependencies.length ||
      provider.hostCapabilities.length
    )
      return false;
    const symbol = canonical.implementation.symbol;
    const resources = physical.numberRemainders.filter((row) => row.symbol === symbol);
    if (resources.length !== 1) return false;
    const resource = resources[0]!;
    const entry = program.abi.entries.find((row) => row.plan.id === resource.bindingId);
    if (!entry || entry.contract.kind !== "callable") return false;
    const declaration = irNumberRemainderCallableDeclaration(entry.contract.ref);
    const slot = emittedProgramBindingIndex(emission, resource.bindingId);
    return (
      declaration?.feature === provider.feature &&
      entry.plan.structuralReferenceKey === resource.referenceKey &&
      preparedIrDataMismatch(entry.contract.params, declaration.params) === undefined &&
      preparedIrDataMismatch(entry.contract.results, declaration.results) === undefined &&
      slot?.space === "function" &&
      support.some((row) => row.key === resource.bindingId && row.index === slot.index) &&
      physicalCallableMatches(emission, resource.bindingId, {
        params: [{ kind: "f64" }, { kind: "f64" }],
        results: [{ kind: "f64" }],
      })
    );
  });
}
/**
 * (#7354 R) A selected native provider joins the completed native setup: exactly one setup binding whose
 * reference is the provider's runtime callable, its entry resolved by the completed emission to a function slot,
 * and a completed support receipt at that slot.
 */
function nativeProviderJoins(emission: EmittedPreparedIrProgram, provider: RuntimeProviderDefinition): boolean {
  const setup = emittedPhysicalSetupPlan(emission).nativeStrings;
  if (!setup || provider.implementation.kind !== "runtime-callable") return false;
  const reference = irRuntimeFuncRef(provider.implementation.symbol);
  const bindings = setup.bindings.filter((row) => preparedIrDataMismatch(row.reference, reference) === undefined);
  if (bindings.length !== 1) return false;
  const slot = emittedProgramBindingIndex(emission, bindings[0]!.entry.id);
  return slot?.space === "function" && emittedSupportFunctionReceipts(emission).some((row) => row.index === slot.index);
}
/**
 * The selected providers, each authenticated against the completed physical plan: the number remainders, and
 * (#7354 R, standalone) the native providers of the native setup. Without a native setup the numeric contract
 * stays exact: every support function is a remainder. Anything unauthenticated refuses.
 */
export function providerCensusMatches(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
  backend: PreparedIrBackendOptions,
  providers: readonly RuntimeProviderDefinition[],
): boolean {
  const isRemainder = (row: RuntimeProviderDefinition) =>
    NUMBER_REMAINDER_RUNTIME_PROVIDERS.some((canonical) => canonical.id === row.id);
  const remainders = providers.filter(isRemainder);
  const natives = providers.filter((row) => !isRemainder(row));
  const native = emittedPhysicalSetupPlan(emission).nativeStrings !== undefined;
  if (!numberRemainderSupportMatches(program, emission, remainders)) return false;
  if (!native) return natives.length === 0 && emittedSupportFunctionReceipts(emission).length === remainders.length;
  return (
    backend.target === "standalone" &&
    natives.every(
      (row) => !row.dependencies.length && !row.hostCapabilities.length && nativeProviderJoins(emission, row),
    )
  );
}
