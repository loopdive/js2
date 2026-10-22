// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../model/instructions.js";

/** Interpret the source domain while widening an i32 storage pattern to Number. */
export function i32NumberWidening(type: ValType): Instr {
  return { op: type.kind === "i32" && type.uint32 === true ? "f64.convert_i32_u" : "f64.convert_i32_s" };
}
