// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "../core/callable-bindings.js";
import { forEachInstrDeep } from "../core/nodes.js";
import { assertPreparedIrProgramPopulation } from "./population.js";
import { preparedIrDataMismatch } from "./data.js";
import { preparedIrProgramOwner } from "./owner.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./prepared-contracts.js";
import { irRuntimeCallableDeclaration, type IrRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import {
  collectNativeAsyncCallableDemands,
  IrNativeAsyncCallableError,
  nativeAsyncCallableValueTypes,
} from "../runtime/native-async-callables.js";
import { collectVectorCallableDemands, IrVectorCallableError } from "../runtime/vector-callables.js";

type RuntimeCallableInput = Pick<PreparedIrProgramProducerInput, "inventory" | "ir" | "derivedUnits">;

export { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "./runtime-abi-identity.js";

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
    let types: ReturnType<typeof nativeAsyncCallableValueTypes> | undefined;
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
          // (#7354 D1) A front-end dynamic helper (`__ir_dyn_add`, …) over a dynamic
          // value is a capability the Prepared path lacks, not a broken program.
          types ??= nativeAsyncCallableValueTypes(fn);
          const dynamic =
            instruction.kind === "call" &&
            [instruction.resultType, ...instruction.args.map((arg) => types!.get(arg))].some(
              (type) => type?.kind === "dynamic",
            );
          failure = Object.freeze(
            dynamic
              ? {
                  kind: "unsupported",
                  code: "body-shape-rejected",
                  stage: "resolve",
                  detail: `dynamic operation ${ref.name} has no Prepared intrinsic`,
                  ...owner,
                }
              : {
                  kind: "invariant",
                  code: "unknown-function-ref",
                  stage: "resolve",
                  detail: `runtime callable ${key} has no canonical declaration`,
                  ...owner,
                },
          );
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
