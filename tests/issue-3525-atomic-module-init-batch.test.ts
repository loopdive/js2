// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, WasmModule } from "../src/ir/types.js";
import { compileMulti, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

import "../src/codegen/expressions.js";

const OPTIONS = {
  experimentalIR: true,
  nativeStrings: true,
  target: "standalone" as const,
  trackIrOutcomes: true,
};

function generate(files: Record<string, string>) {
  return generateMultiModule(analyzeMultiSource(files, "./entry.ts"), OPTIONS);
}

/**
 * Test-only copy of the generated module-init graph.  The production module
 * remains untouched: an owned clone appends an i32 decimal trace to each
 * adapter block, then exposes the same adapter under a test export.  This
 * makes startup order and duplicate execution observable without adding a
 * runtime trace or changing the production ABI.
 */
function instrumentedBatchModule(generated: ReturnType<typeof generate>, order: readonly number[]): WasmModule {
  const module = structuredClone(generated.module);
  // `generateMultiModule` returns backend IR before the public compiler's
  // shared defaultability normalization. Apply that pass to this owned test
  // copy so its emitted binary is valid without changing production state.
  widenNonDefaultableTypes(module);
  const adapter = module.functions.find((fn) => fn.name === "__ir_r5_m2p2a_module_init_adapter");
  if (!adapter) throw new Error("missing P2A graph adapter");
  const sourceBlocks = adapter.body;
  if (sourceBlocks.some((instruction) => instruction.op !== "block")) {
    throw new Error("P2A graph adapter is not a flat block sequence");
  }

  const importedGlobals = module.imports.filter((entry) => entry.desc.kind === "global").length;
  const traceGlobal = importedGlobals + module.globals.length;
  module.globals.push({
    name: "__test_p2a_trace",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  module.exports.push({ name: "__test_p2a_trace", desc: { kind: "global", index: traceGlobal } });

  const traceFor = (digit: number): Instr[] => [
    { op: "global.get", index: traceGlobal },
    { op: "i32.const", value: 10 },
    { op: "i32.mul" },
    { op: "i32.const", value: digit },
    { op: "i32.add" },
    { op: "global.set", index: traceGlobal },
  ];
  const tracedBlocks = order.map((sourceIndex) => {
    const source = sourceBlocks[sourceIndex];
    if (!source || source.op !== "block") throw new Error(`missing P2A source block ${sourceIndex}`);
    return { ...source, body: [...source.body, ...traceFor(sourceIndex + 1)] };
  });
  adapter.body = tracedBlocks;

  const adapterPosition = module.functions.indexOf(adapter);
  if (adapterPosition < 0) throw new Error("P2A graph adapter lost from module");
  const stableOrdinal = module.funcOrdinalToPosition.indexOf(adapterPosition);
  const adapterHandle =
    stableOrdinal >= 0
      ? STABLE_FUNC_BASE + stableOrdinal
      : module.imports.filter((entry) => entry.desc.kind === "func").length + adapterPosition;
  module.exports.push({ name: "__test_p2a_adapter", desc: { kind: "func", index: adapterHandle } });
  return module;
}

function instantiateInstrumentedBatch(
  generated: ReturnType<typeof generate>,
  order: readonly number[],
): WebAssembly.Exports {
  const module = new WebAssembly.Module(emitBinary(instrumentedBatchModule(generated, order)));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module, {}).exports;
}

function moduleInitOutcomes(result: CompileResult) {
  return result.irOutcomes?.filter((outcome) => outcome.unitKind === "module-init") ?? [];
}

afterEach(() => vi.unstubAllEnvs());

describe("#3525 M2-P2A atomic module-init batch", () => {
  it("builds two initializers once, in census order, before the exported read", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    const files = {
      "./a.ts": `let countA: number = 0; countA = countA + 1; export { countA };`,
      "./b.ts": `let countB: number = 10; countB = countB + 1; export { countB };`,
      "./entry.ts": `import { countA } from "./a"; import { countB } from "./b";
        export function run(): number { return countA * 100 + countB; }`,
    };
    const generated = generate(files);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit?.moduleInit;
    expect(audit).toMatchObject({
      executablePlanCount: 2,
      directCompileModuleInitBodyRoots: 0,
      irBodyEmissions: 2,
      invocationKind: "wasm-start",
    });
    expect(audit?.contributorSourceIds).toEqual([
      expect.stringContaining(":source:a.ts"),
      expect.stringContaining(":source:b.ts"),
    ]);
    expect(audit?.resourceArtifactUnitIds).toEqual(audit?.contributorUnitIds);
    expect(audit?.preparedComponentIds).toHaveLength(2);

    const result = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await instantiateWithRuntime(result);
    const run = instance.exports.run as () => number;
    // The production result keeps its source values stable across exported
    // calls.  The owned Wasm copy below observes the detached adapter itself:
    // startup is 12, a second explicit adapter call is 1212, reversed order
    // is 21, and a duplicated body is 1122.
    expect(run()).toBe(111);
    expect(run()).toBe(111);
    expect(moduleInitOutcomes(result).filter((outcome) => outcome.kind === "emitted")).toHaveLength(2);

    const startup = instantiateInstrumentedBatch(generated, [0, 1]);
    const trace = startup.__test_p2a_trace as WebAssembly.Global;
    expect(trace.value).toBe(12);
    (startup.__test_p2a_adapter as () => void)();
    expect(trace.value).toBe(1212);

    const reversed = instantiateInstrumentedBatch(generated, [1, 0]);
    expect((reversed.__test_p2a_trace as WebAssembly.Global).value).toBe(21);

    const duplicated = instantiateInstrumentedBatch(generated, [0, 0, 1, 1]);
    expect((duplicated.__test_p2a_trace as WebAssembly.Global).value).toBe(1122);
    expect((duplicated.__test_p2a_trace as WebAssembly.Global).value).not.toBe(1212);
  }, 120_000);

  it("retains every source storage gap and publishes no direct-init prefix", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    const files = {
      "./a.ts": `let left: string = "a"; export { left };`,
      "./b.ts": `let right: string = "b"; export { right };`,
      "./entry.ts": `export interface EntryMarker { readonly kind: "entry"; }`,
    };
    const generated = generate(files);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(generated.multiPreparedProgramAudit?.moduleInit).toBeUndefined();
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);
    const gaps = generated.multiPreparedProgramAudit?.moduleInitPreclaimGaps ?? [];
    expect(gaps).toHaveLength(2);
    expect(gaps.map(({ sourceId }) => sourceId)).toEqual([
      expect.stringContaining(":source:a.ts"),
      expect.stringContaining(":source:b.ts"),
    ]);
    expect(
      gaps.every(({ gaps: sourceGaps }) => sourceGaps.some((gap) => gap.includes("missing-or-unproven-value"))),
    ).toBe(true);

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
    const poisoned = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(poisoned.success).toBe(false);
    expect(poisoned.binary).toHaveLength(0);
    expect(moduleInitOutcomes(poisoned)).toEqual([
      expect.objectContaining({ file: "a.ts", kind: "invariant", stage: "build" }),
      expect.objectContaining({ file: "b.ts", kind: "invariant", stage: "build" }),
    ]);
    expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct module-init body poison",
    );
  }, 120_000);

  it("keeps a non-scalar late-resource initializer out of P2A admission", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    // The update prevents the array expression from becoming a constant-folded
    // literal control.  The current selector rejects this shape before P2A's
    // storage/resource transaction, so no reservation can be inferred from a
    // later direct result.
    const files = {
      "./a.ts": `let seed: number = 10; seed += 1; let value: number = [seed, 2][0]; export { value };`,
      "./b.ts": `let other: number = 20; other = other + 2; export { other };`,
      "./entry.ts": `export interface EntryMarker { readonly kind: "entry"; }`,
    };
    const generated = generate(files);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    expect(generated.multiPreparedProgramAudit?.moduleInit).toBeUndefined();
    expect(generated.multiPreparedProgramAudit?.bodyPlan.reservations).toEqual([]);

    const direct = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleInitOutcomes(direct).filter((outcome) => outcome.kind === "emitted")).toEqual([]);
    expect(moduleInitOutcomes(direct).filter((outcome) => outcome.kind === "unsupported")).toHaveLength(2);

    vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
    const poisoned = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(poisoned.success).toBe(false);
    expect(poisoned.binary).toHaveLength(0);
    expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct module-init body poison",
    );
  }, 120_000);

  it("retains TDZ-backed direct reads while the ordered batch runs once", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    const files = {
      "./a.ts": `export function readA(): number { return left; }
        let left: number = 1; left = left + 1;`,
      "./b.ts": `export function readB(): number { return right; }
        let right: number = 2; right = right + 2;`,
      "./entry.ts": `import { readA } from "./a"; import { readB } from "./b";
        export function run(): number { return readA() + readB(); }`,
    };
    const generated = generate(files);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const audit = generated.multiPreparedProgramAudit?.moduleInit;
    expect(audit).toMatchObject({
      executablePlanCount: 2,
      directCompileModuleInitBodyRoots: 0,
      irBodyEmissions: 2,
      invocationKind: "wasm-start",
    });
    expect(audit?.resourceArtifactUnitIds).toEqual(audit?.contributorUnitIds);

    const result = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(6);
    expect(moduleInitOutcomes(result).filter((outcome) => outcome.kind === "emitted")).toHaveLength(2);
  }, 120_000);

  it("uses one deferred startup export for the complete contributor batch", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");

    const files = {
      "./a.ts": `export function readA(): number { return left; }
        let left: number = 1; left = left + 1;`,
      "./b.ts": `export function readB(): number { return right; }
        let right: number = 2; right = right + 2;`,
      "./entry.ts": `import { readA } from "./a"; import { readB } from "./b";
        export function run(): number { return readA() + readB(); }`,
    };
    const options = { ...OPTIONS, deferTopLevelInit: true };
    const generated = generateMultiModule(analyzeMultiSource(files, "./entry.ts"), options);
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const deferredTrace = instantiateInstrumentedBatch(generated, [0, 1]);
    const trace = deferredTrace.__test_p2a_trace as WebAssembly.Global;
    expect(trace.value).toBe(0);
    (deferredTrace.__test_p2a_adapter as () => void)();
    expect(trace.value).toBe(12);
    (deferredTrace.__test_p2a_adapter as () => void)();
    expect(trace.value).toBe(1212);

    const result = await compileMulti(files, "./entry.ts", options);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await instantiateWithRuntime(result);
    const run = instance.exports.run as () => number;
    expect(() => run()).toThrow();
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
    expect(run()).toBe(6);
    (instance.exports.__module_init as () => void)();
    expect(run()).toBe(6);
    expect(moduleInitOutcomes(result).filter((outcome) => outcome.kind === "emitted")).toHaveLength(2);
  }, 120_000);

  it("aborts every detached initializer when the last terminal or body is stale", async () => {
    vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
    const files = {
      "./a.ts": `let countA: number = 0; countA = countA + 1; export { countA };`,
      "./b.ts": `let countB: number = 10; countB = countB + 1; export { countB };`,
      "./entry.ts": `import { countA } from "./a"; import { countB } from "./b";
        export function run(): number { return countA * 100 + countB; }`,
    };

    vi.stubEnv("JS2WASM_TEST_DROP_IR_TERMINAL", "last");
    const dropped = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(dropped.success).toBe(false);
    expect(dropped.binary).toHaveLength(0);
    expect(dropped.errors.map((error) => error.message).join("\n")).toContain(
      "initializer batch did not produce one exact detached module-init/resource receipt",
    );
    expect(moduleInitOutcomes(dropped).filter((outcome) => outcome.kind === "invariant")).toHaveLength(2);

    vi.stubEnv("JS2WASM_TEST_DROP_IR_TERMINAL", "0");
    vi.stubEnv("JS2WASM_TEST_MUTATE_MULTI_PREPARED_MODULE_INIT_PENDING_BODY", "1");
    const mutated = await compileMulti(files, "./entry.ts", OPTIONS);
    expect(mutated.success).toBe(false);
    expect(mutated.binary).toHaveLength(0);
    expect(mutated.errors.map((error) => error.message).join("\n")).toContain("allocator");
    expect(moduleInitOutcomes(mutated).filter((outcome) => outcome.kind === "emitted")).toHaveLength(0);
  }, 120_000);
});
