// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, TypeHandle, ValType, LocalDef, Instr } from "./instructions.js";

export type TypeDef = FuncTypeDef | StructTypeDef | ArrayTypeDef | RecGroupDef | SubTypeDef;

export interface FuncTypeDef {
  kind: "func";
  name?: string;
  params: ValType[];
  results: ValType[];
}
export interface StructTypeDef {
  kind: "struct";
  name: string;
  fields: FieldDef[];
  /** Type index of the parent struct (for class inheritance sub-typing) */
  superTypeIdx?: TypeHandle;
  /** When true and superTypeIdx is set, emit sub_final instead of sub (leaf types in hierarchy) */
  final?: boolean;
}
export interface ArrayTypeDef {
  kind: "array";
  name: string;
  element: ValType;
  mutable: boolean;
}
export interface RecGroupDef {
  kind: "rec";
  types: TypeDef[];
}
export interface SubTypeDef {
  kind: "sub";
  name: string;
  superType: TypeHandle | null;
  final: boolean;
  type: StructTypeDef | ArrayTypeDef | FuncTypeDef;
}
export interface FieldDef {
  name: string;
  type: ValType;
  mutable: boolean;
  /**
   * An uninitialized optional numeric class field starts as JavaScript
   * `undefined`, represented in an f64 slot by the canonical signaling-NaN
   * sentinel rather than Wasm's numeric zero default.
   */
  undefinedDefault?: true;
  /**
   * The field's constructor initializer is a call proven to return the native
   * open `$Object` carrier (for example acorn's `this.options = getOptions()`).
   * This is an optimisation hint only: consumers must keep the canonical
   * dynamic fallback because the mutable field may subsequently be replaced.
   */
  dynamicObjectCarrier?: true;
  /**
   * The physical carrier was inferred as numeric, but whole-program source
   * analysis proved every definition/write produces a JS boolean (#2847).
   * Kept separate from ValType so finalize-time host boxing can recover the
   * boolean without changing the already-emitted struct storage ABI.
   */
  jsBoolean?: true;
  /**
   * This source property is only assigned on conditional/loop paths. A hidden
   * companion slot records per-instance own-property presence so an untouched
   * default slot is distinguishable from an explicit null/zero assignment.
   */
  presenceTracked?: true;
  /**
   * (#3780) Bit index of this field's presence flag inside the struct's packed
   * presence words. Only set together with {@link presenceTracked}. The word
   * holding it is the field named `$presence_<bit >>> 5>`; the mask is
   * `1 << (bit & 31)`. Packing matters for allocation volume: acorn's `Node`
   * carries 63 conditionally-assigned properties, which as one `i32` slot each
   * cost 252 bytes of every AST node — roughly half the object.
   */
  presenceBit?: number;
}

export interface WasmFunction {
  name: string;
  typeIdx: TypeHandle;
  locals: LocalDef[];
  body: Instr[];
  exported: boolean;
}

export interface TagDef {
  name: string;
  /** Type index of the tag's function signature (params = exception values) */
  typeIdx: TypeHandle;
}

export interface Import {
  module: string;
  name: string;
  desc: ImportDesc;
}
export type ImportDesc =
  | { kind: "func"; typeIdx: TypeHandle }
  | { kind: "table"; elementType: string; min: number; max?: number }
  | { kind: "global"; type: ValType; mutable: boolean }
  | { kind: "memory"; min: number; max?: number }
  | { kind: "tag"; typeIdx: TypeHandle };

export interface WasmExport {
  name: string;
  desc: { kind: "func" | "table" | "memory" | "global" | "tag"; index: number };
}
export interface Table {
  elementType: string;
  min: number;
  max?: number;
}
export interface Element {
  tableIdx: number;
  offset: Instr[];
  funcIndices: FuncHandle[];
}
export interface GlobalDef {
  name: string;
  type: ValType;
  mutable: boolean;
  init: Instr[];
}
