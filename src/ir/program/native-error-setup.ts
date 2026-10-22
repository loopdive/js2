// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irRuntimeCallableDeclaration, REFERENCE_ERROR_RUNTIME_PROVIDERS } from "../runtime/callable-declarations.js";
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
): NativeErrorConstructorRequirements | undefined {
  const uses = demands.occurrences.filter(
    (row) =>
      demands.buffers[row.bufferIndex]?.view === "projection" &&
      row.instruction.kind === "call" &&
      irRuntimeCallableDeclaration(row.instruction.target)?.feature === "error.reference.construct",
  );
  if (!uses.length) return undefined;
  const canonical = REFERENCE_ERROR_RUNTIME_PROVIDERS.filter((row) => row.id === "native.error.reference.construct");
  if (canonical.length !== 1) fail("missing unique canonical ReferenceError provider");
  const provider = canonical[0]!,
    manifest = demands.projection.prepared.manifest;
  const selected = manifest.providers.filter((row) => row.feature === provider.feature || row.id === provider.id);
  if (selected.length !== 1) fail("missing unique selected ReferenceError provider");
  same(selected[0], provider, "noncanonical selected ReferenceError provider");
  if (provider.implementation.kind !== "runtime-callable" || !provider.signature)
    fail("ReferenceError is not callable");
  const reference = irRuntimeFuncRef(provider.implementation.symbol),
    declaration = irRuntimeCallableDeclaration(reference);
  if (!declaration) fail("ReferenceError has no semantic callable declaration");
  same(provider.signature.params, declaration.params, "ReferenceError parameter contract diverged");
  same([provider.signature.result], declaration.results, "ReferenceError result contract diverged");
  for (const use of uses) {
    if (use.instruction.kind !== "call") fail("ReferenceError occurrence changed kind");
    same(use.instruction.target.binding, reference.binding, "ReferenceError target diverged");
  }
  const source = demands.program.inventory.sources.find((row) => row.kind === "entry");
  if (!source) fail("missing actual entry source");
  return { key: "native-errors:v1:" + JSON.stringify(source.id), kind: "ReferenceError" };
}

/** Join the existing semantic ABI root to its actual physical constructor. */
export function nativeErrorAbiBindings(input: NativeStringValueReservationInput, baseOrder: number) {
  const requirements = selectNativeErrorConstructorRequirements(input.demands);
  same(input.plan.error, requirements, "error selection changed");
  if (!requirements) return [];
  const { program } = input.demands,
    reference = irRuntimeFuncRef("__new_ReferenceError");
  const declaration = irRuntimeCallableDeclaration(reference);
  if (!declaration) fail("missing ReferenceError declaration");
  const index = input.plan.declarations.findIndex((row) => row.key === requirements.key + ":new-ReferenceError");
  const resource = input.plan.declarations[index];
  if (!resource || resource.space !== "function") fail("missing ReferenceError resource");
  const physical = { params: [{ kind: "externref" }], results: [{ kind: "externref" }] };
  same(resource.signature, physical, "ReferenceError physical signature diverged");
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
      "existing ReferenceError ABI differs",
    );
    if (old.contract.kind !== "callable" || Object.hasOwn(old.contract, "promise"))
      fail("ReferenceError ABI is not synchronous callable");
    same(old.contract.ref.binding, reference.binding, "existing ReferenceError reference differs");
    same(
      preparedIrCallableSignature(old.contract.params, old.contract.results),
      signature,
      "existing ReferenceError signature differs",
    );
  }
  return [{ resourceKey: resource.key, reference, entry: old?.plan ?? entry }];
}
