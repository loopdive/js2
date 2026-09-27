// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";

export interface RawExternrefStorageCopyResources {
  readonly arrayTypeIndex: number;
  readonly holeTypeIndex: number;
}

export interface RawExternrefStorageCopyBody {
  params: ValType[];
  results: ValType[];
  locals: LocalDef[];
  body: Instr[];
}

/** Trap an internal contract violation. This is not a JavaScript exception policy. */
function rejectIf(): Instr {
  return { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] };
}

function checkRange(array: number, start: number): Instr[] {
  return [
    { op: "local.get", index: start },
    { op: "local.get", index: array },
    { op: "array.len" },
    { op: "i32.gt_u" },
    rejectIf(),
    // Subtraction is safe only after start <= length. Never add start + count.
    { op: "local.get", index: 6 },
    { op: "local.get", index: array },
    { op: "array.len" },
    { op: "local.get", index: start },
    { op: "i32.sub" },
    { op: "i32.gt_u" },
    rejectIf(),
  ];
}

/**
 * Dormant raw storage primitive, not Get/HasProperty or a semantic Array copy.
 * Params: src/dst backing arrays, src/dst Hole tokens, src/dst offsets, count.
 * The eventual caller MUST authenticate version/kind/provider and obtain tokens
 * from the respective resident storage domains. Type compatibility is not proof.
 * Source slots must already obey their domain; aliasing storage must share it.
 * No context, registration, imports, singleton globals or user callbacks.
 */
export function buildRawExternrefStorageCopyBody(
  resources: RawExternrefStorageCopyResources,
): RawExternrefStorageCopyBody {
  const { arrayTypeIndex, holeTypeIndex } = resources;
  for (const index of [arrayTypeIndex, holeTypeIndex]) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("raw vector copy: invalid type index");
  }
  if (arrayTypeIndex === holeTypeIndex) throw new Error("raw vector copy: array and Hole types must differ");
  const src = 0,
    dst = 1,
    srcHole = 2,
    dstHole = 3,
    srcStart = 4,
    dstStart = 5,
    count = 6;
  const cursor = 7,
    slot = 8;
  const body: Instr[] = [
    ...checkRange(src, srcStart),
    ...checkRange(dst, dstStart),
    { op: "local.get", index: src },
    { op: "local.get", index: dst },
    { op: "ref.eq" },
    { op: "local.get", index: srcHole },
    { op: "local.get", index: dstHole },
    { op: "ref.eq" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    rejectIf(),
    { op: "local.get", index: srcHole },
    { op: "local.get", index: dstHole },
    { op: "ref.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Equal domains: array.copy supplies memmove semantics for overlaps.
        { op: "local.get", index: dst },
        { op: "local.get", index: dstStart },
        { op: "local.get", index: src },
        { op: "local.get", index: srcStart },
        { op: "local.get", index: count },
        { op: "array.copy", dstTypeIdx: arrayTypeIndex, srcTypeIdx: arrayTypeIndex },
      ],
      else: [
        // Unequal domains cannot alias after preflight, so forward translation is safe.
        { op: "i32.const", value: 0 },
        { op: "local.set", index: cursor },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: cursor },
                { op: "local.get", index: count },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: src },
                { op: "local.get", index: srcStart },
                { op: "local.get", index: cursor },
                { op: "i32.add" },
                { op: "array.get", typeIdx: arrayTypeIndex },
                { op: "local.set", index: slot },
                { op: "local.get", index: dst },
                { op: "local.get", index: dstStart },
                { op: "local.get", index: cursor },
                { op: "i32.add" },
                { op: "local.get", index: slot },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: holeTypeIndex },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: slot },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: holeTypeIndex },
                    { op: "local.get", index: srcHole },
                    { op: "ref.eq" },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "externref" } },
                  then: [{ op: "local.get", index: dstHole }, { op: "extern.convert_any" }],
                  else: [{ op: "local.get", index: slot }],
                },
                { op: "array.set", typeIdx: arrayTypeIndex },
                { op: "local.get", index: cursor },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: cursor },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
  return {
    params: [
      { kind: "ref", typeIdx: arrayTypeIndex },
      { kind: "ref", typeIdx: arrayTypeIndex },
      { kind: "ref", typeIdx: holeTypeIndex },
      { kind: "ref", typeIdx: holeTypeIndex },
      { kind: "i32" },
      { kind: "i32" },
      { kind: "i32" },
    ],
    results: [],
    locals: [
      { name: "$cursor", type: { kind: "i32" } },
      { name: "$slot", type: { kind: "externref" } },
    ],
    body,
  };
}
