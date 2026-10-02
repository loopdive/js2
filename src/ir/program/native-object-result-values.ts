// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { closureSignatureEquals, type IrInstr, type IrType, type IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeStringValueDemands, NativeStringValueView } from "./native-string-value-demands.js";

export interface ObjectResultDefinition {
  readonly instruction: IrInstr;
  readonly occurrence: number;
}
export function objectResultDefinitions(
  demands: NativeStringValueDemands,
  unitId: IrUnitId,
  view: NativeStringValueView,
) {
  const definitions = new Map<IrValueId, ObjectResultDefinition>();
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const buffer = demands.buffers[row.bufferIndex]!;
    if (buffer.ownerUnitId !== unitId || buffer.view !== view || row.instruction.result === null) continue;
    if (definitions.has(row.instruction.result)) throw new Error("ordinary Get result proof: ambiguous SSA definition");
    definitions.set(row.instruction.result, { occurrence, instruction: row.instruction });
  }
  return definitions;
}
export function objectResultOriginal(value: IrValueId, definitions: ReadonlyMap<IrValueId, ObjectResultDefinition>) {
  const seen = new Set<IrValueId>();
  for (;;) {
    if (seen.has(value)) throw new Error("ordinary Get result proof: cyclic representation alias");
    seen.add(value);
    const row = definitions.get(value);
    if (row?.instruction.kind !== "coerce.to_externref") return row;
    value = row.instruction.value;
  }
}
export function objectResultIsBoolean(type: IrType | null | undefined): boolean {
  return type?.kind === "val" && !type.typeRef && type.val.kind === "i32" && type.val.boolean === true;
}

/** Prove producers, never the erasable i32 brand or a callable annotation alone. */
export function proveObjectResultValue(
  source: NativeSourceClosureRequirements,
  ownerUnitId: IrUnitId,
  view: NativeStringValueView,
  value: IrValueId,
  expected: IrType,
  external: boolean,
): readonly number[] | undefined {
  const definitions = objectResultDefinitions(source.demands, ownerUnitId, view);
  const active = new Set<IrValueId>();
  const prove = (id: IrValueId, boxed: boolean): readonly number[] | undefined => {
    if (active.has(id)) return undefined;
    active.add(id);
    try {
      const definition = definitions.get(id),
        instruction = definition?.instruction;
      if (!instruction) return undefined;
      if (instruction.kind === "coerce.to_externref") {
        const input = definitions.get(instruction.value)?.instruction.resultType;
        if (input?.kind === "callable" || input?.kind === "closure") return prove(instruction.value, false);
        if (input?.kind === "extern" || (input?.kind === "val" && !input.typeRef && input.val.kind === "externref"))
          return prove(instruction.value, boxed);
        return undefined; // a scalar-to-reference instruction cannot substitute for the real Boolean boxer
      }
      if (objectResultIsBoolean(expected)) {
        if (boxed)
          return instruction.kind === "intrinsic" &&
            instruction.id === "js.boolean.box" &&
            instruction.args.length === 1
            ? prove(instruction.args[0]!, false)
            : undefined;
        if (
          instruction.kind === "const" &&
          instruction.value.kind === "bool" &&
          typeof instruction.value.value === "boolean" &&
          objectResultIsBoolean(instruction.resultType)
        )
          return [];
        if (
          instruction.kind === "unary" &&
          instruction.op === "i32.eqz" &&
          objectResultIsBoolean(instruction.resultType)
        )
          return [];
        if (
          instruction.kind === "binary" &&
          objectResultIsBoolean(instruction.resultType) &&
          /^(?:i32|i64|f32|f64)\.(?:eq|ne|lt(?:_[su])?|le(?:_[su])?|gt(?:_[su])?|ge(?:_[su])?)$/.test(instruction.op)
        )
          return [];
      } else if (
        expected.kind === "callable" &&
        instruction.kind === "closure.new" &&
        closureSignatureEquals(instruction.signature, expected.signature)
      ) {
        const associations = source.allocations.filter(
          (row) => row.occurrence === definition!.occurrence && row.ownerUnitId === ownerUnitId,
        );
        return associations.length === 1 ? [associations[0]!.occurrence] : undefined;
      }
      const arms =
        instruction.kind === "select"
          ? [instruction.whenTrue, instruction.whenFalse]
          : instruction.kind === "if"
            ? [instruction.thenValue, instruction.elseValue]
            : undefined;
      if (!arms) return undefined;
      const values = arms.map((arm) => prove(arm, boxed));
      return values.every((row) => row !== undefined) ? values.flatMap((row) => row!) : undefined;
    } finally {
      active.delete(id);
    }
  };
  return prove(value, external);
}

/** Every normal return is checked; throws retain their original behavior and identity. */
export function proveObjectGetterReturns(
  source: NativeSourceClosureRequirements,
  unitId: IrUnitId,
  expected: IrType,
): readonly number[] | undefined {
  const owner = source.demands.owners.find((row) => row.unitId === unitId);
  if (!owner) return undefined;
  const allocations: number[] = [];
  for (const view of ["program", "projection"] as const) {
    const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
    const returns = fn.blocks.flatMap((block) => (block.terminator.kind === "return" ? [block.terminator.values] : []));
    for (const row of source.demands.occurrences) {
      const buffer = source.demands.buffers[row.bufferIndex]!;
      if (buffer.ownerUnitId !== unitId || buffer.view !== view) continue;
      if (row.instruction.kind === "early.return")
        returns.push(row.instruction.value === null ? [] : [row.instruction.value]);
    }
    if (!returns.length) return undefined;
    for (const values of returns) {
      if (values.length !== 1) return undefined;
      const proof = proveObjectResultValue(source, unitId, view, values[0]!, expected, false);
      if (!proof) return undefined;
      if (view === "projection") allocations.push(...proof);
    }
  }
  return [...new Set(allocations)];
}
