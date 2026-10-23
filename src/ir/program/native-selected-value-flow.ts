// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrInstr, IrInstrCall, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../identity.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";
import type { NativeStringValueView } from "./native-string-value-demands.js";
import { preparedIrDataMismatch } from "./data.js";
import { reproducePreparedIrRuntimeProjection } from "./runtime-validation.js";
import { indexNativeValueDefinitions, nativeValueOriginal } from "./native-value-definitions.js";

export interface NativeSelectedValueFlow<Allocation, Instruction> {
  readonly allocation: Allocation;
  readonly instruction: Instruction;
  readonly calls: readonly number[];
  readonly owners: readonly IrUnitId[];
}
type ValueIndex = ReturnType<typeof indexNativeValueDefinitions>;
type Family = { readonly ownerUnitId: IrUnitId; readonly allocationId: AllocSiteId };
interface FlowAdapter<Allocation extends Family, Instruction extends IrInstr> {
  readonly closureReturns?: true;
  allocation(
    unit: IrUnitId,
    view: NativeStringValueView,
    value: IrValueId,
    instruction: IrInstr,
    index: ValueIndex,
  ): Pick<NativeSelectedValueFlow<Allocation, Instruction>, "allocation" | "instruction"> | undefined;
  calledUnit(
    unit: IrUnitId,
    view: NativeStringValueView,
    instruction: IrInstrCall,
    resolve: (
      unit: IrUnitId,
      view: NativeStringValueView,
      value: IrValueId,
    ) => NativeSelectedValueFlow<Allocation, Instruction> | undefined,
  ):
    | { readonly target: IrUnitId; readonly dependencies: readonly NativeSelectedValueFlow<Allocation, Instruction>[] }
    | undefined;
}

/** Trace exact selected returns; unknown storage, parameters and recursive flows grant no family. */
export function createNativeSelectedValueFlow<Allocation extends Family, Instruction extends IrInstr>(
  source: NativeSourceClosureRequirements,
  adapter: FlowAdapter<Allocation, Instruction>,
) {
  type Flow = NativeSelectedValueFlow<Allocation, Instruction>;
  const indexes = new Map<string, ReturnType<typeof buildData>>();
  const completed = new Map<string, Flow>();
  function buildData(unit: IrUnitId, view: NativeStringValueView) {
    const owner = source.demands.owners.find((row) => row.unitId === unit);
    if (!owner) return undefined;
    const fn = view === "program" ? owner.programFunction : owner.projectedFunction;
    const indexed = indexNativeValueDefinitions(source.demands, unit, view, () => {
      throw Error("native selected value flow: ambiguous SSA definition");
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
        throw Error("native selected value flow: cyclic representation alias");
      })?.instruction
    );
  }
  function returned(unit: IrUnitId, view: NativeStringValueView): readonly IrValueId[] | undefined {
    const current = data(unit, view);
    if (
      !current ||
      (current.fn.closureSubtype && !adapter.closureReturns) ||
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
  ): Flow | undefined {
    const key = JSON.stringify([view, unit, value]);
    if (active.has(key)) return undefined;
    const known = completed.get(key);
    if (known) return known;
    const pending = new Set(active).add(key);
    const instruction = definition(unit, view, value);
    if (!instruction) return undefined;
    const allocation = adapter.allocation(unit, view, value, instruction, data(unit, view)!);
    if (allocation) {
      const proof = { ...allocation, calls: [], owners: [unit] };
      completed.set(key, proof);
      return proof;
    }
    if (instruction.kind !== "call") return undefined;
    const called = adapter.calledUnit(unit, view, instruction, (owner, representation, value) =>
      resolve(owner, representation, value, pending),
    );
    if (!called) return undefined;
    const { target, dependencies } = called;
    const values = returned(target, view);
    if (!values) return undefined;
    const proofs: Flow[] = [];
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
      calls: [...new Set([occurrence, ...[...proofs, ...dependencies].flatMap((proof) => proof.calls)])],
      owners: [...new Set([unit, ...[...proofs, ...dependencies].flatMap((proof) => proof.owners)])],
    };
    completed.set(key, result);
    return result;
  }
  let reproduced: ReturnType<typeof reproducePreparedIrRuntimeProjection> | undefined;
  function projectionMatches(unit: IrUnitId): boolean {
    const owner = source.demands.owners.find((row) => row.unitId === unit);
    if (!owner) return false;
    if (preparedIrDataMismatch(owner.programFunction, owner.projectedFunction) === undefined) return true;
    reproduced ??= reproducePreparedIrRuntimeProjection(source.demands.program, source.demands.projection);
    const expected = reproduced.functions.find((fn) => fn.unitId === unit);
    return expected !== undefined && preparedIrDataMismatch(expected, owner.projectedFunction) === undefined;
  }
  return { data, definition, resolve, projectionMatches };
}
