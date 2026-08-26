// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Tag-5 projection for the `$AnyValue` → externref boundary helper. */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { usesHostBigIntCarrier } from "./host-bigint-carrier.js";

const readExternValue = (anyTypeIdx: number): Instr[] => [
  { op: "local.get", index: 0 },
  { op: "ref.as_non_null" },
  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
];

export function buildAnyTag5ExternProjection(ctx: CodegenContext, anyTypeIdx: number): Instr[] {
  const host = usesHostBigIntCarrier(ctx);
  if (!host && ctx.anyStrTypeIdx < 0) return [];

  const then: Instr[] = host
    ? [...readExternValue(anyTypeIdx), { op: "return" }]
    : [
        ...readExternValue(anyTypeIdx),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...readExternValue(anyTypeIdx), { op: "return" }],
        },
      ];
  return [
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 5 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then },
  ];
}
