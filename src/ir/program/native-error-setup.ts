// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import {
  nativeErrorConstructorProvider,
  NATIVE_ERROR_CONSTRUCTOR_KINDS,
  type NativeErrorConstructorKind,
} from "../runtime/error-callables.js";
import { irCallableBindingKey, irRuntimeFuncRef } from "../core/callable-bindings.js";
import { preparedIrDataMismatch } from "./data.js";
import { preparedIrCallableSignature } from "./abi-signatures.js";
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "./runtime-abi-identity.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { NativeStringValueDemands } from "./native-string-value-demands.js";
import type { NativeStringValueReservationInput } from "../../backend/wasmgc/program/native-string-values.js";
import type { NativeErrorConstructorRequirements } from "../../backend/wasmgc/resources/native-error-constructor.js";

function fail(detail: string): never {
  throw new Error("native error ABI: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

/** Reuse the complete source/projection census; no error-specific AST or body walker. */
export function selectNativeErrorConstructorRequirements(
  demands: NativeStringValueDemands,
  kind: NativeErrorConstructorKind = "ReferenceError",
): NativeErrorConstructorRequirements | undefined {
  const provider = nativeErrorConstructorProvider(kind);
  const uses = demands.occurrences.filter(
    (row) =>
      demands.buffers[row.bufferIndex]?.view === "projection" &&
      row.instruction.kind === "call" &&
      irRuntimeCallableDeclaration(row.instruction.target)?.feature === provider.feature,
  );
  if (!uses.length) return undefined;
  const selected = demands.projection.prepared.manifest.providers.filter(
    (row) => row.feature === provider.feature || row.id === provider.id,
  );
  if (selected.length !== 1) fail(`missing unique selected ${kind} provider`);
  same(selected[0], provider, `noncanonical selected ${kind} provider`);
  if (provider.implementation.kind !== "runtime-callable" || !provider.signature) fail(`${kind} is not callable`);
  const reference = irRuntimeFuncRef(provider.implementation.symbol),
    declaration = irRuntimeCallableDeclaration(reference);
  if (!declaration) fail(`${kind} has no semantic callable declaration`);
  same(provider.signature.params, declaration.params, `${kind} parameter contract diverged`);
  same([provider.signature.result], declaration.results, `${kind} result contract diverged`);
  for (const use of uses) {
    if (use.instruction.kind !== "call") fail(`${kind} occurrence changed kind`);
    same(use.instruction.target.binding, reference.binding, `${kind} target diverged`);
  }
  const source = demands.program.inventory.sources.find((row) => row.kind === "entry");
  if (!source) fail("missing actual entry source");
  return {
    key: "native-errors:v1:" + JSON.stringify(source.id) + (kind === "ReferenceError" ? "" : ":TypeError"),
    kind,
  };
}

export function selectNativeErrorConstructors(
  demands: NativeStringValueDemands,
): readonly NativeErrorConstructorRequirements[] {
  return NATIVE_ERROR_CONSTRUCTOR_KINDS.flatMap((kind) => {
    const value = selectNativeErrorConstructorRequirements(demands, kind);
    return value ? [value] : [];
  });
}

/** Join every selected semantic ABI root to its actual physical constructor. */
export function nativeErrorAbiBindings(input: NativeStringValueReservationInput, baseOrder: number) {
  const requirements = selectNativeErrorConstructors(input.demands);
  same(input.plan.errors ?? [], requirements, "error selection changed");
  return requirements.map((requirement) => errorBinding(input, baseOrder, requirement));
}
function errorBinding(
  input: NativeStringValueReservationInput,
  baseOrder: number,
  requirements: NativeErrorConstructorRequirements,
) {
  const { program } = input.demands,
    reference = irRuntimeFuncRef("__new_" + requirements.kind);
  const declaration = irRuntimeCallableDeclaration(reference);
  if (!declaration) fail("missing error constructor declaration");
  const index = input.plan.declarations.findIndex((row) => row.key === requirements.key + ":new-" + requirements.kind);
  const resource = input.plan.declarations[index];
  if (!resource || resource.space !== "function") fail("missing error constructor resource");
  const physical = { params: [{ kind: "externref" }], results: [{ kind: "externref" }] };
  same(resource.signature, physical, "error constructor physical signature diverged");
  const signature = preparedIrCallableSignature(declaration.params, declaration.results);
  const id = preparedIrRuntimeCallableBindingId(program.inventory, reference);
  const entry: ProgramAbiPlanEntry = {
    id,
    order: { sourceOrder: preparedIrRuntimeAbiAnchor(program.inventory).order, declarationOrder: baseOrder + index },
    displayName: reference.name,
    structuralReferenceKey: irCallableBindingKey(reference.binding),
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "runtime", signature },
  };
  const old = program.abi.entries.find((row) => row.plan.id === id);
  if (old) {
    same(
      old.plan,
      { ...entry, order: old.plan.order, displayName: old.plan.displayName },
      "existing error constructor ABI differs",
    );
    if (old.contract.kind !== "callable" || Object.hasOwn(old.contract, "promise"))
      fail("error constructor ABI is not synchronous callable");
    same(old.contract.ref.binding, reference.binding, "existing error constructor reference differs");
    same(
      preparedIrCallableSignature(old.contract.params, old.contract.results),
      signature,
      "existing error constructor signature differs",
    );
  }
  return { resourceKey: resource.key, reference, entry: old?.plan ?? entry };
}
