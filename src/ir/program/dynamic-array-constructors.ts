// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352) The Array constructor on the dynamic-value legalization, beside the Error family
 * (`dynamic-error-constructors.ts`) and the wrappers (`dynamic-wrapper-constructors.ts`).
 *
 * `Array(…args)` and `new Array(…args)` with the callee the realm's `%Array%` (§23.1.1.1; a call and a construct
 * answer alike, NewTarget being the active function): no argument is an empty array; one number argument is
 * ArrayCreate of it, whose realm body throws the realm's RangeError for a number that is no array length; one argument
 * of any other kind, or several, is an array of them. The arguments are already evaluated (the front end, left to
 * right), and defining them after is the same: a fresh array runs no program code on a define. Any other callee
 * holding the constructor (through a variable) reaches the dispatcher, whose built-in arm is the run-time abort.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { FULL_DATA_DESCRIPTOR } from "../../shared/contracts/descriptor-word.js";
import { realmCall, type RealmConstruction, type RealmConstructionBuilders } from "./dynamic-realm-calls.js";
import { CARRIER, F64, carried } from "./dynamic-value-types.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";

type ArrayBuilders = RealmConstructionBuilders & {
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};

/** `Array(…args)` or `new Array(…args)`, into the instruction's result. */
export function dynamicArrayConstruction(
  b: ArrayBuilders,
  instr: RealmConstruction,
  args: readonly IrValueId[],
): IrInstr[] {
  if (args.length !== 1) return arrayOf(b, args, instr.result!);
  const [value] = args as [IrValueId];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (kind !== "number") return arrayOf(b, args, r);
    const length = b.fresh();
    return [...b.toNumber(instr, value, length), realmCall("js.object.create-array", [length], r)];
  };
  return b.kindChain(instr, value, instr.result!, arm, b.kinds.kindsOf(value), CARRIER);
}

/**
 * ArrayCreate(values.length), then each value CreateDataPropertyOrThrow under its index (§23.1.1.1 step 7), into
 * `result`.
 */
function arrayOf(b: ArrayBuilders, values: readonly IrValueId[], result: IrValueId): IrInstr[] {
  const [length, word] = [b.fresh(), b.fresh()];
  const number = (value: number, into: IrValueId): IrInstr => ({
    kind: "const",
    value: { kind: "f64", value },
    result: into,
    resultType: F64,
  });
  return [
    number(values.length, length),
    realmCall("js.object.create-array", [length], result),
    ...(values.length > 0 ? [number(FULL_DATA_DESCRIPTOR, word)] : []),
    ...values.flatMap((value, index): IrInstr[] => {
      const [text, key] = [b.fresh(), b.fresh()];
      return [
        b.text(String(index), text),
        carried(text, key),
        realmCall("js.object.define-data", [result, key, value, word]),
      ];
    }),
  ];
}
