// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// DATA relational validation controls, never genuine frontend-origin proof.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  capturePreparedSourceMapInput,
  captureTypedIrProgramInput,
  prepareIrProgramSources,
} from "../src/ir/program-source.js";
import { forEachInstrDeep } from "../src/ir/nodes.js";
import { assertPreparedSourceMap } from "../src/ir/program/validation.js";

function data() {
  const text =
    "let a: number = 1, b: number = 2; export function read(): number { return a; } a = a * 10 + 3; a = a + 4;";
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" },
    deferTopLevelInit: false,
  });
  expect(source.kind, source.kind === "prepared" ? undefined : source.detail).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(source.detail);
  const catalog = capturePreparedSourceMapInput(ast.sourceFiles, source.inventory, {
    kind: "capture-source-map",
    sources: ast.sourceFiles.map((sourceFile) => ({
      sourceFile,
      projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
    })),
  });
  const packet = JSON.parse(JSON.stringify({ ...captureTypedIrProgramInput(source), sourceMap: catalog }));
  for (const fn of packet.ir.functions)
    for (const block of fn.blocks) {
      const generated = {
        origin: { kind: "generated", phase: "frontend", role: "implicit-return", ownerUnitId: fn.unitId },
      };
      block.terminator.site = generated;
      for (const instr of block.instrs) forEachInstrDeep(instr, (item) => Object.assign(item, { site: generated }));
    }
  const module = packet.inventory.terminalUnits.find((unit: { kind: string }) => unit.kind === "module-init");
  const fn = packet.ir.functions.find((item: { unitId: string }) => item.unitId === module.id);
  const expression = ast.entryFile.statements[2];
  expect(ts.isExpressionStatement(expression)).toBe(true);
  const start = expression.getStart(ast.entryFile),
    end = expression.end;
  expect(start).toBeGreaterThan(module.declarationEnd);
  const location = ast.entryFile.getLineAndCharacterOfPosition(start);
  fn.blocks[0].instrs[0].site = {
    line: location.line + 1,
    column: location.character,
    origin: {
      kind: "source",
      point: {
        sourceId: module.sourceId,
        donorUnitId: module.id,
        analyzed: { start, end },
        original: { start, end },
        mapping: "exact",
      },
    },
  };
  return {
    packet,
    site: fn.blocks[0].instrs[0].site,
    plan: packet.startup.find((plan: { unitId: string }) => plan.unitId === module.id),
    module,
    text,
    start,
    end,
  };
}
function healthy() {
  const witness = data();
  assertPreparedSourceMap(witness.packet);
  return witness;
}
function paired(mutate: (witness: ReturnType<typeof data>) => void) {
  const witness = healthy();
  mutate(witness);
  expect(() => assertPreparedSourceMap(witness.packet)).toThrow();
  healthy();
}
describe("B3 startup DATA exact occurrence relations", () => {
  it("retains original uninitialized module binding semantic refusal", () => {
    const ast = analyzeMultiSource(
      {
        "./entry.ts":
          "let a: number = 1, b: number; export function read(): number { return a; } a = a * 10 + 3; a = a + 4;",
      },
      "./entry.ts",
    );
    const result = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { target: "host", backend: "wasmgc" },
      deferTopLevelInit: false,
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("original refusal disappeared");
    expect(result.detail).toContain("Phase 1 requires an initializer for 'b'");
    expect(
      prepareIrProgramSources({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy: { target: "host", backend: "wasmgc" },
        deferTopLevelInit: false,
        sourceMap: {
          kind: "capture-source-map",
          sources: ast.sourceFiles.map((sourceFile) => ({
            sourceFile,
            projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
          })),
        },
      } as Parameters<typeof prepareIrProgramSources>[0]),
    ).toEqual(result);
  });
  it("accepts genuine planner later statement range outside the original anchor as DATA", () => {
    const witness = healthy();
    console.info(
      "B3 startup DATA population",
      JSON.stringify({
        sources: witness.packet.inventory.sources.length,
        terminals: witness.packet.inventory.terminalUnits.length,
        functions: witness.packet.ir.functions.length,
        bindings: witness.plan.bindings.length,
        evaluations: witness.plan.evaluations.length,
        anchor: [witness.module.declarationStart, witness.module.declarationEnd],
        later: [witness.start, witness.end],
      }),
    );
  });
  it("accepts frontend control-scaffold only with actual owner as DATA", () => {
    const witness = data();
    // This control isolates the new role from the outside-anchor exception.
    witness.site.origin = {
      kind: "generated",
      phase: "frontend",
      role: "control-scaffold",
      ownerUnitId: witness.module.id,
    };
    Reflect.deleteProperty(witness.site, "line");
    Reflect.deleteProperty(witness.site, "column");
    assertPreparedSourceMap(witness.packet);
    witness.site.origin.ownerUnitId = witness.packet.ir.functions.find(
      (fn: { unitId: string }) => fn.unitId !== witness.module.id,
    ).unitId;
    expect(() => assertPreparedSourceMap(witness.packet)).toThrow();
  });
  for (const [name, mutate] of [
    [
      "occurrence hull spanning separated statements",
      (w) => {
        w.site.origin.point.analyzed.end = w.text.length;
        w.site.origin.point.original.end = w.text.length;
      },
    ],
    [
      "intervening function gap",
      (w) => {
        const donor = w.packet.inventory.terminalUnits.find((u: { kind: string }) => u.kind === "top-level-function");
        w.site.origin.point.analyzed = { start: donor.declarationStart, end: donor.declarationEnd };
        w.site.origin.point.original = { ...w.site.origin.point.analyzed };
      },
    ],
    [
      "zero-width outside-anchor marker",
      (w) => {
        w.site.origin.point.analyzed.end = w.start;
        w.site.origin.point.original.end = w.start;
      },
    ],
    [
      "wrong ordinary donor",
      (w) => {
        w.site.origin.point.donorUnitId = w.packet.inventory.terminalUnits.find(
          (u: { kind: string }) => u.kind === "top-level-function",
        ).id;
      },
    ],
    [
      "duplicated matching startup plan",
      (w) => {
        w.packet.startup.push(structuredClone(w.plan));
      },
    ],
    [
      "changed evaluation key",
      (w) => {
        w.plan.evaluations[1].key += ":wrong";
      },
    ],
    [
      "changed canonical legacy key",
      (w) => {
        w.plan.evaluations[1].legacyKey += ":wrong";
      },
    ],
    [
      "changed range without changed key",
      (w) => {
        w.plan.evaluations[1].start++;
      },
    ],
    [
      "unused sibling NaN range",
      (w) => {
        w.plan.evaluations[2].end = NaN;
      },
    ],
    [
      "fractional sibling start",
      (w) => {
        w.plan.evaluations[2].start += 0.5;
      },
    ],
    [
      "wrong source ordinal",
      (w) => {
        w.plan.evaluations[1].sourceOrdinal = 19;
      },
    ],
    [
      "statement carries foreign binding",
      (w) => {
        w.plan.evaluations[1].bindingIds.push(w.plan.bindings[0].globalBindingId);
      },
    ],
    [
      "reordered initializer binding IDs",
      (w) => {
        w.plan.evaluations[0].bindingIds.reverse();
      },
    ],
    [
      "overlapping binding declaration",
      (w) => {
        w.plan.bindings[1].start = w.plan.bindings[0].start;
      },
    ],
    [
      "excluded static evaluation",
      (w) => {
        w.plan.evaluations[1].kind = "class-static-block";
      },
    ],
    [
      "hostile evaluation getter",
      (w) => {
        Object.defineProperty(w.plan.evaluations[2], "end", {
          get() {
            throw new Error("getter was evaluated");
          },
        });
      },
    ],
  ] satisfies [string, (w: ReturnType<typeof data>) => void][])
    it(`rejects ${name} between fresh healthy DATA controls`, () => paired(mutate));
});

describe("A2 startup DATA descriptor-before-read controls", () => {
  for (const kind of ["unused evaluation field", "binding field", "evaluation array element"] as const) {
    it(`refuses ${kind} without running its getter, then accepts exact restoration`, () => {
      const witness = healthy();
      let reads = 0;
      const record =
        kind === "unused evaluation field"
          ? witness.plan.evaluations[2]
          : kind === "binding field"
            ? witness.plan.bindings[0]
            : witness.plan.evaluations;
      const key = kind === "unused evaluation field" ? "end" : kind === "binding field" ? "globalBindingId" : "2";
      const original = Object.getOwnPropertyDescriptor(record, key)!;
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        get() {
          reads++;
          return original.value;
        },
      });
      expect(() => assertPreparedSourceMap(witness.packet)).toThrow(/accessors|must be data/);
      expect(reads).toBe(0);
      Object.defineProperty(record, key, original);
      assertPreparedSourceMap(witness.packet);
      healthy();
    });
  }
});

describe("A3 startup DATA primitive identity control", () => {
  it("refuses a coherently shared object source ID before calling its conversion hook, then accepts restoration", () => {
    const witness = healthy();
    const original = witness.site.origin.point.sourceId;
    let calls = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        calls++;
        return original;
      },
    };
    const touched: { row: Record<string, unknown>; key: string; value: unknown }[] = [];
    for (const [rows, key] of [
      [witness.packet.inventory.sources, "id"],
      [witness.packet.inventory.allUnits, "sourceId"],
      [witness.packet.inventory.terminalUnits, "sourceId"],
      [witness.packet.sourceMap.sources, "sourceId"],
      [witness.packet.startup, "sourceId"],
      [[witness.site.origin.point], "sourceId"],
    ] as const)
      for (const row of rows)
        if (row[key] === original) {
          touched.push({ row, key, value: row[key] });
          row[key] = hostile;
        }
    expect(touched.length).toBeGreaterThan(5);
    expect(() => assertPreparedSourceMap(witness.packet)).toThrow(/primitive strings/);
    expect(calls).toBe(0);
    for (const item of touched) item.row[item.key] = item.value;
    assertPreparedSourceMap(witness.packet);
    healthy();
  });
});
