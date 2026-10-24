// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstrClassCall, IrType, IrValueId } from "../core/nodes.js";
import type { IrClassShape } from "../core/types.js";
import { irBindingKey } from "../core/declared-types.js";

export function classCallTargetMismatch(
  instr: IrInstrClassCall,
  typeOf: (value: IrValueId) => IrType | undefined,
): string | undefined {
  const receiver = typeOf(instr.receiver);
  if (!instr.target || receiver?.kind !== "class") return undefined;
  for (let shape: IrClassShape | undefined = receiver.shape; shape; shape = shape.parent) {
    const member = shape.methods.find(
      (candidate) => candidate.name === instr.methodName && (candidate.memberKind ?? "method") === instr.memberKind,
    );
    if (!member) continue;
    const want = member.target ? irBindingKey(member.target.binding) : null,
      got = irBindingKey(instr.target.binding);
    return want !== null && got !== null && want !== got
      ? `class.call ${instr.methodName} target ${got} is not ${receiver.shape.className}'s ${want}`
      : undefined;
  }
  return undefined;
}
