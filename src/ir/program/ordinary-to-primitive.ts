// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2b) OrdinaryToPrimitive (§7.1.1.1) of the object kind, decided at run time: the one builder ToString,
 * ToNumber and `+` of an ordinary object share (`TO_STRING_ARM`, `TO_NUMBER_ARM`).
 *
 * No admitted kind is callable, so a conversion method the object holds is skipped (step 2.b), and an absent one is
 * the realm Object.prototype's: `valueOf` answers the object (not a primitive, so it is skipped too), `toString`
 * answers "[object Object]". For every hint the answer is therefore "[object Object]" when `toString` is absent all
 * the way up to the realm's Object.prototype, and a TypeError when the object holds one. `@@toPrimitive` (§7.1.1
 * step 2) is reachable only by naming `Symbol`, and such a program refuses by name.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { CarrierKind, LegalizationProgram } from "./dynamic-value-kinds.js";
import { realmCall, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";

/** The kinds whose values are not callable: a property value of one of them is skipped as a conversion method. */
type NonCallableKind = "number" | "boolean" | "string" | "undefined" | "null" | "error" | "object";
/**
 * The skip above is exact only while every admitted kind is one of them. A slice that admits a callable kind (Fa's
 * function values) fails to compile here until this builder Gets and Calls the methods in hint order.
 */
const EVERY_KIND_IS_NON_CALLABLE: [Exclude<CarrierKind, NonCallableKind>] extends [never] ? true : never = true;

/** The builders OrdinaryToPrimitive is written with. */
export interface ToPrimitiveBuilders extends TypeErrorBuilders {
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
  ) => IrInstr;
}

/** OrdinaryToPrimitive of the once-evaluated ordinary `object`: its string into `result`, or a TypeError. */
export function ordinaryToPrimitive(
  b: ToPrimitiveBuilders,
  program: LegalizationProgram,
  object: IrValueId,
  result: IrValueId,
): IrInstr[] {
  if (program.objects.namesSymbol) gap("ToPrimitive of an object in a program that names 'Symbol'");
  const [name, key, held] = [b.fresh(), b.fresh(), b.fresh()];
  return [
    b.text("toString", name),
    { kind: "coerce.to_externref", value: name, result: key, resultType: b.carrier },
    realmCall("js.object.has", [object, key], held),
    b.branch(
      held,
      // The TypeError does not complete; the empty string only gives the arm its value.
      (r) => [
        ...(EVERY_KIND_IS_NON_CALLABLE && typeError(b, "Cannot convert object to primitive value")),
        b.text("", r),
      ],
      (r) => [b.text("[object Object]", r)],
      result,
    ),
  ];
}
