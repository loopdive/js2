// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, TypeHandle } from "../../../wasm/model/instructions.js";

/** Restore registration order after detaching a prepend-built reaction list.
 * Callback nodes are immutable. Copy only multi-node lists, preserving their
 * functions/captures and leaving the common single-reaction path allocation-free.
 */
export function buildRegistrationOrderedCallbacks(
  callbackTypeIdx: TypeHandle,
  callbacksLocal: number,
  callbackLocal: number,
  reversedLocal: number,
): Instr[] {
  const castHead = (): Instr[] => [
    { op: "local.get", index: callbacksLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: callbackTypeIdx },
  ];
  return [
    { op: "local.get", index: callbacksLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...castHead(),
        { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "ref.null.extern" },
            { op: "local.set", index: reversedLocal },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: callbacksLocal },
                    { op: "ref.is_null" },
                    { op: "br_if", depth: 1 },
                    ...castHead(),
                    { op: "local.set", index: callbackLocal },
                    ...[0, 1, 2, 3].flatMap((fieldIdx): Instr[] => [
                      { op: "local.get", index: callbackLocal },
                      { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx },
                    ]),
                    { op: "local.get", index: reversedLocal },
                    { op: "struct.new", typeIdx: callbackTypeIdx },
                    { op: "extern.convert_any" },
                    { op: "local.set", index: reversedLocal },
                    { op: "local.get", index: callbackLocal },
                    { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
                    { op: "local.set", index: callbacksLocal },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "local.get", index: reversedLocal },
            { op: "local.set", index: callbacksLocal },
          ],
        },
      ],
    },
  ];
}
