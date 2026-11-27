// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352) The Array constructor on the dynamic-value legalization, beside the Error family
 * (`dynamic-error-constructors.ts`) and the wrappers (`dynamic-wrapper-constructors.ts`), and (#7579) the array
 * literal.
 *
 * `Array(…args)` and `new Array(…args)` with the callee the realm's `%Array%` (§23.1.1.1; a call and a construct
 * answer alike, NewTarget being the active function): no argument is an empty array; one number argument is
 * ArrayCreate of it, whose realm body throws the realm's RangeError for a number that is no array length; one argument
 * of any other kind, or several, is an array of them. Any other callee holding the constructor (through a variable)
 * reaches the dispatcher, whose built-in arm is the run-time abort.
 *
 * The values of both are already evaluated (the front end, left to right), and defining them after is the same: a
 * fresh array runs no program code on a define (CreateDataProperty, never [[Set]], so no setter of Array.prototype).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { FULL_DATA_DESCRIPTOR } from "../../shared/contracts/descriptor-word.js";
import { realmCall, type RealmConstruction, type RealmConstructionBuilders } from "./dynamic-realm-calls.js";
import { CARRIER, F64, carried } from "./dynamic-value-types.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";

type ArrayBuilders = RealmConstructionBuilders & {
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};

/** `Array(…args)` or `new Array(…args)`, into the instruction's result. */
export function dynamicArrayConstruction(
  b: ArrayBuilders,
  instr: RealmConstruction,
  args: readonly IrValueId[],
): IrInstr[] {
  if (args.length !== 1) return arrayOfValues(b, args, instr.result!);
  const [value] = args as [IrValueId];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (kind !== "number") return arrayOfValues(b, args, r);
    const length = b.fresh();
    return [...b.toNumber(instr, value, length), realmCall("js.object.create-array", [length], r)];
  };
  return b.kindChain(instr, value, instr.result!, arm, b.kinds.kindsOf(value), CARRIER);
}

/** (#7579) The front end's array literal call (`ARRAY_LITERAL_HELPER`): its length, then key-value pairs. */
export function dynamicArrayLiteral(b: ChainBuilders, instr: Extract<IrInstr, { kind: "call" }>): IrInstr[] {
  const [length, ...pairs] = instr.args as [IrValueId, ...IrValueId[]];
  const values = pairs.filter((_, at) => at % 2 === 1);
  return arrayOf(b, length, values, (index) => [[], pairs[2 * index]!], instr.result!);
}

/** An array of `values` under the indices 0, 1, …, each key written where its value is defined. */
function arrayOfValues(b: ChainBuilders, values: readonly IrValueId[], result: IrValueId): IrInstr[] {
  const length = b.fresh();
  const indexKey: KeyOf = (index) => {
    const [text, key] = [b.fresh(), b.fresh()];
    return [[b.text(String(index), text), carried(text, key)], key];
  };
  return [number(values.length, length), ...arrayOf(b, length, values, indexKey, result)];
}

/** The instructions that write the key of the value at `index`, and the key. */
type KeyOf = (index: number) => readonly [IrInstr[], IrValueId];

const number = (value: number, result: IrValueId): IrInstr => ({
  kind: "const",
  value: { kind: "f64", value },
  result,
  resultType: F64,
});

/**
 * ArrayCreate(`length`), then each of `values` CreateDataPropertyOrThrow under its key (§13.2.4.1 step 5, §23.1.1.1
 * step 7), into `result`.
 */
function arrayOf(
  b: ChainBuilders,
  length: IrValueId,
  values: readonly IrValueId[],
  keyOf: KeyOf,
  result: IrValueId,
): IrInstr[] {
  const word = b.fresh();
  return [
    realmCall("js.object.create-array", [length], result),
    ...(values.length > 0 ? [number(FULL_DATA_DESCRIPTOR, word)] : []),
    ...values.flatMap((value, index): IrInstr[] => {
      const [instrs, key] = keyOf(index);
      return [...instrs, realmCall("js.object.define-data", [result, key, value, word])];
    }),
  ];
}
