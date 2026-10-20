// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr } from "../core/nodes.js";
import type { ValType } from "../../wasm/model/instructions.js";

export type NativeJsClassInstruction = Extract<IrInstr, { kind: `js.class.${string}` | "box" }>;

/** A property observation is a value snapshot, never an alias to mutable property storage. */
export interface NativeJsClassTaggedSnapshot {
  readonly tag: ValType;
  readonly number: ValType;
  readonly reference: ValType;
}
