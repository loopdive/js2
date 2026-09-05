// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Shared companion-table check for sparse-vector marker arms. */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Build `1` when a vector has no own descriptor for the current numeric key.
 * `undefined` means the overlay runtime is not available and callers can use
 * the constant-present fallback without allocating the companion local.
 */
export function holeCompanionNoOwnDescriptor(
  ctx: CodegenContext,
  anyLocal: number,
  compLocal: number,
): Instr[] | undefined {
  const types = ctx.objectRuntimeTypes;
  const lookupIdx = ctx.funcMap.get("__vec_overlay_lookup");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  if (types === undefined || lookupIdx === undefined || objFindIdx === undefined || numToStringIdx === undefined) {
    return undefined;
  }
  return [
    { op: "local.get", index: anyLocal },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: compLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: compLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: numToStringIdx },
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
      ],
    },
  ];
}
