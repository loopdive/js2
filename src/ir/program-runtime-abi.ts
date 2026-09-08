// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "./callable-bindings.js";
import { createIrBindingId } from "./identity-values.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrSourceRecord, IrUnitInventory } from "../shared/contracts/ir-unit-inventory.js";
import { forEachInstrDeep } from "./nodes.js";
import type { IrFuncRef } from "./core/value-references.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import { preparedIrDataMismatch, preparedIrProgramOwner, PreparedIrProgramInvariantError } from "./program.js";
import type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./program/prepared-contracts.js";
import { irRuntimeCallableDeclaration, type IrRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";
import { collectNativeAsyncCallableDemands, IrNativeAsyncCallableError } from "./runtime/native-async-callables.js";
import { collectVectorCallableDemands, IrVectorCallableError } from "./runtime/vector-callables.js";

type RuntimeCallableInput = Pick<PreparedIrProgramProducerInput, "inventory" | "ir" | "derivedUnits">;

/** Shared ABI identity is anchored at the entry source, never at a guessed requesting unit. */
export function preparedIrRuntimeAbiAnchor(inventory: IrUnitInventory): IrSourceRecord {
  const entries = inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1)
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "runtime ABI requires one exact entry source");
  return entries[0]!;
}

export function preparedIrRuntimeCallableBindingId(inventory: IrUnitInventory, ref: IrFuncRef): IrBindingId {
  return createIrBindingId({
    ownerId: preparedIrRuntimeAbiAnchor(inventory).id,
    domain: "callable",
    role: irCallableBindingKey(ref.binding),
  });
}

/** Caller-supplied declaration data cannot replace the canonical runtime catalog. */
export function assertPreparedIrRuntimeCallableDeclaration(declaration: IrRuntimeCallableDeclaration): void {
  const canonical = irRuntimeCallableDeclaration(declaration.ref);
  if (!canonical || preparedIrDataMismatch(canonical, declaration) !== undefined)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime callable ${irCallableBindingKey(declaration.ref.binding)} contradicts its canonical declaration`,
    );
}

/** Ephemeral demand projection over the complete population; accepted bindings stay in the one ABI vector. */
export function prepareIrProgramRuntimeCallables(
  input: RuntimeCallableInput,
):
  | { readonly kind: "prepared"; readonly declarations: readonly IrRuntimeCallableDeclaration[] }
  | PreparedIrProgramFailure {
  assertPreparedIrProgramPopulation(input);
  const declarations = new Map<string, IrRuntimeCallableDeclaration>();
  for (const fn of input.ir.functions) {
    try {
      collectNativeAsyncCallableDemands([fn]);
      collectVectorCallableDemands([fn]);
    } catch (error) {
      if (!(error instanceof IrNativeAsyncCallableError) && !(error instanceof IrVectorCallableError)) throw error;
      const owner = preparedIrProgramOwner(input, fn.unitId);
      if (!owner) throw new PreparedIrProgramInvariantError("invalid-prepared-data", error.message);
      return Object.freeze({
        kind: "invariant",
        code: "verifier-failure",
        stage: "verify",
        detail: error.message,
        ...owner,
      });
    }
    let failure: PreparedIrProgramFailure | undefined;
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (failure) return;
          const ref =
            instruction.kind === "call"
              ? instruction.target
              : instruction.kind === "closure.new"
                ? instruction.liftedFunc
                : undefined;
          if (!ref || (ref.binding.kind !== "runtime" && ref.binding.kind !== "intrinsic")) return;
          const declaration = irRuntimeCallableDeclaration(ref);
          const key = irCallableBindingKey(ref.binding);
          if (declaration) {
            declarations.set(key, declaration);
            return;
          }
          // Other intrinsic families retain their existing independent admission paths.
          if (ref.binding.kind === "intrinsic") return;
          const owner = preparedIrProgramOwner(input, fn.unitId);
          if (!owner)
            throw new PreparedIrProgramInvariantError(
              "invalid-prepared-data",
              `runtime demand in ${fn.unitId} has no exact original owner`,
            );
          failure = Object.freeze({
            kind: "invariant",
            code: "unknown-function-ref",
            stage: "resolve",
            detail: `runtime callable ${key} has no canonical declaration`,
            ...owner,
          });
        });
    if (failure) return failure;
  }
  return Object.freeze({
    kind: "prepared",
    declarations: Object.freeze(
      [...declarations].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value),
    ),
  });
}
