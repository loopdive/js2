// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { buildStandardTryTable } from "../try-table.js";
import type { BlockType, Instr } from "../types.js";
import type { IrLowerResolver } from "./lower-contracts.js";

/** Canonical Wasm EH; the shared tag carries the original opaque Error value. */
export function emitLinearTry(
  resolver: IrLowerResolver | undefined,
  blockType: BlockType,
  body: Instr[],
  catches: { tagIdx: number; body: Instr[] }[],
  catchAll: Instr[] | undefined,
): Instr {
  if (!resolver?.standardizedExceptions?.())
    return {
      op: "try",
      blockType,
      body,
      catches,
      ...(catchAll ? { catchAll } : {}),
    };
  if (catches.length > 0)
    return buildStandardTryTable(
      blockType,
      body,
      catches.map((clause) => ({
        kind: "catch",
        tagIdx: clause.tagIdx,
        payloadType: { kind: "externref" },
        body: clause.body,
      })),
    );
  if (!catchAll) throw new Error("LinearEmitter: standardized try requires a handler");
  const tagIdx = resolver.ensureExnTag?.();
  if (tagIdx === undefined) throw new Error("LinearEmitter: standardized try requires the shared exception tag");
  const handler = [...catchAll];
  const terminal = handler[handler.length - 1];
  if (!terminal || terminal.op !== "rethrow" || terminal.depth !== 0)
    throw new Error("LinearEmitter: standardized finally handler must end in rethrow 0");
  // The balanced finally body leaves the caught payload on the operand stack.
  handler[handler.length - 1] = { op: "throw", tagIdx };
  return buildStandardTryTable(blockType, body, [
    {
      kind: "catch",
      tagIdx,
      payloadType: { kind: "externref" },
      body: handler,
    },
  ]);
}
