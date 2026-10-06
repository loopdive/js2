// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { buildImportManifest } from "../src/compiler/import-manifest.js";
import { emitBinary } from "../src/emit/binary.js";
import { buildImports } from "../src/runtime.js";
import {
  acceptPreparedIrProgram,
  acceptedPhysicalSetupPlan,
  emitAcceptedIrProgram,
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedSupportFunctionReceipts,
} from "../src/ir/program-consumer.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { PreparedIrProgramInvariantError, type EmittedPreparedIrProgram } from "../src/ir/program.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const BACKENDS = ["wasmgc", "linear"] as const;
const POLICIES = BACKENDS.map((backend) => ({ target: "host" as const, backend }));
const SCALAR = {
  "./math.ts": "export function double(value: number): number { return value * 2; }",
  "./entry.ts":
    'import { double } from "./math"; export function calculate(value: number): number { return double(value) + 2; }',
};
const ORIGINAL_MIXED = {
  "./a.ts": "export let left: number = 1; left = left + 1;",
  "./b.ts": "export let right: number = 10; right = right + 2;",
  "./entry.ts":
    '\n    import { left } from "./a";\n    import { right } from "./b";\n    let phase: number = 0;\n    export function initial(): number { return left * 100 + right; }\n    export function readPhase(): number { return phase; }\n    function compute(seed: number): number {\n      let total = 0;\n      for (let i = 0; i < 4; i++) {\n        if (i % 2 === 0) total = total + Math.imul(seed, i + 1);\n        else total = total - i;\n      }\n      return total;\n    }\n    \n  export async function run(seed: number): Promise<number> {\n    phase = 1;\n    const first = await (seed + 1);\n    phase = 2;\n    const second = await compute(first);\n    phase = 3;\n    return second + initial();\n  }\n\n  ',
};
const MIXED_DIGEST = "236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb";

function prepare(files: Record<string, string> = SCALAR, policies = POLICIES) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" },
    runtimePolicies: policies,
    deferTopLevelInit: false,
  });
}

function transaction(backend: (typeof BACKENDS)[number], files: Record<string, string> = SCALAR, policies = POLICIES) {
  const prepared = prepare(files, policies);
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  const accepted = acceptPreparedIrProgram(prepared.program, replayOptions(backend));
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  const plan = acceptedPhysicalSetupPlan(accepted);
  const emitted = emitAcceptedIrProgram(accepted);
  expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
  return { program: prepared.program, accepted, plan, emitted };
}

function deepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    expect("value" in descriptor).toBe(true);
    if ("value" in descriptor) deepFrozen(descriptor.value, seen);
  }
}

function snapshot(value: unknown): string {
  return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, compact: false, sorted: false });
}

function expectInvalid(value: unknown): void {
  let caught: unknown;
  try {
    emittedPhysicalSetupPlan(value as EmittedPreparedIrProgram);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(caught).toMatchObject({
    code: "invalid-transaction-capability",
    message: "program consumer: emission was not produced by this consumer",
  });
}

async function instantiate(emitted: EmittedPreparedIrProgram) {
  const imports = buildImports(buildImportManifest(emitted.module));
  const { instance } = await WebAssembly.instantiate(
    emitBinary(emitted.module),
    imports as unknown as WebAssembly.Imports,
  );
  imports.setInstance?.(instance);
  return instance.exports;
}

function bindingJoins(emitted: EmittedPreparedIrProgram): void {
  const plan = emittedPhysicalSetupPlan(emitted);
  expect(plan.functions.map((slot) => slot.unitId)).toEqual(emitted.emittedUnitIds);
  for (const slot of plan.functions) {
    const index = emittedProgramBindingIndex(emitted, slot.bindingId);
    if (index === undefined) throw new Error("missing authentic physical binding");
    expect(index.space).toBe("function");
    expect(Number.isSafeInteger(index.index)).toBe(true);
    const importedFunctions = emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const definedIndex = index.index - importedFunctions;
    expect(definedIndex).toBeGreaterThanOrEqual(0);
    expect(emitted.module.functions[definedIndex]).toBeDefined();
    expect(emitted.module.functions[definedIndex]!.name).toBe(slot.name);
  }
}

// Mutate an actual numeric constant, not an invented instruction or replacement body.
function numericConstant(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.op === "string" && row.op.endsWith(".const") && typeof row.value === "number") return row;
  for (const child of Object.values(row)) {
    const found = numericConstant(child);
    if (found) return found;
  }
  return undefined;
}

function poison(backend: (typeof BACKENDS)[number], mutation: "body identity" | "nested constant" | "function census") {
  const { emitted, plan } = transaction(backend);
  const binary = emitBinary(emitted.module);
  const index = emittedProgramBindingIndex(emitted, plan.functions[0]!.bindingId);
  if (index === undefined) throw new Error("missing function binding");
  expect(index.space).toBe("function");
  expect(Number.isSafeInteger(index.index)).toBe(true);
  const importedFunctions = emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
  const definedIndex = index.index - importedFunctions;
  expect(definedIndex).toBeGreaterThanOrEqual(0);
  const fn = emitted.module.functions[definedIndex];
  if (!fn) throw new Error("defined source function missing");
  const body = fn.body;
  const functions = [...emitted.module.functions];
  let restore: () => void;
  if (mutation === "body identity") {
    fn.body = [...body];
    expect(fn.body).not.toBe(body);
    restore = () => {
      fn.body = body;
    };
  } else if (mutation === "nested constant") {
    const constant = numericConstant(body);
    if (!constant) throw new Error("genuine scalar constant not found");
    const before = constant.value;
    constant.value = Number(before) + 1;
    restore = () => {
      constant.value = before;
    };
  } else {
    emitted.module.functions.push(fn);
    restore = () => {
      emitted.module.functions.splice(0, emitted.module.functions.length, ...functions);
    };
  }
  try {
    expect(() => emittedPhysicalSetupPlan(emitted)).toThrow(/physical module reservations:/);
  } finally {
    restore();
  }
  expect(fn.body).toBe(body);
  expect(emitted.module.functions).toEqual(functions);
  functions.forEach((original, ordinal) => expect(emitted.module.functions[ordinal]).toBe(original));
  expect(emitBinary(emitted.module)).toEqual(binary);
  expect(() => emittedPhysicalSetupPlan(emitted)).toThrow(
    /physical module reservations: completion requested in failed/,
  );
  const fresh = transaction(backend);
  expect(emittedPhysicalSetupPlan(fresh.emitted)).toBe(fresh.plan);
  expect(fresh.plan).not.toBe(plan);
}

describe("#3525 authentic completed-emission physical plan observation", () => {
  it.each(BACKENDS)("%s scalar retains the accepted deeply frozen plan without new phases", async (backend) => {
    const prepared = prepare();
    if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
    const sourceBefore = snapshot(SCALAR);
    const programBefore = snapshot(prepared.program);
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => {
      if (event.program === prepared.program) phases.push(event.phase);
    });
    try {
      const accepted = acceptPreparedIrProgram(prepared.program, replayOptions(backend));
      if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
      const plan = acceptedPhysicalSetupPlan(accepted);
      const emitted = emitAcceptedIrProgram(accepted);
      const before = snapshot(emitted.module);
      const functions = [...emitted.module.functions];
      const binary = emitBinary(emitted.module);
      for (let read = 0; read < 3; read++) expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
      deepFrozen(plan);
      bindingJoins(emitted);
      expect(snapshot(emitted.module)).toBe(before);
      functions.forEach((fn, index) => expect(emitted.module.functions[index]).toBe(fn));
      expect(emitBinary(emitted.module)).toEqual(binary);
      expect(snapshot(prepared.program)).toBe(programBefore);
      expect(snapshot(SCALAR)).toBe(sourceBefore);
      expect(phases).toEqual(["accepted", "emission-started", "emitted"]);
      expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
      expect(phases).toEqual(["accepted", "emission-started", "emitted"]);
      const exports = await instantiate(emitted);
      const calculate = exports.calculate;
      if (typeof calculate !== "function") throw new Error("calculate export missing");
      expect(calculate(20)).toBe(42);
      expect(calculate(-3)).toBe(-4);
    } finally {
      unsubscribe();
    }
  });

  it("original mixed WasmGC plan joins real async frames, callbacks and distinct owner populations", () => {
    expect(createHash("sha256").update(JSON.stringify(ORIGINAL_MIXED)).digest("hex")).toBe(MIXED_DIGEST);
    const { program, accepted, emitted, plan } = transaction("wasmgc", ORIGINAL_MIXED, [
      { target: "host", backend: "wasmgc" },
    ]);
    expect(program.inventory.sources).toHaveLength(3);
    expect(program.inventory.terminalUnits).toHaveLength(7);
    expect(emitted.emittedUnitIds).toHaveLength(14);
    expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
    const terminals = new Set(program.inventory.terminalUnits.map((unit) => unit.id));
    expect(emitted.emittedUnitIds.filter((id) => terminals.has(id))).toHaveLength(7);
    expect(emitted.module.functions.length).toBeGreaterThan(14);
    expect(plan.asyncFrames?.frames.length).toBeGreaterThan(0);
    expect(plan.asyncFrames?.entries.length).toBeGreaterThan(0);
    const callbacks = plan.asyncFrames!.frames.flatMap((frame) => frame.callbacks);
    expect(callbacks.length).toBeGreaterThan(0);
    for (const callback of callbacks) {
      const entries = plan.asyncFrames!.entries.filter((entry) => entry.id === callback.entry.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(callback.entry);
      expect(callback.entry.aliasOf).toBe(callback.targetBindingId);
      expect(callback.entry.intent).toEqual({
        kind: "export",
        externalName: callback.externalName,
        targetId: callback.targetBindingId,
      });
      const target = emittedProgramBindingIndex(emitted, callback.targetBindingId);
      const alias = emittedProgramBindingIndex(emitted, callback.entry.id);
      if (!target || !alias) throw new Error("callback ABI binding missing");
      expect(target.space).toBe("function");
      expect(Number.isSafeInteger(target.index)).toBe(true);
      expect(alias).toEqual(target);
      expect(emitted.module.exports).toContainEqual({
        name: callback.externalName,
        desc: { kind: "func", index: target.index },
      });
    }
    const before = snapshot(emitted.module);
    const binary = emitBinary(emitted.module);
    expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
    expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
    deepFrozen(plan);
    bindingJoins(emitted);
    expect(snapshot(emitted.module)).toBe(before);
    expect(emitBinary(emitted.module)).toEqual(binary);
    expect(emittedSupportFunctionReceipts(emitted).length).toBeGreaterThan(0);
  });

  it("original mixed Linear preparation retains the located genuine refusal", () => {
    const result = prepare(ORIGINAL_MIXED);
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("mixed Linear refusal missing");
    expect(result.detail).toMatch(/promise\.capability\.create has no linear adapter/);
    expect(result.sourceFile).toBe("entry.ts");
  });

  it.each([undefined, null, false, 0, "emission"])("rejects primitive capability %s", (value) => expectInvalid(value));
  it("rejects shaped getter-bomb without reading module", () => {
    let reads = 0;
    expectInvalid({
      get module() {
        reads++;
        throw new Error("forged module executed");
      },
    });
    expect(reads).toBe(0);
  });
  it("rejects spread, proxy and incomplete accepted capability with a genuine positive witness", () => {
    const { emitted, accepted, plan } = transaction("wasmgc");
    expectInvalid({ ...emitted });
    expectInvalid(new Proxy(emitted, {}));
    expectInvalid(accepted);
    expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
  });
  it("distinct genuine transactions return their own plans, not another program's plan", () => {
    const first = transaction("wasmgc");
    const second = transaction("wasmgc");
    expect(first.program).not.toBe(second.program);
    expect(first.plan).not.toBe(second.plan);
    expect(emittedPhysicalSetupPlan(first.emitted)).toBe(first.plan);
    expect(emittedPhysicalSetupPlan(second.emitted)).toBe(second.plan);
    expect(emittedPhysicalSetupPlan(second.emitted)).not.toBe(first.plan);
  });
  it.each(BACKENDS)("%s frozen plan mutation refuses and leaves original plan and binary intact", (backend) => {
    const { plan, emitted } = transaction(backend);
    const before = snapshot(plan);
    const binary = emitBinary(emitted.module);
    expect(() => Object.defineProperty(plan, "backend", { value: "forged" })).toThrow(TypeError);
    expect(() => Object.defineProperty(plan.functions, "0", { value: null })).toThrow(TypeError);
    expect(Reflect.defineProperty(plan.functions, "0", { value: null })).toBe(false);
    expect(snapshot(plan)).toBe(before);
    expect(emittedPhysicalSetupPlan(emitted)).toBe(plan);
    expect(emitBinary(emitted.module)).toEqual(binary);
  });
  for (const backend of BACKENDS) {
    it.each(["body identity", "nested constant", "function census"] as const)(
      `${backend} %s permanently poisons only that emission after exact restoration`,
      (mutation) => poison(backend, mutation),
    );
  }
});
