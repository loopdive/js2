// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";

/** Fresh `(i32 pointer) -> i32` forwarding walk using caller-supplied layout operands. */
export function buildArrayForwardingResolverBody(
  forwarding: Readonly<{ tag: number; tagOffset: number; pointerOffset: number }>,
): Instr[] {
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // If this is not a forwarding record, break.
            { op: "local.get", index: 0 },
            { op: "i32.load8_u", align: 0, offset: forwarding.tagOffset },
            { op: "i32.const", value: forwarding.tag },
            { op: "i32.ne" },
            { op: "br_if", depth: 1 },
            // ptr = forwarding replacement pointer
            { op: "local.get", index: 0 },
            { op: "i32.load", align: 2, offset: forwarding.pointerOffset },
            { op: "local.set", index: 0 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
  ];
}
