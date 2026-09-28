// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";

/** Actual dependencies of the complete existing SameValue dispatch. No provider is inferred from a signature. */
export interface ObjectSameValueResources {
  readonly typeofNumIdx: FuncHandle;
  readonly typeofBoolIdx: FuncHandle;
  readonly typeofBigIdx: FuncHandle;
  readonly unboxNumIdx: FuncHandle;
  readonly unboxBoolIdx: FuncHandle;
  /** The legacy-i64 case exists only to preserve explicitly selected historical recipes. */
  readonly bigint:
    | { readonly kind: "carrier"; readonly equalIdx: FuncHandle }
    | { readonly kind: "legacy-i64"; readonly toBigIdx: FuncHandle };
  readonly anyStrTypeIdx: TypeHandle;
  readonly strFlattenIdx: FuncHandle | undefined;
  readonly strEqualsIdx: FuncHandle | undefined;
}

/** Preserve the donor's complete primitive dispatch, including its exact numeric bit comparison. */
export function buildObjectSameValueBody(resources: ObjectSameValueResources): Instr[] {
  const {
    typeofNumIdx,
    typeofBoolIdx,
    typeofBigIdx,
    unboxNumIdx,
    unboxBoolIdx,
    bigint,
    anyStrTypeIdx,
    strFlattenIdx,
    strEqualsIdx,
  } = resources;
  const EQ_HEAP = -19; // WasmGC `eq` abstract heap type

  // params: a=0, b=1 ; locals: aa=2 (anyref), ba=3 (anyref)
  const bothTag = (tagIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: tagIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: tagIdx },
    { op: "i32.and" },
  ];
  // Reference identity over the WasmGC `eq` heap (the anyref temps are already
  // materialised in locals 2/3 by `identityArm`'s preamble below).
  const refIdentityArm: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: EQ_HEAP },
    { op: "local.get", index: 3 },
    { op: "ref.test", typeIdx: EQ_HEAP },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "local.get", index: 3 },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  // String SameValue = value equality (flatten both, __str_equals); else ref
  // identity. `__str_flatten`/`__str_equals` are resolved at the top of this
  // same `ensureObjectRuntime` pass (object-runtime helpers already call them,
  // e.g. __obj_hash/__obj_find), so the call indices are regime-consistent.
  const stringOrIdentityArm: Instr[] =
    strFlattenIdx !== undefined && strEqualsIdx !== undefined && anyStrTypeIdx >= 0
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "local.get", index: 3 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.get", index: 3 },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "call", funcIdx: strEqualsIdx },
            ],
            else: refIdentityArm,
          },
        ]
      : refIdentityArm;
  const identityArm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 3 },
    ...stringOrIdentityArm,
  ];
  const bigintArm = (elseArm: Instr[]): Instr[] => [
    ...bothTag(typeofBigIdx),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then:
        bigint.kind === "carrier"
          ? [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "call", funcIdx: bigint.equalIdx },
            ]
          : [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: bigint.toBigIdx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: bigint.toBigIdx },
              { op: "i64.eq" },
            ],
      else: elseArm,
    },
  ];
  const boolArm = (elseArm: Instr[]): Instr[] => [
    ...bothTag(typeofBoolIdx),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: unboxBoolIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxBoolIdx },
        { op: "i32.eq" },
      ],
      else: elseArm,
    },
  ];
  const numberArm = (elseArm: Instr[]): Instr[] => [
    ...bothTag(typeofNumIdx),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0).
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: unboxNumIdx },
        { op: "i64.reinterpret_f64" },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxNumIdx },
        { op: "i64.reinterpret_f64" },
        { op: "i64.eq" },
      ],
      else: elseArm,
    },
  ];
  const nullArm = (rest: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: rest,
    },
  ];
  return nullArm(numberArm(boolArm(bigintArm(identityArm))));
}
