// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import {
  buildObjectHashBody,
  buildObjectKeyEqualsBody,
  buildObjectFindBody,
  type ObjectHashResources,
  type ObjectKeyResources,
  type ObjectFindResources,
} from "./object-key-bodies.js";

/** Definition wrappers for canonical PropertyKey inputs; no hidden ToPropertyKey call. */
export function buildOrdinaryObjectHashDefinition(d: ObjectHashResources): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [
      { name: "str", type: { kind: "ref", typeIdx: d.nativeStrTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: d.strDataTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "h", type: { kind: "i32" } },
      { name: "keyAny", type: { kind: "anyref" } },
      { name: "keyStr", type: { kind: "ref", typeIdx: d.anyStrTypeIdx } },
    ],
    body: buildObjectHashBody(d),
  };
}
export function buildOrdinaryObjectKeyEqualsDefinition(d: ObjectKeyResources): { locals: LocalDef[]; body: Instr[] } {
  return { locals: [], body: buildObjectKeyEqualsBody(d) };
}
export function buildOrdinaryObjectFindDefinition(d: ObjectFindResources): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [
      { name: "arr", type: { kind: "ref", typeIdx: d.propMapTypeIdx } },
      { name: "cap", type: { kind: "i32" } },
      { name: "mask", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "entry", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
      { name: "flatKey", type: { kind: "ref_null", typeIdx: d.nativeStrTypeIdx } },
      { name: "searchAny", type: { kind: "anyref" } },
      { name: "isSymbol", type: { kind: "i32" } },
      { name: "symbolId", type: { kind: "i32" } },
    ],
    body: buildObjectFindBody(d),
  };
}
