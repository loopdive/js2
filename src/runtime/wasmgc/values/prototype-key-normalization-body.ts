// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
export interface PrototypeKeyNormalizationResources {
  readonly anyStr: number;
  readonly boxNumTypeIdx: number;
  readonly symbolTypeIdx: number;
  readonly unboxNumberIdx: number;
  readonly numberToStringIdx: number;
}
export function buildPrototypeKeyNormalizationBody(deps: PrototypeKeyNormalizationResources): Instr[] {
  const { anyStr, boxNumTypeIdx, symbolTypeIdx } = deps;
  // locals: 1=any(anyref)
  const miss = (): Instr[] => [{ op: "ref.null.extern" }, { op: "return" }];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    ...(symbolTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    ...(boxNumTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: deps.unboxNumberIdx },
              { op: "call", funcIdx: deps.numberToStringIdx },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    ...miss().slice(0, 1), // bare null-extern in tail position
  ];
}
