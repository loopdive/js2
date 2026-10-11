// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import type { PreparedIrPresentationArtifacts } from "../src/compiler/ir-program-presentation.js";
import { buildCompiledAdapterImports, instantiateWasm } from "../src/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import * as typed from "../src/ir/program-prepare-ir.js";
import * as middleend from "../src/ir/program-middleend-ir.js";
import * as encoding from "../src/ir/analysis/encoding.js";
import * as ownership from "../src/ir/analysis/ownership.js";
import * as escapeAnalysis from "../src/ir/analysis/escape.js";
import * as legacy from "../src/ir/passes/gvn.js";
import { createGvnCounters } from "../src/ir/passes/gvn-core.js";
import type { IrPreparationControls } from "../src/ir/program/controls.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";

type Backend = "wasmgc" | "linear";
const APPLICATION: Record<string, string> = {
  "./model.ts": "export function polynomial(x: number, target: number): number {\n  return x * x - target;\n}\n",
  "./metrics.ts": "export function absolute(value: number): number {\n  return value < 0 ? -value : value;\n}\n",
  "./solver.ts":
    'import { polynomial } from "./model";\nimport { absolute } from "./metrics";\nexport function bisect(target: number, lo: number, hi: number, tolerance: number, maxIterations: number): number {\n  if (tolerance <= 0 || maxIterations <= 0 || lo >= hi) return -1;\n  let left = polynomial(lo, target);\n  const right = polynomial(hi, target);\n  if (left === 0) return lo;\n  if (right === 0) return hi;\n  if (left * right > 0) return -1;\n  let count = 0;\n  while (count < maxIterations) {\n    const mid = (lo + hi) / 2;\n    const value = polynomial(mid, target);\n    if (absolute(value) <= tolerance || (hi - lo) / 2 <= tolerance) return mid;\n    if (left * value > 0) {\n      lo = mid;\n      left = value;\n    } else {\n      hi = mid;\n    }\n    count = count + 1;\n  }\n  return (lo + hi) / 2;\n}\n',
  "./entry.ts":
    'import { bisect } from "./solver";\nimport { polynomial } from "./model";\nexport function estimate(target: number, lo: number, hi: number, tolerance: number, maxIterations: number): number {\n  return bisect(target, lo, hi, tolerance, maxIterations);\n}\nexport function residual(x: number, target: number): number {\n  return polynomial(x, target);\n}\n',
};
const SOURCE_PINS = [
  {
    logical: "./model.ts",
    bytes: 91,
    sha256: "0370f7d60d9d90c1c9261edab68d018fcba02b0cd551f21f42dff17b0749d453",
  },
  {
    logical: "./metrics.ts",
    bytes: 89,
    sha256: "588dbcb0d26b1878ecf6c019959772471c0fc9cdcff58d049dec67bd44e586fb",
  },
  {
    logical: "./solver.ts",
    bytes: 786,
    sha256: "9a61967126deff453dc57c3a319e67776458fc6f0ee0ac17281e5620fb9ab376",
  },
  {
    logical: "./entry.ts",
    bytes: 347,
    sha256: "535f911bc1c18eb9b667cf27a2240b44191e366bf6617625d7c07d7e74031454",
  },
];
const APPLICATION_CALLS = [
  {
    id: "sqrt2",
    name: "estimate",
    args: [2, 0, 2, 1e-10, 80],
  },
  {
    id: "sqrt49",
    name: "estimate",
    args: [49, 0, 10, 1e-10, 80],
  },
  {
    id: "sqrtQuarter",
    name: "estimate",
    args: [0.25, 0, 1, 1e-10, 80],
  },
  {
    id: "sqrtMillion",
    name: "estimate",
    args: [1000000, 0, 2000, 1e-10, 80],
  },
  {
    id: "invalidBracket",
    name: "estimate",
    args: [4, 3, 5, 1e-10, 80],
  },
  {
    id: "limitedTwo",
    name: "estimate",
    args: [2, 0, 2, 1e-10, 2],
  },
  {
    id: "exactResidual",
    name: "residual",
    args: [3, 9],
  },
  {
    id: "dynamicResidual",
    name: "residual",
    args: [2, 2],
  },
];
// Independently frozen native/math oracle, before any compiler application results.
const APPLICATION_VALUES = [1.4142135623842478, 7.000000000043656, 0.5, 1000, -1, 1.25, 0, 2];

type Call = { name: string; args: number[] };
type Artifact = PreparedIrPresentationArtifacts;

function input(files: Record<string, string>, backend: Backend) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  expect(ast.diagnostics).toEqual([]);
  return {
    userSourceFiles: ast.sourceFiles,
    entryAst: {
      sourceFile: ast.entryFile,
      checker: ast.checker,
      program: ast.program,
      diagnostics: ast.diagnostics,
      syntacticDiagnostics: ast.syntacticDiagnostics,
    },
    multiAst: ast,
    errors: [],
    codegenOptions: { link: [], sourceMap: false },
    sourcesContent: new Map(ast.sourceFiles.map((source) => [source.fileName, source.text])),
    diagnosticAnchor: ast.entryFile,
    options: {
      target: backend === "linear" ? ("linear" as const) : ("gc" as const),
      sourceMap: false,
      optimize: false,
      moduleName: "whole-program-controls",
    },
  };
}
function prepared(files: Record<string, string>, backend: Backend) {
  const result = runPreparedIrPipelinePresentation(input(files, backend));
  expect(result.kind, JSON.stringify(result)).toBe("artifacts");
  if (result.kind !== "artifacts") throw new Error(JSON.stringify(result));
  expect(result.program.inventory.sources).toHaveLength(Object.keys(files).length);
  expect(result.emission.emittedUnitIds.length).toBeGreaterThan(0);
  return result;
}
function native(files: Record<string, string>, calls: readonly Call[]): number[] {
  const dir = mkdtempSync(join(tmpdir(), "ir-return-native-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(
      join(dir, "run.mjs"),
      `import * as entry from './entry.ts';console.log(JSON.stringify(${JSON.stringify(calls)}.map(c=>entry[c.name](...c.args))));`,
    );
    return childValues(dir, join(dir, "run.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function childValues(dir: string, script: string): number[] {
  const child = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  expect(child.stderr).toBe("");
  const values: unknown = JSON.parse(child.stdout);
  expect(Array.isArray(values)).toBe(true);
  if (!Array.isArray(values)) throw new Error(`non-array child output in ${dir}`);
  return values;
}
async function execute(artifact: Artifact, calls: readonly Call[]) {
  expect(artifact.success).toBe(true);
  expect(artifact.binary.byteLength).toBeGreaterThan(8);
  expect(WebAssembly.validate(new Uint8Array(artifact.binary))).toBe(true);
  expect(artifact.adapterManifest).toBeDefined();
  if (!artifact.adapterManifest) throw new Error("missing adapter manifest");
  const imports = buildCompiledAdapterImports(artifact.adapterManifest);
  const { instance } = await instantiateWasm(
    new Uint8Array(artifact.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  const direct = calls.map((call) => {
    const fn = instance.exports[call.name];
    expect(typeof fn).toBe("function");
    if (typeof fn !== "function") throw new Error(`missing ${call.name}`);
    return fn(...call.args);
  });
  const dir = mkdtempSync(join(tmpdir(), "ir-return-helper-"));
  try {
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const helper = artifact.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(helper).not.toBe(artifact.importsHelper);
    writeFileSync(join(dir, "module.imports.mjs"), helper);
    writeFileSync(join(dir, "module.wasm"), artifact.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import{readFileSync}from'node:fs';import{instantiateBytes}from'./module.imports.mjs';const a=await instantiateBytes(readFileSync(new URL('./module.wasm',import.meta.url)));console.log(JSON.stringify(${JSON.stringify(calls)}.map(c=>a.exports[c.name](...c.args))));`,
    );
    return { direct, helper: childValues(dir, join(dir, "run.mjs")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function valuesEqual(actual: readonly unknown[], expected: readonly unknown[]) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) expect(Object.is(actual[i], expected[i]), `call ${i}`).toBe(true);
}

// Observe original analyses around the actual optimizer. Never fabricate a result.
function observeAnalyses(
  operation: () => ReturnType<typeof middleend.optimizePreparedIrProgramIr>,
  controls: IrPreparationControls,
) {
  const encode = vi.spyOn(encoding, "analyzeEncoding");
  const own = vi.spyOn(ownership, "analyzeOwnership");
  const leave = vi.spyOn(escapeAnalysis, "analyzeEscape");
  try {
    const result = operation();
    const count = result.ir.functions.length;
    // There is an initial hygiene encoding stage, then the final function stage.
    expect(encode.mock.calls.length).toBeGreaterThan(count);
    const finalEncoding = encode.mock.calls.slice(-count);
    expect(finalEncoding.map(([fn]) => fn)).toEqual(result.ir.functions);
    expect(own.mock.calls).toHaveLength(controls.ownership || controls.escape ? count : 0);
    expect(leave.mock.calls).toHaveLength(controls.escape ? count : 0);
    for (let index = 0; index < count; index++) {
      const [fn, registry] = finalEncoding[index]!;
      expect(fn).toBe(result.ir.functions[index]);
      expect(encode.mock.calls.every(([, earlierRegistry]) => earlierRegistry === registry)).toBe(true);
      if (controls.ownership || controls.escape) {
        expect(own.mock.calls[index]![0]).toBe(fn);
        expect(own.mock.calls[index]![1]).toBe(registry);
        expect(encode.mock.invocationCallOrder[encode.mock.calls.length - count + index]!).toBeLessThan(
          own.mock.invocationCallOrder[index]!,
        );
      }
      if (controls.escape) {
        expect(leave.mock.calls[index]![0]).toBe(fn);
        expect(leave.mock.calls[index]![1]).toBe(registry);
        expect(own.mock.results[index]!.type).toBe("return");
        expect(leave.mock.calls[index]![2]).toBe(own.mock.results[index]!.value);
        expect(own.mock.invocationCallOrder[index]!).toBeLessThan(leave.mock.invocationCallOrder[index]!);
      }
    }
    return result;
  } finally {
    encode.mockRestore();
    own.mockRestore();
    leave.mockRestore();
  }
}
// These are separate preparations. No spy replaces controls, IR or a return value.
function explicitCore(files: Record<string, string>, backend: Backend, controls: IrPreparationControls) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.diagnostics).toEqual([]);
  expect(ast.syntacticDiagnostics).toEqual([]);
  const policy = { backend, target: "host" as const };
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
  });
  expect(source.kind).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(JSON.stringify(source));
  const packet = captureTypedIrProgramInput(source);
  const counters = createGvnCounters();
  const original = middleend.optimizePreparedIrProgramIr;
  const observed = vi
    .spyOn(middleend, "optimizePreparedIrProgramIr")
    .mockImplementation((data, registry, supplied, actualCounters) => {
      expect(supplied).toEqual(controls);
      expect(supplied).not.toBe(controls); // transaction-owned capture, not caller object identity
      expect(actualCounters).toBe(counters);
      return observeAnalyses(() => original(data, registry, supplied, actualCounters), controls);
    });
  let result;
  try {
    result = typed.prepareTypedIrProgram(packet, { policy, runtimePolicies: [policy], controls }, counters);
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    observed.mockRestore();
  }
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return { source, packet, counters, program: result.program };
}
function assertApplication(program: PreparedIrProgram) {
  assertPreparedIrProgram(program);
  expect(program.inventory.sources).toHaveLength(4);
  expect(program.inventory.terminalUnits).toHaveLength(5);
  expect(program.units.size).toBe(5);
  expect(program.reconciliation).toBe("complete");
  expect(program.allocations.size).toBe(0);
  expect(program.allocations.entries).toEqual([]);
  expect(program.allocations.metadata).toEqual([]);
  const expectedOwners = [
    ["polynomial", "model.ts"],
    ["absolute", "metrics.ts"],
    ["bisect", "solver.ts"],
    ["estimate", "entry.ts"],
    ["residual", "entry.ts"],
  ];
  expect(program.inventory.sources.map((row) => row.sourceKey).sort()).toEqual([
    "entry.ts",
    "metrics.ts",
    "model.ts",
    "solver.ts",
  ]);
  expect(new Set(program.inventory.sources.map((row) => row.id)).size).toBe(4);
  expect(program.inventory.terminalUnits.map((row) => row.displayName).sort()).toEqual(
    expectedOwners.map(([name]) => name).sort(),
  );
  expect([...program.units.keys()]).toEqual(program.inventory.terminalUnits.map((row) => row.id));
  expect(program.derivedUnits).toEqual([]);
  expect(program.ir.functions.map((fn) => fn.unitId)).toEqual(program.inventory.terminalUnits.map((row) => row.id));
  for (const [name, file] of expectedOwners) {
    const owner = program.inventory.terminalUnits.find((row) => row.displayName === name)!;
    const source = program.inventory.sources.find((row) => row.id === owner.sourceId)!;
    expect(source.sourceKey).toBe(file);
    const text = APPLICATION[`./${file}`]!;
    expect(text.slice(owner.declarationStart, owner.declarationEnd)).toContain(`function ${name}(`);
    const callable = program.abi.entries.filter(
      (row) =>
        row.plan.intent.kind === "callable" &&
        row.plan.intent.origin === "source" &&
        row.plan.intent.unitId === owner.id,
    );
    expect(callable).toHaveLength(1);
    expect(callable[0]!.contract.kind).toBe("callable");
    if (file !== "entry.ts") continue;
    const exported = program.abi.entries.filter(
      (row) => row.contract.kind === "export" && row.contract.externalName === name,
    );
    expect(exported).toHaveLength(1);
    const exportContract = exported[0]!.contract;
    if (exportContract.kind !== "export") throw new Error("missing source export");
    const target = program.abi.entries.find((row) => row.plan.id === exportContract.targetId)!;
    expect(target.contract.kind).toBe("callable");
    expect(target.plan.intent.kind).toBe("callable");
    if (target.plan.intent.kind !== "callable") throw new Error("non-callable source export");
    expect(target.plan.intent.unitId ?? target.plan.intent.targetUnitId).toBe(owner.id);
  }
  expect(
    program.abi.entries
      .filter((row) => row.contract.kind === "export")
      .map((row) => (row.contract.kind === "export" ? row.contract.externalName : ""))
      .sort(),
  ).toEqual(["estimate", "residual"]);
  for (const fn of program.ir.functions) {
    expect(program.units.has(fn.unitId) || program.derivedUnits.some((row) => row.id === fn.unitId)).toBe(true);
    expect(verifyIrFunction(fn, undefined, undefined, { verifyDominanceNaive: true })).toEqual([]);
  }
}
function coreValues(program: PreparedIrProgram, backend: Backend, calls: readonly Call[]) {
  const accepted = acceptPreparedIrProgram(program, {
    backend,
    target: "host",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "explicit-typed-core",
  });
  expect(accepted.kind).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  const emitted = emitAcceptedIrProgram(accepted);
  expect(emitted.emittedUnitIds).toEqual([...program.ir.functions.map((fn) => fn.unitId)]);
  expect(emitted.module.imports).toHaveLength(0);
  const bytes = emitBinary(emitted.module);
  expect(bytes.byteLength).toBeGreaterThan(8);
  expect(WebAssembly.validate(new Uint8Array(bytes))).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)));
  return calls.map((call) => {
    const fn = instance.exports[call.name];
    if (typeof fn !== "function") throw new Error(`missing core export ${call.name}`);
    return fn(...call.args);
  });
}
function ambient(controls: IrPreparationControls) {
  vi.stubEnv("JS2WASM_IR_GVN", controls.gvnMode === "off" ? "0" : controls.gvnMode === "on" ? "1" : "poison");
  vi.stubEnv("JS2WASM_IR_OWNERSHIP", controls.ownership ? "1" : "0");
  vi.stubEnv("JS2WASM_IR_ESCAPE", controls.escape ? "1" : "0");
  vi.stubEnv("IR_VERIFY_ALLOC", controls.verifyIntermediateAllocations ? "1" : "0");
  vi.stubEnv("JS2WASM_IR_VERIFY_DOMINANCE_NAIVE", controls.verifyDominanceNaive ? "1" : "0");
}
const selections = [
  { ownership: false, escape: false },
  { ownership: true, escape: false },
  { ownership: false, escape: true },
  { ownership: true, escape: true },
];
let nativeValues: number[];
beforeAll(() => {
  nativeValues = native(APPLICATION, APPLICATION_CALLS);
  valuesEqual(nativeValues, APPLICATION_VALUES);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("delivered whole-program controls with genuine source and original helpers", () => {
  it("pins the unchanged four-module, five-function, eight-call native application oracle", () => {
    for (const pin of SOURCE_PINS) {
      const text = APPLICATION[pin.logical]!;
      expect(Buffer.byteLength(text)).toBe(pin.bytes);
      expect(createHash("sha256").update(text).digest("hex")).toBe(pin.sha256);
    }
    expect(APPLICATION_CALLS).toHaveLength(8);
    valuesEqual(nativeValues, APPLICATION_VALUES);
  });
  for (const backend of ["wasmgc", "linear"] as const) {
    for (const gvnMode of ["off", "on"] as const) {
      for (const selection of selections) {
        it(`${backend} GVN ${gvnMode}, ownership ${selection.ownership}, escape ${selection.escape}: explicit core and separate original private artifacts`, async () => {
          const controls = { ...selection, gvnMode, verifyIntermediateAllocations: true, verifyDominanceNaive: true };
          const core = explicitCore(APPLICATION, backend, controls);
          expect(core.source.ir.functions).toHaveLength(5);
          expect(core.packet.callables.some((row) => row.kind === "import-alias")).toBe(true);
          assertApplication(core.program);
          valuesEqual(coreValues(core.program, backend, APPLICATION_CALLS), nativeValues);
          expect(core.counters.poisoned).toBe(0);
          if (gvnMode === "off") expect(core.counters.functions).toBe(0);
          else expect(core.counters.functions).toBeGreaterThan(0);

          ambient(controls);
          const original = typed.prepareTypedIrProgram;
          const originalOptimizer = middleend.optimizePreparedIrProgramIr;
          let suppliedCounters: Parameters<typeof original>[2];
          const preparation = vi
            .spyOn(typed, "prepareTypedIrProgram")
            .mockImplementation((packet, options, counters) => {
              expect(packet).not.toBe(core.packet);
              expect(options.controls).toEqual(controls);
              suppliedCounters = counters;
              return original(packet, options, counters);
            });
          const optimization = vi
            .spyOn(middleend, "optimizePreparedIrProgramIr")
            .mockImplementation((data, registry, captured, counters) => {
              expect(captured).toEqual(controls);
              expect(counters).toBe(suppliedCounters);
              return observeAnalyses(() => originalOptimizer(data, registry, captured, counters), controls);
            });
          const artifact = prepared(APPLICATION, backend);
          expect(preparation).toHaveBeenCalledTimes(1);
          expect(optimization).toHaveBeenCalledTimes(1);
          expect(suppliedCounters).toBeDefined();
          expect(suppliedCounters).not.toBe(core.counters);
          assertApplication(artifact.program);
          expect(artifact.program).not.toBe(core.program);
          const executed = await execute(artifact.artifacts, APPLICATION_CALLS);
          valuesEqual(executed.direct, nativeValues);
          valuesEqual(executed.helper, nativeValues);
        });
      }
    }
    it(`${backend}: contradictory ambient poison cannot override explicit complete-application controls`, () => {
      const controls = {
        gvnMode: "off" as const,
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      };
      const normal = explicitCore(APPLICATION, backend, controls);
      ambient({
        gvnMode: "poison",
        ownership: true,
        escape: true,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      });
      const observer = vi.fn();
      const unsubscribe = subscribePreparedIrProgram(observer);
      const telemetry = vi.spyOn(legacy, "recordLegacyGvnCountersOnce");
      try {
        const contrary = explicitCore(APPLICATION, backend, controls);
        expect(encodePreparedIrProgram(contrary.program)).toBe(encodePreparedIrProgram(normal.program));
        expect(contrary.counters).toEqual({ functions: 0, merged: 0, poisoned: 0 });
        expect(observer).not.toHaveBeenCalled();
        expect(telemetry).not.toHaveBeenCalled();
        valuesEqual(coreValues(contrary.program, backend, APPLICATION_CALLS), nativeValues);
      } finally {
        unsubscribe();
      }
    });
    it(`${backend}: genuine duplicate expressions merge on GVN and poison produces an observed wrong value`, () => {
      const files = {
        "./entry.ts": "export function main(x: number): number { const a = x + 1; const b = x + 1; return a + b; }",
      };
      const nativeDuplicate = native(files, [{ name: "main", args: [20] }]);
      valuesEqual(nativeDuplicate, [42]);
      for (const gvnMode of ["off", "on", "poison"] as const) {
        const result = explicitCore(files, backend, {
          gvnMode,
          ownership: true,
          escape: true,
          verifyIntermediateAllocations: true,
          verifyDominanceNaive: true,
        });
        const values = coreValues(result.program, backend, [{ name: "main", args: [20] }]);
        if (gvnMode === "poison") {
          expect(result.counters.poisoned).toBeGreaterThan(0);
          expect(Object.is(values[0], nativeDuplicate[0])).toBe(false);
        } else valuesEqual(values, nativeDuplicate);
        if (gvnMode === "on") expect(result.counters.merged).toBeGreaterThan(0);
        if (gvnMode === "off") expect(result.counters.functions).toBe(0);
      }
    });
  }
});
