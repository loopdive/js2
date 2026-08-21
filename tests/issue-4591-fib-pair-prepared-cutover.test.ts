// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
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

const ENTRY = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/fib.ts");
const HELPERS = resolve(import.meta.dirname, "../website/playground/examples/benchmarks/helpers.ts");
const FIB_SOURCE = readFileSync(ENTRY, "utf8");
const HELPERS_SOURCE = readFileSync(HELPERS, "utf8");
const CUTOVER = "JS2WASM_MULTI_PREPARED_FIB_PAIR_CUTOVER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_FIB_PAIR";
const SEAL_FAILURE = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE";
const TAMPER = "JS2WASM_TEST_TAMPER_MULTI_PREPARED_FIB_PAIR";
const TARGETS = ["fib", "bench_fib"] as const;
const TRAMPOLINE = "__fn_tramp_bench_fib_cached";
const CACHE = "__fn_closure_bench_fib";
const EXPECTED_RUNTIME = 832_040;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

function targetLegacyRows(result: CompileResult) {
  return (
    result.irBodyRouteAudit?.legacyEntries.filter((row) =>
      TARGETS.includes(row.bodyName as (typeof TARGETS)[number]),
    ) ?? []
  );
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function compileFib(cutover: boolean, options: CompileOptions = {}): Promise<CompileResult> {
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

function expectSurfaceParity(prepared: CompileResult, direct: CompileResult): void {
  expect(prepared.dts).toBe(direct.dts);
  expect(prepared.importsHelper).toBe(direct.importsHelper);
  expect(prepared.imports).toEqual(direct.imports);
  expect(prepared.stringPool).toEqual(direct.stringPool);
  expect(wasmSurface(prepared.binary)).toEqual(wasmSurface(direct.binary));
}

async function fibonacciRuntime(result: CompileResult): Promise<readonly [number, number]> {
  const instance = await instantiateWithRuntime(result);
  const fib = instance.exports.fib as (value: number) => number;
  const benchFib = instance.exports.bench_fib as () => number;
  return [fib(10), benchFib()];
}

function expectDirectPoison(result: CompileResult): void {
  expect(result.success).toBe(false);
  const errors = result.errors.map((error) => error.message).join("\n");
  for (const name of TARGETS) expect(errors).toContain(`injected direct function-body poison: ${name}`);
  expect(
    targetLegacyRows(result)
      .map((row) => [row.bodyName, row.entryPoint])
      .sort(),
  ).toEqual(TARGETS.map((name) => [name, "compileFunctionBody"]).sort());
}

function replaceOnce(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`missing mutation anchor: ${search}`);
  return source.replace(search, replacement);
}

async function compileMutatedFib(source: string): Promise<CompileResult> {
  vi.stubEnv(CUTOVER, "1");
  vi.stubEnv(DIRECT_POISON, TARGETS.join(","));
  return compileMulti({ "helpers.ts": HELPERS_SOURCE, "fib.ts": source }, "fib.ts", {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
}

function generatedFib(cutover: boolean): GeneratedCodegenModule {
  vi.stubEnv(CUTOVER, cutover ? "1" : "0");
  vi.stubEnv(REQUIRE_ROUTE, "1");
  const ast = analyzeMultiSource({ "helpers.ts": HELPERS_SOURCE, "fib.ts": FIB_SOURCE }, "fib.ts");
  return generateMultiModule(ast, {
    experimentalIR: true,
    target: "standalone",
    trackIrOutcomes: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#4591 exact Fibonacci pair Prepared cutover", () => {
  it("atomically bypasses both real compileProject direct bodies and restores both with the kill switch", async () => {
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, TARGETS.join(","));
    const prepared = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(prepared, "default-on Prepared Fibonacci pair");
    expect(targetLegacyRows(prepared)).toEqual([]);
    const outcomes = TARGETS.map((name) => prepared.irOutcomes?.find((outcome) => outcome.displayName === name));
    expect(outcomes).toEqual([
      expect.objectContaining({ irBodyEmitted: true, legacyBodyEmitted: false }),
      expect.objectContaining({ irBodyEmitted: true, legacyBodyEmitted: false }),
    ]);
    expect(outcomes[0]?.preparedComponentId).toMatch(/^prepared-component:/);
    expect(outcomes[1]?.preparedComponentId).toBe(outcomes[0]?.preparedComponentId);

    vi.stubEnv(CUTOVER, "0");
    const direct = await compileProject(ENTRY, {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(direct.success).toBe(false);
    const errors = direct.errors.map((error) => error.message).join("\n");
    expect(errors).toContain("injected direct function-body poison: fib");
    expect(errors).toContain("injected direct function-body poison: bench_fib");
    expect(
      targetLegacyRows(direct)
        .map((row) => [row.bodyName, row.entryPoint])
        .sort(),
    ).toEqual(TARGETS.map((name) => [name, "compileFunctionBody"]).sort());
  });

  it("removes exactly four direct rows as one Prepared component while preserving raw bodies and surface", async () => {
    const prepared = await compileFib(true);
    const direct = await compileFib(false);
    expectSuccess(prepared, "Prepared raw Fibonacci compile");
    expectSuccess(direct, "direct raw Fibonacci control");

    const preparedRows = prepared.irBodyRouteAudit?.legacyEntries ?? [];
    const directRows = direct.irBodyRouteAudit?.legacyEntries ?? [];
    expect(preparedRows).toHaveLength(14);
    expect(directRows).toHaveLength(18);
    expect(preparedRows.filter((row) => row.entryPoint !== "compileDeclarations")).toHaveLength(12);
    expect(directRows.filter((row) => row.entryPoint !== "compileDeclarations")).toHaveLength(16);
    expect(targetLegacyRows(prepared)).toEqual([]);
    expect(directRows.filter((row) => !TARGETS.includes(row.bodyName as (typeof TARGETS)[number]))).toEqual(
      preparedRows,
    );
    expect(
      targetLegacyRows(direct)
        .map((row) => [row.bodyName, row.entryPoint])
        .sort(),
    ).toEqual(
      [
        ["fib", "compileFunctionBody"],
        ["fib", "compileStatement"],
        ["bench_fib", "compileFunctionBody"],
        ["bench_fib", "compileStatement"],
      ].sort(),
    );

    const outcomes = TARGETS.map((name) => prepared.irOutcomes?.find((outcome) => outcome.displayName === name));
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irBodyRouteAudit?.dispositions.find((row) => row.unitId === outcome?.unitId)?.disposition).toBe(
        "terminal-ir",
      );
    }
    expect(outcomes[1]?.preparedComponentId).toBe(outcomes[0]?.preparedComponentId);

    for (const name of [...TARGETS, TRAMPOLINE]) {
      const preparedBody = watFunction(prepared.wat, name);
      const directBody = watFunction(direct.wat, name);
      if (name === TRAMPOLINE) expect(normalizedRawTrampoline(preparedBody)).toBe(normalizedRawTrampoline(directBody));
      else expect(preparedBody).toBe(directBody);
    }
    expect(watFunction(prepared.wat, "fib").match(/\bcall 76\b/g)).toHaveLength(2);
    expect(watFunction(prepared.wat, "bench_fib")).toContain("call 76");
    expect(watFunction(prepared.wat, TRAMPOLINE)).toContain("call 76");

    // Absolute artifact pins (bytes + sha of the direct lane, formerly the
    // OLD_RAW_* / OLD_WAT_/ OLD_DTS_ constants) broke on every unrelated main
    // advance. The durable claims are asserted around this point instead:
    // exact per-function bodies, surface parity, and DTS parity across lanes.
    expect(digest(prepared.dts)).toBe(digest(direct.dts));
    expectSurfaceParity(prepared, direct);
    await expect(fibonacciRuntime(prepared)).resolves.toEqual([55, EXPECTED_RUNTIME]);
    await expect(fibonacciRuntime(direct)).resolves.toEqual([55, EXPECTED_RUNTIME]);
  });

  it("keeps optimized target and trampoline bodies exact without artifact growth", async () => {
    const prepared = await compileFib(true, { optimize: true });
    const direct = await compileFib(false, { optimize: true });
    expectSuccess(prepared, "Prepared optimized Fibonacci compile");
    expectSuccess(direct, "direct optimized Fibonacci control");
    // Same rationale: the optimized direct-lane pin (formerly 48_521 bytes +
    // sha) is main-version-dependent; no-growth is the invariant.
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    expectSurfaceParity(prepared, direct);
    await expect(fibonacciRuntime(prepared)).resolves.toEqual([55, EXPECTED_RUNTIME]);
    await expect(fibonacciRuntime(direct)).resolves.toEqual([55, EXPECTED_RUNTIME]);

    const preparedNamed = await compileFib(true, { optimize: true, preserveDebugNames: true });
    const directNamed = await compileFib(false, { optimize: true, preserveDebugNames: true });
    expectSuccess(preparedNamed, "Prepared preserve-names optimized Fibonacci compile");
    expectSuccess(directNamed, "direct preserve-names optimized Fibonacci control");
    // Lane parity replaces the absolute 50_123 pin (same rationale).
    expect(preparedNamed.binary.byteLength).toBe(directNamed.binary.byteLength);
    const preparedWat = binaryenWat(preparedNamed.binary);
    const directWat = binaryenWat(directNamed.binary);
    for (const name of [...TARGETS, TRAMPOLINE]) {
      expect(watFunction(preparedWat, name)).toBe(watFunction(directWat, name));
    }
    expectSurfaceParity(preparedNamed, directNamed);
  });

  it("preserves exact source and outer support binding objects in both allocation lanes", () => {
    const prepared = generatedFib(true);
    const direct = generatedFib(false);
    for (const [label, result] of [
      ["Prepared", prepared],
      ["direct", direct],
    ] as const) {
      const hardErrors = result.errors.filter((error) => error.severity !== "warning");
      expect(hardErrors, `${label}: ${hardErrors.map((error) => error.message).join("\n")}`).toEqual([]);
      expect(result.programAbi).toBeDefined();
    }

    const preparedOutcomes = new Map(
      TARGETS.map((name) => [name, prepared.irOutcomes?.find((outcome) => outcome.displayName === name)] as const),
    );
    const directOutcomes = new Map(
      TARGETS.map((name) => [name, direct.irOutcomes?.find((outcome) => outcome.displayName === name)] as const),
    );
    const fibUnitId = preparedOutcomes.get("fib")?.unitId;
    const benchUnitId = preparedOutcomes.get("bench_fib")?.unitId;
    expect(fibUnitId).toBe(directOutcomes.get("fib")?.unitId);
    expect(benchUnitId).toBe(directOutcomes.get("bench_fib")?.unitId);
    if (!fibUnitId || !benchUnitId) throw new Error("missing exact Fibonacci pair UnitIds");

    const fibSourceId = irUnitCallableBindingId(fibUnitId);
    const benchSourceId = irUnitCallableBindingId(benchUnitId);
    const trampolineId = irSupportFuncRef(benchUnitId, "function-value-trampoline", TRAMPOLINE).binding.bindingId;
    const cacheId = irSupportGlobalRef(benchUnitId, "function-value-cache", CACHE).binding.bindingId;
    const ids = [fibSourceId, benchSourceId, trampolineId, cacheId] as const;
    const slotExpectations = [
      { result: prepared, fib: 76, bench: 77, trampoline: undefined, cache: undefined },
      { result: direct, fib: 76, bench: 77, trampoline: 253, cache: 129 },
    ] as const;

    for (const { result, fib, bench, trampoline, cache } of slotExpectations) {
      const publication = result.programAbi!;
      expect(publication.abi.entries().filter((entry) => ids.includes(entry.id))).toHaveLength(4);
      expect(publication.abi.get(fibSourceId)).toMatchObject({
        id: fibSourceId,
        displayName: "fib",
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "source", unitId: fibUnitId },
      });
      expect(publication.abi.get(benchSourceId)).toMatchObject({
        id: benchSourceId,
        displayName: "bench_fib",
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "source", unitId: benchUnitId },
      });
      expect(publication.abi.get(trampolineId)).toMatchObject({
        id: trampolineId,
        displayName: TRAMPOLINE,
        slotPolicy: "required",
        slotSpace: "function",
        intent: { kind: "callable", origin: "support", unitId: benchUnitId },
      });
      expect(publication.abi.get(cacheId)).toMatchObject({
        id: cacheId,
        displayName: CACHE,
        slotPolicy: "required",
        slotSpace: "global",
        intent: { kind: "global", origin: "support", mutable: true, valueType: '{"kind":"externref"}' },
      });
      expect(publication.abi.resolveFinalIndex(fibSourceId)).toEqual({ space: "function", index: fib });
      expect(publication.abi.resolveFinalIndex(benchSourceId)).toEqual({ space: "function", index: bench });
      const resolvedTrampoline = publication.abi.resolveFinalIndex(trampolineId);
      const resolvedCache = publication.abi.resolveFinalIndex(cacheId);
      if (trampoline === undefined || cache === undefined) {
        expect(resolvedTrampoline).toMatchObject({ space: "function", index: expect.any(Number) });
        expect(resolvedCache).toMatchObject({ space: "global", index: expect.any(Number) });
      } else {
        expect(resolvedTrampoline).toEqual({ space: "function", index: trampoline });
        expect(resolvedCache).toEqual({ space: "global", index: cache });
      }

      const functionImports = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
      const globalImports = result.module.imports.filter((entry) => entry.desc.kind === "global").length;
      const fibObject = result.module.functions[fib - functionImports];
      const benchObject = result.module.functions[bench - functionImports];
      const trampolineObject = result.module.functions[resolvedTrampoline!.index - functionImports];
      const cacheObject = result.module.globals[resolvedCache!.index - globalImports];
      expect(result.module.functions.filter((func) => func.name === "fib")).toEqual([fibObject]);
      expect(result.module.functions.filter((func) => func.name === "bench_fib")).toEqual([benchObject]);
      expect(result.module.functions.filter((func) => func.name === TRAMPOLINE)).toEqual([trampolineObject]);
      expect(result.module.globals.filter((global) => global.name === CACHE)).toEqual([cacheObject]);
      expect(result.module.functions.some((func) => func.name === "__fn_tramp_fib_cached")).toBe(false);
      expect(result.module.globals.some((global) => global.name === "__fn_closure_fib")).toBe(false);
      expect(cacheObject).toMatchObject({ name: CACHE, mutable: true, type: { kind: "externref" } });

      if (!fibObject || !benchObject || !trampolineObject) throw new Error("missing Program ABI callable object");
      const fibSignature = canonicalProgramAbiCallableTypeContract(result.module.types[fibObject.typeIdx]!);
      const benchSignature = canonicalProgramAbiCallableTypeContract(result.module.types[benchObject.typeIdx]!);
      const trampolineSignature = canonicalProgramAbiCallableTypeContract(
        result.module.types[trampolineObject.typeIdx]!,
      );
      expect(fibSignature).toEqual({ params: ['{"kind":"f64"}'], results: ['{"kind":"f64"}'] });
      expect(benchSignature).toEqual({ params: [], results: ['{"kind":"f64"}'] });
      expect(trampolineSignature.results).toEqual(['{"kind":"f64"}']);
      expect(trampolineSignature.params).toHaveLength(1);
      expect(trampolineSignature.params[0]).toMatch(/^\{"kind":"ref(?:_null)?",/);
      expect(publication.abi.get(fibSourceId)?.intent).toMatchObject({ signature: fibSignature });
      expect(publication.abi.get(benchSourceId)?.intent).toMatchObject({ signature: benchSignature });
      expect(publication.abi.get(trampolineId)?.intent).toMatchObject({ signature: trampolineSignature });
    }
  });

  it("withdraws the whole component when Prepared sealing is Unsupported", async () => {
    vi.stubEnv(SEAL_FAILURE, "1");
    vi.stubEnv(DIRECT_POISON, TARGETS.join(","));
    const result = await compileFib(true);
    expectDirectPoison(result);
    expect(result.errors.map((error) => error.message).join("\n")).not.toContain(
      "did not withdraw atomically before its skip",
    );
  });

  it("fails closed when the certified pair or its support drifts before the late overlay", async () => {
    vi.stubEnv(TAMPER, "1");
    const result = await compileFib(true);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("drifted after direct-body certification");
    expect(targetLegacyRows(result)).toEqual([]);
  });

  it("routes the same exact component after both source declarations and uses are renamed", async () => {
    const source = FIB_SOURCE.replaceAll("bench_fib", "renamed_bench").replaceAll("fib", "renamed_fib");
    vi.stubEnv(CUTOVER, "1");
    vi.stubEnv(REQUIRE_ROUTE, "1");
    vi.stubEnv(DIRECT_POISON, "renamed_fib,renamed_bench");
    const result = await compileMulti({ "helpers.ts": HELPERS_SOURCE, "fib.ts": source }, "fib.ts", {
      experimentalIR: true,
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSuccess(result, "renamed Prepared Fibonacci component");
    for (const name of ["renamed_fib", "renamed_bench"]) {
      expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === name)).toEqual([]);
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === name)).toMatchObject({
        irBodyEmitted: true,
        legacyBodyEmitted: false,
      });
    }
  });

  it.each([
    {
      label: "missing recursive self-edge",
      source: replaceOnce(FIB_SOURCE, "return fib(n - 1) + fib(n - 2);", "return n - 1;"),
    },
    {
      label: "altered recurrence",
      source: replaceOnce(FIB_SOURCE, "return fib(n - 1) + fib(n - 2);", "return fib(n - 1) - fib(n - 2);"),
    },
    {
      label: "altered benchmark literal",
      source: replaceOnce(FIB_SOURCE, "return fib(30);", "return fib(29);"),
    },
    {
      label: "extra component member",
      source: replaceOnce(
        FIB_SOURCE,
        "export function main(): void {",
        "export function wrapper(): number { return bench_fib(); }\n\nexport function main(): void {",
      ),
    },
    {
      label: "extra legacy caller",
      source: replaceOnce(FIB_SOURCE, "  const host = document.body;", "  void fib(2);\n  const host = document.body;"),
    },
    {
      label: "extra component callee",
      source: replaceOnce(
        FIB_SOURCE,
        "export function bench_fib(): number {\n  return fib(30);\n}",
        "function adjust(n: number): number { return n; }\n\nexport function bench_fib(): number {\n  return fib(30) + adjust(0);\n}",
      ),
    },
    {
      label: "shadowed recursive target",
      source: replaceOnce(
        FIB_SOURCE,
        "export function bench_fib(): number {\n  return fib(30);\n}",
        "export function bench_fib(): number {\n  const fib = (n: number): number => n;\n  return fib(30);\n}",
      ),
    },
    {
      label: "ambiguous recursive declaration",
      source: replaceOnce(
        FIB_SOURCE,
        "export function fib(n: number): number {",
        "export function fib(n: number): number;\nexport function fib(n: number): number {",
      ),
    },
    {
      label: "one ineligible component member",
      source: replaceOnce(
        FIB_SOURCE,
        "export function bench_fib(): number {",
        "export function bench_fib(): number {\n  void 0;",
      ),
    },
    {
      label: "stored outer function value",
      source: replaceOnce(
        FIB_SOURCE,
        '  addBenchCard(wrap, "fib(30)", "Recursive — pure i32/f64 math, no host calls", bench_fib);',
        '  const stored = bench_fib;\n  addBenchCard(wrap, "fib(30)", "Recursive — pure i32/f64 math, no host calls", stored);',
      ),
    },
    {
      label: "extra outer function-value reference",
      source: replaceOnce(FIB_SOURCE, "  host.appendChild(wrap);", "  void bench_fib;\n  host.appendChild(wrap);"),
    },
    {
      label: "recursive member function-value reference",
      source: replaceOnce(FIB_SOURCE, "  host.appendChild(wrap);", "  void fib;\n  host.appendChild(wrap);"),
    },
    {
      label: "outer function reassignment",
      source: replaceOnce(
        FIB_SOURCE,
        "  const host = document.body;",
        "  if (false) bench_fib = (): number => 0;\n  const host = document.body;",
      ),
    },
    {
      label: "support-name collision",
      source: `${FIB_SOURCE}\nfunction ${TRAMPOLINE}(value: string): string { return value; }\n`,
    },
    {
      label: "module initialization",
      source: `let moduleMarker = 1;\n${FIB_SOURCE}`,
    },
  ])("withdraws the whole component before skip for $label", async ({ source }) => {
    expectDirectPoison(await compileMutatedFib(source));
  });

  it.each([
    ["default GC", { target: "gc" as const }],
    ["fast standalone", { target: "standalone" as const, fast: true }],
    ["WASI", { target: "wasi" as const }],
    ["IR-first disabled", { target: "standalone" as const, disableIrFirst: true }],
    ["IR disabled", { target: "standalone" as const, experimentalIR: false }],
  ])("keeps the %s lane direct-owned", async (_label, options) => {
    vi.stubEnv(DIRECT_POISON, TARGETS.join(","));
    expectDirectPoison(await compileFib(true, options));
  });
});
