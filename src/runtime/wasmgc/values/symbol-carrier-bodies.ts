// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { StructTypeDef, ArrayTypeDef } from "../../../wasm/model/module-records.js";
import { createVectorBackingArrayType } from "./vector-grow-store.js";

export function createSymbolCarrierShape<R>(description: R) {
  return {
    kind: "struct" as const,
    name: "$Symbol",
    fields: [
      { name: "id", type: { kind: "i32" as const }, mutable: false },
      { name: "desc", type: description, mutable: false },
    ],
  };
}
export function createSymbolCarrierType(anyStrTypeIdx: number): StructTypeDef {
  return createSymbolCarrierShape({ kind: "ref_null" as const, typeIdx: anyStrTypeIdx });
}
export function createSymbolInternArrayType(symbolTypeIdx: number): ArrayTypeDef {
  return createVectorBackingArrayType(`__arr_symref_${symbolTypeIdx}`, { kind: "ref_null", typeIdx: symbolTypeIdx });
}
export interface SymbolBoxResources {
  readonly symIdx: number;
  readonly anyStrTypeIdx: number;
  readonly internArrTypeIdx: number;
  readonly internGlobalIdx: number;
}
export interface SymbolBoxLocalSlots {
  readonly table: number;
  readonly existing: number;
  readonly grow: number;
}

function initializeInternTable(d: SymbolBoxResources, slots: SymbolBoxLocalSlots): Instr[] {
  const { internGlobalIdx, internArrTypeIdx } = d;
  const { table: TBL } = slots;
  return [
    // tbl = global; allocate (id+1, min 16) slots if null.
    { op: "global.get", index: internGlobalIdx },
    { op: "local.tee", index: TBL },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // allocate id+1 slots; the grow loop below extends ×2 as ids climb.
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.new_default", typeIdx: internArrTypeIdx },
        { op: "local.set", index: TBL },
        { op: "local.get", index: TBL },
        { op: "global.set", index: internGlobalIdx },
      ],
    },
  ];
}

function growInternTable(d: SymbolBoxResources, slots: SymbolBoxLocalSlots): Instr[] {
  const { internGlobalIdx, internArrTypeIdx } = d;
  const { table: TBL, grow: GROW } = slots;
  return [
    // grow ×2 until id < tbl.len
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: TBL },
            { op: "ref.as_non_null" },
            { op: "array.len" },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: TBL },
            { op: "ref.as_non_null" },
            { op: "array.len" },
            { op: "i32.const", value: 2 },
            { op: "i32.mul" },
            { op: "array.new_default", typeIdx: internArrTypeIdx },
            { op: "local.set", index: GROW },
            { op: "local.get", index: GROW },
            { op: "ref.as_non_null" },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: TBL },
            { op: "ref.as_non_null" },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: TBL },
            { op: "ref.as_non_null" },
            { op: "array.len" },
            { op: "array.copy", dstTypeIdx: internArrTypeIdx, srcTypeIdx: internArrTypeIdx },
            { op: "local.get", index: GROW },
            { op: "local.set", index: TBL },
            { op: "local.get", index: TBL },
            { op: "global.set", index: internGlobalIdx },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

function loadOrCreateSymbol(d: SymbolBoxResources, slots: SymbolBoxLocalSlots): Instr[] {
  const { symIdx, anyStrTypeIdx, internArrTypeIdx } = d;
  const { table: TBL, existing: EXISTING } = slots;
  return [
    // existing = tbl[id]; if null create + store; return extern(existing).
    { op: "local.get", index: TBL },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 0 },
    { op: "array.get", typeIdx: internArrTypeIdx },
    { op: "local.tee", index: EXISTING },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        // tbl[id] = new $Symbol{id, null}; tee into `existing`
        { op: "local.get", index: TBL },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 0 },
        { op: "ref.null", typeIdx: anyStrTypeIdx },
        { op: "struct.new", typeIdx: symIdx },
        { op: "local.tee", index: EXISTING },
        { op: "array.set", typeIdx: internArrTypeIdx },
        { op: "local.get", index: EXISTING },
        { op: "ref.as_non_null" },
        { op: "extern.convert_any" },
      ],
      else: [{ op: "local.get", index: EXISTING }, { op: "ref.as_non_null" }, { op: "extern.convert_any" }],
    },
  ];
}

/** Exact interned-boxing recipe; allocation and publication stay with the caller. */
export function buildSymbolBoxBody(d: SymbolBoxResources, slots: SymbolBoxLocalSlots): Instr[] {
  return [...initializeInternTable(d, slots), ...growInternTable(d, slots), ...loadOrCreateSymbol(d, slots)];
}
export function buildSymbolBoxDefinition(d: SymbolBoxResources): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [
      { name: "tbl", type: { kind: "ref_null", typeIdx: d.internArrTypeIdx } },
      { name: "existing", type: { kind: "ref_null", typeIdx: d.symIdx } },
      { name: "grow", type: { kind: "ref_null", typeIdx: d.internArrTypeIdx } },
    ],
    body: buildSymbolBoxBody(d, { table: 1, existing: 2, grow: 3 }),
  };
}
