// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { verifyIrIntrinsicSignature } from "../analysis/intrinsics.js";
import { INTRINSIC_DEFINITIONS } from "../core/intrinsics.js";
import { irImportFuncRef, irRuntimeFuncRef } from "../core/callable-bindings.js";
import type { IrInstrIntrinsic, IrIntrinsicBackendComposite, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrFuncRef } from "../core/value-references.js";
import { resolveRuntimeHostCapabilityFuncRecord, RUNTIME_HOST_CAPABILITY_RECORDS } from "./host-capabilities.js";
import { RUNTIME_PROVIDERS } from "./manifest.js";

const BACKEND_COMPOSITE_BY_INTRINSIC: Readonly<Partial<Record<IrInstrIntrinsic["id"], IrIntrinsicBackendComposite>>> =
  Object.freeze({
    "js.to_uint32": "to-uint32",
    "math.clz32": "math.clz32",
    "math.imul": "math.imul",
    "math.max": "math.max",
    "math.min": "math.min",
  });

/**
 * (#3526 F1-S1) Closed set of PHYSICAL callable targets each intrinsic admits,
 * derived from the provider catalogue and the central capability records — not
 * from an emitted import spelling. The semantic identity of the instruction is
 * always the versioned `IntrinsicId`; these keys authenticate the exact
 * physical target a frozen provider is allowed to attach, so a crosswire, a
 * wrong capability, or a wrong runtime symbol rejects before materialization.
 */
function callableBindingKey(binding: IrFuncRef["binding"]): string {
  switch (binding.kind) {
    case "import":
      return `import:${binding.module}:${binding.field}`;
    case "runtime":
      return `runtime:${binding.symbol}`;
    case "intrinsic":
      return `intrinsic:${binding.symbol}`;
    default:
      return `other:${binding.kind}`;
  }
}

const ADMITTED_CALLABLE_TARGETS: ReadonlyMap<IrInstrIntrinsic["id"], ReadonlySet<string>> = (() => {
  const table = new Map<IrInstrIntrinsic["id"], Set<string>>();
  for (const provider of RUNTIME_PROVIDERS) {
    const implementation = provider.implementation;
    if (implementation.kind !== "host-callable" && implementation.kind !== "runtime-callable") continue;
    for (const [id, definition] of Object.entries(INTRINSIC_DEFINITIONS)) {
      if (definition.feature !== provider.feature) continue;
      const key =
        implementation.kind === "host-callable"
          ? callableBindingKey(
              irImportFuncRef(
                // (#3526 F2-S2) `resolveRuntimeHostCapabilityFuncRecord` is the
                // fail-closed kind guard: a global capability has no callable
                // spelling, so admitting one here would mint a nonsense target.
                ...((record) => [record.module, record.field] as const)(
                  resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, implementation.capability),
                ),
              ).binding,
            )
          : callableBindingKey(irRuntimeFuncRef(implementation.symbol).binding);
      const admitted = table.get(id as IrInstrIntrinsic["id"]) ?? new Set<string>();
      admitted.add(key);
      table.set(id as IrInstrIntrinsic["id"], admitted);
    }
  }
  return table;
})();

/** Verify the closed semantic signature and any post-freeze provider binding. */
export function verifyIrIntrinsicInstruction(
  instr: IrInstrIntrinsic,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[] {
  const errors = [...verifyIrIntrinsicSignature(instr, typeOf)];
  if (instr.provider?.kind === "callable") {
    const binding = instr.provider.target.binding;
    if (binding.kind === "intrinsic") {
      if (binding.symbol !== instr.id) {
        errors.push(`${instr.id} callable provider must retain the semantic intrinsic binding`);
      }
    } else {
      // (#3526 F1-S1) A physical import/runtime target is admitted only when
      // the closed provider catalogue names it for THIS intrinsic. Keeping the
      // physical identity (rather than a capability-only one) is deliberate:
      // the union import is shared with raw consumers and its ABI/order must
      // not drift.
      const admitted = ADMITTED_CALLABLE_TARGETS.get(instr.id);
      if (!admitted || !admitted.has(callableBindingKey(binding))) {
        errors.push(
          `${instr.id} callable provider target ${callableBindingKey(binding)} is not an admitted physical provider`,
        );
      }
    }
  }
  if (instr.provider?.kind === "backend-composite") {
    const expected = BACKEND_COMPOSITE_BY_INTRINSIC[instr.id];
    if (instr.provider.operation !== expected) {
      errors.push(
        expected === undefined
          ? `${instr.id} does not admit a backend composite provider`
          : `${instr.id} backend composite provider must use ${expected}, got ${instr.provider.operation}`,
      );
    }
  }
  return errors;
}
