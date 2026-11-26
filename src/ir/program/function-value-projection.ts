// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Fa) The function-value projection as the dynamic-value legalization meets it: the front end puts a packed
 * callable into the dynamic value with a call of `__ir_dyn_call_box` (`functionObjectDynamicValue`), and on the
 * Prepared path that call is the packed callable's own externref (`dynamic-value-legalization.ts`), of the function
 * kind (`carrierKindOf`).
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { IR_DYN_CALL_BOX_FN } from "../../shared/contracts/dynamic-call-helpers.js";

/** The value the projection puts into the dynamic value, if `instr` is that projection. */
export function functionValueOperand(instr: IrInstr | undefined): IrValueId | undefined {
  return instr?.kind === "call" && instr.target.binding.kind === "runtime" && instr.target.name === IR_DYN_CALL_BOX_FN
    ? instr.args[0]
    : undefined;
}
