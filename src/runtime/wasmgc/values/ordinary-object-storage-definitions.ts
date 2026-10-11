// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import {
  buildOrdinaryObjectCreateBody,
  buildOrdinaryObjectInsertBody,
  buildOrdinaryObjectGrowBody,
  type OrdinaryObjectCreateResources,
  type OrdinaryObjectInsertResources,
  type OrdinaryObjectGrowResources,
} from "./ordinary-object-storage-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

/** The supplied prototype has already been checked against the issued ordinary layout. */
export function buildOrdinaryObjectCreateDefinition(
  d: OrdinaryObjectCreateResources,
  prototype: "default" | "null" | "argument",
): { locals: LocalDef[]; body: Instr[] } {
  const body = buildOrdinaryObjectCreateBody(d);
  if (prototype === "null") body[5] = { op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype };
  if (prototype === "argument") {
    body[0] = { op: "local.get", index: 0 };
    body.splice(
      5,
      1,
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype }],
        else: [{ op: "i32.const", value: 0 }],
      },
    );
  }
  return { locals: [], body };
}

export function buildOrdinaryObjectInsertDefinition(d: OrdinaryObjectInsertResources): {
  locals: LocalDef[];
  body: Instr[];
} {
  return {
    locals: [
      { name: "arr", type: { kind: "ref", typeIdx: d.propMapTypeIdx } },
      { name: "cap", type: { kind: "i32" } },
      { name: "mask", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "e", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
      { name: "fkey", type: { kind: "ref_null", typeIdx: d.nativeStrTypeIdx } },
      { name: "keyStr", type: { kind: "ref_null", typeIdx: d.anyStrTypeIdx } },
      { name: "searchAny", type: { kind: "anyref" } },
      { name: "searchIsSym", type: { kind: "i32" } },
      { name: "searchSymId", type: { kind: "i32" } },
    ],
    body: buildOrdinaryObjectInsertBody(d),
  };
}

export function buildOrdinaryObjectGrowDefinition(d: OrdinaryObjectGrowResources): {
  locals: LocalDef[];
  body: Instr[];
} {
  return {
    locals: [
      { name: "old", type: { kind: "ref", typeIdx: d.propMapTypeIdx } },
      { name: "newCap", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "oldLen", type: { kind: "i32" } },
      { name: "e", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
      { name: "inserted", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
    ],
    body: buildOrdinaryObjectGrowBody(d),
  };
}
