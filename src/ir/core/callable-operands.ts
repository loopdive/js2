// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "./nodes.js";
import type { IrFuncRef } from "./value-references.js";

/** Explicit calls and callable allocations; operation-specific providers have their own owners. */
export function directIrCallableReferences(instruction: IrInstr): readonly IrFuncRef[] {
  switch (instruction.kind) {
    case "call":
      return [instruction.target];
    case "closure.new":
      return [instruction.liftedFunc];
    case "class.value.new":
      return [instruction.callTarget, instruction.allocator];
    default:
      return [];
  }
}
