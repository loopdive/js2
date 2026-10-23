// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../identity.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeStringValueView } from "./native-string-value-demands.js";
import { indexNativeValueDefinitions, nativeValueOriginal } from "./native-value-definitions.js";

type ClassAllocation = NonNullable<NativeSourceClosureRequirements["classValues"]>[number];
export interface NativeConstructorFlow {
  readonly allocation: ClassAllocation;
  readonly instruction: Extract<IrInstr, { kind: "class.value.new" }>;
  /** Actual direct call occurrences, not a claim that evaluations share identity. */
  readonly calls: readonly number[];
  readonly owners: readonly IrUnitId[];
}

/** Trace exact selected returns; unknown storage, parameters and recursive flows grant no family. */
export function createNativeConstructorFlow(source: NativeSourceClosureRequirements) {
  const indexes = new Map<string, ReturnType<typeof buildData>>();
  const completed = new Map<string, NativeConstructorFlow>();
  function buildData(unit: IrUnitId, view: NativeStringValueView) {
    const owner = source.demands.owners.find((row) => row.unitId === unit);
    if (!owner) return undefined;
    const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
    const indexed = indexNativeValueDefinitions(source.demands, unit, view, () => {
      throw Error("native constructor flow: ambiguous SSA definition");
    });
    return { fn, ...indexed };
  }
  function data(unit: IrUnitId, view: NativeStringValueView) {
    const key = JSON.stringify([view, unit]);
    if (!indexes.has(key)) indexes.set(key, buildData(unit, view));
    return indexes.get(key);
  }
  function definition(unit: IrUnitId, view: NativeStringValueView, value: IrValueId): IrInstr | undefined {
    const definitions = data(unit, view)?.definitions;
    return (
      definitions &&
      nativeValueOriginal(value, definitions, () => {
        throw Error("native constructor flow: cyclic representation alias");
      })?.instruction
    );
  }
  function returned(unit: IrUnitId, view: NativeStringValueView): readonly IrValueId[] | undefined {
    const current = data(unit, view);
    if (
      !current ||
      current.fn.closureSubtype ||
      current.fn.asyncPlan ||
      current.fn.asyncRuntime ||
      (current.fn.funcKind && current.fn.funcKind !== "regular") ||
      current.fn.resultTypes.length !== 1 ||
      current.rows.some(({ instruction }) => instruction.kind === "raw.wasm")
    )
      return undefined;
    const values: IrValueId[] = [];
    for (const block of current.fn.blocks) {
      if (block.terminator.kind !== "return") continue;
      if (block.terminator.values.length !== 1) return undefined;
      values.push(block.terminator.values[0]!);
    }
    for (const { instruction } of current.rows) {
      if (instruction.kind !== "early.return") continue;
      if (instruction.value === null) return undefined;
      values.push(instruction.value);
    }
    return values.length ? [...new Set(values)] : undefined;
  }
  function resolve(
    unit: IrUnitId,
    view: NativeStringValueView,
    value: IrValueId,
    active = new Set<string>(),
  ): NativeConstructorFlow | undefined {
    const key = JSON.stringify([view, unit, value]);
    if (active.has(key)) return undefined;
    const known = completed.get(key);
    if (known) return known;
    const pending = new Set(active).add(key);
    const instruction = definition(unit, view, value);
    if (instruction?.kind === "class.value.new") {
      const allocation = source.classValues?.find((row) => {
        const occurrence = source.demands.occurrences[row.occurrence]!,
          region = source.demands.buffers[occurrence.bufferIndex]!;
        return region.view === view && row.ownerUnitId === unit && occurrence.instruction === instruction;
      });
      if (!allocation) return undefined;
      const proof = { allocation, instruction, calls: [], owners: [unit] };
      completed.set(key, proof);
      return proof;
    }
    if (instruction?.kind !== "call" || instruction.target.binding.kind !== "unit") return undefined;
    const target = instruction.target.binding.unitId;
    const values = returned(target, view);
    if (!values) return undefined;
    const proofs: NativeConstructorFlow[] = [];
    for (const returnedValue of values) {
      const proof = resolve(target, view, returnedValue, pending),
        first = proofs[0];
      if (
        !proof ||
        (first &&
          (proof.allocation.ownerUnitId !== first.allocation.ownerUnitId ||
            proof.allocation.allocationId !== first.allocation.allocationId))
      )
        return undefined;
      proofs.push(proof);
    }
    const occurrence = data(unit, view)!.rows.find((row) => row.instruction === instruction)!.occurrence;
    const result = {
      ...proofs[0]!,
      calls: [...new Set([occurrence, ...proofs.flatMap((proof) => proof.calls)])],
      owners: [...new Set([unit, ...proofs.flatMap((proof) => proof.owners)])],
    };
    completed.set(key, result);
    return result;
  }
  return { definition, resolve };
}
