// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Source-only authored controls: collection, compilation and execution NOT_RUN.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as legacy from "../src/index.js";
import * as frontend from "../src/checker/index.js";
import * as compiler from "../src/compiler.js";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import * as consumer from "../src/ir/program-consumer.js";
import * as binaryEmitter from "../src/emit/binary.js";
import {
  instantiatePreparedArtifact,
  preparedRuntimeExecutionObservation,
} from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  createIncrementalCompiler,
  requiredPreparedEmission,
  requiredPreparedFailure,
  requiredPreparedFrontendFailure,
  requiredPreparedFinalArtifactObservation,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const REQUEST = Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const });
const GRAPH = Object.freeze({
  "./fixture.ts": "export function twice(x: number): number { return x * 2; }\n",
  "./entry.ts":
    'import { twice } from "./fixture"; export function answer(x: number): number { return twice(x) + 1; }\n',
  // An additional provided root must be analyzed/prepared, too.
  "./extra.ts": "export function extra(): number { return 9; }\n",
});
const options = (target: "gc" | "linear" = "gc"): Test262CompileOptions => ({
  wholeProgram: REQUEST,
  target,
  backend: target === "linear" ? "linear" : "wasmgc",
  sourceMap: false,
  optimize: false,
  emitWat: false,
});
function forbidDirectGenerators() {
  return [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ].map((spy) =>
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

describe("Test262 strict prepared entry", () => {
  it.each(["gc", "linear"] as const)(
    "prepares the entire unchanged graph for %s and observes actual final artifacts",
    async (target) => {
      const forbidden = forbidDirectGenerators();
      const analysis = vi.spyOn(frontend, "analyzeMultiSource");
      const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
      const emission = vi.spyOn(consumer, "emitAcceptedIrProgram");
      const result = await compileMulti(GRAPH, "./entry.ts", options(target));
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(analysis).toHaveBeenCalledOnce();
      expect(analysis.mock.calls[0]![0]).toEqual(GRAPH);
      expect(presentation).toHaveBeenCalledOnce();
      const input = presentation.mock.calls[0]![0];
      const ast = analysis.mock.results[0]!.value as ReturnType<typeof frontend.analyzeMultiSource>;
      expect(input.multiAst).toBe(ast);
      expect(input.entryAst.program).toBe(ast.program);
      expect(input.entryAst.checker).toBe(ast.checker);
      expect(input.userSourceFiles).toBe(ast.sourceFiles);
      expect(ast.syntacticDiagnostics).toEqual([]);
      expect(ast.diagnostics).toEqual([]);
      expect(input.sourcesContent.size).toBe(3);
      for (const source of ast.sourceFiles) expect(input.sourcesContent.get(source.fileName)).toBe(source.text);
      expect(emission).toHaveBeenCalledOnce();
      const actual = emission.mock.results[0]!.value as ReturnType<typeof consumer.emitAcceptedIrProgram>;
      const plan = consumer.emittedPhysicalSetupPlan(actual);
      const output = presentation.mock.results[0]!.value as ReturnType<
        typeof compiler.runPreparedIrPipelinePresentation
      >;
      expect(output.kind).toBe("artifacts");
      if (output.kind !== "artifacts") throw new Error("mandatory genuine prepared artifacts absent");
      const base = requiredPreparedEmission(result);
      expect(base).toBeDefined();
      expect(base?.target).toBe("host");
      expect(base?.requestedTarget).toBe(target);
      expect(base?.backend).toBe(target === "linear" ? "linear" : "wasmgc");
      expect(base?.units.sources).toEqual(
        output.program.inventory.sources.map((source) => ({ id: source.id, file: source.originalFileName })),
      );
      expect(base?.units.sources).toHaveLength(3);
      expect(base?.units.original).toEqual(output.program.inventory.terminalUnits.map((unit) => unit.id));
      expect(base?.units.emitted).toEqual(actual.emittedUnitIds);
      expect(base?.units.physical).toEqual(plan.functions.map((fn) => fn.unitId));
      expect(base?.units.abi).toEqual(output.program.abi.entries.map((entry) => entry.plan.id));
      expect(base?.units.original.length).toBeGreaterThanOrEqual(3);
      const final = requiredPreparedFinalArtifactObservation(result);
      expect(final?.base).toBe(base);
      expect(final?.binary).toEqual(result.binary);
      expect(final?.binary).not.toBe(result.binary);
      expect(final?.adapterManifest).toEqual(result.adapterManifest);
      expect(final?.hostImportInventory).toEqual(result.hostImportInventory);
      expect(Object.isFrozen(final?.adapterManifest)).toBe(true);
      expect(requiredPreparedFailure(result)).toBeUndefined();
      expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    },
  );

  it("retains single-source bytes and explicit strict defaults", async () => {
    const forbidden = forbidDirectGenerators();
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const source = "// exact retained text\nexport function value(): number { return 7; }\n";
    const result = await compile(source, { wholeProgram: REQUEST, fileName: "original.ts", emitWat: false });
    expect(result.success).toBe(true);
    expect(analysis.mock.calls[0]![0]).toEqual({ "original.ts": source });
    expect(presentation.mock.calls[0]![0].options.sourceMap).toBe(false);
    expect(presentation.mock.calls[0]![0].options.optimize).toBe(false);
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["closure", "export function make(x: number): () => number { return () => x; }"],
    ["class", "export class Value { read(): number { return 3; } }"],
  ])("keeps %s refusal separate from a frontend syntax rejection", async (_name, source) => {
    const forbidden = forbidDirectGenerators();
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const result = await compile(source, options());
    const ast = analysis.mock.results[0]!.value as ReturnType<typeof frontend.analyzeMultiSource>;
    expect(ast.syntacticDiagnostics).toEqual([]);
    expect(result.success).toBe(false);
    const failure = requiredPreparedFailure(result);
    expect(failure && ["unsupported", "presentation-unsupported"].includes(failure.kind)).toBe(true);
    expect(result.errors.some((error) => error.file && error.line > 0 && error.column > 0)).toBe(true);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("retains a genuine syntax diagnostic from a non-entry fixture", async () => {
    const forbidden = forbidDirectGenerators();
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const result = await compileMulti({ ...GRAPH, "./extra.ts": "export const = ;" }, "./entry.ts", options());
    const ast = analysis.mock.results[0]!.value as ReturnType<typeof frontend.analyzeMultiSource>;
    expect(ast.syntacticDiagnostics.length).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(requiredPreparedFailure(result)?.kind).toBe("output-failed");
    const frontendFailure = requiredPreparedFrontendFailure(result);
    expect(frontendFailure?.phase).toBe("syntax");
    expect(frontendFailure?.sources).toEqual(
      ast.sourceFiles.map((source) => ({ file: source.fileName, text: source.text })),
    );
    const syntaxCodes = new Set(ast.syntacticDiagnostics.map((diagnostic) => diagnostic.code));
    expect(
      frontendFailure?.diagnostics.some(
        (diagnostic) => typeof diagnostic.code === "number" && syntaxCodes.has(diagnostic.code),
      ),
    ).toBe(true);
    expect(requiredPreparedFrontendFailure({ ...result })).toBeUndefined();
    expect(
      result.errors.some(
        (error) => typeof error.code === "number" && syntaxCodes.has(error.code) && error.file?.endsWith("extra.ts"),
      ),
    ).toBe(true);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("uses the reviewed native presentation and genuine fixed constructor for standalone numeric/Boolean exports", async () => {
    const forbidden = forbidDirectGenerators();
    const result = await compile(
      "export function add(a: number, b: number): number { return a + b; } export function greater(x: number): boolean { return x > 3; }",
      { ...options(), target: "standalone", backend: "wasmgc" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const base = requiredPreparedEmission(result)!;
    expect(base.target).toBe("standalone");
    expect(base.requestedTarget).toBe("standalone");
    expect(base.backend).toBe("wasmgc");
    const execution = instantiatePreparedArtifact(result);
    const actual = preparedRuntimeExecutionObservation(execution, result.binary, execution.imports);
    expect(actual?.base).toBe(base);
    expect(actual?.actualRuntimeContext).toBe("GENUINE_FIXED_CONSTRUCTION_AND_INSTANCE");
    expect(actual?.actualBinary).toBe("MATCHED_ACTUAL_ENGINE_OPERAND");
    expect(actual?.actualImports).toBe("MATCHED_ACTUAL_ENGINE_OPERAND");
    expect((execution.instance.exports.add as (a: number, b: number) => number)(20, 22)).toBe(42);
    // The actual Wasm Boolean ABI is i32; the finalized boundary metadata retains Boolean.
    expect((execution.instance.exports.greater as (x: number) => number)(4)).toBe(1);
    expect((execution.instance.exports.greater as (x: number) => number)(1)).toBe(0);
    expect(result.exportSignatures?.greater?.result).toBe("boolean");
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("preserves the real WASI startup refusal rather than inventing a start adapter", async () => {
    const forbidden = forbidDirectGenerators();
    const result = await compile("let value = 1; export function read(): number { return value; }", {
      ...options(),
      target: "wasi",
      backend: "wasmgc",
    });
    expect(result.success).toBe(false);
    const failure = requiredPreparedFailure(result);
    expect(failure?.kind).toBe("unsupported");
    if (failure?.kind !== "unsupported") throw new Error("mandatory located WASI startup refusal absent");
    expect(failure.phase).toBe("acceptance");
    expect(failure.failure.detail).toContain("startup adapter wasi-start-export is not materializable");
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["linear", "standalone"],
    ["wasmgc", "linear"],
  ] as const)("rejects explicit backend %s conflicting with target %s before analysis", async (backend, target) => {
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const result = await compile("export function value(): number { return 1; }", { ...options(), backend, target });
    expect(result.success).toBe(false);
    expect(result.errors[0]?.code).toBe("prepared-backend-target-mismatch");
    expect(requiredPreparedFailure(result)?.kind).toBe("adapter-unsupported");
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(analysis).not.toHaveBeenCalled();
  });

  it.each(["sourceMap", "optimize"] as const)("refuses %s:true rather than overriding it", async (field) => {
    const forbidden = forbidDirectGenerators();
    const result = await compile("export function value(): number { return 1; }", { ...options(), [field]: true });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === "unproved-output-option")).toBe(true);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("refuses runtimeEvalProvider:false and define before frontend analysis", async () => {
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    for (const extra of [{ runtimeEvalProvider: false }, { define: { X: "1" } }]) {
      const result = await compile("export function value(): number { return 1; }", { ...options(), ...extra });
      expect(result.success).toBe(false);
      expect(requiredPreparedFailure(result)?.kind).toBe("adapter-unsupported");
      expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    }
    expect(analysis).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "prepared-program-required", version: 2 },
    { kind: "prepared-program-required", version: 1, extra: true },
  ])("rejects malformed own requests before unrelated getters", async (wholeProgram) => {
    let reads = 0;
    const bad = Object.defineProperty({ wholeProgram }, "target", {
      enumerable: true,
      get() {
        reads++;
        throw new Error("unrelated option getter");
      },
    });
    await expect(
      compile("export function value(): number { return 1; }", bad as unknown as Test262CompileOptions),
    ).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
  });

  it("rejects inherited and accessor selectors without invoking getters or a legacy delegate", async () => {
    const delegated = vi.spyOn(legacy, "compile");
    let reads = 0;
    const inherited = Object.create({ wholeProgram: REQUEST }) as Test262CompileOptions;
    const accessor = Object.defineProperty({}, "wholeProgram", {
      get() {
        reads++;
        return REQUEST;
      },
    }) as Test262CompileOptions;
    const foreignPrototype = { wholeProgram: Object.assign(Object.create({ extra: true }), REQUEST) };
    const nested = {
      wholeProgram: Object.defineProperty({ version: 1 }, "kind", {
        enumerable: true,
        get() {
          reads++;
          return "prepared-program-required";
        },
      }),
    };
    for (const bad of [inherited, accessor, nested, foreignPrototype])
      await expect(compile("", bad as Test262CompileOptions)).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
    expect(delegated).not.toHaveBeenCalled();
  });

  it("rejects inherited target options and strict option accessors before analysis", async () => {
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    let reads = 0;
    const inherited = Object.assign(Object.create({ target: "standalone" }), { wholeProgram: REQUEST });
    const accessor = Object.defineProperty({ wholeProgram: REQUEST }, "target", {
      get() {
        reads++;
        return "standalone";
      },
    });
    await expect(compile("", inherited)).rejects.toThrow(TypeError);
    await expect(compile("", accessor as Test262CompileOptions)).rejects.toThrow(TypeError);
    expect(reads).toBe(0);
    expect(analysis).not.toHaveBeenCalled();
  });

  it("rejects aliased normalized file roots without silently dropping a source", async () => {
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    await expect(
      compileMulti(
        {
          "entry.ts": "export function a(): number { return 1; }",
          "./entry.ts": "export function b(): number { return 2; }",
        },
        "entry.ts",
        options(),
      ),
    ).rejects.toThrow("duplicate normalized source name");
    expect(analysis).not.toHaveBeenCalled();
  });

  it("observes only the identical finalized result, with detached immutable metadata and copied bytes", async () => {
    const result = await compile("export function value(): number { return 1; }", options());
    expect(result.success).toBe(true);
    const first = requiredPreparedFinalArtifactObservation(result)!;
    expect(first).toBeDefined();
    expect(requiredPreparedEmission({ ...result })).toBeUndefined();
    expect(requiredPreparedFinalArtifactObservation({ ...result })).toBeUndefined();
    first.binary[0] = first.binary[0]! ^ 255;
    const again = requiredPreparedFinalArtifactObservation(result)!;
    expect(again.binary).toEqual(result.binary);
    expect(again.binary).not.toBe(first.binary);
    const saved = result.binary[0]!;
    result.binary[0] = saved ^ 255;
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    result.binary[0] = saved;
    expect(requiredPreparedEmission(result)).toBeUndefined();
  });

  it.each([
    "binary",
    "success",
    "errors",
    "imports",
    "targetProfile",
    "adapterManifest",
    "hostImportInventory",
  ] as const)("retires observation on %s metadata mutation", async (field) => {
    const result = await compile("export function value(): number { return 1; }", options());
    expect(result.success).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(result, field)!;
    Object.defineProperty(result, field, {
      ...descriptor,
      value: field === "success" ? false : field === "binary" ? new Uint8Array(result.binary) : {},
    });
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    Object.defineProperty(result, field, descriptor);
    expect(requiredPreparedEmission(result)).toBeUndefined();
  });

  it("does not evaluate a newly installed binary accessor while rejecting mutation", async () => {
    const result = await compile("export function value(): number { return 1; }", options());
    let reads = 0;
    Object.defineProperty(result.binary, "length", {
      get() {
        reads++;
        return 0;
      },
    });
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("reanalyzes all incremental strict roots and never reuses a prior emission receipt", async () => {
    const forbidden = forbidDirectGenerators();
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const incremental = createIncrementalCompiler(options("linear"));
    try {
      const first = await incremental.compileMulti(GRAPH, "./entry.ts");
      const edited = { ...GRAPH, "./fixture.ts": "export function twice(x: number): number { return x * 3; }\n" };
      const second = await incremental.compileMulti(edited, "./entry.ts");
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(analysis).toHaveBeenCalledTimes(2);
      expect(analysis.mock.calls[1]![0]).toEqual(edited);
      expect(requiredPreparedEmission(first)).not.toBe(requiredPreparedEmission(second));
      expect(requiredPreparedEmission(first)?.units.sources).toHaveLength(3);
      expect(requiredPreparedEmission(second)?.units.sources).toHaveLength(3);
      const third = await incremental.compile("export function third(): number { return 3; }");
      expect(third.success).toBe(true);
      expect(requiredPreparedEmission(third)?.units.sources).toHaveLength(1);
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally {
      incremental.dispose();
    }
    await expect(incremental.compile("")).rejects.toThrow("disposed");
  });

  it("keeps strict incremental defaults after caller deletion and mutation", async () => {
    const forbidden = forbidDirectGenerators();
    const legacyFactory = vi.spyOn(legacy, "createIncrementalCompiler");
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const request = { ...REQUEST };
    const defaults: Test262CompileOptions = { ...options("linear"), wholeProgram: request };
    const incremental = createIncrementalCompiler(defaults);
    try {
      // Mutate the caller graph AFTER factory capture, including its selector.
      Reflect.deleteProperty(defaults, "wholeProgram");
      Reflect.set(request, "version", 2);
      Reflect.set(defaults, "target", "gc");
      Reflect.set(defaults, "backend", "wasmgc");
      Reflect.set(defaults, "sourceMap", true);
      Reflect.set(defaults, "optimize", true);
      const single = await incremental.compile("export function value(): number { return 8; }");
      const multi = await incremental.compileMulti(GRAPH, "./entry.ts");
      expect(single.success).toBe(true);
      expect(multi.success).toBe(true);
      expect(requiredPreparedEmission(single)?.backend).toBe("linear");
      expect(requiredPreparedEmission(multi)?.requestedTarget).toBe("linear");
      expect(presentation).toHaveBeenCalledTimes(2);
      for (const [input] of presentation.mock.calls) {
        expect(input.options.target).toBe("linear");
        expect(input.options.sourceMap).toBe(false);
        expect(input.options.optimize).toBe(false);
      }
      // A strict factory still rejects malformed per-call selection.
      await expect(incremental.compile("", { wholeProgram: undefined })).rejects.toThrow("malformed");
      expect(legacyFactory).not.toHaveBeenCalled();
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally {
      incremental.dispose();
    }
  });

  it.each([undefined, false] as const)(
    "refuses a supplied malformed JS fixture excluded by allowJs=%s",
    async (allowJs) => {
      const forbidden = forbidDirectGenerators();
      const analysis = vi.spyOn(frontend, "analyzeMultiSource");
      const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
      const files = { "./entry.ts": "export function value(): number { return 8; }", "./excluded.js": "const = ;" };
      const result = await compileMulti(files, "./entry.ts", { ...options(), allowJs });
      expect(analysis.mock.calls[0]![0]).toEqual(files);
      const ast = analysis.mock.results[0]!.value as ReturnType<typeof frontend.analyzeMultiSource>;
      expect(ast.sourceFiles.some((source) => source.fileName.endsWith("excluded.js"))).toBe(false);
      expect(result.success).toBe(false);
      expect(result.errors.some((error) => error.code === "prepared-source-graph-incomplete")).toBe(true);
      expect(requiredPreparedFailure(result)?.kind).toBe("adapter-unsupported");
      expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
      expect(requiredPreparedEmission(result)).toBeUndefined();
      expect(presentation).not.toHaveBeenCalled();
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each(["fileName", "text"] as const)("refuses analyzed root %s drift before presentation", async (field) => {
    const original = frontend.analyzeMultiSource;
    vi.spyOn(frontend, "analyzeMultiSource").mockImplementation((...args) => {
      const ast = original(...args);
      const fixture = ast.sourceFiles.find((source) => source.fileName.endsWith("extra.ts"));
      if (!fixture) throw new Error("mandatory genuine extra root absent");
      // Negative drift on a real analyzed graph, never a fabricated positive.
      Reflect.set(fixture, field, field === "fileName" ? "foreign.ts" : "export const changed = 0;");
      return ast;
    });
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const result = await compileMulti(GRAPH, "./entry.ts", options());
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === "prepared-source-graph-incomplete")).toBe(true);
    expect(requiredPreparedFailure(result)?.kind).toBe("adapter-unsupported");
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(presentation).not.toHaveBeenCalled();
  });

  it("detaches and freezes failed-output evidence without exposing the result alias", async () => {
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const source = "export const = ;";
    const result = await compile(source, { ...options(), target: "standalone", backend: "wasmgc" });
    expect(result.success).toBe(false);
    const raw = presentation.mock.results[0]!.value as ReturnType<typeof compiler.runPreparedIrPipelinePresentation>;
    expect(raw.kind).toBe("output-failed");
    const failure = requiredPreparedFailure(result);
    expect(failure?.kind).toBe("output-failed");
    if (failure?.kind !== "output-failed" || raw.kind !== "output-failed")
      throw new Error("mandatory real failed output absent");
    expect(Object.hasOwn(failure, "artifacts")).toBe(false);
    expect(failure).not.toBe(raw);
    expect(failure.errors).not.toBe(raw.errors);
    expect(failure.errors).toEqual(raw.errors);
    expect(failure.errors.length).toBeGreaterThan(0);
    const first = failure.errors[0]!;
    const message = first.message;
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.errors)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, "message", "forged frontend failure")).toBe(false);
    expect(Reflect.set(failure.errors, "length", 0)).toBe(false);
    expect(requiredPreparedFailure(result)).toBe(failure);
    expect(first.message).toBe(message);
    const frontendFailure = requiredPreparedFrontendFailure(result);
    expect(frontendFailure?.phase).toBe("syntax");
    expect(frontendFailure?.backend).toBe("wasmgc");
    expect(frontendFailure?.target).toBe("standalone");
    expect(Reflect.set(frontendFailure!.sources[0]!, "text", "forged source")).toBe(false);
    expect(frontendFailure?.sources[0]?.text).toBe(source);
    // Real CompileResult mutation remains terminally detected; detached data
    // cannot keep the reporter current or reissue evidence after restoration.
    const original = result.errors[0]!.message;
    result.errors[0]!.message = "mutated actual diagnostic";
    expect(requiredPreparedFailure(result)).toBeUndefined();
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    result.errors[0]!.message = original;
    expect(requiredPreparedFailure(result)).toBeUndefined();
  });

  it("freezes detached located IR refusal metadata", async () => {
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const result = await compile("export function make(x: number): () => number { return () => x; }", options());
    expect(result.success).toBe(false);
    const raw = presentation.mock.results[0]!.value as ReturnType<typeof compiler.runPreparedIrPipelinePresentation>;
    const failure = requiredPreparedFailure(result);
    expect(failure).toBeDefined();
    expect(failure).not.toBe(raw);
    expect(Object.isFrozen(failure)).toBe(true);
    if (failure?.kind === "unsupported" && raw.kind === "unsupported") {
      expect(failure.failure).not.toBe(raw.failure);
      expect(failure.failure.location).toEqual(raw.failure.location);
      expect(Object.isFrozen(failure.failure.location)).toBe(true);
      expect(Object.hasOwn(failure.failure, "cause")).toBe(false);
      expect(Reflect.set(failure.failure.location, "line", -1)).toBe(false);
      expect(Reflect.set(failure.failure, "detail", "forged")).toBe(false);
    } else if (failure?.kind === "presentation-unsupported" && raw.kind === "presentation-unsupported") {
      expect(failure.gaps).not.toBe(raw.gaps);
      expect(failure.gaps).toEqual(raw.gaps);
      expect(failure.gaps.length).toBeGreaterThan(0);
      expect(Object.isFrozen(failure.gaps[0])).toBe(true);
      expect(Reflect.set(failure.gaps[0]!, "detail", "forged")).toBe(false);
    } else throw new Error("mandatory genuine located refusal absent");
    expect(requiredPreparedFailure(result)).toBe(failure);
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
  });

  it("preserves the real single-source parser gate for allowJs malformed grammar", async () => {
    const forbidden = forbidDirectGenerators();
    const analysis = vi.spyOn(frontend, "analyzeMultiSource");
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const source = "// literal malformed JavaScript retained\nconst = ;\n";
    const result = await compile(source, {
      ...options(),
      target: "standalone",
      backend: "wasmgc",
      allowJs: true,
      fileName: "test.js",
      strictJsSyntax: false,
    });
    expect(analysis).toHaveBeenCalledOnce();
    expect(analysis.mock.calls[0]![0]).toEqual({ "test.js": source });
    const ast = analysis.mock.results[0]!.value as ReturnType<typeof frontend.analyzeMultiSource>;
    expect(ast.sourceFiles).toHaveLength(1);
    expect(ast.sourceFiles[0]!.text).toBe(source);
    expect(ast.syntacticDiagnostics.length).toBeGreaterThan(0);
    expect(presentation).toHaveBeenCalledOnce();
    const input = presentation.mock.calls[0]![0];
    expect(input.options.allowJs).toBe(true);
    expect(input.options.strictJsSyntax).toBe(true);
    expect(input.options.target).toBe("standalone");
    expect(input.options.sourceMap).toBe(false);
    expect(input.options.optimize).toBe(false);
    expect(input.runEarlyErrorsOnAllowJs).toBe(true);
    expect(result.success).toBe(false);
    expect(requiredPreparedFailure(result)?.kind).toBe("output-failed");
    const failure = requiredPreparedFrontendFailure(result);
    expect(failure?.phase).toBe("syntax");
    expect(failure?.backend).toBe("wasmgc");
    expect(failure?.target).toBe("standalone");
    expect(failure?.sources).toEqual([{ file: "test.js", text: source }]);
    expect(failure?.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of failure!.diagnostics) {
      expect(
        ast.syntacticDiagnostics.some(
          (actual) => actual.category === 1 && actual.code === diagnostic.code && actual.file === ast.entryFile,
        ),
      ).toBe(true);
      expect(result.errors).toContainEqual(diagnostic);
      expect(diagnostic.file).toBe("test.js");
      expect(diagnostic.line).toBeGreaterThan(0);
      expect(diagnostic.column).toBeGreaterThan(0);
    }
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("always performs single-source allowJs early validation without requiring a multi-source opt-in", async () => {
    const forbidden = forbidDirectGenerators();
    const presentation = vi.spyOn(compiler, "runPreparedIrPipelinePresentation");
    const result = await compile("let value = 1; let value = 2;", {
      ...options(),
      allowJs: true,
      fileName: "early.js",
    });
    expect(presentation.mock.calls[0]![0].runEarlyErrorsOnAllowJs).toBe(true);
    expect(result.success).toBe(false);
    const observed = requiredPreparedFrontendFailure(result);
    expect(observed?.phase).toBe("early");
    expect(observed?.diagnostics.length).toBeGreaterThan(0);
    expect(observed?.sources).toEqual([{ file: "early.js", text: "let value = 1; let value = 2;" }]);
    expect(requiredPreparedFailure(result)?.kind).toBe("output-failed");
    const errors = result.errors;
    result.errors = [];
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    result.errors = errors;
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    expect(requiredPreparedFailure(result)).toBeUndefined();
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });

  it("does not certify real hardened or unresolved-import refusals as syntax/early negatives", async () => {
    const hardened = await compile("const o: any = {}; o.__proto__ = {}; export const k = 1;", {
      ...options(),
      hardened: true,
    });
    expect(hardened.success).toBe(false);
    expect(requiredPreparedFailure(hardened)?.kind).toBe("output-failed");
    expect(requiredPreparedFrontendFailure(hardened)).toBeUndefined();
    const resolution = await compileMulti(
      { "./entry.ts": 'import { missing } from "./missing"; export function read(): number { return missing(); }' },
      "./entry.ts",
      options(),
    );
    expect(resolution.success).toBe(false);
    expect(resolution.errors.some((error) => error.code === 2307)).toBe(true);
    expect(requiredPreparedFrontendFailure(resolution)).toBeUndefined();
    expect(requiredPreparedEmission(resolution)).toBeUndefined();
  });

  it("does not mint frontend ownership for an actual engine-rejected final binary", async () => {
    // Deliberately corrupt a REAL emitted artifact before the real engine gate;
    // no fake Program, provider, frontend diagnostic or successful constructor.
    const original = binaryEmitter.emitBinary;
    vi.spyOn(binaryEmitter, "emitBinary").mockImplementation((module) => {
      const bytes = original(module).slice();
      bytes[0] = bytes[0]! ^ 255;
      return bytes;
    });
    const result = await compile("export function value(): number { return 1; }", options());
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.code === "invalid-module")).toBe(true);
    expect(requiredPreparedFailure(result)?.kind).toBe("output-failed");
    expect(requiredPreparedFrontendFailure(result)).toBeUndefined();
    expect(requiredPreparedEmission(result)).toBeUndefined();
    expect(requiredPreparedFinalArtifactObservation(result)).toBeUndefined();
  });

  it("delegates omitted multi-source and incremental selectors with unchanged caller operands", async () => {
    const multi = vi.spyOn(legacy, "compileMulti");
    const defaults = { emitWat: false, optimize: false };
    const result = await compileMulti(GRAPH, "./entry.ts", defaults);
    expect(multi).toHaveBeenCalledWith(GRAPH, "./entry.ts", defaults);
    expect(requiredPreparedEmission(result)).toBeUndefined();
    const factory = vi.spyOn(legacy, "createIncrementalCompiler");
    const incremental = createIncrementalCompiler(defaults);
    expect(factory).toHaveBeenCalledWith(defaults);
    const actual = factory.mock.results[0]!.value as ReturnType<typeof legacy.createIncrementalCompiler>;
    const singleCall = vi.spyOn(actual, "compile");
    const multiCall = vi.spyOn(actual, "compileMulti");
    const dispose = vi.spyOn(actual, "dispose");
    try {
      const callOptions = { fileName: "legacy.ts" };
      const single = await incremental.compile("export function value(): number { return 1; }", callOptions);
      expect(singleCall).toHaveBeenCalledWith("export function value(): number { return 1; }", callOptions);
      expect(requiredPreparedEmission(single)).toBeUndefined();
      await incremental.compileMulti(GRAPH, "./entry.ts", callOptions);
      expect(multiCall).toHaveBeenCalledWith(GRAPH, "./entry.ts", callOptions);
    } finally {
      incremental.dispose();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("delegates an omitted selector to the unchanged public entry", async () => {
    const delegated = vi.spyOn(legacy, "compile");
    const source = "export function value(): number { return 1; }";
    const settings = { emitWat: false, optimize: false };
    const result = await compile(source, settings);
    expect(delegated).toHaveBeenCalledWith(source, settings);
    expect(result).toBe(
      delegated.mock.results[0]!.value instanceof Promise
        ? await delegated.mock.results[0]!.value
        : delegated.mock.results[0]!.value,
    );
    expect(requiredPreparedEmission(result)).toBeUndefined();
  });
});
