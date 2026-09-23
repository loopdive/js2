// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitBinary } from "../src/emit/binary.js";
import {
  acceptPreparedIrProgram,
  acceptedPhysicalSetupPlan,
  emitAcceptedIrProgram,
  emittedProgramBindingIndex,
} from "../src/ir/program-consumer.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const source = `
function join(a: string, b: string): string { return a + b; }
export function run(): void {
  console.log(join("first", " line"));
  console.log(join("é", "😀"));
  console.log(join("", "third"));
  console.log(join("fourth", ""));
}`;
function prepare(text: string, gvn: boolean, asyncFamily = false) {
  vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": text }),
      policy,
      nativeStringValueProjection: "standalone-native",
      ...(asyncFamily
        ? ({ promiseDelayProjection: "standalone-native", asyncFamilyProjection: "standalone-native" } as const)
        : ({ nativeStringOutputProjection: "standalone-native" } as const)),
    }),
  );
}
function output(exports: WebAssembly.Exports): string {
  const prepare = exports.__stdout_prepare as () => number;
  const char = exports.__stdout_char as (index: number) => number;
  expect(typeof prepare).toBe("function");
  expect(typeof char).toBe("function");
  const length = prepare();
  return Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join("");
}
afterEach(async () => {
  vi.unstubAllEnvs();
  // Let the worker report completed synchronous Wasm cases before the next one.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("prepared source string output through the actual consumer", () => {
  for (const gvn of [false, true])
    for (const decoded of [false, true])
      for (const utf8Storage of [false, true])
        for (const emptyIdentity of [false, true]) {
          it(`runs four exact lines with no numeric runtime, GVN=${gvn}, decoded=${decoded}, UTF8=${utf8Storage}, identity=${emptyIdentity}`, () => {
            const original = prepare(source, gvn);
            const encoded = encodePreparedIrProgram(original);
            const program = decoded ? decodePreparedIrProgram(encoded) : original;
            expect(encodePreparedIrProgram(program)).toEqual(encoded);
            const phases: string[] = [];
            const stop = subscribePreparedIrProgram((event) => {
              if (event.program === program) phases.push(event.phase);
            });
            try {
              const accepted = acceptPreparedIrProgram(program, {
                ...replayOptions("wasmgc", "standalone"),
                utf8Storage,
                stringConcatEmptyIdentity: emptyIdentity,
              });
              if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
              const plan = acceptedPhysicalSetupPlan(accepted);
              const native = plan.nativeStrings;
              if (!native || native.resources.mode === "formatter-layout")
                throw new Error("missing actual string resources");
              expect(native.resources.mode).toBe("literals");
              expect(native.resources.output?.stdout).toBe(true);
              expect(native.resources.output?.options.emptyIdentity).toBe(emptyIdentity);
              expect(
                native.resources.declarations.some(
                  (row) => row.role[0] === "values" || row.role[0] === "string-number",
                ),
              ).toBe(false);
              expect(
                native.resources.declarations.filter((row) => row.role[0] === "flatten" && row.role[1] === "flatten"),
              ).toHaveLength(1);
              expect(plan.nativeNumberFormat).toBeUndefined();
              const emitted = emitAcceptedIrProgram(accepted);
              expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
              expect(emitted.emittedUnitIds.length).toBeGreaterThanOrEqual(2);
              expect(emitted.module.imports).toEqual([]);
              for (const binding of native.bindings)
                expect(emittedProgramBindingIndex(emitted, binding.entry.id)).toBeDefined();
              const bytes = emitBinary(emitted.module);
              expect(bytes.byteLength).toBeGreaterThan(100);
              const module = new WebAssembly.Module(bytes as BufferSource);
              for (let fresh = 0; fresh < 2; fresh++) {
                const exports = new WebAssembly.Instance(module, {}).exports;
                expect(output(exports)).toBe("");
                (exports.run as () => void)();
                expect(output(exports)).toBe("first line\né😀\nthird\nfourth\n");
                expect(output(exports)).toBe("first line\né😀\nthird\nfourth\n");
              }
              expect(phases).toEqual(["accepted", "emission-started", "emitted"]);
            } finally {
              stop();
            }
          });
        }
  it.each(["__stdout_prepare", "__stdout_char"])("rejects conflicting source export %s before emission", (name) => {
    const program = prepare(
      `export function run(): void { console.log("line"); } export function ${name}(): number { return 42; }`,
      false,
    );
    const phases: string[] = [];
    const stop = subscribePreparedIrProgram((event) => {
      if (event.program === program) phases.push(event.phase);
    });
    try {
      const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
      expect(accepted.kind).toBe("unsupported");
      if (accepted.kind !== "unsupported") throw new Error("output export collision was admitted");
      expect(accepted.detail).toContain(`export ${name} is declared twice`);
      expect(phases).toEqual([]);
    } finally {
      stop();
    }
  });
  it.each([
    "export function run(): void { console.log(42); }",
    'export function run(console: number): void { console.log("line"); }',
    'export function run(): void { console.log("a", "b"); }',
    'export function run(): void { console.log?.("line"); }',
  ])("keeps unsupported console shape explicit: %s", (text) => {
    const result = prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": text }),
      policy,
      nativeStringOutputProjection: "standalone-native",
    });
    expect(result.kind).toBe("unsupported");
  });
  it("replays real output in a fresh frontend-free child and detects a forbidden import", () => {
    const program = prepare('export function run(): number { console.log("é😀"); return 42; }', false);
    const directory = mkdtempSync(join(tmpdir(), "ir-output-consumer-replay-"));
    const encoded = join(directory, "program.json");
    const oracle = join(directory, "oracle.json");
    writeFileSync(encoded, encodePreparedIrProgram(program));
    const line = "é😀\n";
    const calls = [
      { export: "run", args: [], expected: 42 },
      { export: "__stdout_prepare", args: [], expected: line.length },
      ...Array.from({ length: line.length }, (_, index) => ({
        export: "__stdout_char",
        args: [index],
        expected: line.charCodeAt(index),
      })),
      { export: "__stdout_prepare", args: [], expected: line.length },
    ];
    writeFileSync(oracle, JSON.stringify({ targets: [{ backend: "wasmgc", target: "standalone" }], calls }));
    for (const forbidden of [false, true]) {
      const args = [
        "--experimental-wasm-exnref",
        "--max-old-space-size=4096",
        "--import",
        "tsx",
        "scripts/ir-whole-program-replay.mjs",
        encoded,
        oracle,
        ...(forbidden ? ["--probe-forbidden-import"] : []),
      ];
      const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
      writeFileSync(
        join(directory, forbidden ? "forbidden.json" : "replay.json"),
        JSON.stringify({
          args,
          status: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        }),
      );
      if (child.error) throw child.error;
      expect(child.signal).toBeNull();
      expect(child.status).toBe(forbidden ? 1 : 0);
      const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
      const target = report.targets["wasmgc:standalone"];
      expect(target.kind).toBe("ran");
      expect(target.emittedUnits).toBeGreaterThan(0);
      expect(target.emittedUnits).toBe(target.projectionUnits);
      expect(target.rows).toHaveLength(calls.length);
      expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
      expect(report.loadedModuleCount).toBeGreaterThan(20);
      expect(report.ok).toBe(!forbidden);
      if (forbidden) expect(report.typescriptModules.length).toBeGreaterThan(0);
      else {
        expect(report.typescriptModules).toEqual([]);
        expect(report.frontendModules).toEqual([]);
        expect(report.failures).toEqual([]);
      }
    }
  });
  it("retains the unchanged full async family and reports the next gap before emission", () => {
    const text = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915",
    );
    const program = prepare(text, false, true);
    expect(program.inventory.allUnits).toHaveLength(7);
    expect(program.inventory.terminalUnits).toHaveLength(5);
    expect(program.runtime[0]!.prepared.functions).toHaveLength(16);
    const phases: string[] = [];
    const stop = subscribePreparedIrProgram((event) => {
      if (event.program === program) phases.push(event.phase);
    });
    try {
      const accepted = acceptPreparedIrProgram(program, {
        ...replayOptions("wasmgc", "standalone"),
        numberFormat: { integerBeforeScratch: true },
      });
      expect(accepted.kind).toBe("unsupported");
      if (accepted.kind !== "unsupported") throw new Error("full async family needs its complete execution proof");
      expect(accepted.detail).not.toContain("string.concat has no native string value resource join");
      expect(accepted.detail).toMatch(/async|promise|scheduler/);
      expect(phases).toEqual([]);
    } finally {
      stop();
    }
  });
});
