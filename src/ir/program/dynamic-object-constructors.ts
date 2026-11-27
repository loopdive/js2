// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7574) The Object constructor on the dynamic-value legalization, beside the Error family
 * (`dynamic-error-constructors.ts`), the wrappers (`dynamic-wrapper-constructors.ts`) and Array
 * (`dynamic-array-constructors.ts`).
 *
 * `Object(v)` and `new Object(v)` with the callee the realm's `%Object%` (§20.1.1.1; NewTarget is undefined or the
 * active function, so a call and a construct answer alike): no argument, `undefined` or `null` is
 * OrdinaryObjectCreate(%Object.prototype%), the allocation an empty object literal uses; an object or a function is
 * itself; a string, number or Boolean is ToObject's wrapper of it (`js.object.create-wrapper`, whose prototype the
 * realm then holds). The argument is already evaluated (the front end, left to right), so an extra one has run and is
 * ignored. Any other callee holding the constructor (through a variable) reaches the dispatcher, whose built-in arm is
 * the run-time abort.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { WRAPPER_OF_PRIMITIVE, realmConstructorId } from "./builtin-prototype-keys.js";
import { realmCall, type RealmConstruction, type RealmConstructionBuilders } from "./dynamic-realm-calls.js";
import { CARRIER, carried } from "./dynamic-value-types.js";
import { IS_OBJECT, type CarrierKind } from "./dynamic-value-kinds.js";

/** `Object(…args)` or `new Object(…args)`, into the instruction's result. */
export function dynamicObjectConstruction(
  b: RealmConstructionBuilders,
  instr: RealmConstruction,
  args: readonly IrValueId[],
): IrInstr[] {
  const value = args[0];
  const empty = (r: IrValueId): IrInstr[] => [realmCall("js.object.create-default", [], r)];
  if (value === undefined) return empty(instr.result!);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (IS_OBJECT[kind]) return [carried(value, r)];
    const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
    return wrapper === undefined
      ? empty(r)
      : b.selectorCall("js.object.create-wrapper", [value], realmConstructorId(wrapper)!.selector, r);
  };
  return b.kindChain(instr, value, instr.result!, arm, b.kinds.kindsOf(value), CARRIER);
}
