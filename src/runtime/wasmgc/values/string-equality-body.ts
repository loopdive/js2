// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";

export type StringEqualityLayout = Pick<
  NativeStringLayout,
  "nativeStrTypeIdx" | "nativeStrDataTypeIdx" | "anyStrTypeIdx" | "hashedStrTypeIdx"
>;

function flattenParameters(flatType: number, handles: readonly [number, number]): Instr[] {
  return handles.flatMap<Instr>((funcIdx, index) => [
    { op: "local.get", index },
    { op: "ref.test", typeIdx: flatType },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index },
        { op: "call", funcIdx },
        { op: "local.set", index },
      ],
    },
  ]);
}

/** Exact donor core, before the canonical flat-access cast wrapper. */
export function buildStringEqualityBody(
  layout: StringEqualityLayout,
  lazy: boolean,
  flattenPreamble: readonly Instr[],
): Instr[] {
  const { nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx, hashedStrTypeIdx } = layout;
  const lenTypeIdx = lazy ? layout.anyStrTypeIdx : strTypeIdx;
  return [
    // (#3673) identity fast path: same ref → equal. Literal interning gives
    // every literal site one shared struct, so comparisons against the same
    // interned literal (property-name probes, keyword checks) exit here
    // without touching the character data.
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "ref.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    // len = a.len
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: lenTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 2 }, // len

    // if a.len != b.len return 0
    { op: "local.get", index: 2 },
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: lenTypeIdx, fieldIdx: 0 },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },

    // (#3673 round 9) Hash fast-reject: when BOTH sides are `$HashedString`
    // with computed hashes (interned literals bake theirs at compile time)
    // and the hashes differ, the strings cannot be equal — O(1) instead of
    // the char loop. Equal hashes (match or collision) fall through to the
    // authoritative char compare. The `__extern_get` member-ladder arms
    // compare an interned probe key against interned field-name constants
    // bucketed by length + first char, so this reject does the real work.
    ...(hashedStrTypeIdx >= 0
      ? ([
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: hashedStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.test", typeIdx: hashedStrTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "ref.cast", typeIdx: hashedStrTypeIdx },
                  { op: "struct.get", typeIdx: hashedStrTypeIdx, fieldIdx: 3 },
                  { op: "local.tee", index: 8 },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: 1 },
                      { op: "ref.cast", typeIdx: hashedStrTypeIdx },
                      { op: "struct.get", typeIdx: hashedStrTypeIdx, fieldIdx: 3 },
                      { op: "local.tee", index: 9 },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 9 },
                          { op: "i32.ne" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ] satisfies Instr[])
      : []),

    // (#4157) Everything above answered without a flat buffer; the loop below
    // is the first consumer of `off`/`data`.
    ...flattenPreamble,

    // aOff = a.off
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 6 },

    // bOff = b.off
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: 7 },

    // aData = a.data
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 4 },

    // bData = b.data
    { op: "local.get", index: 1 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: 5 },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 3 },

    // loop: compare element by element
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i >= len, break (strings are equal)
            { op: "local.get", index: 3 },
            { op: "local.get", index: 2 },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },

            // if aData[aOff + i] != bData[bOff + i], return 0
            { op: "local.get", index: 4 },
            { op: "local.get", index: 6 },
            { op: "local.get", index: 3 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.get", index: 5 },
            { op: "local.get", index: 7 },
            { op: "local.get", index: 3 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "i32.ne" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },

            // i++
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 3 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return 1 (equal)
    { op: "i32.const", value: 1 },
  ];
}

export function buildStringEqualityLocals(layout: StringEqualityLayout): LocalDef[] {
  return [
    { name: "len", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "aData", type: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx } },
    { name: "bData", type: { kind: "ref", typeIdx: layout.nativeStrDataTypeIdx } },
    { name: "aOff", type: { kind: "i32" } },
    { name: "bOff", type: { kind: "i32" } },
    { name: "aHash", type: { kind: "i32" } },
    { name: "bHash", type: { kind: "i32" } },
  ];
}

function castFlatReads(body: readonly Instr[], flatType: number): Instr[] {
  return body.flatMap<Instr>((instruction) => {
    if (instruction.op === "struct.get" && instruction.typeIdx === flatType)
      return [{ op: "ref.cast", typeIdx: flatType }, instruction];
    if (instruction.op === "if")
      return [
        {
          ...instruction,
          ...(instruction.then ? { then: castFlatReads(instruction.then, flatType) } : {}),
          ...(instruction.else ? { else: castFlatReads(instruction.else, flatType) } : {}),
        },
      ];
    if (instruction.op === "block" || instruction.op === "loop" || instruction.op === "try_table")
      return [{ ...instruction, body: castFlatReads(instruction.body, flatType) }];
    return [instruction];
  });
}

/** Explicit lazy policy and concrete flatten handle; no codegen context or ambient flag. */
export function buildStringEqualityDefinition(
  layout: StringEqualityLayout,
  flattenHandle: number,
  lazy: boolean,
): { locals: LocalDef[]; body: Instr[] } {
  const handles: readonly [number, number] = [flattenHandle, flattenHandle];
  const body = buildStringEqualityBody(layout, lazy, lazy ? flattenParameters(layout.nativeStrTypeIdx, handles) : []);
  return {
    locals: buildStringEqualityLocals(layout),
    body: [
      ...(lazy ? [] : flattenParameters(layout.nativeStrTypeIdx, handles)),
      ...castFlatReads(body, layout.nativeStrTypeIdx),
    ],
  };
}
