// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";

/** The registered name read, in either the host or native string representation. */
export type ErrorNameValue =
  | { readonly kind: "global"; readonly index: number; readonly representation: "gc" | "externref" }
  | { readonly kind: "callable"; readonly handle: number; readonly representation: "gc" }
  | { readonly kind: "legacy-missing" };

export function buildErrorConstructorBody(
  structIdx: number,
  tagValue: number,
  argCount: number,
  name: ErrorNameValue,
): Instr[] {
  const nameInstrs: Instr[] =
    name.kind === "legacy-missing"
      ? [{ op: "ref.null.extern" }]
      : name.kind === "global"
        ? [{ op: "global.get", index: name.index }]
        : [{ op: "call", funcIdx: name.handle }];
  if (name.kind !== "legacy-missing" && name.representation === "gc") nameInstrs.push({ op: "extern.convert_any" });
  return [
    { op: "i32.const", value: tagValue },
    argCount > 0 ? { op: "local.get", index: 0 } : { op: "ref.null.extern" },
    ...nameInstrs,
    // Preserve the existing stack initializer and lazy property bag.
    { op: "ref.null.extern" },
    { op: "i32.const", value: -1 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];
}
