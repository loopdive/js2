// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import type { ValType } from "../../../wasm/model/instructions.js";

/** The legacy registry's exact key, including nullable/reference distinctions. */
export function refCellTypeKey(value: ValType): string {
  return value.kind === "ref" || value.kind === "ref_null" ? `${value.kind}_${value.typeIdx}` : value.kind;
}

/** The caller owns field-type identity and registration; no module or allocator is hidden here. */
export function createRefCellType(key: string, value: ValType): StructTypeDef {
  return { kind: "struct", name: `__ref_cell_${key}`, fields: [{ name: "value", type: value, mutable: true }] };
}
