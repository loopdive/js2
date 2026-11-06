// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrFuncRef } from "../core/value-references.js";
import { irSupportRef, irVal, type IrType } from "../core/types.js";
import { irCallableBindingKey, irSupportFuncRef } from "../core/callable-bindings.js";
import { irSupportTypeRef } from "../core/type-references.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import { preparedIrCallableSignature, preparedIrDataKey } from "./abi-signatures.js";
import { preparedIrDataMismatch } from "./data.js";
import { planPreparedHostImport } from "./host-import-plan.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { CurrentPreparedIrAsyncRuntime } from "../runtime/contracts/prepared.js";
import type {
  PreparedFrameInput,
  PreparedHostAsyncFramePlan,
  PreparedAsyncFrameSignatureType,
  PreparedAsyncFrameCallable,
  FrameField,
} from "./prepared-async-frame-contracts.js";
import { gap } from "./prepared-async-frame-layout.js";
type PlannedImport = PreparedHostAsyncFramePlan["imports"][number];
const ext: ValType = { kind: "externref" };

/** Supplementary declarations use the same canonical constructors as the main ABI. */
export class FrameDeclarations {
  readonly entries: ProgramAbiPlanEntry[] = [];
  private next: number;
  constructor(readonly input: PreparedFrameInput) {
    this.next = input.declarationOrderStart;
    if (
      input.anchor.kind !== "entry" ||
      !Number.isSafeInteger(this.next) ||
      this.next < 0 ||
      !Number.isSafeInteger(input.anchor.order) ||
      input.anchor.order < 0
    )
      gap("invalid ABI anchor or declaration order");
  }
  order() {
    return {
      sourceOrder: this.input.anchor.order,
      declarationOrder: this.next++,
    };
  }
  add(entry: ProgramAbiPlanEntry): ProgramAbiPlanEntry {
    const existing = this.input.abiEntries.find((row) => row.plan.id === entry.id)?.plan;
    if (existing) {
      const { order: _oldOrder, displayName: _oldName, ...old } = existing;
      const { order: _newOrder, displayName: _newName, ...next } = entry;
      if (preparedIrDataMismatch(old, next)) gap(`supplementary ABI collision for ${entry.displayName}`);
      return existing;
    }
    if (
      this.entries.some((row) => row.id === entry.id) ||
      [...this.input.abiEntries.map((row) => row.plan), ...this.entries].some(
        (row) =>
          row.order.sourceOrder === entry.order.sourceOrder &&
          row.order.declarationOrder === entry.order.declarationOrder,
      )
    )
      gap(`supplementary ABI identity/order collision for ${entry.displayName}`);
    this.entries.push(entry);
    return entry;
  }
  callable(
    reference: IrFuncRef,
    bindingId: IrBindingId,
    params: readonly PreparedAsyncFrameSignatureType[],
    results: readonly PreparedAsyncFrameSignatureType[],
    origin: "import" | "support",
  ): PreparedAsyncFrameCallable {
    const logical = (type: PreparedAsyncFrameSignatureType): IrType =>
      type.kind === "support-ref" ? type : irVal(type);
    const entry = this.add({
      id: bindingId,
      order: this.order(),
      displayName: reference.name,
      structuralReferenceKey: irCallableBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin,
        ...(origin === "support" ? { unitId: this.input.fn.unitId } : {}),
        signature: preparedIrCallableSignature(params.map(logical), results.map(logical)),
      },
    });
    return { reference, bindingId, params, results, entry };
  }
  imports(runtime: CurrentPreparedIrAsyncRuntime): PlannedImport[] {
    if (runtime.kind !== "host-wasmgc") return gap("host adapters are absent");
    return runtime.adapters.map((adapter) => {
      const imported = planPreparedHostImport(this.input.anchor, this.next, adapter.record);
      this.next++;
      if (preparedIrDataMismatch(imported.reference.binding, adapter.target.binding) !== undefined)
        return gap("async adapter target differs from canonical host capability");
      return { ...imported, capability: adapter.capability, entry: this.add(imported.entry) };
    });
  }
}

export function frameMachinery<F extends FrameField>(declarations: FrameDeclarations, fields: readonly F[]) {
  const { input } = declarations;
  const reference = irSupportTypeRef(input.fn.unitId, "prepared-async-frame", `${input.fn.name}__frame`);
  const frame = {
    reference,
    fields,
    entry: declarations.add({
      id: reference.binding.bindingId,
      order: declarations.order(),
      displayName: reference.name,
      structuralReferenceKey: irTypeBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "type",
      intent: {
        kind: "type",
        shapeKey: preparedIrDataKey({ kind: "struct", fields }),
      },
    }),
  };
  const helper = (role: string, params: readonly PreparedAsyncFrameSignatureType[], results: readonly ValType[]) => {
    const ref = irSupportFuncRef(input.fn.unitId, `prepared-async-frame:${role}`, `${input.fn.name}__${role}`);
    if (ref.binding.kind !== "support") return gap("support constructor lost its binding");
    return declarations.callable(ref, ref.binding.bindingId, params, results, "support");
  };
  const auxiliaries = {
    resume: helper("resume", [irSupportRef(reference, false)], []),
    fulfillStep: helper("fulfill", [ext, ext], [ext]),
    rejectStep: helper("reject", [ext, ext], [ext]),
  };
  if (!input.callbacks) return { frame, auxiliaries, callbacks: [] };
  const callbacksInput = input.callbacks;
  const ids = [callbacksInput.fulfill, callbacksInput.reject];
  const existingNames = input.abiEntries.flatMap((row) =>
    row.contract.kind === "export" ? [row.contract.externalName] : [],
  );
  if (
    ids[0] === ids[1] ||
    ids.some(
      (id) =>
        !Number.isSafeInteger(id) ||
        id < 0 ||
        id > 0x7fffffff ||
        callbacksInput.occupiedIds.includes(id) ||
        [...callbacksInput.occupiedNames, ...existingNames].includes(`__cb_${id}`),
    )
  )
    gap("callback IDs/names are invalid or occupied");
  const callbacks = ids.map((id, index) => {
    const externalName = `__cb_${id}`;
    const targetBindingId = index === 0 ? auxiliaries.fulfillStep.bindingId : auxiliaries.rejectStep.bindingId;
    return {
      id,
      externalName,
      targetBindingId,
      entry: declarations.add({
        id: createIrBindingId({
          ownerId: input.fn.unitId,
          domain: "export",
          role: `prepared-async-frame:callback:${index}`,
        }),
        order: declarations.order(),
        displayName: externalName,
        slotPolicy: "alias",
        aliasOf: targetBindingId,
        intent: { kind: "export", externalName, targetId: targetBindingId },
      }),
    };
  });
  return { frame, auxiliaries, callbacks };
}
