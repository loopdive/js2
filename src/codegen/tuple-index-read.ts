// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * A tuple that crosses an externref boundary is still the same JS array.
 * Its `_N` fields are compiler storage names, not the observable index names.
 * Add exact numeric-index reads over registered tuple layouts, preserving
 * source identity and leaving unmatched keys to the existing property path.
 * Called after __extern_get_idx's receiver is internalized in local 2.
 */
export function buildTupleIndexReadArms(ctx: CodegenContext, box: (type: ValType) => Instr[] | null): Instr[] {
  const arms: Instr[] = [];
  for (const typeIdx of [...new Set(ctx.tupleTypeMap.values())].sort((a, b) => a - b)) {
    const def = ctx.mod.types[typeIdx];
    const struct =
      def?.kind === "struct" ? def : def?.kind === "sub" && def.type.kind === "struct" ? def.type : undefined;
    if (!struct) continue;
    const reads: Instr[] = [];
    for (const [fieldIdx, field] of struct.fields.entries()) {
      if (field.name !== `_${fieldIdx}`) continue;
      const booleanBox = field.type.kind === "i32" && field.type.boolean ? ctx.funcMap.get("__box_boolean") : undefined;
      const boxing: Instr[] | null = booleanBox === undefined ? box(field.type) : [{ op: "call", funcIdx: booleanBox }];
      if (!boxing) continue;
      reads.push(
        { op: "local.get", index: 1 },
        { op: "f64.const", value: fieldIdx },
        { op: "f64.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx },
            { op: "struct.get", typeIdx, fieldIdx },
            ...boxing,
            { op: "return" },
          ],
          else: [],
        },
      );
    }
    if (reads.length > 0)
      arms.push(
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: reads, else: [] },
      );
  }
  return arms;
}
