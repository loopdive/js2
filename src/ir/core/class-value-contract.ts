// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstrClassValueNew, IrType, IrValueId } from "./nodes.js";
import { closureSignatureEquals } from "./types.js";

/** Representation checks shared by construction, verification and backend lowering. */
export function classValueNewMismatch(
  instruction: Pick<IrInstrClassValueNew, "signature" | "construct" | "parent" | "properties" | "resultType">,
  typeOf: (value: IrValueId) => IrType | undefined,
): string | undefined {
  if (
    instruction.resultType?.kind !== "callable" ||
    !closureSignatureEquals(instruction.resultType.signature, instruction.signature)
  )
    return "class.value.new result must retain its exact callable signature";
  if (typeOf(instruction.construct)?.kind !== "closure")
    return "class.value.new requires an internal Construct closure";
  for (const [role, value] of [
    ["parent", instruction.parent],
    ["properties", instruction.properties],
  ] as const) {
    const type = typeOf(value);
    if (!(type?.kind === "extern" || (type?.kind === "val" && !type.typeRef && type.val.kind === "externref")))
      return `class.value.new ${role} requires an external value`;
  }
  return undefined;
}
