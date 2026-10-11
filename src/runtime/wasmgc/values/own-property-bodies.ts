// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
/** Eager legacy kernels only: prologues and late carrier extensions remain separate.
 * Scalar bindings are recipe construction data, not issued provider authority.
 * Receiver/key params are 0/1, scratch anyref is 2 and nullable entry is 3. */
export interface OwnPropertyBindings {
  readonly objectTypeIdx: number;
  readonly findOwnIdx: number;
  readonly builtinMetadataIdx?: number;
  /** Borrowed legacy construction node; preserve identity. Not provider authority. */
  readonly nonObjectArm: Instr;
}
export function buildOwnPropertyBody(d: OwnPropertyBindings): Instr[] {
  return [
    // (#2896) Builtin-fn metadata arm: name/length are OWN properties of a
    // builtin function value (until deleted). get_meta returns non-null
    // exactly when the own property exists.
    ...(d.builtinMetadataIdx !== undefined
      ? ([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: d.builtinMetadataIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // any = any.convert_extern(obj); if !ref.test $Object → carrier bag, else 0 (#4010 S3)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    { op: "i32.eqz" },
    d.nonObjectArm,
    // e = __obj_find(cast<$Object>(any), key) ; return e != null
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.findOwnIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
  ];
}
export interface PropertyEnumerableBindings {
  readonly objectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly findOwnIdx: number;
  readonly enumerableFlag: number;
}
export function buildPropertyIsEnumerableBody(d: PropertyEnumerableBindings): Instr[] {
  return [
    // any = any.convert_extern(obj); if !ref.test $Object → 0
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // e = __obj_find(cast<$Object>(any), key)  (local 3)
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.findOwnIdx },
    { op: "local.tee", index: 3 },
    // if e == null → 0 (no own property)
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    // return (e.flags & d.enumerableFlag) != 0
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
    { op: "i32.const", value: d.enumerableFlag },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
  ];
}
