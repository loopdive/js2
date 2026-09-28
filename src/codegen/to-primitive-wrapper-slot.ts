// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../wasm/model/instructions.js";

/** Legacy literal acquisition stays at each original wrapper occurrence. */
export function captureWrapperPrimitiveKey(
  wrapperPrimitiveKey: string,
  stringExtern: (value: string) => Instr[],
): readonly Instr[] {
  return stringExtern(wrapperPrimitiveKey);
}
