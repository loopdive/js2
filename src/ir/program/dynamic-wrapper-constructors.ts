// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350 B3a) The wrapper constructors on the dynamic-value legalization, beside the Error family
 * (`dynamic-error-constructors.ts`).
 *
 * Conversion. `X(v)` with `X` the unchanged global `String`, `Number` or `Boolean` and its callee the realm's value
 * (`(String)(v)`, `(0, Number)(v)`; the plain `X(v)` is the front end's conversion plan, `prepare-number-conversion.ts`)
 * is §22.1.1.1, §21.1.1.1 or §20.3.1.1 with NewTarget undefined: ToString, ToNumber or ToBoolean of the first argument,
 * and "", +0 or false without one. The arguments are already evaluated (the front end, left to right), so an extra
 * one has run and is ignored. Any other callee holding the constructor (through a variable) reaches the dispatcher,
 * whose built-in arm is the run-time abort.
 *
 * Construction. `new X(v)` makes a wrapper object, which the realm does not have yet: it refuses by name.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { RealmConstructor } from "./builtin-prototype-keys.js";
import type { RealmConstruction, RealmConstructionBuilders } from "./dynamic-error-constructors.js";
import { carried } from "./dynamic-value-chains.js";
import { gap } from "./dynamic-value-gap.js";

type WrapperBuilders = RealmConstructionBuilders & {
  readonly toNumber: (instr: IrInstr, value: IrValueId, result: IrValueId) => IrInstr[];
};

/** `X(v)` of the wrapper constructor `ctor`, into the instruction's result; `new X(v)` refuses. */
export function dynamicWrapperConstruction(
  b: WrapperBuilders,
  instr: RealmConstruction,
  ctor: RealmConstructor,
  args: readonly IrValueId[],
): IrInstr[] {
  if (instr.kind === "dyn.construct") gap(`new ${ctor.name} (a wrapper object; #7350 B3bc)`);
  const [value, converted] = [args[0], b.fresh()];
  const into = (instrs: IrInstr[], box: "js.number.box" | "js.boolean.box" | undefined): IrInstr[] => [
    ...instrs,
    box === undefined ? carried(converted, instr.result!) : b.intrinsic(instr, box, [converted], instr.result!),
  ];
  const constant = (kind: "f64" | "bool"): IrInstr => ({
    kind: "const",
    value: kind === "f64" ? { kind, value: 0 } : { kind, value: false },
    result: converted,
    resultType: { kind: "val", val: kind === "f64" ? { kind } : { kind: "i32", boolean: true } },
  });
  switch (ctor.name) {
    case "String":
      return into(value === undefined ? [b.text("", converted)] : b.stringOf(instr, value, converted), undefined);
    case "Number":
      return into(value === undefined ? [constant("f64")] : b.toNumber(instr, value, converted), "js.number.box");
    default: // Boolean
      return into(
        value === undefined ? [constant("bool")] : [b.intrinsic(instr, "js.value.to_boolean", [value], converted)],
        "js.boolean.box",
      );
  }
}
