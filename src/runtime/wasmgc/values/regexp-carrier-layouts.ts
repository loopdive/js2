// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Layouts of the native RegExp engine's WasmGC types: the `$NativeRegExp`
 * carrier and the backtrack frame the VM stacks. The i32 array both refer to is
 * the module's ordinary `array (mut i32)`, so it arrives as an index; the
 * constant arrays a carrier holds are built by {@link regExpI32ArrayInstrs}.
 */
import type { Instr, TypeHandle, ValType } from "../../../wasm/model/instructions.js";
import type { ArrayTypeDef, StructTypeDef } from "../../../wasm/model/module-records.js";

export const NATIVE_REGEXP_STRUCT_NAME = "__StandaloneRegExp";
export const REGEXP_FRAME_STRUCT_NAME = "__ReFrame";
export const REGEXP_FRAME_ARRAY_NAME = "__ReFrameArr";

/**
 * The `$NativeRegExp` struct (#1539). Holds the flags bitfield, the
 * capture-group count, the compiled bytecode program, the class table, and the
 * source pattern string. Field order is load-bearing — codegen reads by
 * `fieldIdx`.
 *
 * NOTE: field[1] must NOT be a ref-to-array. `getArrTypeIdxFromVec` (in
 * registry/types.ts) is a *structural* heuristic that classifies any struct
 * whose field[1] is a ref-to-array as a "vec struct", which makes
 * `coerceType` ref→externref attach `__make_iterable` (a JS host import). With
 * the array fields at slots 0/1 that misfires and breaks standalone purity
 * (#682's struct dodged this by having `flags:i32` at field[1]); putting the
 * i32 scalars first keeps the struct off that heuristic.
 */
export const RE_FIELD_FLAGS = 0;
export const RE_FIELD_NGROUPS = 1;
export const RE_FIELD_PROG = 2;
export const RE_FIELD_CLASS_TABLE = 3;
export const RE_FIELD_SOURCE = 4;
export const RE_FIELD_NSCRATCH = 5; // #1959 — scratch slots for PROGRESS guards
// (#4439) Exported for the reflective `String.prototype.match` body, which must
// resolve the `g` flag and reset `lastIndex` at RUNTIME — the borrowed form has
// no regex EXPRESSION for `staticRegExpFlags` to read.
export const RE_FIELD_LASTINDEX = 6;
// Keep the legacy f64 slot for the common numeric fast path, but preserve a
// non-numeric assignment opaquely until g/y exec applies ToLength. This mirrors
// the host lane's deferred-lastIndex contract without widening every existing
// numeric reflection site.
export const RE_FIELD_LASTINDEX_RAW = 7;
export const RE_FIELD_LASTINDEX_RAW_PRESENT = 8;
// (#6651 B6) [[Writable]] of the own `lastIndex` data property, inverted so a
// fresh carrier's default `0` is the spec's `writable: true` (§22.2.3.3). Set
// only by `Object.defineProperty(re, "lastIndex", {writable: false})`; read by
// the runtime `[[Set]]` arms in `regexp-lastindex-carrier.ts`. `$`-prefixed so
// the closed-struct ladders never expose it as a property.
export const RE_FIELD_LASTINDEX_NONWRITABLE = 9;

/**
 * @param i32ArrayTypeIdx `array (mut i32)`: the program and the class table.
 * @param anyStringTypeIdx the string carrier `source` is stored as.
 */
export function buildNativeRegExpType(i32ArrayTypeIdx: TypeHandle, anyStringTypeIdx: TypeHandle): StructTypeDef {
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32ArrayTypeIdx };
  return {
    kind: "struct",
    name: NATIVE_REGEXP_STRUCT_NAME,
    // (#5142) The pattern fields are MUTABLE: Annex B §B.2.4.1
    // `RegExp.prototype.compile` recompiles a regexp IN PLACE, so the receiver's
    // program / flags / source have to be replaceable on an existing struct.
    // There is exactly one `$NativeRegExp` heap type and nothing reads it through
    // a subtype, so widening mutability is additive.
    fields: [
      { name: "flags", type: { kind: "i32" }, mutable: true },
      { name: "nGroups", type: { kind: "i32" }, mutable: true },
      { name: "prog", type: i32ArrRef, mutable: true },
      { name: "classTable", type: i32ArrRef, mutable: true },
      { name: "source", type: { kind: "ref", typeIdx: anyStringTypeIdx }, mutable: true },
      // Scratch capture-slot count for PROGRESS empty-loop guards (#1959). The VM
      // caps array is sized `2*nGroups + nScratch`; scratch slots are never
      // reported as captures. Field added after source to keep lastIndex last.
      { name: "nScratch", type: { kind: "i32" }, mutable: true },
      // [[LastIndex]] (§22.2.7.1) — keep the numeric slot for the hot path, and
      // pair it with an opaque raw value/presence bit for deferred ToLength of
      // object assignments (`re.lastIndex = {valueOf(){...}}`).
      { name: "lastIndex", type: { kind: "f64" }, mutable: true },
      { name: "lastIndexRaw", type: { kind: "externref" }, mutable: true },
      { name: "lastIndexRawPresent", type: { kind: "i32" }, mutable: true },
      { name: "$lastIndexNonWritable", type: { kind: "i32" }, mutable: true },
    ],
  };
}

/** One backtrack alternative `{ pc, sp, caps }`, exactly like the reference VM's frame. */
export function buildRegExpFrameType(i32ArrayTypeIdx: TypeHandle): StructTypeDef {
  return {
    kind: "struct",
    name: REGEXP_FRAME_STRUCT_NAME,
    fields: [
      { name: "pc", type: { kind: "i32" }, mutable: true },
      { name: "sp", type: { kind: "i32" }, mutable: true },
      { name: "caps", type: { kind: "ref", typeIdx: i32ArrayTypeIdx }, mutable: true },
    ],
  };
}

/** The backtrack stack: nullable so a grown stack's tail can stay unallocated. */
export function buildRegExpFrameArrayType(frameTypeIdx: TypeHandle): ArrayTypeDef {
  return {
    kind: "array",
    name: REGEXP_FRAME_ARRAY_NAME,
    element: { kind: "ref_null", typeIdx: frameTypeIdx },
    mutable: true,
  };
}

/** Values per `array.new_fixed`: V8 refuses one with more than 10,000 operands. */
const FIXED_CHUNK = 8192;

/**
 * Leave one non-null i32 array holding `values` on the stack: a program, a
 * class table or a names table. Large Unicode string properties produce
 * programs past the `array.new_fixed` limit, so with a `scratchLocal` an array
 * over {@link FIXED_CHUNK} values is assembled in that local from bounded fixed
 * chunks; the local is requested only then. Without one, the array is always
 * a single `array.new_fixed`.
 */
export function regExpI32ArrayInstrs(
  i32ArrayTypeIdx: TypeHandle,
  values: readonly number[],
  scratchLocal?: () => number,
): Instr[] {
  // `array.new_fixed` needs at least one operand.
  if (values.length === 0)
    return [
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: i32ArrayTypeIdx },
    ];
  if (values.length <= FIXED_CHUNK || scratchLocal === undefined) return fixedI32Array(i32ArrayTypeIdx, values);
  const local = scratchLocal();
  const instrs: Instr[] = [
    { op: "i32.const", value: values.length },
    { op: "array.new_default", typeIdx: i32ArrayTypeIdx },
    { op: "local.set", index: local },
  ];
  for (let offset = 0; offset < values.length; offset += FIXED_CHUNK) {
    const chunk = values.slice(offset, offset + FIXED_CHUNK);
    instrs.push(
      { op: "local.get", index: local },
      { op: "i32.const", value: offset },
      ...fixedI32Array(i32ArrayTypeIdx, chunk),
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: chunk.length },
      { op: "array.copy", dstTypeIdx: i32ArrayTypeIdx, srcTypeIdx: i32ArrayTypeIdx },
    );
  }
  instrs.push({ op: "local.get", index: local });
  return instrs;
}

function fixedI32Array(i32ArrayTypeIdx: TypeHandle, values: readonly number[]): Instr[] {
  const instrs: Instr[] = values.map((value) => ({ op: "i32.const", value: value | 0 }));
  instrs.push({ op: "array.new_fixed", typeIdx: i32ArrayTypeIdx, length: values.length });
  return instrs;
}
