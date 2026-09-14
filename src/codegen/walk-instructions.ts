// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, WasmModule } from "../ir/types.js";
import { walkInstructionDag } from "../wasm/model/instruction-walk.js";
export { walkInstructions, walkInstructionDag, walkChildren } from "../wasm/model/instruction-walk.js";

/** Struct types that have a concrete allocation site in the completed module. */
export function allocatedStructTypeIndices(mod: WasmModule): ReadonlySet<number> {
  const out = new Set<number>();
  const visited = new WeakSet<Instr[]>();
  for (const body of [...mod.functions.map((fn) => fn.body), ...mod.globals.map((global) => global.init)])
    walkInstructionDag(
      body,
      (instr) => {
        if (instr.op === "struct.new" && typeof instr.typeIdx === "number") out.add(instr.typeIdx);
      },
      visited,
    );
  return out;
}
