import { describe, it, expect } from "vitest";
import {
  allocatedStructTypeIndices,
  walkChildren,
  walkInstructionDag,
  walkInstructions,
} from "../src/codegen/walk-instructions.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

describe("walkInstructions", () => {
  it("visits flat instruction list", () => {
    const instrs: Instr[] = [
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.const", value: 2 } as Instr,
      { op: "i32.add" } as Instr,
    ];
    const visited: string[] = [];
    walkInstructions(instrs, (instr) => visited.push(instr.op));
    expect(visited).toEqual(["i32.const", "i32.const", "i32.add"]);
  });

  it("recurses into block body", () => {
    const instrs: Instr[] = [
      {
        op: "block",
        blockType: { kind: "void" },
        body: [{ op: "i32.const", value: 42 } as Instr, { op: "drop" } as Instr],
      } as unknown as Instr,
    ];
    const visited: string[] = [];
    walkInstructions(instrs, (instr) => visited.push(instr.op));
    expect(visited).toEqual(["block", "i32.const", "drop"]);
  });

  it("recurses into if/then/else", () => {
    const instrs: Instr[] = [
      {
        op: "if",
        blockType: { kind: "void" },
        then: [{ op: "nop" } as Instr],
        else: [{ op: "unreachable" } as Instr],
      } as unknown as Instr,
    ];
    const visited: string[] = [];
    walkInstructions(instrs, (instr) => visited.push(instr.op));
    expect(visited).toEqual(["if", "nop", "unreachable"]);
  });

  it("recurses into try/catches/catchAll", () => {
    const instrs: Instr[] = [
      {
        op: "try",
        blockType: { kind: "void" },
        body: [{ op: "call", funcIdx: 0 } as Instr],
        catches: [{ tagIdx: 0, body: [{ op: "drop" } as Instr] }],
        catchAll: [{ op: "unreachable" } as Instr],
      } as unknown as Instr,
    ];
    const visited: string[] = [];
    walkInstructions(instrs, (instr) => visited.push(instr.op));
    expect(visited).toEqual(["try", "call", "drop", "unreachable"]);
  });

  it("recurses into nested blocks", () => {
    const instrs: Instr[] = [
      {
        op: "block",
        blockType: { kind: "void" },
        body: [
          {
            op: "loop",
            blockType: { kind: "void" },
            body: [{ op: "br", labelIdx: 0 } as Instr],
          } as unknown as Instr,
        ],
      } as unknown as Instr,
    ];
    const visited: string[] = [];
    walkInstructions(instrs, (instr) => visited.push(instr.op));
    expect(visited).toEqual(["block", "loop", "br"]);
  });

  it("allows mutation of instructions", () => {
    const instrs: Instr[] = [
      { op: "call", funcIdx: 5 } as Instr,
      {
        op: "block",
        blockType: { kind: "void" },
        body: [{ op: "call", funcIdx: 10 } as Instr],
      } as unknown as Instr,
    ];
    walkInstructions(instrs, (instr) => {
      const a = instr as any;
      if (typeof a.funcIdx === "number") {
        a.funcIdx += 3;
      }
    });
    expect((instrs[0] as any).funcIdx).toBe(8);
    expect(((instrs[1] as any).body[0] as any).funcIdx).toBe(13);
  });

  it("can visit a shared instruction DAG once by array identity", () => {
    const leaf: Instr[] = [{ op: "nop" } as Instr];
    let shared = leaf;
    for (let depth = 0; depth < 28; depth++) {
      shared = [
        {
          op: "if",
          blockType: { kind: "empty" },
          then: shared,
          else: shared,
        } as Instr,
      ];
    }

    const visited: string[] = [];
    walkInstructionDag(shared, (instr) => visited.push(instr.op));

    expect(visited).toHaveLength(29);
    expect(visited.filter((op) => op === "nop")).toHaveLength(1);
  });
});

it("collects allocated struct types once across shared module roots", () => {
  const leaf: Instr[] = [{ op: "struct.new", typeIdx: 7 }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    functions: [
      { name: "first", typeIdx: 0, locals: [], body: shared },
      { name: "second", typeIdx: 0, locals: [], body: shared },
    ],
    globals: [],
  } as unknown as WasmModule;

  expect([...allocatedStructTypeIndices(mod)]).toEqual([7]);
});

describe("walkChildren", () => {
  it("yields all child arrays of a try instruction", () => {
    const tryInstr = {
      op: "try",
      blockType: { kind: "void" },
      body: [{ op: "nop" }],
      catches: [
        { tagIdx: 0, body: [{ op: "drop" }] },
        { tagIdx: 1, body: [{ op: "unreachable" }] },
      ],
      catchAll: [{ op: "return" }],
    } as unknown as Instr;
    const children: Instr[][] = [];
    walkChildren(tryInstr, (c) => children.push(c));
    expect(children.length).toBe(4); // body, catch0.body, catch1.body, catchAll
  });

  it("yields nothing for a simple instruction", () => {
    const instr = { op: "i32.const", value: 0 } as Instr;
    const children: Instr[][] = [];
    walkChildren(instr, (c) => children.push(c));
    expect(children.length).toBe(0);
  });
});
