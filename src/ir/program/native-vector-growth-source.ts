// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irVecElemSetSymbol } from "../core/vector-runtime.js";
import { IrInvariantError } from "../../shared/contracts/ir-preparation-errors.js";

import { collectNativeNumericAppendProtocol } from "../analysis/allocation-evidence/numeric-append-protocol.js";

/** Own source sequence only; complete Program validation still joins effects, origins, ABI and resources. */
export function refuseUnbackedNativeNumericGrowth(fn: IrFunction): void {
  const types = new Map<IrValueId, IrType>(fn.params.map((param) => [param.value, param.type]));
  const symbol = irVecElemSetSymbol({ kind: "val", val: { kind: "f64" } });
  for (const buffer of [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
  ])
    for (const root of buffer)
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType !== null) types.set(instr.result, instr.resultType);
        if (
          instr.kind !== "call" ||
          instr.target.binding.kind !== "intrinsic" ||
          instr.target.binding.symbol !== symbol
        )
          return;
        const receiver = types.get(instr.args[0]!);
        if (
          receiver?.kind !== "vec" ||
          receiver.layout ||
          receiver.elementType.kind !== "val" ||
          receiver.elementType.val.kind !== "f64"
        )
          throw new IrInvariantError(
            "type-map-failure",
            "build",
            "native numeric grow/store lacks its authentic logical f64 receiver",
            { unitId: fn.unitId },
          );
      });
  collectNativeNumericAppendProtocol([fn]);
}
