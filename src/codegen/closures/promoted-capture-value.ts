// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { refCellValueType } from "../registry/types.js";
import { valTypesMatch } from "../shared.js";

/** Read an immutable capture's value, not a promoted sibling's mutable cell. */
export function promotedCaptureValueInstrs(ctx: CodegenContext, name: string, expected: ValType | undefined): Instr[] {
  const globalIdx = ctx.capturedGlobals.get(name);
  if (globalIdx === undefined) throw new Error(`Missing promoted capture global: ${name}`);
  const instructions: Instr[] = [{ op: "global.get", index: globalIdx }];
  const box = ctx.capturedBoxGlobals?.get(name);
  if (
    box !== undefined &&
    box.globalIdx === globalIdx &&
    expected !== undefined &&
    box.valType !== undefined &&
    valTypesMatch(expected, box.valType)
  ) {
    const globalType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    if ((globalType?.kind !== "ref" && globalType?.kind !== "ref_null") || globalType.typeIdx !== box.refCellTypeIdx) {
      throw new Error(`Promoted capture cell type disagrees with its global: ${name}`);
    }
    const innerType = refCellValueType(ctx, box.refCellTypeIdx);
    if (innerType === undefined || !valTypesMatch(innerType, expected)) {
      throw new Error(`Promoted capture cell value type disagrees with its consumer: ${name}`);
    }
    instructions.push({ op: "struct.get", typeIdx: box.refCellTypeIdx, fieldIdx: 0 });
  } else if (ctx.capturedGlobalsWidened.has(name)) {
    instructions.push({ op: "ref.as_non_null" });
  }
  return instructions;
}
