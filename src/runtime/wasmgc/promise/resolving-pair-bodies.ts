// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PromiseSettleClosureResources } from "./resolution-bodies.js";
import { buildPromiseRejectionEvent } from "./rejection-event-bodies.js";

/** Lock before resolution reads user properties or enqueues pending adoption. */
export function buildPromiseResolvingPairGuard(resources: PromiseSettleClosureResources): Instr[] {
  const { capTypeIdx, capPromiseFieldIdx, guardTypeIdx } = resources;
  if (guardTypeIdx === undefined) throw new Error("Resolving pair guard requires its shared cell type");
  return [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: capTypeIdx },
    { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: capPromiseFieldIdx + 1 },
    { op: "struct.get", typeIdx: guardTypeIdx, fieldIdx: 0 },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...buildPromiseRejectionEvent(
          resources.rejectionDispatchFuncIdx,
          resources.duplicateEvent ?? 2,
          [
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: capTypeIdx },
            { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: capPromiseFieldIdx },
          ],
          [{ op: "local.get", index: 1 }],
        ),
        { op: "return" },
      ],
    },
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: capTypeIdx },
    { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: capPromiseFieldIdx + 1 },
    { op: "i32.const", value: 1 },
    { op: "struct.set", typeIdx: guardTypeIdx, fieldIdx: 0 },
  ];
}
