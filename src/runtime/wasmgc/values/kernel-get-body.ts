// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1, G1) The one call of the realm kernel's [[Get]] that the source-object adapters and the Error family's
 * bodies share. It is a leaf, so that neither of them imports the other.
 */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";

/**
 * The kernel's [[Get]] over `operands` (object, key, receiver) into the local `value`, by the get adapter's rule: a
 * status up to 2 answers the value, any other traps. (#7354 G1) Also Error.prototype.toString's reads.
 */
export function kernelGetInto(get: FuncHandle, operands: readonly Instr[], value: number): Instr[] {
  return [
    ...operands,
    { op: "call", funcIdx: get },
    { op: "local.set", index: value },
    { op: "i32.const", value: 2 },
    { op: "i32.gt_u" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
  ];
}
