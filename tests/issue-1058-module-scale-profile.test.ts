// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { measureModuleScale } from "../src/codegen/module-scale-profile.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

describe("#1058 module-scale profiling", () => {
  it("counts shared instruction-array graphs without a per-instruction identity Set", () => {
    const sharedNop = { op: "nop" } as Instr;
    const sharedLeaf = [sharedNop];
    const root = [
      {
        op: "if",
        blockType: { kind: "empty" },
        then: sharedLeaf,
        else: sharedLeaf,
      } as Instr,
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [sharedNop],
      } as Instr,
    ];
    const mod = {
      functions: [
        { name: "first", typeIdx: 0, locals: [], body: root },
        { name: "second", typeIdx: 0, locals: [], body: root },
      ],
      imports: [],
      types: [{}],
      globals: [],
    } as unknown as WasmModule;

    expect(measureModuleScale(mod)).toEqual({
      funcs: 2,
      imports: 0,
      types: 1,
      globals: 0,
      instrs: 10,
      uniqueInstrs: 4,
    });
  });
});
