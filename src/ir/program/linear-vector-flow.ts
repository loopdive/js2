// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction, type IrInstr, type IrModule, type IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface LinearVectorOrigin {
  readonly functionIndex: number;
  readonly instruction: Extract<IrInstr, { kind: "vec.new_fixed" }>;
}
type SymbolicOrigin = LinearVectorOrigin | { readonly unitId: IrUnitId; readonly parameter: number };
interface FunctionFlow {
  readonly values: ReadonlyMap<IrValueId, readonly SymbolicOrigin[]>;
  readonly returns: readonly SymbolicOrigin[];
}
function unsupported(fn: IrFunction, detail: string): never {
  throw new IrUnsupportedError(
    "array-representation-unsupported",
    "resolve",
    `native Linear vector call flow: ${detail}`,
    { unitId: fn.unitId },
  );
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `linear vector call flow: ${detail}`);
}

/** Recompute static producer origins from the complete checked IR; never mint sites for transport. */
export function collectLinearVectorFlow(
  module: IrModule,
): ReadonlyMap<IrUnitId, ReadonlyMap<IrValueId, readonly LinearVectorOrigin[]>> {
  const functions = new Map(module.functions.map((fn, index) => [fn.unitId, { fn, index }]));
  if (functions.size !== module.functions.length) invalid("duplicate source-unit owner");
  const flows = new Map<IrUnitId, FunctionFlow>();
  const active = new Set<IrUnitId>();
  const incoming = new Map<IrUnitId, { fn: IrFunction; args: readonly (readonly SymbolicOrigin[])[] }[]>();
  const summarize = (fn: IrFunction): FunctionFlow => {
    const cached = flows.get(fn.unitId);
    if (cached) return cached;
    if (active.has(fn.unitId)) unsupported(fn, "recursive vector result is not admitted");
    active.add(fn.unitId);
    const values = new Map<IrValueId, readonly SymbolicOrigin[]>();
    fn.params.forEach((param, parameter) => {
      if (param.type.kind === "vec") values.set(param.value, [{ unitId: fn.unitId, parameter }]);
    });
    const origin = (value: IrValueId): readonly SymbolicOrigin[] => {
      const origins = values.get(value);
      if (!origins?.length) unsupported(fn, "vector SSA value has no authenticated producer");
      return origins;
    };
    const visit = (instr: IrInstr): void => {
      if (instr.kind === "vec.new_fixed") {
        if (instr.result === null || instr.alloc === undefined) invalid("construction lacks actual result/site");
        values.set(instr.result, [{ functionIndex: functions.get(fn.unitId)!.index, instruction: instr }]);
      } else if (instr.kind === "call") {
        const target =
          instr.target.binding.kind === "unit" ? functions.get(instr.target.binding.unitId)?.fn : undefined;
        const carries =
          instr.resultType?.kind === "vec" ||
          target?.params.some((param) => param.type.kind === "vec") ||
          instr.args.some((arg) => values.has(arg));
        if (!carries) return;
        if (!target || target.params.length !== instr.args.length)
          unsupported(fn, "vector call has no exact complete unit target");
        const args = target.params.map((param, index) => (param.type.kind === "vec" ? origin(instr.args[index]!) : []));
        const rows = incoming.get(target.unitId) ?? [];
        rows.push({ fn, args });
        incoming.set(target.unitId, rows);
        if (instr.resultType?.kind === "vec") {
          if (instr.result === null) invalid("vector call lacks result");
          const returned = summarize(target).returns;
          if (!returned.length) unsupported(target, "vector result lacks a complete return producer");
          values.set(
            instr.result,
            returned.flatMap((item) =>
              "instruction" in item ? [item] : item.unitId === target.unitId ? args[item.parameter]! : [item],
            ),
          );
        }
      } else if (instr.resultType?.kind === "vec") unsupported(fn, `unproved vector-producing ${instr.kind}`);
    };
    for (const block of fn.blocks) for (const instr of block.instrs) forEachInstrDeep(instr, visit);
    const returns: SymbolicOrigin[] = [];
    for (const block of fn.blocks) {
      const term = block.terminator;
      if (term.kind === "return")
        term.values.forEach((value, ordinal) => {
          if (fn.resultTypes[ordinal]?.kind === "vec") returns.push(...origin(value));
        });
    }
    const flow = { values, returns };
    flows.set(fn.unitId, flow);
    active.delete(fn.unitId);
    return flow;
  };
  module.functions.forEach(summarize);
  const resolve = (item: SymbolicOrigin, seen: ReadonlySet<string>): readonly LinearVectorOrigin[] => {
    if ("instruction" in item) return [item];
    const owner = functions.get(item.unitId)?.fn;
    if (!owner) invalid("formal input has a foreign unit");
    const key = `${item.unitId}:${item.parameter}`;
    if (seen.has(key)) unsupported(owner, "recursive vector parameter flow is not admitted");
    if (owner.exported) unsupported(owner, "public vector parameter transport is not admitted");
    const rows = incoming.get(item.unitId);
    if (!rows?.length) unsupported(owner, "vector formal has no complete internal callers");
    const next = new Set(seen).add(key);
    return rows.flatMap((row) => row.args[item.parameter]!.flatMap((arg) => resolve(arg, next)));
  };
  const result = new Map<IrUnitId, ReadonlyMap<IrValueId, readonly LinearVectorOrigin[]>>();
  for (const fn of module.functions) {
    const values = new Map<IrValueId, readonly LinearVectorOrigin[]>();
    const receivers = new Set<IrValueId>();
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set")
            receivers.add(instr.vec);
        });
    for (const [value, symbolic] of flows.get(fn.unitId)!.values) {
      if (!receivers.has(value)) continue;
      const origins = resolveAllVectorOrigins(
        symbolic.flatMap((item) => resolve(item, new Set())),
        fn,
      );
      values.set(value, origins);
    }
    result.set(fn.unitId, values);
  }
  return result;
}

function resolveAllVectorOrigins(
  origins: readonly LinearVectorOrigin[],
  fn: IrFunction,
): readonly LinearVectorOrigin[] {
  const distinct = [...new Map(origins.map((origin) => [origin.instruction.alloc, origin])).values()];
  if (!distinct.length) unsupported(fn, "empty origin population");
  const capacities = new Set(distinct.map(({ instruction }) => instruction.capacity ?? instruction.elements.length));
  if (capacities.size !== 1) unsupported(fn, "mixed requested backing extents are not admitted");
  return distinct;
}
