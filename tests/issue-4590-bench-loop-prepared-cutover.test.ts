// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import binaryen from "binaryen";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule, type GeneratedCodegenModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compileMulti, compileProject, type CompileOptions, type CompileResult } from "../src/index.js";
import { irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Register the low-level codegen delegates used by generateMultiModule.
import "../src/codegen/expressions.js";

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/loop.ts");
const HELPERS = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
const LOOP_SOURCE = readFileSync(ENTRY, "utf8");
const HELPERS_SOURCE = readFileSync(HELPERS, "utf8");
const CUTOVER = "JS2WASM_MULTI_PREPARED_BENCH_LOOP_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_BENCH_LOOP";
const SEAL_FAILURE = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE";
const TAMPER = "JS2WASM_TEST_TAMPER_MULTI_PREPARED_FUNCTION_VALUE_LEAF";
const TRAMPOLINE = "__fn_tramp_bench_loop_cached";
const CACHE = "__fn_closure_bench_loop";
const EXPECTED_RUNTIME = 1_783_293_664;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

async function compileBench(cutover: boolean, options: CompileOptions = {}): Promise<CompileResult> {
  vi.stubEnv(CUTOVER, cutover ? "1" : "0");
  return compileProject(ENTRY, {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
    emitWat: true,
    ...options,
  });
}

function wasmSurface(binary: Uint8Array) {
  const module = new WebAssembly.Module(binary);
  return {
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  };
}

function watFunction(wat: string, name: string): string {
  const sameLine = wat.indexOf(`(func $${name} `);
  const start = sameLine >= 0 ? sameLine : wat.indexOf(`(func $${name}\n`);
  if (start < 0) throw new Error(`missing WAT function ${name}`);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function ${name}`);
}

function binaryenWat(binary: Uint8Array): string {
  const module = binaryen.readBinary(binary);
  try {
    return module.emitText();
  } finally {
    module.dispose();
  }
}

function normalizedRawTrampoline(body: string): string {
  return body.replace(/\(type \d+\)/, "(type #)").replace(/\$__inl\d+_/g, "$__inl#_");
}

async function benchRuntime(result: CompileResult): Promise<number> {
  const instance = await instantiateWithRuntime(result);
  return (instance.exports.bench_loop as () => number)();
}

function expectDirectPoison(result: CompileResult): void {
  expect(result.success).toBe(false);
  expect(result.errors.map((error) => error.message).join("\n")).toContain(
    "injected direct function-body poison: bench_loop",
  );
  expect(
    result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop").map((row) => row.entryPoint),
  ).toContain("compileFunctionBody");
}

async function compileMutatedLoop(source: string): Promise<CompileResult> {
  vi.stubEnv(CUTOVER, "1");
  vi.stubEnv(DIRECT_POISON, "bench_loop");
  return compileMulti({ "helpers.ts": HELPERS_SOURCE, "loop.ts": source }, "loop.ts", {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
}

function generatedBench(cutover: boolean): GeneratedCodegenModule {
  vi.stubEnv(CUTOVER, cutover ? "1" : "0");
  vi.stubEnv(REQUIRE_ROUTE, "1");
  const ast = analyzeMultiSource({ "helpers.ts": HELPERS_SOURCE, "loop.ts": LOOP_SOURCE }, "loop.ts");
  return generateMultiModule(ast, {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#4590 exact bench_loop Prepared cutover", () => {
  it("bypasses the real compileProject direct body and restores it with the dedicated kill switch", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const prepared = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(prepared, "default-on Prepared compile");
    expect(prepared.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
    expect(prepared.irOutcomes?.find((outcome) => outcome.displayName === "bench_loop")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
    });

    vi.stubEnv(CUTOVER, "0");
    const direct = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(direct.success).toBe(false);
    expect(direct.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: bench_loop",
    );
  });

  it("removes exactly the two bench_loop direct rows while preserving its raw body and external surface", async () => {
    const prepared = await compileBench(true, {
      emitWatOnlyFunctions: ["bench_loop", TRAMPOLINE],
    });
    const direct = await compileBench(false, {
      emitWatOnlyFunctions: ["bench_loop", TRAMPOLINE],
    });
    expectSuccess(prepared, "Prepared raw compile");
    expectSuccess(direct, "direct raw control");

    const preparedRows = prepared.irBodyRouteAudit?.legacyEntries ?? [];
    const directRows = direct.irBodyRouteAudit?.legacyEntries ?? [];
    expect(preparedRows).toHaveLength(14);
    expect(directRows).toHaveLength(16);
    expect(preparedRows.filter((row) => row.entryPoint !== "compileDeclarations")).toHaveLength(12);
    expect(directRows.filter((row) => row.entryPoint !== "compileDeclarations")).toHaveLength(14);
    expect(preparedRows.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
    expect(directRows.filter((row) => row.bodyName !== "bench_loop")).toEqual(preparedRows);
    expect(directRows.filter((row) => row.bodyName === "bench_loop").map((row) => row.entryPoint)).toEqual([
      "compileFunctionBody",
      "compileStatement",
    ]);
    const outcome = prepared.irOutcomes?.find((candidate) => candidate.displayName === "bench_loop");
    expect(outcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome?.unitId)?.disposition).toBe(
      "terminal-ir",
    );

    const preparedBody = watFunction(prepared.wat, "bench_loop");
    const directBody = watFunction(direct.wat, "bench_loop");
    const preparedTrampoline = watFunction(prepared.wat, TRAMPOLINE);
    const directTrampoline = watFunction(direct.wat, TRAMPOLINE);
    expect(preparedBody).toBe(directBody);
    expect(normalizedRawTrampoline(preparedTrampoline)).toBe(normalizedRawTrampoline(directTrampoline));
    expect(preparedBody.match(/\$slot___ru_acc[0-7]/g)).toHaveLength(8);
    expect(preparedTrampoline.match(/\$__inl\d+_\$slot___ru_acc[0-7]/g)).toHaveLength(8);
    expect(preparedBody).toContain("i32.const 125000");
    expect(preparedTrampoline).toContain("i32.const 125000");

    // Early support allocation is the one intentional raw artifact delta.
    expect(prepared.binary.byteLength).toBe(direct.binary.byteLength - 35);
    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.importsHelper).toBe(direct.importsHelper);
    expect(prepared.imports).toEqual(direct.imports);
    expect(prepared.stringPool).toEqual(direct.stringPool);
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    await expect(benchRuntime(prepared)).resolves.toBe(EXPECTED_RUNTIME);
    await expect(benchRuntime(direct)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("keeps optimized bench_loop and trampoline bodies exact without size or runtime growth", async () => {
    const prepared = await compileBench(true, { optimize: true, preserveDebugNames: true });
    const direct = await compileBench(false, { optimize: true, preserveDebugNames: true });
    expectSuccess(prepared, "Prepared optimized compile");
    expectSuccess(direct, "direct optimized control");
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    // Lane PARITY is the invariant; an absolute byte pin (formerly 50_363)
    // broke on every unrelated main advance that shifted the optimized
    // artifact. Both lanes compile the same graph, so their optimized sizes
    // must be equal — that is the no-size-growth claim, portably.
    expect(prepared.binary.byteLength).toBe(direct.binary.byteLength);

    const preparedWat = binaryenWat(prepared.binary);
    const directWat = binaryenWat(direct.binary);
    const preparedBody = watFunction(preparedWat, "bench_loop");
    const directBody = watFunction(directWat, "bench_loop");
    const preparedTrampoline = watFunction(preparedWat, TRAMPOLINE);
    const directTrampoline = watFunction(directWat, TRAMPOLINE);
    expect(preparedBody).toBe(directBody);
    expect(preparedTrampoline).toBe(directTrampoline);
    expect(preparedBody).toContain("(i32.const 125000)");
    expect(preparedTrampoline).toContain("(i32.const 125000)");

    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.importsHelper).toBe(direct.importsHelper);
    expect(prepared.imports).toEqual(direct.imports);
    expect(prepared.stringPool).toEqual(direct.stringPool);
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    await expect(benchRuntime(prepared)).resolves.toBe(EXPECTED_RUNTIME);
    await expect(benchRuntime(direct)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("preserves support binding contracts with lane-exact singleton slots and objects", () => {
    const prepared = generatedBench(true);
    const direct = generatedBench(false);
    for (const [label, result] of [
      ["Prepared", prepared],
      ["direct", direct],
    ] as const) {
      const hardErrors = result.errors.filter((error) => error.severity !== "warning");
      expect(hardErrors, `${label}: ${hardErrors.map((error) => error.message).join("\n")}`).toEqual([]);
      expect(result.programAbi).toBeDefined();
    }
    const preparedOutcome = prepared.irOutcomes?.find((candidate) => candidate.displayName === "bench_loop");
    const directOutcome = direct.irOutcomes?.find((candidate) => candidate.displayName === "bench_loop");
    expect(preparedOutcome?.unitId).toBe(directOutcome?.unitId);
    if (!preparedOutcome?.unitId) throw new Error("missing exact bench_loop UnitId");

    const sourceId = irUnitCallableBindingId(preparedOutcome.unitId);
    const trampolineId = irSupportFuncRef(preparedOutcome.unitId, "function-value-trampoline", TRAMPOLINE).binding
      .bindingId;
    const cacheId = irSupportGlobalRef(preparedOutcome.unitId, "function-value-cache", CACHE).binding.bindingId;
    const ids = [sourceId, trampolineId, cacheId] as const;
    const slotExpectations = [
      { result: prepared, source: 76, trampoline: 78, cache: 10 },
      { result: direct, source: 76, trampoline: 252, cache: 129 },
    ] as const;

    for (const { result, source, trampoline, cache } of slotExpectations) {
      const publication = result.programAbi!;
      expect(publication.abi.entries().filter((entry) => ids.includes(entry.id))).toHaveLength(3);
      expect(publication.abi.get(sourceId)).toMatchObject({
        id: sourceId,
        displayName: "bench_loop",
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "source", unitId: preparedOutcome.unitId },
      });
      expect(publication.abi.get(trampolineId)).toMatchObject({
        id: trampolineId,
        displayName: TRAMPOLINE,
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "support", unitId: preparedOutcome.unitId },
      });
      expect(publication.abi.get(cacheId)).toMatchObject({
        id: cacheId,
        displayName: CACHE,
        slotPolicy: "required",
        slotSpace: "global",
        intent: { kind: "global", origin: "support", mutable: true, valueType: '{"kind":"externref"}' },
      });
      expect(publication.abi.resolveFinalIndex(sourceId)).toEqual({ space: "function", index: source });
      expect(publication.abi.resolveFinalIndex(trampolineId)).toEqual({ space: "function", index: trampoline });
      expect(publication.abi.resolveFinalIndex(cacheId)).toEqual({ space: "global", index: cache });

      const functionImports = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
      const globalImports = result.module.imports.filter((entry) => entry.desc.kind === "global").length;
      const sourceObject = result.module.functions[source - functionImports];
      const trampolineObject = result.module.functions[trampoline - functionImports];
      const cacheObject = result.module.globals[cache - globalImports];
      expect(result.module.functions.filter((func) => func.name === "bench_loop")).toEqual([sourceObject]);
      expect(result.module.functions.filter((func) => func.name === TRAMPOLINE)).toEqual([trampolineObject]);
      expect(result.module.globals.filter((global) => global.name === CACHE)).toEqual([cacheObject]);
      expect(sourceObject?.name).toBe("bench_loop");
      expect(trampolineObject?.name).toBe(TRAMPOLINE);
      expect(cacheObject).toMatchObject({ name: CACHE, mutable: true, type: { kind: "externref" } });

      if (!sourceObject || !trampolineObject) throw new Error("missing exact function object at Program ABI slot");
      const sourceEntry = publication.abi.get(sourceId);
      const trampolineEntry = publication.abi.get(trampolineId);
      const sourceSignature = canonicalProgramAbiCallableTypeContract(result.module.types[sourceObject.typeIdx]!);
      const trampolineSignature = canonicalProgramAbiCallableTypeContract(
        result.module.types[trampolineObject.typeIdx]!,
      );
      expect(sourceSignature).toEqual({ params: [], results: ['{"kind":"f64"}'] });
      expect(sourceEntry?.intent.kind === "callable" ? sourceEntry.intent.signature : undefined).toEqual(
        sourceSignature,
      );
      expect(trampolineSignature.results).toEqual(['{"kind":"f64"}']);
      expect(trampolineSignature.params).toHaveLength(1);
      expect(trampolineSignature.params[0]).toMatch(/^\{"kind":"ref(?:_null)?",/);
      expect(trampolineEntry?.intent.kind === "callable" ? trampolineEntry.intent.signature : undefined).toEqual(
        trampolineSignature,
      );
    }
  });

  it("fails closed when the preallocated singleton pair drifts after Prepared certification", async () => {
    vi.stubEnv(TAMPER, "bench_loop");
    const result = await compileBench(true);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("drifted after direct-body certification");
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
  });

  it("withdraws an exact Unsupported preparation before requesting the direct-body skip", async () => {
    vi.stubEnv(SEAL_FAILURE, "1");
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const result = await compileBench(true);
    expectDirectPoison(result);
    expect(result.errors.map((error) => error.message).join("\n")).not.toContain(
      "did not withdraw atomically before its skip",
    );
  });

  it("routes the same exact reduction after every function-value use is renamed", async () => {
    const renamed = "renamed_reduction";
    const source = LOOP_SOURCE.replaceAll("bench_loop", renamed);
    vi.stubEnv(CUTOVER, "1");
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, renamed);
    const result = await compileMulti({ "helpers.ts": HELPERS_SOURCE, "loop.ts": source }, "loop.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(result, "renamed Prepared reduction");
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === renamed)).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === renamed)).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
    });
  });

  it.each([
    {
      label: "altered reduction literal",
      source: LOOP_SOURCE.replace("i < 1000000", "i < 999999"),
    },
    {
      label: "extensionless imported source",
      source: LOOP_SOURCE.replace('from "./helpers.ts"', 'from "./helpers"'),
    },
    {
      label: "shadowed imported callee",
      source: LOOP_SOURCE.replace(
        "export function main(): void {",
        "export function main(): void {\n  function addBenchCard(..._args: unknown[]): void {}",
      ),
    },
    {
      label: "stored function value",
      source: LOOP_SOURCE.replace(
        '  addBenchCard(wrap, "Loop: 1M Int32 sum", "Tight i32 loop with explicit | 0 wrap, no allocations", bench_loop);',
        '  const stored = bench_loop;\n  addBenchCard(wrap, "Loop: 1M Int32 sum", "Tight i32 loop with explicit | 0 wrap, no allocations", stored);',
      ),
    },
    {
      label: "multiple function-value references",
      source: LOOP_SOURCE.replace("  host.appendChild(wrap);", "  void bench_loop;\n  host.appendChild(wrap);"),
    },
    {
      label: "additional direct caller",
      source: LOOP_SOURCE.replace("  host.appendChild(wrap);", "  bench_loop();\n  host.appendChild(wrap);"),
    },
    {
      label: "synthetic trampoline collision",
      source: `${LOOP_SOURCE}\nfunction ${TRAMPOLINE}(value: string): string { return value; }\n`,
    },
    {
      label: "nonliteral reduction bound",
      source: `const LOOP_LIMIT = 1000000;\n${LOOP_SOURCE.replace("i < 1000000", "i < LOOP_LIMIT")}`,
    },
    {
      label: "exact reduction with module initialization",
      source: `let moduleMarker = 1;\n${LOOP_SOURCE}`,
    },
  ])("withdraws before skip for $label", async ({ source }) => {
    expectDirectPoison(await compileMutatedLoop(source));
  });

  it.each([
    ["default GC", { target: "gc" as const }],
    ["fast standalone", { target: "standalone" as const, fast: true }],
    ["WASI", { target: "wasi" as const }],
    ["IR-first disabled", { target: "standalone" as const, disableIrFirst: true }],
    ["IR disabled", { target: "standalone" as const, experimentalIR: false }],
  ])("keeps the %s lane direct-owned", async (_label, options) => {
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    expectDirectPoison(await compileBench(true, options));
  });
});
