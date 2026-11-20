// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7368) A receiver's own-property lookup through the realm (`js.object.has-own`, `property-is-enumerable`,
 * `get-own-property`). The realm's bodies (`source-object-bodies.ts`) answer an ordinary object, a Number and a
 * Boolean, and for `undefined` / `null` the caller or the body throws. A String's exotic object owns `length` and
 * its indices (§10.4.3.1), which no body serves, so a receiver that may be a String is split here:
 *   - a constant key a String never owns answers the String's absent property, without the call;
 *   - a computed key, `length` or an index refuses by name.
 * No String reaches the bodies, whose String arm is therefore an unreachable invariant.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { isArrayIndexKey } from "./builtin-prototype-keys.js";
import { constantKeyOf } from "./dynamic-member-access.js";
import type { CarrierKind } from "./dynamic-value-kinds.js";
import { gap } from "./dynamic-value-gap.js";

/** Each lookup and what it answers for an absent property: `false`, or `undefined` (FromPropertyDescriptor's). */
const ABSENT = {
  "js.object.has-own": "false",
  "js.object.property-is-enumerable": "false",
  "js.object.get-own-property": "undefined",
} as const;

export type OwnPropertyLookup = keyof typeof ABSENT;

export function isOwnPropertyLookup(symbol: string): symbol is OwnPropertyLookup {
  return Object.hasOwn(ABSENT, symbol);
}

/** The legalization builders a lookup is written with. */
export interface OwnPropertyLookupBuilders {
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly fresh: () => IrValueId;
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
  /** Whether `value` is one of `kinds`, into `result`. */
  readonly anyKind: (instr: IrInstr, kinds: readonly CarrierKind[], value: IrValueId, result: IrValueId) => IrInstr[];
  readonly intrinsic: (instr: IrInstr, id: IntrinsicId, args: readonly IrValueId[], result?: IrValueId) => IrInstr;
  readonly branch: (
    cond: IrValueId,
    then: (r: IrValueId) => IrInstr[],
    else_: (r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType,
  ) => IrInstr;
}

/** The value a contract operand was coerced to the carrier from. */
function uncoerced(b: OwnPropertyLookupBuilders, operand: IrValueId): IrValueId {
  const definition = b.definitions.get(operand);
  return definition?.kind === "coerce.to_externref" ? definition.value : operand;
}

/** The call `lookup` of the legalized function: unchanged, or split on a receiver that may be a String. */
export function ownPropertyLookup(
  b: OwnPropertyLookupBuilders,
  lookup: OwnPropertyLookup,
  instr: Extract<IrInstr, { kind: "call" }>,
): IrInstr[] {
  const [receiver, key] = instr.args.map((operand) => uncoerced(b, operand));
  if (!b.kindsOf(receiver!).includes("string")) return [instr];
  const name = constantKeyOf(b.definitions, key!);
  if (name === undefined || name === "length" || isArrayIndexKey(name))
    gap(`${lookup} of '${name ?? "a computed key"}' on a possible string, whose exotic own properties no body serves`);
  const absent = (r: IrValueId): IrInstr[] => [
    ABSENT[lookup] === "undefined"
      ? b.intrinsic(instr, "js.value.undefined", [], r)
      : { kind: "const", value: { kind: "bool", value: false }, result: r, resultType: instr.resultType },
  ];
  const isString = b.fresh();
  return [
    ...b.anyKind(instr, ["string"], receiver!, isString),
    b.branch(isString, absent, (r) => [{ ...instr, result: r }], instr.result!, instr.resultType!),
  ];
}
