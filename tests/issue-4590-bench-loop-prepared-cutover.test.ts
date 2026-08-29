// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
// #4617 C1 — declaration-fact record/replay fault injection (test-only).
const POISON_ORACLE = "JS2WASM_TEST_POISON_DECLARATION_ORACLE";
const LIVE_ORACLE = "JS2WASM_TEST_DECLARATION_REPLAY_LIVE_ORACLE";
const MUTATE_SNAPSHOT = "JS2WASM_TEST_MUTATE_DECLARATION_SNAPSHOT";
const TAMPER_REPLAY = "JS2WASM_TEST_TAMPER_DECLARATION_REPLAY";
const POISON_MESSAGE = "live declaration oracle poisoned after semantic-snapshot finalization";
const TRAMPOLINE = "__fn_tramp_bench_loop_cached";
const CACHE = "__fn_closure_bench_loop";
const EXPECTED_RUNTIME = 1_783_293_664;
const WASM_OPT_INVALID_BINARY_WARNING =
  "wasm-opt produced an invalid binary (it failed WebAssembly.validate); shipping unoptimized output instead. " +
  "This is a known binaryen-JS-module encoder bug for WasmGC ref types (#1941) — installing a native wasm-opt on PATH avoids it.";
const WASM_OPT_NOT_AVAILABLE_WARNING =
  "wasm-opt not available: install the 'binaryen' npm package or add wasm-opt to PATH. Skipping optimization.";
const RAW_HOST_IMPORTS = [
  "env.Document_createElement",
  "env.Element_set_textContent",
  "env.HTMLElement_addEventListener",
  "env.Performance_now",
  "env.Element_get_children",
  "env.Document_get_body",
  "env.Element_set_innerHTML",
  "env.CSSStyleDeclaration_set_cssText",
  "env.HTMLElement_get_style",
  "env.Node_appendChild",
] as const;

type OptimizerDiagnostic = CompileResult["errors"][number];

const EXPECTED_RAW_DIAGNOSTICS: readonly OptimizerDiagnostic[] = RAW_HOST_IMPORTS.map((hostImport) => ({
  message:
    `Host import leak (warning, #2961): host import "${hostImport}" survives into the finished --target standalone ` +
    `binary and would fail instantiation in a runtime with no JS host (#2073/#2075). This is currently a warning; ` +
    `#2961 ratchets --target standalone to the same hard no-leak guarantee --target wasi already enforces. The ` +
    `name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.ts). Add a Wasm-native fallback for ` +
    `this feature, or — for a transitional host import — add an allowlist entry citing the tracking issue and include ` +
    `"[allowlist-grow]" in your PR description.`,
  line: 15,
  column: 20,
  severity: "warning",
  file: "loop.ts",
}));

function isRecognizedWasmOptFallback(message: string): boolean {
  return (
    message === WASM_OPT_INVALID_BINARY_WARNING ||
    message === WASM_OPT_NOT_AVAILABLE_WARNING ||
    /^wasm-opt -O3 failed: .+/s.test(message) ||
    /^wasm-opt output was rejected because it changed the canonical runtime rec-group — .+; using the unoptimized module$/s.test(
      message,
    )
  );
}

function assertRawOptimizerDiagnostics(
  prepared: readonly OptimizerDiagnostic[],
  direct: readonly OptimizerDiagnostic[],
): void {
  if (!isDeepStrictEqual(prepared, EXPECTED_RAW_DIAGNOSTICS) || !isDeepStrictEqual(direct, EXPECTED_RAW_DIAGNOSTICS)) {
    throw new Error(
      `raw diagnostics must equal the exact ordered #2961 authority: ` +
        `Prepared=${JSON.stringify(prepared)}, direct=${JSON.stringify(direct)}`,
    );
  }
}

function classifyOptimizerDiagnostics(
  prepared: readonly OptimizerDiagnostic[],
  direct: readonly OptimizerDiagnostic[],
): "optimized" | "fallback" {
  if (prepared.length === 0 && direct.length === 0) return "optimized";
  if (
    prepared.length !== 1 ||
    direct.length !== 1 ||
    !isDeepStrictEqual(prepared[0], direct[0]) ||
    !isDeepStrictEqual(prepared[0], {
      message: prepared[0]?.message,
      line: 1,
      column: 1,
      severity: "warning",
    }) ||
    !isRecognizedWasmOptFallback(prepared[0].message)
  ) {
    throw new Error(
      `optimizer diagnostics must be empty or one identical recognized fallback per lane: ` +
        `Prepared=${JSON.stringify(prepared)}, direct=${JSON.stringify(direct)}`,
    );
  }
  return "fallback";
}

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

function codegenErrors(result: GeneratedCodegenModule): string {
  return result.errors
    .filter((error) => error.severity !== "warning")
    .map((error) => error.message)
    .join("\n");
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

/** In-memory twin of `compileBench(true, ...)`; cheaper per test than compileProject. */
async function compileBenchSources(options: CompileOptions = {}): Promise<CompileResult> {
  vi.stubEnv(CUTOVER, "1");
  return compileMulti({ "helpers.ts": HELPERS_SOURCE, "loop.ts": LOOP_SOURCE }, "loop.ts", {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
    ...options,
  });
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
    expect(prepared.binary.byteLength).toBe(direct.binary.byteLength - 29);
    expect(prepared.dts).toBe(direct.dts);
    expect(prepared.importsHelper).toBe(direct.importsHelper);
    expect(prepared.imports).toEqual(direct.imports);
    expect(prepared.stringPool).toEqual(direct.stringPool);
    expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
    await expect(benchRuntime(prepared)).resolves.toBe(EXPECTED_RUNTIME);
    await expect(benchRuntime(direct)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("keeps optimized bench_loop and trampoline bodies exact without size or runtime growth", async () => {
    const rawPrepared = await compileBench(true, { optimize: false, preserveDebugNames: true });
    const rawDirect = await compileBench(false, { optimize: false, preserveDebugNames: true });
    const prepared = await compileBench(true, { optimize: true, preserveDebugNames: true });
    const direct = await compileBench(false, { optimize: true, preserveDebugNames: true });
    expectSuccess(rawPrepared, "Prepared raw optimizer control");
    expectSuccess(rawDirect, "direct raw optimizer control");
    expectSuccess(prepared, "Prepared optimized compile");
    expectSuccess(direct, "direct optimized control");

    const fallbackControl = {
      message: WASM_OPT_NOT_AVAILABLE_WARNING,
      line: 1,
      column: 1,
      severity: "warning",
    } as const;
    const invalidControl = { ...fallbackControl, message: WASM_OPT_INVALID_BINARY_WARNING } as const;
    const unrelatedControl = { ...fallbackControl, message: "unrelated compile warning" } as const;
    const unrecognizedControl = { ...fallbackControl, message: "wasm-opt unexpectedly declined" } as const;
    const wrongLevelZero = { ...fallbackControl, message: "wasm-opt -O0 failed: synthetic refusal" } as const;
    const wrongLevelNine = { ...fallbackControl, message: "wasm-opt -O9 failed: synthetic refusal" } as const;
    const wrongSeverityControl = { ...fallbackControl, severity: "error" } as const;
    const wrongAnchorControl = { ...fallbackControl, line: 2 } as const;
    expect(classifyOptimizerDiagnostics([], [])).toBe("optimized");
    expect(classifyOptimizerDiagnostics([fallbackControl], [fallbackControl])).toBe("fallback");
    for (const [left, right] of [
      [[fallbackControl], []],
      [
        [fallbackControl, fallbackControl],
        [fallbackControl, fallbackControl],
      ],
      [[unrelatedControl], [unrelatedControl]],
      [[unrecognizedControl], [unrecognizedControl]],
      [[wrongLevelZero], [wrongLevelZero]],
      [[wrongLevelNine], [wrongLevelNine]],
      [[wrongSeverityControl], [wrongSeverityControl]],
      [[wrongAnchorControl], [wrongAnchorControl]],
      [[fallbackControl], [invalidControl]],
    ] as const) {
      expect(() => classifyOptimizerDiagnostics(left, right)).toThrow(
        "optimizer diagnostics must be empty or one identical recognized fallback per lane",
      );
    }

    expect(() => assertRawOptimizerDiagnostics([], [])).toThrow(
      "raw diagnostics must equal the exact ordered #2961 authority",
    );
    const identicallyDriftedRaw = EXPECTED_RAW_DIAGNOSTICS.slice(1);
    expect(() => assertRawOptimizerDiagnostics(identicallyDriftedRaw, identicallyDriftedRaw)).toThrow(
      "raw diagnostics must equal the exact ordered #2961 authority",
    );
    assertRawOptimizerDiagnostics(rawPrepared.errors, rawDirect.errors);
    expect(prepared.errors.slice(0, rawPrepared.errors.length)).toEqual(rawPrepared.errors);
    expect(direct.errors.slice(0, rawDirect.errors.length)).toEqual(rawDirect.errors);
    const disposition = classifyOptimizerDiagnostics(
      prepared.errors.slice(rawPrepared.errors.length),
      direct.errors.slice(rawDirect.errors.length),
    );
    const preparedWat = disposition === "optimized" ? binaryenWat(prepared.binary) : rawPrepared.wat;
    const directWat = disposition === "optimized" ? binaryenWat(direct.binary) : rawDirect.wat;
    const preparedBody = watFunction(preparedWat, "bench_loop");
    const directBody = watFunction(directWat, "bench_loop");
    const preparedTrampoline = watFunction(preparedWat, TRAMPOLINE);
    const directTrampoline = watFunction(directWat, TRAMPOLINE);

    expect(preparedBody).toBe(directBody);
    if (disposition === "optimized") {
      // Lane parity is the portable no-growth authority after wasm-opt runs.
      expect(prepared.binary.byteLength).toBe(direct.binary.byteLength);
      expect(preparedTrampoline).toBe(directTrampoline);
    } else {
      expect(prepared.binary).toEqual(rawPrepared.binary);
      expect(direct.binary).toEqual(rawDirect.binary);
      expect(prepared.binary.byteLength).toBe(133_297);
      expect(direct.binary.byteLength).toBe(133_326);
      expect(prepared.binary.byteLength).toBe(direct.binary.byteLength - 29);
      expect(normalizedRawTrampoline(preparedTrampoline)).toBe(normalizedRawTrampoline(directTrampoline));
    }
    expect(preparedBody).toContain("i32.const 125000");
    expect(preparedTrampoline).toContain("i32.const 125000");

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
      { result: direct, source: 76, trampoline: 291, cache: 139 },
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

  // ── #4617 C1: declaration-fact record/replay ────────────────────────────
  //
  // The route's declaration authority is now a captured, canonicalized,
  // serialized, re-parsed snapshot replayed through an oracle with NO delegate.
  // These cases prove the replay is load-bearing (not a spy that never throws),
  // that a poisoned live path would have been observed, and that one corrupted
  // fact withdraws BEFORE any support allocation or direct-body skip.

  it("routes the exact reduction from replayed facts with both live declaration methods poisoned", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(POISON_ORACLE, "bench_loop");
    vi.stubEnv(DIRECT_POISON, "bench_loop");
    const result = await compileBenchSources();
    expectSuccess(result, "replayed Prepared compile under a poisoned live oracle");
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "bench_loop")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    await expect(benchRuntime(result)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("observes the poison when the pre-C1 live-query path runs after finalization", () => {
    vi.stubEnv(POISON_ORACLE, "bench_loop");
    vi.stubEnv(LIVE_ORACLE, "bench_loop");
    // Codegen-only: the route decision is complete before binary emission, and
    // this assertion is about the diagnostic, not the artifact.
    expect(codegenErrors(generatedBench(true))).toContain(POISON_MESSAGE);
  });

  it("fails an armed-but-unmatched declaration fault injection instead of passing silently", () => {
    vi.stubEnv(POISON_ORACLE, "not_the_certified_route");
    expect(codegenErrors(generatedBench(true))).toContain(
      "is armed for not_the_certified_route but the certified route is bench_loop",
    );
  });

  it("keeps the live-oracle lane and the replay lane identical in route, surface, and runtime", async () => {
    vi.stubEnv(LIVE_ORACLE, "bench_loop");
    vi.stubEnv(REQUIRE_ROUTE, "1");
    const live = await compileBenchSources();
    vi.unstubAllEnvs();
    vi.stubEnv(REQUIRE_ROUTE, "1");
    const replayed = await compileBenchSources();
    expectSuccess(live, "live-oracle declaration lane");
    expectSuccess(replayed, "replayed declaration lane");

    expect(replayed.irBodyRouteAudit?.legacyEntries).toEqual(live.irBodyRouteAudit?.legacyEntries);
    expect(replayed.irBodyRouteAudit?.dispositions).toEqual(live.irBodyRouteAudit?.dispositions);
    expect(replayed.irOutcomes).toEqual(live.irOutcomes);
    expect(replayed.dts).toBe(live.dts);
    expect(replayed.importsHelper).toBe(live.importsHelper);
    expect(replayed.imports).toEqual(live.imports);
    expect(replayed.stringPool).toEqual(live.stringPool);
    expect(replayed.binary.byteLength).toBe(live.binary.byteLength);
    // Byte-for-byte binary equality subsumes any WAT comparison, so this lane
    // deliberately does not materialize two whole-module text renderings.
    expect(Buffer.from(replayed.binary).equals(Buffer.from(live.binary))).toBe(true);
    expect(wasmSurface(replayed.binary)).toEqual(wasmSurface(live.binary));
    await expect(benchRuntime(replayed)).resolves.toBe(EXPECTED_RUNTIME);
    await expect(benchRuntime(live)).resolves.toBe(EXPECTED_RUNTIME);
  });

  it("fails closed when the retained declaration snapshot is tampered after certification", async () => {
    vi.stubEnv(TAMPER_REPLAY, "bench_loop");
    const result = await compileBenchSources();
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("drifted after direct-body certification");
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "bench_loop")).toEqual([]);
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
