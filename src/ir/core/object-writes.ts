// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstrBase, IrValueId } from "./nodes.js";

/**
 * Fixed-field store: value is a logical object and newValue matches its field.
 * Native lowering uses struct.set; reference projection needs failureMode.
 */
export interface IrInstrObjectSet extends IrInstrBase {
  readonly kind: "object.set";
  readonly value: IrValueId;
  readonly name: string;
  readonly newValue: IrValueId;
  /** Omitted means unknown/native-only. Not an environment or carrier choice. */
  readonly failureMode?: "throw" | "ignore";
}

export function objectSetInstruction(
  value: IrValueId,
  name: string,
  newValue: IrValueId,
  failureMode?: "throw" | "ignore",
): IrInstrObjectSet {
  return {
    kind: "object.set",
    value,
    name,
    newValue,
    ...(failureMode === undefined ? {} : { failureMode }),
    result: null,
    resultType: null,
  };
}
