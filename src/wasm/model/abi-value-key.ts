// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "./instructions.js";

export function canonicalProgramAbiValType(type: ValType): string {
  switch (type.kind) {
    case "i32":
      return JSON.stringify({
        kind: type.kind,
        ...(type.boolean === true ? { boolean: true as const } : {}),
        ...(type.symbol === true ? { symbol: true as const } : {}),
      });
    case "i64":
      return JSON.stringify({
        kind: type.kind,
        ...(type.bigint === true ? { bigint: true as const } : {}),
      });
    case "ref":
    case "ref_null":
      return JSON.stringify({ kind: type.kind, typeIdx: type.typeIdx });
    default:
      return JSON.stringify({ kind: type.kind });
  }
}
