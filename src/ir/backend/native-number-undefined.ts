// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunction, IrInstr } from "../core/nodes.js";
import type { Instr, ValType } from "../../wasm/model/instructions.js";
import type { NativeNumberUndefinedLegalityUse } from "../analysis/allocation-evidence/native-number-undefined-legality.js";
import type { IrBackendNativeAdmission } from "../analysis/backend-legality.js";

/** The existing vocabulary admitted by an independently checked native carrier. */
export type NativeNumberUndefinedInstruction = Extract<
  IrInstr,
  { kind: "const" | "box" | "tag.test" | "dyn.eq" | "dyn.to_number" }
>;

export type { NativeNumberUndefinedMemoryDescription } from "../program/prepared-linear-memory-contracts.js";

/** Scoped to the exact current function, instruction census and active emission attempt. */
export interface NativeNumberUndefinedLowering {
  readonly carrier: ValType;
  readonly legality: NativeNumberUndefinedLegalityUse;
  /** The verifier's injected admission over `legality` (#3518 lowering-cycle pin). */
  readonly admission: IrBackendNativeAdmission;
  assertFunction(fn: IrFunction): void;
  owns(instr: IrInstr): instr is NativeNumberUndefinedInstruction;
  emit(
    instr: NativeNumberUndefinedInstruction,
    operands: readonly (readonly Instr[])[],
    scratch: (type: ValType) => number,
  ): readonly Instr[];
}
