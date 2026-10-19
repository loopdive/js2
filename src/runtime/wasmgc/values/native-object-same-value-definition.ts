// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { buildObjectSameValueBody, type ObjectSameValueResources } from "./object-same-value-body.js";

/** Native SameValue treats every NaN representation as the same Number value.
 * Keep the historical recipe intact for frozen donor/source custody. After
 * handling this numeric case, share its complete primitive/reference dispatch.
 * Both Number brands are proved before unboxing; no coercion is performed.
 */
export function buildNativeObjectSameValueDefinition(d: ObjectSameValueResources): {
  locals: LocalDef[];
  body: Instr[];
} {
  const nanTest = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "call", funcIdx: d.unboxNumIdx },
    { op: "local.get", index },
    { op: "call", funcIdx: d.unboxNumIdx },
    { op: "f64.ne" },
  ];
  return {
    locals: [
      { name: "aa", type: { kind: "anyref" } },
      { name: "ba", type: { kind: "anyref" } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.typeofNumIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.typeofNumIdx },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...nanTest(0),
          ...nanTest(1),
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          },
        ],
      },
      ...buildObjectSameValueBody(d),
    ],
  };
}
