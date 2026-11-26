// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The native string compare (`__str_compare`): the sign (-1/0/1) of two flat strings in UTF-16 code-unit order
 * (§7.2.13 step 3 / IsLessThan's string arm), the common prefix first and then the length. The ordinary pipeline's
 * helper (`codegen/native-strings-basics.ts`) and (#7354 L0a) the Prepared dynamic value's `js.value.string_compare`
 * (`native-dynamic-values.ts`) share this body; each flattens its operands first (a rope or a UTF-8 string becomes a
 * flat WTF-16 string), so the loop always reads code units.
 */
import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";
import { castFlatReads, flattenLocals } from "./string-equality-body.js";

export type StringCompareLayout = Pick<NativeStringLayout, "nativeStrTypeIdx" | "nativeStrDataTypeIdx">;

/** The two flat strings and the first of the ten scratch locals (`STRING_COMPARE_SCRATCH`, in this order). */
export interface StringCompareLocals {
  readonly a: number;
  readonly b: number;
  readonly scratch: number;
}

const SCRATCH = ["lenA", "lenB", "minLen", "i", "aData", "bData", "aOff", "bOff", "ca", "cb"] as const;

/** The scratch locals, declared from `StringCompareLocals.scratch` on. */
export function buildStringCompareScratchLocals(layout: StringCompareLayout): LocalDef[] {
  const data: ValType = { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx };
  return SCRATCH.map((name) => ({ name, type: name.endsWith("Data") ? data : { kind: "i32" } }));
}

/** The compare's body over two flat strings, before any flatten preamble or cast. */
export function buildStringCompareBody(layout: StringCompareLayout, locals: StringCompareLocals): Instr[] {
  const L = {
    a: locals.a,
    b: locals.b,
    ...Object.fromEntries(SCRATCH.map((name, offset) => [name, locals.scratch + offset])),
  } as Record<"a" | "b" | (typeof SCRATCH)[number], number>;
  return [
    // lenA = a.len
    { op: "local.get", index: L.a },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: L.lenA },

    // lenB = b.len
    { op: "local.get", index: L.b },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: L.lenB },

    // minLen = min(lenA, lenB)
    { op: "local.get", index: L.lenA },
    { op: "local.get", index: L.lenB },
    { op: "local.get", index: L.lenA },
    { op: "local.get", index: L.lenB },
    { op: "i32.lt_u" },
    { op: "select" },
    { op: "local.set", index: L.minLen },

    // aOff = a.off
    { op: "local.get", index: L.a },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: L.aOff },

    // bOff = b.off
    { op: "local.get", index: L.b },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: L.bOff },

    // aData = a.data
    { op: "local.get", index: L.a },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: L.aData },

    // bData = b.data
    { op: "local.get", index: L.b },
    { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: L.bData },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.i },

    // loop: compare element by element
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= minLen, break (common prefix is equal)
            { op: "local.get", index: L.i },
            { op: "local.get", index: L.minLen },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },

            // ca = aData[aOff + i]
            { op: "local.get", index: L.aData },
            { op: "local.get", index: L.aOff },
            { op: "local.get", index: L.i },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: layout.nativeStrDataTypeIdx },
            { op: "local.set", index: L.ca },

            // cb = bData[bOff + i]
            { op: "local.get", index: L.bData },
            { op: "local.get", index: L.bOff },
            { op: "local.get", index: L.i },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: layout.nativeStrDataTypeIdx },
            { op: "local.set", index: L.cb },

            // if ca < cb return -1
            { op: "local.get", index: L.ca },
            { op: "local.get", index: L.cb },
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: -1 }, { op: "return" }],
            },

            // if ca > cb return 1
            { op: "local.get", index: L.ca },
            { op: "local.get", index: L.cb },
            { op: "i32.gt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },

            // i++
            { op: "local.get", index: L.i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L.i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Common prefix is equal; compare by length
    // if lenA < lenB return -1
    { op: "local.get", index: L.lenA },
    { op: "local.get", index: L.lenB },
    { op: "i32.lt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: -1 }, { op: "return" }],
    },

    // if lenA > lenB return 1
    { op: "local.get", index: L.lenA },
    { op: "local.get", index: L.lenB },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },

    // return 0 (equal)
    { op: "i32.const", value: 0 },
  ];
}

/**
 * (#7354 L0a) The compare over two carriers (externref) that hold strings: each is cast to `$AnyString` into its own
 * local and flattened there, then the shared body runs on the flat strings.
 */
export function buildCarrierStringCompareDefinition(
  layout: StringCompareLayout & Pick<NativeStringLayout, "anyStrTypeIdx">,
  flattenHandle: number,
): { locals: LocalDef[]; body: Instr[] } {
  const strings = { a: 2, b: 3, scratch: 4 };
  const anyString: ValType = { kind: "ref", typeIdx: layout.anyStrTypeIdx };
  const cast = (param: number, local: number): Instr[] => [
    { op: "local.get", index: param },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: layout.anyStrTypeIdx },
    { op: "local.set", index: local },
  ];
  return {
    locals: [
      { name: "a", type: anyString },
      { name: "b", type: anyString },
      ...buildStringCompareScratchLocals(layout),
    ],
    body: [
      ...cast(0, strings.a),
      ...cast(1, strings.b),
      ...flattenLocals(layout.nativeStrTypeIdx, flattenHandle, [strings.a, strings.b]),
      ...castFlatReads(buildStringCompareBody(layout, strings), layout.nativeStrTypeIdx),
    ],
  };
}
