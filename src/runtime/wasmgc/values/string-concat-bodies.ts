// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, TypeHandle, ValType } from "../../../wasm/model/instructions.js";

/** Already resolved index spaces, not resource-admission authority. */
export interface StringConcatLayout {
  readonly strTypeIdx: TypeHandle;
  readonly strDataTypeIdx: TypeHandle;
  readonly anyStrTypeIdx: TypeHandle;
  readonly consStrTypeIdx: TypeHandle;
}

export interface StringConcatResources {
  readonly flattenIdx: FuncHandle;
  readonly emptyIdentity: boolean;
}

export interface StringBatchedConcatResources {
  readonly flattenIdx: FuncHandle;
  readonly concatIdx: FuncHandle;
  /** One independently produced literal sequence per original null guard. */
  readonly undefinedLiterals: readonly (readonly Instr[])[];
}

const FLAT_CONCAT_LIMIT = 64;

/** Complete binary concat body; registration and the environment switch stay with the caller. */
export function buildStringConcatDefinition(
  layout: StringConcatLayout,
  resources: StringConcatResources,
): { locals: LocalDef[]; body: Instr[] } {
  const { strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx } = layout;
  const { flattenIdx, emptyIdentity } = resources;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  // params: a(0), b(1)
  // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
  const body: Instr[] = [
    // lenA = a.len (field 0 of AnyString)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 }, // lenA

    // lenB = b.len (field 0 of AnyString)
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 3 }, // lenB

    // Empty strings are the identity element for concatenation. Returning
    // the other immutable string directly avoids allocating and copying a
    // fresh flat string for common accumulator shapes such as
    // `let out = ""; out += value`. Keep a compile-time kill switch so the
    // optimization can be measured against the identical compiler tree.
    ...(!emptyIdentity
      ? []
      : [
          { op: "local.get" as const, index: 2 },
          { op: "i32.eqz" as const },
          {
            op: "if" as const,
            blockType: { kind: "empty" as const },
            then: [{ op: "local.get" as const, index: 1 }, { op: "return" as const }],
          },
          { op: "local.get" as const, index: 3 },
          { op: "i32.eqz" as const },
          {
            op: "if" as const,
            blockType: { kind: "empty" as const },
            then: [{ op: "local.get" as const, index: 0 }, { op: "return" as const }],
          },
        ]),

    // newLen = lenA + lenB
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "i32.add" },
    { op: "local.set", index: 4 }, // newLen

    // if newLen >= 64, create ConsString (O(1) rope node)
    { op: "local.get", index: 4 },
    { op: "i32.const", value: 64 },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        // struct.new $ConsString(newLen, a, b)
        { op: "local.get", index: 4 }, // len = newLen
        { op: "local.get", index: 0 }, // left = a
        { op: "local.get", index: 1 }, // right = b
        { op: "struct.new", typeIdx: consStrTypeIdx },
      ],
      else: [
        // Short string: flatten both sides and copy
        // flatA = flatten(a)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.set", index: 6 },

        // flatB = flatten(b)
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.set", index: 7 },

        // newArr = array.new_default(newLen)
        { op: "local.get", index: 4 },
        { op: "array.new_default", typeIdx: strDataTypeIdx },
        { op: "local.set", index: 5 },

        // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
        { op: "local.get", index: 5 }, // dst
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 }, // dstOffset
        { op: "local.get", index: 6 }, // flatA
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
        { op: "local.get", index: 6 }, // flatA
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
        { op: "local.get", index: 2 }, // lenA
        {
          op: "array.copy",
          dstTypeIdx: strDataTypeIdx,
          srcTypeIdx: strDataTypeIdx,
        },

        // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
        { op: "local.get", index: 5 }, // dst
        { op: "ref.as_non_null" },
        { op: "local.get", index: 2 }, // dstOffset = lenA
        { op: "local.get", index: 7 }, // flatB
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
        { op: "local.get", index: 7 }, // flatB
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
        { op: "local.get", index: 3 }, // lenB
        {
          op: "array.copy",
          dstTypeIdx: strDataTypeIdx,
          srcTypeIdx: strDataTypeIdx,
        },

        // result = struct.new $NativeString(newLen, 0, newArr)
        { op: "local.get", index: 4 }, // len = newLen
        { op: "i32.const", value: 0 }, // off = 0
        { op: "local.get", index: 5 }, // data = newArr
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: strTypeIdx },
      ],
    },
  ];

  return {
    locals: [
      { name: "lenA", type: { kind: "i32" } },
      { name: "lenB", type: { kind: "i32" } },
      { name: "newLen", type: { kind: "i32" } },
      { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
    ],
    body,
  };
}

/** Complete fixed-arity concat body with detached literal dependencies. */
export function buildStringBatchedConcatDefinition(
  layout: Pick<StringConcatLayout, "strTypeIdx" | "strDataTypeIdx" | "anyStrTypeIdx">,
  arity: number,
  resources: StringBatchedConcatResources,
): { locals: LocalDef[]; body: Instr[] } {
  if (!Number.isInteger(arity) || arity < 2 || resources.undefinedLiterals.length !== arity)
    throw new Error("native batched concat: literal population must match arity");
  for (let index = 0; index < arity; index++)
    if (!Array.isArray(resources.undefinedLiterals[index]))
      throw new Error("native batched concat: missing literal sequence");
  const { strTypeIdx, strDataTypeIdx, anyStrTypeIdx } = layout;
  const { flattenIdx, concatIdx } = resources;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  // Params: operand0..operandN-1.
  // Locals: totalLen(N), output(N+1), offset(N+2).
  const totalLenLocal = arity;
  const outputLocal = arity + 1;
  const offsetLocal = arity + 2;
  const body: Instr[] = [];
  // (#4394) Null-carrier ToString guard. A statically-string-typed operand can
  // carry the null $AnyString sentinel at runtime — the JS `undefined` of a
  // missing property/param that flowed through a string-typed slot (the #3548
  // carrier convention; e.g. `expectedErrorConstructor.name` in the test262
  // asyncHelpers, JSDoc-typed `string`). The length sum below would trap on it
  // ("dereferencing a null pointer in __str_concat_N"). §7.1.17 ToString of
  // that carrier is "undefined", so substitute exactly that — never the empty
  // string, which would silently corrupt the concatenation.
  for (let index = 0; index < arity; index++) {
    body.push(
      { op: "local.get", index },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...structuredClone(resources.undefinedLiterals[index]!), { op: "local.set", index }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  for (let index = 0; index < arity; index++) {
    body.push({ op: "local.get", index }, { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, { op: "i32.add" });
  }
  body.push(
    { op: "local.tee", index: totalLenLocal },
    { op: "i32.const", value: FLAT_CONCAT_LIMIT },
    { op: "i32.lt_u" },
  );

  const flatArm: Instr[] = [];
  for (let index = 0; index < arity; index++) {
    flatArm.push(
      { op: "local.get", index },
      { op: "ref.test", typeIdx: strTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index },
        ],
      },
    );
  }
  flatArm.push(
    { op: "local.get", index: totalLenLocal },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: outputLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: offsetLocal },
  );
  for (let index = 0; index < arity; index++) {
    flatArm.push(
      { op: "local.get", index: outputLocal },
      { op: "ref.as_non_null" },
      { op: "local.get", index: offsetLocal },
      { op: "local.get", index },
      { op: "ref.cast", typeIdx: strTypeIdx },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.get", index },
      { op: "ref.cast", typeIdx: strTypeIdx },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.get", index },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "array.copy", dstTypeIdx: strDataTypeIdx, srcTypeIdx: strDataTypeIdx },
    );
    if (index + 1 < arity) {
      flatArm.push(
        { op: "local.get", index: offsetLocal },
        { op: "local.get", index },
        { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
        { op: "i32.add" },
        { op: "local.set", index: offsetLocal },
      );
    }
  }
  flatArm.push(
    { op: "local.get", index: totalLenLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: outputLocal },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: strTypeIdx },
  );

  // Preserve the exact existing left-associated concat/rope behaviour for
  // longer results. Only the short-string allocation path changes.
  const pairwiseArm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: concatIdx },
  ];
  for (let index = 2; index < arity; index++) {
    pairwiseArm.push({ op: "local.get", index }, { op: "call", funcIdx: concatIdx });
  }

  body.push({
    op: "if",
    blockType: { kind: "val", type: strRef },
    then: flatArm,
    else: pairwiseArm,
  });

  return {
    locals: [
      { name: "totalLen", type: { kind: "i32" } },
      { name: "output", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "offset", type: { kind: "i32" } },
    ],
    body,
  };
}
