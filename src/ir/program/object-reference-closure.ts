// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrModule } from "../core/nodes.js";
import { irTypeEquals, type IrType } from "../core/types.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { IrObjectReferencePlan } from "./object-reference-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `reference object call closure: ${detail}`);
}

function accepts(actual: IrType | undefined, expected: IrType): boolean {
  return (
    !!actual &&
    (irTypeEquals(actual, expected) ||
      (actual.kind === "vec" &&
        !actual.nullable &&
        expected.kind === "vec" &&
        expected.nullable &&
        irTypeEquals({ ...actual, nullable: true }, expected)))
  );
}

/** Validate complete declared contracts before optimizer rewrites can conceal a bad call. */
export function assertObjectReferenceCallClosure(
  input: { readonly ir: IrModule; readonly objectReferences?: IrObjectReferencePlan },
  entries: readonly PreparedIrAbiEntry[],
): void {
  if (!input.objectReferences) return;
  const calls = new Map(
    entries.flatMap((entry) =>
      entry.plan.slotPolicy !== "alias" && entry.contract.kind === "callable"
        ? [[irCallableBindingKey(entry.contract.ref.binding), entry.contract] as const]
        : [],
    ),
  );
  for (const fn of input.ir.functions) {
    const types = nativeAsyncCallableValueTypes(fn);
    const buffers = [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ];
    for (const buffer of buffers)
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "closure.new") {
            if (!calls.has(irCallableBindingKey(instruction.liftedFunc.binding)))
              invalid(`${fn.unitId}: unknown captured callable`);
            return;
          }
          if (instruction.kind !== "call") return;
          const key = irCallableBindingKey(instruction.target.binding),
            contract = calls.get(key);
          if (!contract) return invalid(`${fn.unitId}: undeclared callee ${key}`);
          if (
            instruction.args.length !== contract.params.length ||
            instruction.args.some((arg, index) => !accepts(types.get(arg), contract.params[index]!))
          )
            invalid(`${fn.unitId}: arguments disagree with declared callee ${key}`);
          if (
            contract.results.length > 1 ||
            (contract.results.length === 0
              ? instruction.result !== null || instruction.resultType !== null
              : instruction.result === null ||
                !instruction.resultType ||
                !irTypeEquals(instruction.resultType, contract.results[0]!))
          )
            invalid(`${fn.unitId}: result disagrees with declared callee ${key}`);
        });
  }
}
