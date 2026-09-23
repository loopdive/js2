// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachInstrDeep, type IrInstrIntrinsic } from "../core/nodes.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { INTRINSIC_DEFINITIONS } from "../core/intrinsics.js";
import { NUMBER_BOUNDARY_RUNTIME_PROVIDERS } from "../runtime/manifest.js";
import { resolveRuntimeHostCapabilityFuncRecord } from "../runtime/host-capabilities.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrSourceRecord } from "../../shared/contracts/ir-unit-inventory.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import { preparedIrDataMismatch } from "./data.js";
import { planPreparedHostImport } from "./host-import-plan.js";

export interface HostNumberBoundarySetup {
  readonly imports: readonly ReturnType<typeof planPreparedHostImport>[];
  readonly entries: readonly ProgramAbiPlanEntry[];
}

/** Resolve the actual number-box demands; an async bridge never grants this policy. */
export function planHostNumberBoundary(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  anchor: IrSourceRecord,
  supplemental: readonly ProgramAbiPlanEntry[],
): { kind: "planned"; setup: HostNumberBoundarySetup } | { kind: "unsupported"; unitId: IrUnitId; detail: string } {
  const demands: { unitId: IrUnitId; instruction: IrInstrIntrinsic }[] = [];
  for (const fn of projection.prepared.functions)
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "intrinsic" && instruction.id === "js.number.box")
            demands.push({ unitId: fn.unitId, instruction });
        });
  if (!demands.length) return { kind: "planned", setup: { imports: [], entries: [] } };
  const unitId = demands[0]!.unitId;
  const gap = (detail: string) => ({ kind: "unsupported" as const, unitId, detail });
  const { manifest, providers } = projection.prepared;
  if (projection.backend !== "wasmgc" || projection.target !== "host" || manifest.policy.numberBoundary.box !== "host")
    return gap("number boxing requires the explicit host number-boundary provider policy");
  const canonical = NUMBER_BOUNDARY_RUNTIME_PROVIDERS.filter((provider) => provider.id === "host.js.number.box");
  const provider = canonical[0];
  const selected = manifest.providers.filter((row) => row.feature === "js.number.box");
  if (
    canonical.length !== 1 ||
    !provider?.signature ||
    provider.implementation.kind !== "host-callable" ||
    provider.implementation.capability !== "number.box" ||
    selected.length !== 1 ||
    preparedIrDataMismatch(selected[0], provider) !== undefined ||
    preparedIrDataMismatch(providers.get("js.number.box"), provider) !== undefined ||
    preparedIrDataMismatch(provider.signature, INTRINSIC_DEFINITIONS["js.number.box"].signature) !== undefined
  )
    return gap("number boxing does not have its exact canonical selected provider and semantic signature");
  if (!program.inventory.sources.includes(anchor)) throw new Error("number box anchor belongs to another program");
  const occupied = [...program.abi.entries.map((row) => row.plan), ...supplemental];
  let order = 0;
  for (const entry of occupied)
    if (entry.order.sourceOrder === anchor.order) order = Math.max(order, entry.order.declarationOrder + 1);
  const record = resolveRuntimeHostCapabilityFuncRecord(manifest.hostCapabilityRecords, "number.box");
  let imported = planPreparedHostImport(anchor, order, record);
  for (const demand of demands) {
    const attachment = demand.instruction.provider;
    if (attachment?.kind !== "callable" || irCallableBindingKey(attachment.target.binding) !== imported.referenceKey)
      return {
        kind: "unsupported",
        unitId: demand.unitId,
        detail: "number box attachment differs from its canonical host import",
      };
  }
  const previous = occupied.find((entry) => entry.id === imported.entry.id);
  if (previous) {
    if (
      preparedIrDataMismatch(previous, {
        ...imported.entry,
        order: previous.order,
        displayName: previous.displayName,
      }) !== undefined
    )
      return gap("number box import contradicts an existing ABI declaration");
    imported = { ...imported, entry: previous };
  }
  return { kind: "planned", setup: { imports: [imported], entries: previous ? [] : [imported.entry] } };
}
