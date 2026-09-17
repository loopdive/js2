// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ProgramAbiMap, type ProgramAbiPlanEntry } from "./abi.js";
import { preparedIrDataMismatch } from "./data.js";
import type { IrSourceRecord } from "../../shared/contracts/ir-unit-inventory.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import {
  planPreparedHostAsyncFrame,
  type PreparedHostAsyncFramePlan,
  type PreparedHostAsyncFrameOutcome,
} from "./prepared-async-frame-plan.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";

export interface AsyncFrameSetup {
  readonly frames: readonly PreparedHostAsyncFramePlan[];
  readonly entries: readonly ProgramAbiPlanEntry[];
}

/** Join real async owners into the existing ABI before any physical reservation. */
export function planAsyncFrameSetup(
  program: PreparedIrProgram,
  options: Pick<RuntimeManifestPolicy, "backend" | "target">,
  projection: PreparedIrProgramRuntimeProjection,
  supplemental: readonly ProgramAbiPlanEntry[],
  anchor: IrSourceRecord,
):
  | { readonly kind: "planned"; readonly setup: AsyncFrameSetup }
  | Extract<PreparedHostAsyncFrameOutcome, { kind: "unsupported" }> {
  if (!program.inventory.sources.includes(anchor) || anchor.kind !== "entry")
    throw new Error("async frame anchor does not belong to this program");
  const entries = new Map(program.abi.entries.map((row) => [row.plan.id, row.plan]));
  const joined: ProgramAbiPlanEntry[] = [];
  const join = (row: ProgramAbiPlanEntry): void => {
    const previous = entries.get(row.id);
    if (previous) {
      if (
        preparedIrDataMismatch(previous, { ...row, order: previous.order, displayName: previous.displayName }) !==
        undefined
      )
        throw new Error(`async frame ABI contradicts existing binding ${row.id}`);
    } else {
      entries.set(row.id, row);
      joined.push(row);
    }
  };
  supplemental.forEach(join);
  const initialIds = new Set(entries.keys());
  const names = new Set(
    program.abi.entries.flatMap((row) => (row.contract.kind === "export" ? [row.contract.externalName] : [])),
  );
  const ids: number[] = [];
  let nextCallback = 0;
  const callback = (): number => {
    while (names.has(`__cb_${nextCallback}`)) nextCallback++;
    return nextCallback++;
  };
  const frames: PreparedHostAsyncFramePlan[] = [];
  for (const fn of projection.prepared.functions) {
    if (!fn.asyncPlan && !fn.asyncRuntime) continue;
    let order = 0;
    for (const row of entries.values())
      if (row.order.sourceOrder === anchor.order) order = Math.max(order, row.order.declarationOrder + 1);
    const outcome = planPreparedHostAsyncFrame({
      fn,
      backend: options.backend,
      target: options.target,
      abiEntries: program.abi.entries,
      anchor,
      declarationOrderStart: order,
      callbacks: { fulfill: callback(), reject: callback(), occupiedIds: ids, occupiedNames: [...names] },
    });
    if (outcome.kind !== "planned") return outcome;
    outcome.plan.entries.forEach(join);
    for (const published of outcome.plan.callbacks) {
      if (names.has(published.externalName)) throw new Error("async callback export collides with another owner");
      names.add(published.externalName);
      ids.push(published.id);
    }
    frames.push(outcome.plan);
  }
  const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const row of entries.values()) abi.plan(row);
  abi.sealPlan();
  return { kind: "planned", setup: { frames, entries: joined.filter((row) => !initialIds.has(row.id)) } };
}
