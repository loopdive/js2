// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspectPreparedClassCopy } from "./helpers/prepared-class-inspector.js";
import { expect, it } from "vitest";
import { CLASS_ALLOCATION_SOURCE, prepareClassAllocationProgram } from "./helpers/prepared-class-values.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";

for (const decoded of [false, true])
  it(`executes the actual class allocation in a complete Prepared program, decoded=${decoded}`, async () => {
    const original = prepareClassAllocationProgram(),
      encoded = encodePreparedIrProgram(original);
    const program = decoded ? decodePreparedIrProgram(encoded) : original;
    expect(encodePreparedIrProgram(program)).toBe(encoded);
    const result = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (result.kind !== "ran") throw Error(JSON.stringify(result.failure));
    const { run } = result;
    const plan = acceptedPhysicalSetupPlan(run.accepted);
    expect(plan.classValues?.occurrences.length).toBeGreaterThan(0);
    expect(plan.classValues?.bindings).toHaveLength(1);
    expect(run.emitted.module.imports).toEqual([]);
    expect(run.emitted.emittedUnitIds).toEqual(run.accepted.runtime.prepared.functions.map((fn) => fn.unitId));
    const { make, invoke, stub } = run.exports;
    if (typeof make !== "function" || typeof invoke !== "function" || typeof stub !== "function")
      throw Error("missing actual exports");
    const first = make(1),
      second = make(2);
    expect(Object.is(first, second)).toBe(false);
    expect(invoke(first, 9)).toBe(-99);
    expect(invoke(second, 9)).toBe(-99);
    expect(invoke(first, 8)).toBe(-99);
    expect(invoke(stub(), 1)).toBe(-99);
    // These probes inspect a new instance of an explicitly instrumented COPY.
    const inspected = await inspectPreparedClassCopy(run.emitted.module);
    const call = (name: string, ...args: unknown[]): unknown => {
      const fn = inspected[name];
      if (typeof fn !== "function") throw Error("missing probe " + name);
      return fn(...args);
    };
    const global = (name: string): WebAssembly.Global => {
      const value = inspected[name];
      if (!(value instanceof WebAssembly.Global)) throw Error("missing actual global " + name);
      return value;
    };
    const a = call("make", 1),
      b = call("make", 2),
      constructA = call("inspectConstruct", a),
      constructB = call("inspectConstruct", b);
    expect(call("invoke", constructA, 9)).toBe(10);
    expect(call("invoke", constructB, 9)).toBe(11);
    expect(call("invoke", constructA, 8)).toBe(9);
    const realm = call("inspectKernelRealm", null),
      prototype = call("inspectKernelPrototype", null);
    expect(realm).not.toBeNull();
    expect(prototype).not.toBeNull();
    expect(Object.is(call("inspectClassRealm", a), realm)).toBe(true);
    expect(Object.is(call("inspectClassRealm", b), realm)).toBe(true);
    expect(Object.is(call("inspectSourceRealm", constructA), realm)).toBe(true);
    expect(Object.is(call("inspectSourcePrototype", constructA), prototype)).toBe(true);
    expect(call("inspectClassParent", a)).toBeNull();
    // Test-only reset of the canonical bootstrap proves old allocations retain
    // identity while later allocations receive the actual new bootstrap values.
    global("inspectKernelState").value = 0;
    const c = call("make", 3),
      constructC = call("inspectConstruct", c),
      newRealm = call("inspectKernelRealm", null);
    expect(Object.is(newRealm, realm)).toBe(false);
    expect(Object.is(call("inspectClassRealm", c), newRealm)).toBe(true);
    expect(Object.is(call("inspectSourceRealm", constructC), newRealm)).toBe(true);
    expect(Object.is(call("inspectSourcePrototype", constructC), call("inspectKernelPrototype", null))).toBe(true);
    expect(Object.is(call("inspectClassRealm", a), realm)).toBe(true);
    expect(Object.is(call("inspectSourcePrototype", constructA), prototype)).toBe(true);
    expect(call("invoke", constructA, 9)).toBe(10);
    expect(call("invoke", constructC, 9)).toBe(12);
  });

it("replays class allocation in a guarded fresh process without the frontend", () => {
  const program = prepareClassAllocationProgram(),
    directory = mkdtempSync(join(process.cwd(), ".tmp/class-prepared-replay-"));
  const encoded = join(directory, "program.json"),
    oracle = join(directory, "oracle.json");
  writeFileSync(encoded, encodePreparedIrProgram(program));
  const calls = [-2, 0, 1, 37].map((seed) => ({ export: "run", args: [seed], expected: -99 }));
  writeFileSync(oracle, JSON.stringify({ targets: [{ backend: "wasmgc", target: "standalone" }], calls }));
  const args = ["--max-old-space-size=4096", "--import", "tsx", "scripts/ir-whole-program-replay.mjs", encoded, oracle];
  const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
  );
  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(report.ok).toBe(true);
  expect(report.reencodedIdentical).toBe(true);
  expect(report.loadedModuleCount).toBeGreaterThan(0);
  expect(report.frontendModules).toEqual([]);
  expect(report.typescriptModules).toEqual([]);
  expect(report.failures).toEqual([]);
  const target = report.targets["wasmgc:standalone"];
  expect(target.kind).toBe("ran");
  expect(target.emittedUnits).toBe(target.projectionUnits);
  expect(target.emittedUnits).toBe(
    program.runtime.find((row) => row.backend === "wasmgc" && row.target === "standalone")!.prepared.functions.length,
  );
  expect(target.rows).toHaveLength(calls.length);
  expect(target.rows.every((row: { match: boolean }) => row.match)).toBe(true);
});

it("allocates class values without selecting an indirect-call invocation resource", async () => {
  const source = CLASS_ALLOCATION_SOURCE.slice(0, CLASS_ALLOCATION_SOURCE.indexOf("export function invoke"));
  const program = prepareClassAllocationProgram(source);
  const result = await replayProgram(program, replayOptions("wasmgc", "standalone"));
  if (result.kind !== "ran") throw Error(JSON.stringify(result.failure));
  expect(acceptedPhysicalSetupPlan(result.run.accepted).nativeInvocation).toBeUndefined();
  expect(result.run.emitted.module.imports).toEqual([]);
  expect(result.run.emitted.emittedUnitIds).toHaveLength(program.runtime[0]!.prepared.functions.length);
  const make = result.run.exports.make;
  if (typeof make !== "function") throw Error("missing actual allocation export");
  expect(Object.is(make(3), make(4))).toBe(false);
});
