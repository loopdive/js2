// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, type IrProgramSourcePreparation } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { forEachInstrDeep } from "../src/ir/nodes.js";

function source(files: Record<string, string>, reverse = false) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  return prepareIrProgramSources({
    sourceFiles: reverse ? [...ast.sourceFiles].reverse() : ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" },
    deferTopLevelInit: false,
  });
}

function prepared(value: ReturnType<typeof source>): IrProgramSourcePreparation {
  expect(value.kind, value.kind === "prepared" ? undefined : value.detail).toBe("prepared");
  if (value.kind !== "prepared") throw new Error(value.detail);
  return value;
}

describe("whole-source preparation", () => {
  it("keeps dependency startup order with noncommutative initializers when the caller reverses files", () => {
    const files = {
      "./base.ts": "export let digit: number = 1; digit = digit * 10 + 3;",
      "./entry.ts":
        'import { digit } from "./base"; let answer: number = digit * 10 + 2; export function read(): number { return answer; }',
    };
    const normal = prepared(source(files));
    const reversed = prepared(source(files, true));
    expect(normal.inventory.terminalUnits).toHaveLength(3);
    expect(normal.startup.map((plan) => plan.sourceId)).toEqual(normal.inventory.sources.map((item) => item.id));
    expect(reversed.startup).toEqual(normal.startup);
    expect(reversed.ir).toEqual(normal.ir);
    expect(normal.ir.functions.filter((fn) => fn.exported).map((fn) => fn.name)).toEqual(["read"]);
  });

  it("marks an entry re-export's original body reachable before optimization", () => {
    const result = prepared(
      source({
        "./body.ts": "export function original(): number { return 5; }",
        "./entry.ts": 'export { original as answer } from "./body";',
      }),
    );
    expect(result.ir.functions.filter((fn) => fn.exported).map((fn) => fn.name)).toEqual(["original"]);
    expect(result.callables.some((record) => record.kind === "export-alias" && record.localName === "answer")).toBe(
      true,
    );
  });

  it("locates unsupported storage at its initializer, not the last visited function", () => {
    const result = source({
      "./bad.ts": "export let object: object = {};",
      "./entry.ts": 'import "./bad"; export function last(): number { return 1; }',
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("storage failure was lost");
    expect(result.unitId).toContain("module-init");
    expect(result.location.sourceId).toContain("bad.ts");
    expect(result.sourceFile).toBe("bad.ts");
  });

  it("preserves an imported async owner's filename through runtime preparation failure", () => {
    const ast = analyzeMultiSource(
      {
        "./body.ts": "export async function immediate(): Promise<number> { return 3; }",
        "./entry.ts": 'export { immediate } from "./body";',
      },
      "./entry.ts",
    );
    const result = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { target: "host", backend: "wasmgc" },
      deferTopLevelInit: false,
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("async preparation failure was lost");
    expect(result.unitId).toContain("top-level-function");
    expect(result.location.sourceId).toContain("body.ts");
    expect(result.sourceFile).toBe("body.ts");
  });

  it("retains TDZ checks for functions callable during startup", () => {
    const result = prepared(
      source({
        "./entry.ts":
          "export function read(): number { return value; } let before: number = read(); let value: number = 2;",
      }),
    );
    const read = result.ir.functions.find((fn) => fn.name === "read")!;
    let guards = 0;
    for (const block of read.blocks)
      for (const instruction of block.instrs)
        forEachInstrDeep(instruction, (item) => {
          if (
            item.kind === "call" &&
            item.target.binding.kind === "runtime" &&
            item.target.binding.symbol === "__new_ReferenceError"
          )
            guards++;
        });
    expect(guards).toBe(1);
  });
});
