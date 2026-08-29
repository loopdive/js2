// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, WasmFunction, WasmModule } from "../src/ir/types.js";
import { wrapExports } from "../src/runtime.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";

const CANDIDATE_COUNT = 40;
const CODEGEN_OPTIONS = { standalone: true, nativeStrings: true } as const;
const COMPILE_OPTIONS = { target: "standalone", nativeStrings: true } as const;
const literals = Array.from(
  { length: CANDIDATE_COUNT },
  (_, i) => `const o${i} = { pos: ${i + 1}, key${i}: ${1000 + i} };`,
).join("\n");

const SOURCE = `
${literals}

function getBoxed(o: any): any { return o.pos; }
function getNumber(o: any): number {
  const value: number = o.pos;
  return value;
}
function setBoxed(o: any, value: any): void { o.pos = value; }
function setNumber(o: any, value: number): void { o.pos = value; }

export function probe(): number {
  setNumber(o39, 321);
  setBoxed(o38, 123);
  return getNumber(o39) + getBoxed(o38) + getNumber(o0);
}
`;

function childArrays(instr: Instr): Instr[][] {
  switch (instr.op) {
    case "block":
    case "loop":
    case "try_table":
      return [instr.body];
    case "if":
      return instr.else ? [instr.then, instr.else] : [instr.then];
    case "try":
      return [instr.body, ...instr.catches.map((clause) => clause.body), ...(instr.catchAll ? [instr.catchAll] : [])];
    default:
      return [];
  }
}

function instructionArrayCensus(body: Instr[]): {
  physicalArrays: number;
  physicalInstructions: number;
  multiplyParented: Instr[][];
} {
  const pending = [body];
  const visited = new Set<Instr[]>();
  const parentCounts = new Map<Instr[], number>();
  let physicalInstructions = 0;
  while (pending.length > 0) {
    const instrs = pending.pop()!;
    if (visited.has(instrs)) continue;
    visited.add(instrs);
    physicalInstructions += instrs.length;
    for (const instr of instrs) {
      for (const child of childArrays(instr)) {
        parentCounts.set(child, (parentCounts.get(child) ?? 0) + 1);
        if (!visited.has(child)) pending.push(child);
      }
    }
  }
  return {
    physicalArrays: visited.size,
    physicalInstructions,
    multiplyParented: [...parentCounts.entries()].filter(([, count]) => count > 1).map(([instrs]) => instrs),
  };
}

function instructionArrays(body: Instr[]): Set<Instr[]> {
  const arrays = new Set<Instr[]>();
  const pending = [body];
  while (pending.length > 0) {
    const instrs = pending.pop()!;
    if (arrays.has(instrs)) continue;
    arrays.add(instrs);
    for (const instr of instrs) pending.push(...childArrays(instr));
  }
  return arrays;
}

function namedFunction(mod: WasmModule, name: string): WasmFunction {
  const fn = mod.functions.find((candidate) => candidate.name === name);
  if (!fn) {
    const related = mod.functions
      .filter((candidate) => candidate.name.includes("pos"))
      .map((candidate) => candidate.name);
    throw new Error(`missing generated function ${name}; related: ${related.join(", ")}`);
  }
  return fn;
}

describe("#1058 collision-stamped dispatch ladders stay physical trees", () => {
  let mod: WasmModule;
  let generatedErrors: { severity: string; message: string }[];

  beforeAll(() => {
    const generated = generateModule(analyzeSource(SOURCE, "issue-1058-dispatch-dag.ts"), CODEGEN_OPTIONS);
    mod = generated.module;
    generatedErrors = generated.errors;
  }, 120_000);

  it("uses one continuation edge per generic, f64, and exported getter/setter candidate", () => {
    expect(generatedErrors.filter((error) => error.severity !== "warning")).toEqual([]);

    const names = ["__get_member_pos", "__set_member_pos", "__set_member_pos__f64", "__sget_pos", "__sset_pos"];
    for (const name of names) {
      const census = instructionArrayCensus(namedFunction(mod, name).body);
      expect(census.multiplyParented, `${name} has a shared continuation`).toEqual([]);
      // Forty arms should remain linear in their physical representation. The
      // old two-parent continuation represented >10^12 logical occurrences.
      expect(census.physicalArrays, `${name} array count`).toBeLessThan(1_000);
      expect(census.physicalInstructions, `${name} instruction count`).toBeLessThan(5_000);
    }
  });

  it("gives the native strict and SameValueZero equality helpers distinct instruction trees", () => {
    const strictArrays = instructionArrays(namedFunction(mod, "__host_eq").body);
    const sameValueZeroArrays = instructionArrays(namedFunction(mod, "__same_value_zero").body);
    const sharedArrays = [...strictArrays].filter((body) => sameValueZeroArrays.has(body));

    expect(sharedArrays).toEqual([]);
  });

  it("emits valid Wasm and selects late collision-stamped candidates semantically", async () => {
    widenNonDefaultableTypes(mod);
    const generatedBinary = emitBinary(mod);
    expect(WebAssembly.validate(generatedBinary)).toBe(true);

    const result: any = await compile(SOURCE, {
      ...COMPILE_OPTIONS,
      fileName: "issue-1058-dispatch-dag-runtime.ts",
    });
    expect(result.success, result.errors?.map((error: any) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports: any = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setExports?.(instance.exports);
    const exports = wrapExports(instance.exports, { signatures: result.exportSignatures });
    expect((exports.probe as () => number)()).toBe(445);
  }, 120_000);
});
