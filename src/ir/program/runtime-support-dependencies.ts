// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "../core/callable-bindings.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { irTypeEquals, type IrType, type IrTypeRef } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { PreparedIrProgram } from "./prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { numberFormatRadixSupportDeclarations } from "./formatter-support.js";

/** Semantic dependency proof for separate support bodies, not physical readiness. */
export function assertPreparedIrRuntimeSupportDependencies(
  input: Pick<PreparedIrProgram, "inventory" | "runtimeSupport" | "abi">,
): void {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `runtime support dependencies: ${detail}`);
  };
  for (const batch of input.runtimeSupport?.batches ?? []) {
    const anchors = input.inventory.sources.filter((source) => source.kind === "entry");
    if (anchors.length !== 1 || anchors[0]!.id !== batch.sourceId) invalid("foreign source anchor");
    const canonical = numberFormatRadixSupportDeclarations(batch.sourceId);
    const callables = [...canonical.kernels, canonical.implementation];
    const active = new Set<object>();
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (active.has(value)) invalid("cyclic support dependency graph");
      const record = value as Record<string, unknown>;
      if (record.kind === "string.const" && (Object.hasOwn(record, "storage") || Object.hasOwn(record, "materializer")))
        invalid("D1 support literals cannot carry physical storage or materializer attachments");
      if (Object.hasOwn(record, "typeIdx")) invalid("physical type index in semantic support");
      if (
        [
          "global",
          "class",
          "object",
          "vec",
          "closure",
          "callable",
          "boxed",
          "union",
          "fnctor",
          "extern",
          "dynamic",
          "ref",
          "ref_null",
        ].includes(String(record.kind))
      )
        invalid(`unsupported dependency-bearing form ${String(record.kind)}`);
      if (record.kind === "support-ref") {
        const type = value as Extract<IrType, { kind: "support-ref" }>;
        if (!type.ref || type.ref.binding?.kind !== "support" || !irTypeEquals(type, canonical.scratch.type))
          invalid("foreign or incompatible symbolic scratch type");
      }
      if (record.kind === "type" || record.kind === "func") {
        const ref = value as IrTypeRef | IrFuncRef;
        const binding = ref.binding;
        if (binding?.kind !== "support") {
          invalid("support body references a non-support declaration");
          return;
        }
        const bindingId = binding.bindingId;
        const key = ref.kind === "type" ? irTypeBindingKey(ref.binding) : irCallableBindingKey(ref.binding);
        const allowed =
          ref.kind === "type"
            ? key === irTypeBindingKey(canonical.scratch.type.ref.binding)
            : callables.some((callee) => key === irCallableBindingKey(callee.ref.binding));
        if (!allowed) invalid("foreign symbolic dependency");
        const matches = input.abi.entries.filter((entry) => entry.plan.id === bindingId);
        if (matches.length !== 1) invalid("missing or duplicate symbolic dependency");
        const entry = matches[0]!;
        if (
          entry.plan.structuralReferenceKey !== key ||
          entry.plan.slotPolicy !== "required" ||
          entry.plan.slotSpace !== (ref.kind === "type" ? "type" : "function") ||
          entry.contract.kind !== (ref.kind === "type" ? "type" : "callable")
        )
          invalid("symbolic dependency lacks its required ABI declaration");
      }
      active.add(value);
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            if (!Object.hasOwn(value, index)) invalid("sparse support dependency graph");
            visit(value[index]);
          }
        } else {
          for (const nested of Object.values(record)) visit(nested);
        }
      } finally {
        active.delete(value);
      }
    };
    // Traverse actual fields, including block arguments, nested instructions,
    // slots and explicit ref/type positions. Occurrence receipts are not used.
    visit(batch.scratch.type);
    visit(batch.kernels);
    visit(batch.implementation);
  }
}
