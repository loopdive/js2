// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O2b, F1) OrdinaryToPrimitive (§7.1.1.1) of the object and function kinds, decided at run time: the one
 * builder ToString, ToNumber and `+` share (`TO_STRING_ARM`, `TO_NUMBER_ARM`).
 *
 * For each name in hint order the method is Got; a callable one is called and a non-callable one skipped (step 2.b).
 * A method the object does not hold is the realm Object.prototype's: `valueOf` answers the object (not a primitive, so
 * it is skipped too) and `toString` "[object Object]". Calling a method needs calls through a value (slice F2), so a
 * callable one ends the program by name at run time (`js.value.unsupported`); in a program that creates no function
 * value no method can be callable, so only `toString` is consulted and the answer is "[object Object]" or a TypeError.
 * A function value's own `toString` is Function.prototype.toString, the source text the closure does not carry, so
 * its ToPrimitive is the same abort. `@@toPrimitive` (§7.1.1 step 2) is reachable only by naming `Symbol`, and such a
 * program refuses by name.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { LegalizationProgram } from "./dynamic-value-kinds.js";
import { realmCall, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";

/** ToPrimitive's hint: `string` for ToString, `number` for ToNumber and (as `default`) for `+`. */
export type ToPrimitiveHint = "string" | "number";

/** The builders OrdinaryToPrimitive is written with. */
export interface ToPrimitiveBuilders extends TypeErrorBuilders {
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
  ) => IrInstr;
  /** `js.value.is_function` of `value` into `result`, where the program creates function values. */
  readonly isCallable: ((value: IrValueId, result: IrValueId) => IrInstr) | undefined;
  /** The run-time abort (`js.value.unsupported`), its never-produced string into `result`. */
  readonly unsupported: (result: IrValueId) => IrInstr;
}

/** OrdinaryToPrimitive of the once-evaluated ordinary `object` with `hint`: its string into `result`, or a TypeError. */
export function ordinaryToPrimitive(
  b: ToPrimitiveBuilders,
  program: LegalizationProgram,
  object: IrValueId,
  hint: ToPrimitiveHint,
  result: IrValueId,
): IrInstr[] {
  if (program.objects.namesSymbol) gap("ToPrimitive of an object in a program that names 'Symbol'");
  // Without a callable kind `valueOf` is skipped whether held or not, so it is not consulted at all: the answers are
  // the same, and a program without function values keeps the bytes it had before F1.
  const names = !b.isCallable ? ["toString"] : hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  // The method `names[index]` and the ones after it, into `r`.
  const step = (index: number, r: IrValueId): IrInstr[] => {
    const name = names[index];
    // The TypeError does not complete; the empty string only gives the arm its value.
    if (name === undefined) return [...typeError(b, "Cannot convert object to primitive value"), b.text("", r)];
    const [text, key, held] = [b.fresh(), b.fresh(), b.fresh()];
    const absent = (r: IrValueId) => (name === "toString" ? [b.text("[object Object]", r)] : step(index + 1, r));
    return [
      b.text(name, text),
      { kind: "coerce.to_externref", value: text, result: key, resultType: b.carrier },
      realmCall("js.object.has", [object, key], held),
      b.branch(held, (r) => skipUnlessCallable(b, object, key, (s) => step(index + 1, s), r), absent, r),
    ];
  };
  return step(0, result);
}

/** A held method: a callable one ends at the abort (calls through a value are F2's), any other is skipped. */
function skipUnlessCallable(
  b: ToPrimitiveBuilders,
  object: IrValueId,
  key: IrValueId,
  skip: (result: IrValueId) => IrInstr[],
  result: IrValueId,
): IrInstr[] {
  if (!b.isCallable) return skip(result);
  const [method, callable] = [b.fresh(), b.fresh()];
  return [
    realmCall("js.object.get", [object, key, object], method),
    b.isCallable(method, callable),
    b.branch(callable, (r) => [b.unsupported(r)], skip, result),
  ];
}
