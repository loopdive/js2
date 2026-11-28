// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350 B3a) The wrapper constructors on the dynamic-value legalization, beside the Error family
 * (`dynamic-error-constructors.ts`).
 *
 * Conversion. `X(v)` with `X` the unchanged global `String`, `Number` or `Boolean` and its callee the realm's value
 * (`(String)(v)`, `(0, Number)(v)`; the plain `X(v)` is the front end's conversion plan, `prepare-number-conversion.ts`)
 * is §22.1.1.1, §21.1.1.1 or §20.3.1.1 with NewTarget undefined (`WRAPPER_CONVERSIONS`). The arguments are already
 * evaluated (the front end, left to right), so an extra one has run and is ignored. Any other callee holding the
 * constructor (through a variable) reaches the dispatcher, whose built-in arm is the run-time abort.
 *
 * Construction. (#7561) `new X(v)` is the same conversion, then the realm's wrapper of it
 * (`js.object.create-wrapper`): its [[Prototype]] is X's `prototype`, read only and non-configurable, so the realm
 * reads it.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { WRAPPER_CONVERSIONS, type RealmConstructor } from "./builtin-prototype-keys.js";
import type { RealmConstruction, RealmConstructionBuilders } from "./dynamic-realm-calls.js";
import { carried } from "./dynamic-value-chains.js";

type WrapperBuilders = RealmConstructionBuilders & {
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};

/** `X(v)` or `new X(v)` of the wrapper constructor `ctor`, into the instruction's result. */
export function dynamicWrapperConstruction(
  b: WrapperBuilders,
  instr: RealmConstruction,
  ctor: RealmConstructor<"wrapper">,
  args: readonly IrValueId[],
): IrInstr[] {
  if (instr.kind !== "dyn.construct") return conversion(b, instr, ctor, args[0], instr.result!);
  const primitive = b.fresh();
  return [
    ...conversion(b, instr, ctor, args[0], primitive),
    ...b.selectorCall("js.object.create-wrapper", [primitive], ctor.selector, instr.result!),
  ];
}

/** The constructor's conversion of `value` (`WRAPPER_CONVERSIONS`), as a carrier primitive into `result`. */
function conversion(
  b: WrapperBuilders,
  instr: RealmConstruction,
  ctor: RealmConstructor<"wrapper">,
  value: IrValueId | undefined,
  result: IrValueId,
): IrInstr[] {
  const converted = b.fresh();
  const into = (instrs: IrInstr[], box: "js.number.box" | "js.boolean.box" | undefined): IrInstr[] => [
    ...instrs,
    box === undefined ? carried(converted, result) : b.intrinsic(instr, box, [converted], result),
  ];
  const constant = (value: number | boolean): IrInstr => ({
    kind: "const",
    value: typeof value === "number" ? { kind: "f64", value } : { kind: "bool", value },
    result: converted,
    resultType: { kind: "val", val: typeof value === "number" ? { kind: "f64" } : { kind: "i32", boolean: true } },
  });
  const rule = WRAPPER_CONVERSIONS[ctor.name];
  switch (rule.to) {
    case "string":
      return into(
        value === undefined ? [b.text(rule.absent, converted)] : b.stringOf(instr, value, converted),
        undefined,
      );
    case "number":
      return into(value === undefined ? [constant(rule.absent)] : b.toNumber(instr, value, converted), "js.number.box");
    case "boolean":
      return into(
        value === undefined ? [constant(rule.absent)] : [b.intrinsic(instr, "js.value.to_boolean", [value], converted)],
        "js.boolean.box",
      );
  }
}
