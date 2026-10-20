// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, beforeAll } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  encodePreparedIrProgram,
  decodePreparedIrProgram,
  assertPreparedIrProgramShape,
} from "../src/ir/program-codec.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";

const standalone = { backend: "wasmgc", target: "standalone" } as const;
const linearStandalone = { backend: "linear", target: "standalone" } as const;
const wasi = { backend: "linear", target: "wasi" } as const;
const gcWasi = { backend: "wasmgc", target: "wasi" } as const;
function input(source: string) {
  const ast = analyzeMultiSource({ "entry.ts": source }, "entry.ts");
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: standalone,
    deferTopLevelInit: false,
  };
}
let program: PreparedIrProgram;
let bytes: string;
beforeAll(() => {
  const result = prepareWholeIrProgram(
    input("export var value: number = 1; export function run(): number { return value; }"),
  );
  if (result.kind !== "prepared") throw new Error(result.detail);
  program = result.program;
  bytes = encodePreparedIrProgram(program);
});

describe("semantic startup intent survives DATA and all requested runtime policies", () => {
  it("round-trips the actual producer's boolean without inventing a source-origin requirement", () => {
    expect(program.startup[0]!.invocation).toEqual({
      target: "standalone",
      kind: "wasm-start",
      deferTopLevelInit: false,
      exactlyOnce: true,
    });
    const replay = decodePreparedIrProgram(bytes);
    expect(encodePreparedIrProgram(replay)).toBe(bytes);
    expect(replay.startup[0]!.invocation.deferTopLevelInit).toBe(false);
  });
  const corruptions = [
    [
      "missing defer",
      (row: Record<string, unknown>) => {
        Reflect.deleteProperty(row, "deferTopLevelInit");
      },
    ],
    [
      "nonboolean defer",
      (row: Record<string, unknown>) => {
        row.deferTopLevelInit = "false";
      },
    ],
    [
      "defer/kind contradiction",
      (row: Record<string, unknown>) => {
        row.deferTopLevelInit = true;
      },
    ],
    [
      "target/kind contradiction",
      (row: Record<string, unknown>) => {
        row.target = "wasi";
      },
    ],
    [
      "not exactly once",
      (row: Record<string, unknown>) => {
        row.exactlyOnce = false;
      },
    ],
    [
      "unexpected invocation field",
      (row: Record<string, unknown>) => {
        row.permission = true;
      },
    ],
  ] as const;
  it.each(corruptions)("rejects %s in shape, complete validation, and decode", (_label, change) => {
    const invocation: Record<string, unknown> = { ...program.startup[0]!.invocation };
    change(invocation);
    const forged = { ...program, startup: [{ ...program.startup[0]!, invocation }] } as unknown as PreparedIrProgram;
    expect(() => assertPreparedIrProgramShape(forged)).toThrow(/startup invocation/);
    expect(() => assertPreparedIrProgram(forged)).toThrow(/startup invocation/);
    const envelope = JSON.parse(bytes);
    change(envelope.program.startup[0].invocation);
    expect(() => decodePreparedIrProgram(JSON.stringify(envelope))).toThrow(/startup invocation/);
  });
  it("does not invoke an accessor masquerading as semantic defer DATA", () => {
    let reads = 0;
    const invocation = { ...program.startup[0]!.invocation };
    Object.defineProperty(invocation, "deferTopLevelInit", {
      get: () => {
        reads++;
        return false;
      },
    });
    const forged = { ...program, startup: [{ ...program.startup[0]!, invocation }] };
    expect(() => assertPreparedIrProgramShape(forged)).toThrow(/own DATA/);
    expect(reads).toBe(0);
  });
  it.each([
    ["one automatic projection", [standalone], false, 0],
    ["both automatic backends", [standalone, linearStandalone], false, 0],
    ["Linear WASI alongside standalone", [standalone, wasi], false, 1],
    ["WasmGC WASI alongside standalone", [standalone, gcWasi], false, 1],
    ["semantic deferral", [standalone, linearStandalone], true, 1],
    ["unknown empty projection population", [], false, 1],
  ] as const)("retains exactly the required global TDZ guard for %s", (_label, policies, defer, count) => {
    const source = prepareIrProgramSources({
      ...input("let value: number = 1; export function read(): number { return value; }"),
      runtimePolicies: policies as readonly RuntimeManifestPolicy[],
      deferTopLevelInit: defer,
    });
    if (source.kind !== "prepared") throw new Error(source.detail);
    const read = source.ir.functions.find((fn) => fn.name === "read")!;
    let guards = 0;
    for (const block of read.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (
            instruction.kind === "call" &&
            instruction.target.binding.kind === "runtime" &&
            instruction.target.binding.symbol === "__new_ReferenceError"
          )
            guards++;
        });
    expect(guards).toBe(count);
  });
  it("keeps proven initialized function-local vectors free of fabricated global TDZ demands", () => {
    const source = prepareIrProgramSources({
      ...input(
        "export function run(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }",
      ),
      runtimePolicies: [standalone, linearStandalone, wasi, gcWasi],
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw new Error(source.detail);
    const calls: string[] = [];
    for (const fn of source.ir.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "call" && instruction.target.binding.kind === "runtime")
              calls.push(instruction.target.binding.symbol);
          });
    expect(calls).not.toContain("__new_ReferenceError");
    expect(source.allocations.size).toBe(1);
  });
});
