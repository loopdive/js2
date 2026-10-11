// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";

const source = `
function make(seed: number): (value: number) => number {
  const captured = seed * 2 + 3;
  return function add(value: number): number { return captured + value; };
}
export function run(seed: number): number {
  const first = make(seed);
  const second = make(seed + 100);
  return first(7) + second(9) + first(-2);
}`;
function prepare(gvn: boolean) {
  vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
  return requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
}
function nativeOracle(): (seed: number) => number {
  const exports: { run?: (seed: number) => number } = {};
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(javascript, { exports }, { timeout: 1000 });
  if (typeof exports.run !== "function") throw new Error("native exact-source oracle lacks run");
  return exports.run;
}
const expected = nativeOracle();
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("real source closure allocation through the prepared consumer", () => {
  for (const gvn of [false, true])
    for (const decoded of [false, true])
      it(`executes independent captures and repeated calls, GVN=${gvn}, decoded=${decoded}`, async () => {
        const original = prepare(gvn),
          bytes = encodePreparedIrProgram(original);
        const program = decoded ? decodePreparedIrProgram(bytes) : original;
        const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
        if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
        const { run } = outcome;
        const plan = acceptedPhysicalSetupPlan(run.accepted);
        expect(plan.sourceClosures?.units.length).toBeGreaterThan(0);
        expect(plan.sourceClosures?.shapes.some((shape) => shape.captures.length > 0)).toBe(true);
        expect(run.emitted.emittedUnitIds).toEqual(run.accepted.runtime.prepared.functions.map((fn) => fn.unitId));
        expect(run.emitted.module.imports).toEqual([]);
        const callable = run.exports.run;
        expect(typeof callable).toBe("function");
        if (typeof callable !== "function") throw new Error("missing actual run export");
        for (const seed of [-2, 0, 1, 37]) expect(callable(seed)).toBe(expected(seed));
      });

  it("replays the actual capturing program with no frontend in a fresh child", () => {
    const program = prepare(false);
    const directory = mkdtempSync(join(tmpdir(), "ir-source-closure-replay-"));
    const encoded = join(directory, "program.json"),
      oracle = join(directory, "oracle.json");
    writeFileSync(encoded, encodePreparedIrProgram(program));
    const calls = [-2, 0, 1, 37].map((seed) => ({ export: "run", args: [seed], expected: expected(seed) }));
    writeFileSync(oracle, JSON.stringify({ targets: [{ backend: "wasmgc", target: "standalone" }], calls }));
    const args = [
      "--max-old-space-size=4096",
      "--import",
      "tsx",
      "scripts/ir-whole-program-replay.mjs",
      encoded,
      oracle,
    ];
    const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(
      join(directory, "replay.json"),
      JSON.stringify({ args, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
    );
    if (child.error) throw child.error;
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(report.ok).toBe(true);
    expect(report.reencodedIdentical).toBe(true);
    expect(report.typescriptModules).toEqual([]);
    expect(report.frontendModules).toEqual([]);
    expect(report.failures).toEqual([]);
    const target = report.targets["wasmgc:standalone"];
    expect(target.kind).toBe("ran");
    expect(target.emittedUnits).toBe(target.projectionUnits);
    expect(target.emittedUnits).toBeGreaterThan(2);
    expect(target.rows).toHaveLength(calls.length);
    expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
  });
});
