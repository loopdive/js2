// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { numericVector } from "../analysis/allocation-evidence/structured-vector-facts.js";
import type { NativeModuleGlobalEvidence } from "../analysis/allocation-evidence/module-vector-globals.js";
/** Ephemeral index of the existing canonical contracts, never a second persisted identity map. */
export function nativeModuleGlobalEvidence(
  program: PreparedIrProgram,
): ReadonlyMap<string, NativeModuleGlobalEvidence> {
  const globals = new Map<string, NativeModuleGlobalEvidence>();
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native module vector: ${detail}`);
  };
  for (const { plan, contract } of program.abi.entries) {
    if (
      contract.kind !== "global" ||
      contract.ref.binding.kind !== "source" ||
      plan.intent.kind !== "global" ||
      plan.intent.origin !== "source"
    )
      continue;
    const key = irGlobalBindingKey(contract.ref.binding);
    const owner = plan.intent.unitId;
    if (owner === undefined) return invalid("source global has no canonical storage owner");
    if (globals.has(key)) invalid("duplicate global contract");
    let tdzKey: string | undefined;
    if (numericVector(contract.type)) {
      const owners = program.startup.filter((row) =>
        row.bindings.some(
          (binding) =>
            binding.globalBindingId === plan.id && binding.declarationKind === "const" && binding.tdzBindingId !== null,
        ),
      );
      if (
        owners.length !== 1 ||
        owners[0]!.unitId !== plan.intent.unitId ||
        owners[0]!.sourceId !== plan.intent.sourceId ||
        contract.type.kind !== "vec" ||
        contract.type.nullable
      )
        invalid("vector storage lost its original const/startup owner");
      const binding = owners[0]?.bindings.find((row) => row.globalBindingId === plan.id);
      if (binding?.tdzBindingId == null) return invalid("vector storage lost its canonical TDZ binding");
      const tdz = program.abi.entries.find((row) => row.plan.id === binding.tdzBindingId);
      if (
        !tdz ||
        tdz.contract.kind !== "global" ||
        tdz.contract.ref.binding.kind !== "source" ||
        tdz.contract.type.kind !== "val" ||
        tdz.contract.type.val.kind !== "i32" ||
        !tdz.contract.mutable ||
        tdz.plan.intent.kind !== "global" ||
        tdz.plan.intent.origin !== "source" ||
        tdz.plan.intent.unitId !== owner ||
        tdz.plan.intent.sourceId !== plan.intent.sourceId
      )
        return invalid("vector TDZ contract differs from its original owner");
      tdzKey = irGlobalBindingKey(tdz.contract.ref.binding);
    }
    globals.set(key, { type: contract.type, owner, ...(tdzKey === undefined ? {} : { tdzKey }) });
  }
  return globals;
}
