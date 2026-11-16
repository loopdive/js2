// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";

/**
 * Actual dependencies of the primitive equality dispatch. No provider is
 * inferred from a signature. An absent `bigint` or `strings` arm means the
 * caller's value set cannot contain that kind; its values then fall through to
 * reference identity.
 */
export interface ObjectSameValueResources {
  /**
   * `same-value` (SameValue, §7.2.10): f64 bit patterns, so NaN equals NaN and
   * +0 differs from -0. `strict` (IsStrictlyEqual, §7.2.15 via Number::equal):
   * `f64.eq`, so NaN differs from NaN and +0 equals -0.
   */
  readonly numbers: "same-value" | "strict";
  readonly typeofNumIdx: FuncHandle;
  readonly typeofBoolIdx: FuncHandle;
  readonly unboxNumIdx: FuncHandle;
  readonly unboxBoolIdx: FuncHandle;
  /** The legacy-i64 case exists only to preserve explicitly selected historical recipes. */
  readonly bigint?:
    | { readonly kind: "carrier"; readonly typeofIdx: FuncHandle; readonly equalIdx: FuncHandle }
    | { readonly kind: "legacy-i64"; readonly typeofIdx: FuncHandle; readonly toBigIdx: FuncHandle };
  readonly strings?: {
    readonly anyStrTypeIdx: TypeHandle;
    readonly flattenIdx: FuncHandle;
    readonly equalsIdx: FuncHandle;
  };
}

/** Preserve the donor's complete primitive dispatch; only the numeric rule is the caller's choice. */
export function buildObjectSameValueBody(resources: ObjectSameValueResources): Instr[] {
  const { numbers, typeofNumIdx, typeofBoolIdx, unboxNumIdx, unboxBoolIdx, bigint, strings } = resources;
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
    strings !== undefined
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: strings.anyStrTypeIdx },
          { op: "local.get", index: 3 },
          { op: "ref.test", typeIdx: strings.anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: strings.anyStrTypeIdx },
              { op: "call", funcIdx: strings.flattenIdx },
              { op: "local.get", index: 3 },
              { op: "ref.cast", typeIdx: strings.anyStrTypeIdx },
              { op: "call", funcIdx: strings.flattenIdx },
              { op: "call", funcIdx: strings.equalsIdx },
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
  const bigintArm = (big: NonNullable<typeof bigint>, elseArm: Instr[]): Instr[] => [
    ...bothTag(big.typeofIdx),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then:
        big.kind === "carrier"
          ? [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "call", funcIdx: big.equalIdx },
            ]
          : [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: big.toBigIdx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: big.toBigIdx },
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
  // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0); every NaN
  // payload/sign denotes the same Number value.
  const sameValueNumbers: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: unboxNumIdx },
    { op: "i64.reinterpret_f64" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: unboxNumIdx },
    { op: "i64.reinterpret_f64" },
    { op: "i64.eq" },
    ...[0, 1].flatMap((index): Instr[] => [
      { op: "local.get", index },
      { op: "call", funcIdx: unboxNumIdx },
      { op: "local.get", index },
      { op: "call", funcIdx: unboxNumIdx },
      { op: "f64.ne" },
    ]),
    { op: "i32.and" },
    { op: "i32.or" },
  ];
  const strictNumbers: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: unboxNumIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: unboxNumIdx },
    { op: "f64.eq" },
  ];
  const numberArm = (elseArm: Instr[]): Instr[] => [
    ...bothTag(typeofNumIdx),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: numbers === "same-value" ? sameValueNumbers : strictNumbers,
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
  return nullArm(numberArm(boolArm(bigint === undefined ? identityArm : bigintArm(bigint, identityArm))));
}
