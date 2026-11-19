// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354) The ordinary-object family of source calls: the `js.object.*` contracts (`ordinary-object-callables.ts`). A
 * descriptor operation's attribute mask is a constant operand and an accessor's halves are closures, so a projection
 * must keep both as they were: the realm's define reads them at run time, and nothing re-derives them.
 */
import type { IrInstrCall, IrValueId } from "../core/nodes.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { preparedIrDataMismatch } from "./data.js";
import type { NativeStringValueDemands } from "./native-string-value-demands.js";
import type { SourceCallDefinitions, SourceCallFamily, SourceCallPair } from "./native-source-calls.js";
import { nativeValueOriginal } from "./native-value-definitions.js";

function fail(detail: string): never {
  throw new Error("ordinary object source calls: " + detail);
}

/** The exact-integer attribute mask a descriptor operation passes last, or `undefined` for any other producer. */
export function descriptorMask(call: IrInstrCall, definitions: SourceCallDefinitions): number | undefined {
  const row = definitions.get(call.args[call.args.length - 1]!);
  if (row?.instruction.kind !== "const" || row.instruction.value.kind !== "f64") return undefined;
  const value = row.instruction.value.value;
  return Number.isInteger(value) && value >= 0 && value <= 1023 ? value : undefined;
}

function descriptorHalfIdentity(
  demands: NativeStringValueDemands,
  value: IrValueId,
  definitions: SourceCallDefinitions,
) {
  const row = nativeValueOriginal(value, definitions, () => fail("cyclic representation-only SSA alias"))?.instruction;
  if (row?.kind === "const") return { kind: "constant", value: row.value };
  if (row?.kind !== "closure.new") return undefined;
  if (row.alloc === undefined) fail("descriptor closure is missing its allocation identity");
  const allocation = AllocSiteRegistry.fromSnapshot(demands.allocations).resolve(row.alloc);
  if (!allocation || allocation.kind !== "closure") fail("descriptor closure allocation is not live");
  return {
    kind: "closure",
    allocation: allocation.id,
    lifted: row.liftedFunc.binding,
    signature: row.signature,
    captures: row.captureFieldTypes,
  };
}

/** A define keeps its mask; an accessor define also keeps each half its mask says is present. */
function sameDescriptor({ demands, feature, call, definitions, original, originalDefinitions }: SourceCallPair): void {
  if (!feature.startsWith("js.object.define-")) return;
  const mask = descriptorMask(original, originalDefinitions);
  if (mask !== descriptorMask(call, definitions)) fail("descriptor presence/attribute mask changed across projection");
  if (feature !== "js.object.define-accessor" || mask === undefined) return;
  for (const [bit, argument] of [
    [256, 2],
    [512, 3],
  ] as const) {
    if (!(mask & bit)) continue;
    if (
      preparedIrDataMismatch(
        descriptorHalfIdentity(demands, original.args[argument]!, originalDefinitions),
        descriptorHalfIdentity(demands, call.args[argument]!, definitions),
      ) !== undefined
    )
      fail("descriptor callable allocation changed across projection");
  }
}

export const ORDINARY_OBJECT_SOURCE_CALLS: SourceCallFamily<OrdinaryObjectRuntimeFeature> = Object.freeze({
  declaration: irOrdinaryObjectCallableDeclaration,
  samePair: sameDescriptor,
});
