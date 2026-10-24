// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import type { NativeSourceClosureRequirements } from "./native-source-closure-requirements.js";

/** Internal wrappers use explicit newTarget/argv; nested public invocations own their own frame. */
export function constructEntryEffectGap(source: NativeSourceClosureRequirements, entry: IrUnitId): string | undefined {
  const pending = [entry],
    visited = new Set<IrUnitId>();
  while (pending.length) {
    const unit = pending.pop()!;
    if (visited.has(unit)) continue;
    visited.add(unit);
    if (!source.demands.owners.some((owner) => owner.unitId === unit)) return "missing direct helper body";
    for (const row of source.demands.occurrences) {
      const region = source.demands.buffers[row.bufferIndex]!;
      if (region.view !== "projection" || region.ownerUnitId !== unit) continue;
      const instruction = row.instruction;
      if (
        instruction.kind === "raw.wasm" ||
        instruction.kind.startsWith("dyn.") ||
        instruction.kind === "closure.call" ||
        instruction.kind === "class.call" ||
        instruction.kind === "class.static_call" ||
        instruction.kind === "class.super_call" ||
        instruction.kind === "class.new" ||
        instruction.kind === "fnctor.new"
      )
        return `unowned ambient invocation ${instruction.kind}`;
      if (
        (instruction.kind === "global.get" || instruction.kind === "global.set") &&
        instruction.target.binding.kind !== "source"
      )
        return "runtime/support global has no explicit-only frame proof";
      if (instruction.kind !== "call") continue;
      if (instruction.target.binding.kind === "unit") {
        pending.push(instruction.target.binding.unitId);
        continue;
      }
      const feature = irRuntimeCallableDeclaration(instruction.target)?.feature;
      if (
        feature !== "js.closure.method" &&
        feature !== "js.closure.apply-vector" &&
        feature !== "js.construct" &&
        feature !== "js.closure.undefined" &&
        feature !== "class.value.allocate" &&
        feature !== "error.reference.construct" &&
        feature !== "error.type.construct"
      )
        return `callable lacks an explicit-only or installed-frame contract: ${feature ?? instruction.target.name}`;
    }
  }
  return undefined;
}
