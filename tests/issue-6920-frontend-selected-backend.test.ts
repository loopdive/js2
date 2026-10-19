// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6920 A-C1 — the frontend takes a physical vector's representation from the
// resolver's selected backend, never from the handle's shape.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import type { IrVecLowering, LinearVecLowering } from "../src/ir/backend/handles.js";
import { lowerFunctionAstToIr, type IrFromAstResolver } from "../src/ir/from-ast.js";
import type { ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-6920-frontend-selected-backend");
const SOURCE = `export function pair(): number { const a = [1, 2]; return a.length; }`;

const gcHandle = (element: ValType): IrVecLowering => ({
  valueType: { kind: "ref", typeIdx: 7 },
  vecStructTypeIdx: 7,
  lengthFieldIdx: 0,
  dataFieldIdx: 1,
  arrayTypeIdx: 6,
  elementValType: element,
});

function lower(resolver: IrFromAstResolver) {
  const ast = analyzeSource(SOURCE);
  const fn = ast.sourceFile.statements.find(ts.isFunctionDeclaration)!;
  return lowerFunctionAstToIr(fn, {
    exported: true,
    ownerUnitId: identities.next("pair").unitId,
    checker: ast.checker,
    resolver,
  });
}

describe("#6920 A-C1 frontend selected backend", () => {
  it("lowers a WasmGC handle when the selected backend is wasmgc", () => {
    const { main } = lower({ selectedBackend: "wasmgc", resolveVecForElement: gcHandle });
    expect(main.blocks.length).toBeGreaterThan(0);
  });

  it("refuses physical vectors when the resolver names no selected backend (no WasmGC default)", () => {
    expect(() => lower({ resolveVecForElement: gcHandle })).toThrow(/vector representation has no selected backend/);
  });

  it("rejects a WasmGC handle under the linear backend before using its carrier", () => {
    expect(() => lower({ selectedBackend: "linear", resolveVecForElement: gcHandle })).toThrow(
      /vec representation mismatch: linear backend received a WasmGC vector handle/,
    );
  });

  it("rejects a linear-memory handle under the wasmgc backend", () => {
    const linear = { valueType: { kind: "i32" }, elementValType: { kind: "f64" }, linearMemory: {} } as unknown;
    expect(() => lower({ selectedBackend: "wasmgc", resolveVecForElement: () => linear as LinearVecLowering })).toThrow(
      /vec representation mismatch: wasmgc backend received a linear-memory vector handle/,
    );
  });
});
