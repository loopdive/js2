// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrInstr } from "../nodes.js";
import type { Instr } from "../../wasm/model/instructions.js";

// #1713: exported as `emitConstInstr` so `WasmGcEmitter.emitConst` can delegate
// to this single const-lowering implementation (not duplicated).
export function emitConstInstr(instr: Extract<IrInstr, { kind: "const" }>, out: Instr[], funcName: string): void {
  const v = instr.value;
  switch (v.kind) {
    case "i32":
      out.push({ op: "i32.const", value: v.value });
      return;
    case "i64":
      out.push({ op: "i64.const", value: v.value });
      return;
    case "f32":
      out.push({ op: "f32.const", value: v.value });
      return;
    case "f64":
      out.push({ op: "f64.const", value: v.value });
      return;
    case "bool":
      out.push({ op: "i32.const", value: v.value ? 1 : 0 });
      return;
    case "null":
      throw new Error(`ir/lower: const null must be emitted through BackendEmitter.emitNull (${funcName})`);
    case "undefined":
      throw new Error(`ir/lower: Phase 1 does not materialize 'undefined' constants (${funcName})`);
  }
}
