// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { emitBinary, emitBinaryWithSourceMap } from "../src/emit/binary.js";
import { createEmptyModule, type Instr, type ValType, type WasmModule } from "../src/ir/types.js";

const EMPTY_BLOCK = { kind: "empty" } as const;

function moduleWithBody(body: Instr[], params: ValType[] = []): WasmModule {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", params, results: [] });
  mod.functions.push({ name: "probe", typeIdx: 0, locals: [], body, exported: false });
  return mod;
}

function leaf(): Instr[] {
  return [{ op: "i32.const", value: 7 }, { op: "drop" }];
}

function expandedMiddle(): Instr[] {
  return [
    { op: "block", blockType: EMPTY_BLOCK, body: leaf() },
    { op: "block", blockType: EMPTY_BLOCK, body: leaf() },
  ];
}

describe("#1058 binary emission of shared instruction-array DAGs", () => {
  it("is byte-identical to the fully expanded tree and preserves source-map output", () => {
    const sharedLeaf = leaf();
    const sharedMiddle: Instr[] = [
      { op: "block", blockType: EMPTY_BLOCK, body: sharedLeaf },
      { op: "block", blockType: EMPTY_BLOCK, body: sharedLeaf },
    ];
    const sharedBody: Instr[] = [
      {
        op: "block",
        blockType: EMPTY_BLOCK,
        body: sharedMiddle,
        sourcePos: { file: "dag.ts", line: 1, column: 1 },
      },
      {
        op: "block",
        blockType: EMPTY_BLOCK,
        body: sharedMiddle,
        sourcePos: { file: "dag.ts", line: 2, column: 1 },
      },
    ];
    const expandedBody: Instr[] = [
      {
        op: "block",
        blockType: EMPTY_BLOCK,
        body: expandedMiddle(),
        sourcePos: { file: "dag.ts", line: 1, column: 1 },
      },
      {
        op: "block",
        blockType: EMPTY_BLOCK,
        body: expandedMiddle(),
        sourcePos: { file: "dag.ts", line: 2, column: 1 },
      },
    ];

    const sharedBinary = emitBinary(moduleWithBody(sharedBody));
    const expandedBinary = emitBinary(moduleWithBody(expandedBody));
    expect(sharedBinary).toEqual(expandedBinary);
    expect(WebAssembly.validate(sharedBinary)).toBe(true);

    const sharedMapped = emitBinaryWithSourceMap(moduleWithBody(sharedBody));
    const expandedMapped = emitBinaryWithSourceMap(moduleWithBody(expandedBody));
    expect(sharedMapped.binary).toEqual(sharedBinary);
    expect(sharedMapped).toEqual(expandedMapped);
    expect(sharedMapped.sourceMapEntries.map((entry) => entry.sourcePos.line)).toEqual([1, 2]);
  });

  it("validates a shared array independently in every function frame and clears state after failure", () => {
    const sharedRead: Instr[] = [{ op: "local.get", index: 0 }, { op: "drop" }];
    const sharedBody: Instr[] = [
      { op: "block", blockType: EMPTY_BLOCK, body: sharedRead },
      { op: "block", blockType: EMPTY_BLOCK, body: sharedRead },
    ];
    const mod = createEmptyModule();
    mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [] }, { kind: "func", params: [], results: [] });
    mod.functions.push(
      { name: "valid", typeIdx: 0, locals: [], body: sharedBody, exported: false },
      { name: "invalid", typeIdx: 1, locals: [], body: sharedBody, exported: false },
    );

    expect(() => emitBinary(mod)).toThrow(/local \(local\.get\) index out of range/);

    const afterFailure = emitBinary(moduleWithBody([{ op: "nop" }]));
    expect(WebAssembly.validate(afterFailure)).toBe(true);
  });

  it("completes a deep shared DAG with bounded output", () => {
    let body: Instr[] = [{ op: "nop" }];
    for (let depth = 0; depth < 18; depth++) {
      const child = body;
      body = [
        { op: "block", blockType: EMPTY_BLOCK, body: child },
        { op: "block", blockType: EMPTY_BLOCK, body: child },
      ];
    }

    const binary = emitBinary(moduleWithBody(body));
    expect(binary.byteLength).toBeLessThan(2_000_000);
    expect(WebAssembly.validate(binary)).toBe(true);
  });
});
