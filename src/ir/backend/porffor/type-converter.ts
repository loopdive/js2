// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../../nodes.js";
import { asVal } from "../../nodes.js";
import type { TypeConverter } from "../contract.js";

/**
 * Symbolic Porffor value slots used above the unstable numeric T.* enum.
 * P2's module adapter maps these names to the compatibility-checked ordinals
 * only at final Porffor assembly time.
 */
export type PorfforValueSlot = "f64" | "i32" | "u32" | "i64" | "u64" | "ptr";

/** Narrow scalar converter matching the P1 Porffor legality profile. */
export class PorfforTypeConverter implements TypeConverter<PorfforValueSlot> {
  readonly backend = "porffor" as const;

  convertType(type: IrType): readonly PorfforValueSlot[] {
    if (type.kind === "object" || type.kind === "string" || type.kind === "vec") return ["ptr"];
    const value = asVal(type);
    if (!value) {
      throw new Error(`porffor backend does not support IR type '${type.kind}'`);
    }

    switch (value.kind) {
      case "f64":
        return ["f64"];
      case "i32":
        return [type.kind === "val" && type.signed === false ? "u32" : "i32"];
      case "i64":
        return [type.kind === "val" && type.signed === false ? "u64" : "i64"];
      case "ref":
      case "ref_null":
        // Only backend-created vec scratch locals reach this arm in P4. JS2
        // heap values themselves remain explicit linear-memory pointers.
        return ["ptr"];
      default:
        throw new Error(`porffor backend does not support ValType '${value.kind}'`);
    }
  }
}
