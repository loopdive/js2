// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { forEachInstrDeep, type IrInstrRefCellNew } from "../src/ir/core/nodes.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";

const source = `
function make(seed: number): () => number {
  return function increment(): number { seed += 1; return seed; };
}
export function run(seed: number): number {
  const first = make(seed);
  const second = make(seed + 20);
  return first() * 10000 + second() * 100 + first();
}`;
function oracle(): (seed: number) => number {
  const exports: { run?: (seed: number) => number } = {};
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("exact mutable-capture source lacks run");
  return exports.run;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("native ref cells through actual source closure lowering", () => {
  for (const gvn of [false, true])
    for (const decoded of [false, true])
      it(`executes repeated shared mutations and independent cells, GVN=${gvn}, decoded=${decoded}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
        const original = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
        const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const kinds: string[] = [];
        for (const fn of program.runtime[0]!.prepared.functions)
          for (const block of fn.blocks)
            for (const root of block.instrs)
              forEachInstrDeep(root, (instruction) => {
                if (instruction.kind.startsWith("refcell.")) kinds.push(instruction.kind);
              });
        expect(kinds).toContain("refcell.new");
        expect(kinds).toContain("refcell.get");
        expect(kinds).toContain("refcell.set");
        const result = await replayProgram(program, replayOptions("wasmgc", "standalone"));
        if (result.kind !== "ran") throw new Error(JSON.stringify(result.failure));
        const plan = acceptedPhysicalSetupPlan(result.run.accepted).sourceClosures;
        expect(plan?.refCells).toHaveLength(1);
        const issued = planNativeSourceClosureRequirements(program, program.runtime[0]!);
        if (!issued) throw new Error("actual mutable capture requirements missing");
        const expectedAllocations: {
          view: string;
          ownerUnitId: string;
          block: number;
          instruction: IrInstrRefCellNew;
        }[] = [];
        for (const [ownerIndex, owner] of program.ir.functions.entries())
          for (const [view, fn] of [
            ["program", owner],
            ["projection", program.runtime[0]!.prepared.functions[ownerIndex]!],
          ] as const)
            for (const [blockIndex, block] of fn.blocks.entries())
              for (const root of block.instrs)
                forEachInstrDeep(root, (instruction) => {
                  if (instruction.kind === "refcell.new")
                    expectedAllocations.push({ view, ownerUnitId: fn.unitId, block: blockIndex, instruction });
                });
        const actualAllocations = issued.refCellAllocations.map((row) => {
          const occurrence = issued.demands.occurrences[row.occurrence]!,
            region = issued.demands.buffers[occurrence.bufferIndex]!;
          expect(region.root.kind).toBe("block");
          expect(row.ownerUnitId).toBe(region.ownerUnitId);
          expect(row.rawAllocationId).toBe(occurrence.instruction.alloc);
          return {
            view: region.view,
            ownerUnitId: region.ownerUnitId,
            block: region.root.index,
            instruction: occurrence.instruction,
          };
        });
        const evidence = join(process.cwd(), ".tmp/native-ref-cell-census");
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
          join(evidence, `gvn-${gvn}-decoded-${decoded}.json`),
          JSON.stringify({ expectedAllocations, actualAllocations, issued: issued.refCellAllocations }, null, 2),
        );
        expect(expectedAllocations.length).toBeGreaterThan(0);
        expect(plan?.refCellAllocations).toEqual(issued.refCellAllocations);
        expect(new Set(issued.refCellAllocations.map((row) => row.occurrence)).size).toBe(
          issued.refCellAllocations.length,
        );
        expect(actualAllocations).toEqual(expectedAllocations);
        actualAllocations.forEach((row, index) =>
          expect(row.instruction).toBe(expectedAllocations[index]!.instruction),
        );
        expect(plan?.shapes.some((shape) => shape.captures.some((type) => type.kind === "boxed"))).toBe(true);
        const cells = result.run.emitted.module.types
          .flatMap((type) => (type.kind === "rec" ? type.types : [type]))
          .filter((type) => type.kind === "struct" && type.name === "__ref_cell_f64");
        expect(cells).toHaveLength(1);
        expect(cells[0]).toMatchObject({ fields: [{ name: "value", type: { kind: "f64" }, mutable: true }] });
        const operations: string[] = [];
        for (const fn of result.run.emitted.module.functions)
          walkInstructions(fn.body, (instruction) => {
            operations.push(instruction.op);
          });
        expect(operations).toContain("struct.new");
        expect(operations).toContain("struct.get");
        expect(operations).toContain("struct.set");
        expect(result.run.emitted.module.imports).toEqual([]);
        const run = result.run.exports.run;
        if (typeof run !== "function") throw new Error("actual source run export missing");
        const expected = oracle();
        for (const seed of [-3, 0, 11]) expect(run(seed)).toBe(expected(seed));
      });

  it("replays actual mutable cells in a fresh process without TypeScript or frontend modules", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
    const root = join(process.cwd(), ".tmp/native-ref-cell-replay");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "child-")),
      encoded = join(directory, "program.json"),
      oraclePath = join(directory, "oracle.json");
    writeFileSync(encoded, encodePreparedIrProgram(program));
    const expected = oracle(),
      calls = [-3, 0, 11].map((seed) => ({ export: "run", args: [seed], expected: expected(seed) }));
    writeFileSync(oraclePath, JSON.stringify({ targets: [{ backend: "wasmgc", target: "standalone" }], calls }));
    const args = [
      "--max-old-space-size=4096",
      "--import",
      "tsx",
      "scripts/ir-whole-program-replay.mjs",
      encoded,
      oraclePath,
    ];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(
      join(directory, "replay.json"),
      JSON.stringify({ args, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
    );
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(report.ok).toBe(true);
    expect(report.reencodedIdentical).toBe(true);
    expect(report.frontendModules).toEqual([]);
    expect(report.typescriptModules).toEqual([]);
    expect(report.failures).toEqual([]);
    const target = report.targets["wasmgc:standalone"];
    expect(target.kind).toBe("ran");
    expect(target.emittedUnits).toBe(target.projectionUnits);
    expect(target.emittedUnits).toBeGreaterThan(1);
    expect(target.rows).toHaveLength(calls.length);
    expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
  });
});
