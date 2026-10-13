// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, forEachNestedBuffer, type IrModule, type IrInstr } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { irGlobalBindingKey } from "../../core/global-binding-keys.js";
import { numericVector } from "./structured-vector-facts.js";
import type { AllocationEvidenceFailure } from "./contracts.js";
export interface NativeModuleGlobalEvidence {
  readonly type: IrType;
  readonly owner: IrUnitId;
  readonly tdzKey?: string;
}
/** Complete initialization and protected-flag writer census, independent of producer annotations. */
export function checkNativeModuleVectorWriters(
  module: IrModule,
  globals: ReadonlyMap<string, NativeModuleGlobalEvidence>,
): AllocationEvidenceFailure | undefined {
  const vectors = [...globals].filter(([, contract]) => numericVector(contract.type));
  const owners = new Set(vectors.map(([, contract]) => contract.owner));
  const protectedKeys = new Map<string, NativeModuleGlobalEvidence>();
  for (const [key, contract] of vectors) {
    if (!contract.tdzKey) return { kind: "invalid", code: "allocation-provenance", at: { kind: "module" } };
    protectedKeys.set(key, contract);
    protectedKeys.set(contract.tdzKey, contract);
  }
  const counts = new Map<string, number>(),
    positions = new Map<string, { buffer: readonly IrInstr[]; index: number }>();
  let failure: AllocationEvidenceFailure | undefined;
  for (const fn of module.functions)
    for (const block of fn.blocks)
      block.instrs.forEach((root, index) =>
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "call" && instr.target.binding.kind === "unit" && owners.has(instr.target.binding.unitId))
            failure = { kind: "invalid", code: "allocation-provenance", at: { kind: "function", unitId: fn.unitId } };
          if (instr.kind !== "global.set") return;
          const key = irGlobalBindingKey(instr.target.binding),
            contract = protectedKeys.get(key);
          if (!contract) return;
          if (fn.unitId !== contract.owner || root !== instr)
            failure = { kind: "invalid", code: "allocation-provenance", at: { kind: "function", unitId: fn.unitId } };
          if (key === contract.tdzKey) {
            const one = block.instrs[index - 1];
            if (
              one?.kind !== "const" ||
              one.value.kind !== "i32" ||
              one.value.value !== 1 ||
              one.result !== instr.value
            )
              failure = { kind: "invalid", code: "lexical-definition", at: { kind: "function", unitId: fn.unitId } };
          }
          counts.set(key, (counts.get(key) ?? 0) + 1);
          positions.set(key, { buffer: block.instrs, index });
        }),
      );
  if (failure) return failure;
  for (const [key, contract] of vectors) {
    const value = positions.get(key),
      flag = positions.get(contract.tdzKey!);
    if (
      counts.get(key) !== 1 ||
      counts.get(contract.tdzKey!) !== 1 ||
      !value ||
      !flag ||
      value.buffer !== flag.buffer ||
      value.index >= flag.index
    )
      return { kind: "invalid", code: "occurrence-mismatch", at: { kind: "module" } };
  }
  return undefined;
}
/** Genuine logical reads retain their exact original ReferenceError guard in every projection. */
export function checkNativeModuleVectorReads(
  module: IrModule,
  globals: ReadonlyMap<string, NativeModuleGlobalEvidence>,
): AllocationEvidenceFailure | undefined {
  if (![...globals.values()].some((contract) => numericVector(contract.type))) return undefined;
  for (const fn of module.functions) {
    const active = new Set<readonly IrInstr[]>();
    let failure: AllocationEvidenceFailure | undefined;
    const visit = (buffer: readonly IrInstr[], depth: number, inherited: ReadonlySet<string>): void => {
      const initialized = new Set(inherited);
      if (active.has(buffer)) {
        failure = { kind: "invalid", code: "occurrence-mismatch", at: { kind: "function", unitId: fn.unitId } };
        return;
      }
      if (depth > 128) {
        failure = { kind: "not-covered", reason: "resource-limit", at: { kind: "function", unitId: fn.unitId } };
        return;
      }
      active.add(buffer);
      buffer.forEach((instr, index) => {
        if (instr.kind === "global.get") {
          const contract = globals.get(irGlobalBindingKey(instr.target.binding));
          if (contract && numericVector(contract.type) && (!contract.tdzKey || !initialized.has(contract.tdzKey))) {
            const get = buffer[index - 3],
              eqz = buffer[index - 2],
              guard = buffer[index - 1];
            const then = guard?.kind === "if.stmt" ? guard.then : [];
            const nil = then[0],
              call = then[1],
              throw_ = then[2];
            if (
              !contract.tdzKey ||
              get?.kind !== "global.get" ||
              irGlobalBindingKey(get.target.binding) !== contract.tdzKey ||
              eqz?.kind !== "unary" ||
              eqz.op !== "i32.eqz" ||
              eqz.rand !== get.result ||
              guard?.kind !== "if.stmt" ||
              guard.cond !== eqz.result ||
              guard.else.length !== 0 ||
              then.length !== 3 ||
              nil?.kind !== "const" ||
              nil.value.kind !== "null" ||
              call?.kind !== "call" ||
              call.target.binding.kind !== "runtime" ||
              call.target.binding.symbol !== "__new_ReferenceError" ||
              call.args.length !== 1 ||
              call.args[0] !== nil.result ||
              call.result === null ||
              throw_?.kind !== "throw" ||
              throw_.value !== call.result
            )
              failure = { kind: "invalid", code: "lexical-definition", at: { kind: "function", unitId: fn.unitId } };
          }
        }
        if (instr.kind === "global.set") {
          const key = irGlobalBindingKey(instr.target.binding);
          if ([...globals.values()].some((row) => numericVector(row.type) && row.tdzKey === key)) initialized.add(key);
        }
        forEachNestedBuffer(instr, (child) => visit(child, depth + 1, initialized));
      });
      active.delete(buffer);
    };
    for (const block of fn.blocks) visit(block.instrs, 0, new Set());
    if (failure) return failure;
  }
  return undefined;
}
