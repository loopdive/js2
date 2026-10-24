// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import type { PromiseThenableJobResources } from "./resolution-bodies.js";

/** Native common Get captures the method and receiver; legacy modes retain their existing dispatch. */
export function buildThenableJobCall(resources: PromiseThenableJobResources, vecLocal: number): Instr[] {
  const { applyClosureIdx, peelValueFuncIdx, varargThenFuncIdx, capsTypeIdx, capsFields } = resources;
  const capturedThenLocal = 5;
  const mode = Object.getOwnPropertyDescriptor(resources, "invocationMode");
  if (mode) {
    if (
      !mode.enumerable ||
      !Object.hasOwn(mode, "value") ||
      mode.value !== "captured" ||
      !Number.isInteger(applyClosureIdx) ||
      applyClosureIdx! < 0
    )
      throw Error("Promise job requires explicit captured invocation and a shared Call binding");
    return [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: capsTypeIdx },
      { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: capsFields.callback },
      { op: "local.get", index: 1 },
      { op: "local.get", index: vecLocal },
      { op: "call", funcIdx: applyClosureIdx! },
    ];
  }
  if (!Number.isInteger(varargThenFuncIdx) || varargThenFuncIdx! < 0)
    throw Error("Promise job default invocation requires its fallback Call binding");
  return applyClosureIdx === undefined
    ? [
        { op: "local.get", index: 1 } as Instr,
        { op: "call", funcIdx: peelValueFuncIdx } as Instr,
        { op: "local.get", index: vecLocal } as Instr,
        { op: "call", funcIdx: varargThenFuncIdx! } as Instr,
      ]
    : ([
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: capsTypeIdx },
        { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: capsFields.callback },
        { op: "local.tee", index: capturedThenLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: peelValueFuncIdx },
            { op: "local.get", index: vecLocal },
            { op: "call", funcIdx: varargThenFuncIdx! },
          ],
          else: [
            { op: "local.get", index: capturedThenLocal },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: peelValueFuncIdx },
            { op: "local.get", index: vecLocal },
            { op: "call", funcIdx: applyClosureIdx },
          ],
        },
      ] satisfies Instr[]);
}
