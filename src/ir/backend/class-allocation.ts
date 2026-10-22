// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrLowerResolver } from "./lower-contracts.js";

export function emitIrClassAllocation<S>(
  instruction: Extract<IrInstr, { kind: "class.new" | "class.value.new" }>,
  resolver: IrLowerResolver,
  emitter: BackendEmitter<S>,
  emitValue: (value: IrValueId, out: S) => void,
  funcName: string,
  out: S,
): void {
  if (instruction.kind === "class.value.new") {
    emitter.emitFuncRef(resolver.resolveFunc(instruction.callTarget), out);
    emitter.emitScalarConst("i32", instruction.signature.defaultParamStart ?? instruction.signature.params.length, out);
    emitValue(instruction.properties, out);
    emitValue(instruction.construct, out);
    emitter.emitToExternref(out);
    emitValue(instruction.parent, out);
    emitter.emitCall(resolver.resolveFunc(instruction.allocator), out);
    return;
  }
  const cl = resolver.resolveClass?.(instruction.shape);
  if (!cl) throw new Error(`ir/lower: resolver cannot lower class ${instruction.shape.className} (${funcName})`);
  for (const argument of instruction.args) emitValue(argument, out);
  emitter.emitCall(resolver.resolveFunc(instruction.target ?? cl.constructorFunc), out);
}
