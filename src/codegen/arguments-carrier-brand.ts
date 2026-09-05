// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared state/IR helpers for the standalone nominal arguments carrier.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

type ArgumentsCarrierContext = CodegenContext & { argumentsVecTypeIdx?: number };

/** Return the nominal arguments carrier, or -1 before it is materialized. */
export function getArgumentsVecTypeIdx(ctx: CodegenContext): number {
  return (ctx as ArgumentsCarrierContext).argumentsVecTypeIdx ?? -1;
}

/** Exclude the nominal arguments subtype before testing ordinary vec carriers. */
export function excludeArgumentsArrayCarrier(ctx: CodegenContext, anyLocal: number, chain: Instr[]): Instr[] {
  const typeIdx = getArgumentsVecTypeIdx(ctx);
  if (typeIdx < 0) return chain;
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: chain,
    },
  ];
}
