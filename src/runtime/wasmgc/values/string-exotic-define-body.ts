// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { OrdinaryDescriptorResources } from "./ordinary-object-descriptor-common.js";

/** String DefineOwnProperty is virtual-first; ordinary GetOwnProperty has a different order. */
export function buildDescriptorCurrentLookup(
  d: OrdinaryDescriptorResources,
  objectLocal: number,
  keyLocal: number,
  entryLocal: number,
): Instr[] {
  const args: Instr[] = [
    { op: "local.get", index: objectLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: keyLocal },
  ];
  const ordinary: Instr[] = [...args, { op: "call", funcIdx: d.objFindIdx }];
  return d.stringVirtualOwnIdx === undefined
    ? ordinary
    : [
        ...args,
        { op: "call", funcIdx: d.stringVirtualOwnIdx },
        { op: "local.tee", index: entryLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
          then: ordinary,
          else: [{ op: "local.get", index: entryLocal }],
        },
      ];
}
/** Compatibility succeeded: the virtual descriptor is immutable and is never inserted into the table. */
export function buildStringCompatibleDescriptorReturn(d: OrdinaryDescriptorResources): Instr[] {
  return d.stringVirtualOwnIdx === undefined
    ? []
    : [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: d.stringVirtualOwnIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 0 }, { op: "return" }] },
      ];
}
