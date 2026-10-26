// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PreparedHostAsyncFramePlan,
  PreparedAsyncFrameSignatureType,
} from "../../../ir/program/prepared-async-frame-plan.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { PreparedAsyncFrameReservations } from "./prepared-async-frame.js";

/** One layout/machinery allocation order for host and materialized native frames. */
export function reservePreparedFrameLayout(
  transaction: PhysicalModuleReservations,
  plan: Pick<PreparedHostAsyncFramePlan, "frame" | "primary" | "auxiliaries">,
  entry: FunctionReservation,
): PreparedAsyncFrameReservations {
  const fail = (detail: string): never => {
    throw new Error(`prepared async resources: ${detail}`);
  };
  if (entry.key !== plan.primary.bindingId) fail("foreign primary slot");
  const frame = transaction.reserveType(plan.frame.entry.id, {
    kind: "struct",
    name: plan.frame.entry.displayName,
    fields: plan.frame.fields.map((field) => ({ ...field })),
  });
  const value = (type: PreparedAsyncFrameSignatureType): ValType => {
    if (type.kind !== "support-ref") return type;
    if (type.ref.binding.bindingId !== plan.frame.entry.id) return fail("foreign frame signature");
    return { kind: type.nullable ? "ref_null" : "ref", typeIdx: frame.typeIndex };
  };
  const reserve = (row: PreparedHostAsyncFramePlan["primary"]): FunctionReservation =>
    transaction.reserveFunction(row.bindingId, row.entry.displayName, {
      params: row.params.map(value),
      results: row.results.map(value),
    });
  const result = Object.freeze({
    frame,
    entry,
    resume: reserve(plan.auxiliaries.resume),
    fulfillStep: reserve(plan.auxiliaries.fulfillStep),
    rejectStep: reserve(plan.auxiliaries.rejectStep),
  });
  return result;
}
