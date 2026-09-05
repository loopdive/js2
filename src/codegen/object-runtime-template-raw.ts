// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Build the dynamic `strings.raw` arm for `__extern_get`.
 *
 * The property key is an arbitrary externref. Check its native-string brand
 * before flattening it; deepEqual's `value[Symbol.iterator]` probe is the
 * important non-string case. Only a native template-vector receiver may then
 * expose its extra `raw` field.
 */
export function buildTemplateRawGetArm(
  ctx: CodegenContext,
  templateVecTypeIdx: number,
  strFlattenIdx: number | undefined,
  strEqualsIdx: number | undefined,
): Instr[] {
  if (templateVecTypeIdx < 0 || strFlattenIdx === undefined || strEqualsIdx === undefined) return [];

  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        ...nativeStringLiteralInstrs(ctx, "raw"),
        { op: "call", funcIdx: strEqualsIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 4 },
            { op: "ref.test", typeIdx: templateVecTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 4 },
                { op: "ref.cast", typeIdx: templateVecTypeIdx },
                { op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 },
                { op: "extern.convert_any" },
                { op: "return" },
              ],
            },
          ],
        },
      ],
    },
  ];
}
