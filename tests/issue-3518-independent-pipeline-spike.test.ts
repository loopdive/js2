// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Experimental driver, not an async acceptance test or a replacement compiler.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareNumberFormatRuntimeSupport } from "../src/frontend/builtins/prepare-number-format.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import * as compiler from "../src/compiler.js";
import * as generation from "../src/codegen/index.js";
import * as context from "../src/codegen/context/create-context.js";
import * as integration from "../src/ir/integration.js";
import * as selfhost from "../src/codegen/stdlib-selfhost.js";

const fixtureHash = "6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915";
const expectedIdentities: unknown = JSON.parse(
  readFileSync(
    new URL("../plan/agent-context/3518-independent-spike-identities-2026-09-15.json", import.meta.url),
    "utf8",
  ),
);
// Exact first observed failure, retained rather than accepting any refusal.
const expectedDetail =
  "wasmgc:standalone physical setup cannot be materialized (18 gaps): " +
  [
    "async frames do not support wasmgc:standalone",
    "body delay results carries non-scalar IR type extern; physical carrier materialization is not available",
    "body fetchUser__ir_async_state_0 results carries non-scalar IR type extern; physical carrier materialization is not available",
    "runtime callable __ir_promise_delay_native needs runtime function materialization",
    "runtime callable __ir_async_promise_all_native needs runtime function materialization",
    "body delay references runtime callable __ir_promise_delay_native that the plan cannot reserve",
    "body fetchUser__ir_async_state_0 references runtime callable __ir_promise_delay_native that the plan cannot reserve",
    "body fetchAllParallel__ir_async_state_0 references runtime callable __ir_async_promise_all_native that the plan cannot reserve",
    ...Array.from(
      { length: 4 },
      () => "body main references intrinsic callable async.clock.snapshot that the plan cannot reserve",
    ),
    "native Promise inventory missing-runtime-configuration: selected native Promise runtime configuration is unavailable",
    "native Promise inventory producer-declaration: complete native Promise, closure, vector, formatter, frame and boundary producer observations are unavailable",
    "native Promise inventory source-carrier-association: complete source-to-native-carrier associations are unavailable",
    "native Promise inventory dispatch-evidence: native property lookup and callable dispatch owner evidence is unavailable",
    "native Promise inventory construction-contract: independent native producer construction contracts are unavailable",
    "native Promise inventory complete-composition: complete native Promise inventory composition has not been issued",
  ].join("; ");
const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const options = {
  backend: "wasmgc",
  target: "standalone",
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "independent-ir-spike",
  numberFormat: { integerBeforeScratch: true },
} as const;

function forbidLegacyExecution() {
  const calls: string[] = [];
  const reject = (name: string) => () => {
    calls.push(name);
    throw new Error(`SPIKE_LEGACY_EXECUTION:${name}`);
  };
  vi.spyOn(compiler, "compileSource").mockImplementation(reject("compileSource"));
  vi.spyOn(compiler, "compileSourceSync").mockImplementation(reject("compileSourceSync"));
  vi.spyOn(compiler, "compileMultiSource").mockImplementation(reject("compileMultiSource"));
  vi.spyOn(compiler, "compileFilesSource").mockImplementation(reject("compileFilesSource"));
  vi.spyOn(generation, "generateModule").mockImplementation(reject("generateModule"));
  vi.spyOn(generation, "generateMultiModule").mockImplementation(reject("generateMultiModule"));
  vi.spyOn(context, "createCodegenContext").mockImplementation(reject("createCodegenContext"));
  vi.spyOn(integration, "compileIrPathFunctions").mockImplementation(reject("compileIrPathFunctions"));
  vi.spyOn(integration, "compilePreparedProgramComponent").mockImplementation(
    reject("compilePreparedProgramComponent"),
  );
  vi.spyOn(selfhost, "buildSelfHostedIr").mockImplementation(reject("legacyBuildSelfHostedIr"));
  vi.spyOn(selfhost, "emitSelfHostedFunc").mockImplementation(reject("emitSelfHostedFunc"));
  vi.spyOn(selfhost, "emitSelfHostedMathFunc").mockImplementation(reject("emitSelfHostedMathFunc"));
  // Positive control: demonstrate interception before measuring zero calls.
  const controls = [
    ["compileSource", compiler.compileSource],
    ["compileSourceSync", compiler.compileSourceSync],
    ["compileMultiSource", compiler.compileMultiSource],
    ["compileFilesSource", compiler.compileFilesSource],
    ["generateModule", generation.generateModule],
    ["generateMultiModule", generation.generateMultiModule],
    ["createCodegenContext", context.createCodegenContext],
    ["compileIrPathFunctions", integration.compileIrPathFunctions],
    ["compilePreparedProgramComponent", integration.compilePreparedProgramComponent],
    ["legacyBuildSelfHostedIr", selfhost.buildSelfHostedIr],
    ["emitSelfHostedFunc", selfhost.emitSelfHostedFunc],
    ["emitSelfHostedMathFunc", selfhost.emitSelfHostedMathFunc],
  ] as const;
  for (const [name, entry] of controls) {
    expect(() => (entry as unknown as () => unknown)()).toThrow(`SPIKE_LEGACY_EXECUTION:${name}`);
  }
  expect(calls).toEqual(controls.map(([name]) => name));
  calls.length = 0;
  return calls;
}

function prepare(text: string, gvnMode: "off" | "on", fullFamily = true) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    ...(fullFamily
      ? {
          nativeStringValueProjection: "standalone-native" as const,
          promiseDelayProjection: "standalone-native" as const,
          asyncFamilyProjection: "standalone-native" as const,
        }
      : {}),
  });
  if (source.kind !== "prepared") throw new Error(`source preparation: ${JSON.stringify(source)}`);
  const support = prepareNumberFormatRuntimeSupport(source, policy);
  const result = prepareTypedIrProgram(captureTypedIrProgramInput(source, support), {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode,
      ownership: false,
      escape: false,
      verifyIntermediateAllocations: false,
      verifyDominanceNaive: false,
    },
  });
  if (result.kind !== "prepared") throw new Error(`typed preparation: ${JSON.stringify(result)}`);
  return result.program;
}

afterEach(() => vi.restoreAllMocks());

it("executes a scalar control through preparation, ABI, backend and engine with legacy entrypoints poisoned", async () => {
  const calls = forbidLegacyExecution();
  const program = prepare("export function main(): number { return 42; }", "off", false);
  const accepted = acceptPreparedIrProgram(program, options);
  expect(accepted.kind).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  const emitted = emitAcceptedIrProgram(accepted);
  const binary = emitBinary(emitted.module);
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(WebAssembly.Module.exports(module)).toContainEqual({ name: "main", kind: "function" });
  const { instance } = await WebAssembly.instantiate(binary, {});
  expect((instance.exports.main as () => number)()).toBe(42);
  expect(calls).toEqual([]);
  console.log(
    "SPIKE_SCALAR",
    JSON.stringify({
      units: program.units.size,
      functions: program.ir.functions.length,
      abi: program.abi.entries.length,
      bytes: binary.length,
      value: 42,
      legacyCalls: calls,
    }),
  );
});

for (const gvn of ["off", "on"] as const) {
  for (const decoded of [false, true]) {
    it(`records the unchanged async family at its real acceptance boundary, GVN=${gvn}, decoded=${decoded}`, async () => {
      // Allow worker IPC between long synchronous compiler cases; do not mask
      // runner errors or change the compiler/acceptance timeout policy.
      await setImmediate();
      const calls = forbidLegacyExecution();
      const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
      expect(createHash("sha256").update(source).digest("hex")).toBe(fixtureHash);
      const program = prepare(source, gvn);
      const encoded = encodePreparedIrProgram(program);
      const current = decoded ? decodePreparedIrProgram(encoded) : program;
      if (decoded) {
        expect(current).not.toBe(program);
        expect(encodePreparedIrProgram(current)).toEqual(encoded);
      }
      expect(current.units.size).toBe(5);
      expect([...current.units.keys()]).toEqual(
        [0, 1, 2, 3, 4].map(
          (index) =>
            `ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:root:top-level-function:${String(index).padStart(16, "0")}`,
        ),
      );
      expect(current.ir.functions).toHaveLength(16);
      expect(current.ir.functions.map((fn) => fn.name)).toEqual([
        "delay",
        "fetchUser",
        "fetchUser__ir_async_state_0",
        "fetchAllSequential",
        "fetchAllSequential__ir_async_state_0",
        "fetchAllSequential__ir_async_state_1",
        "fetchAllSequential__ir_async_state_2",
        "fetchAllSequential__ir_async_state_3",
        "fetchAllSequential__ir_async_state_4",
        "fetchAllParallel",
        "fetchAllParallel__ir_async_state_0",
        "fetchAllParallel__ir_async_state_1",
        "main",
        "main__ir_async_state_0",
        "main__ir_async_state_1",
        "main__ir_async_state_2",
      ]);
      expect(current.abi.entries).toHaveLength(32);
      expect(current.allocations.size).toBe(29);
      expect({
        units: [...current.units.keys()],
        functions: current.ir.functions.map((fn) => ({ unitId: fn.unitId, name: fn.name })),
      }).toEqual(expectedIdentities);
      expect(current.runtimeSupport?.batches).toHaveLength(1);
      expect(current.runtimeSupport!.batches[0]).toMatchObject({
        kind: "number-format-radix-v1",
        source: {
          definition: "numToStringRadixDef",
          functionName: "__sh_num_toString_radix",
          utf8Bytes: 1618,
          sha256: "7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6",
        },
      });
      expect(current.runtimeSupport!.batches[0]!.implementation.body).toEqual(
        program.runtimeSupport!.batches[0]!.implementation.body,
      );
      const accepted = acceptPreparedIrProgram(current, options);
      expect(accepted).toEqual({
        kind: "unsupported",
        code: "body-shape-rejected",
        stage: "build",
        detail: expectedDetail,
        unitId:
          "ir-unit:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Aentry.ts:root:top-level-function:0000000000000001",
        location: {
          sourceId: "ir-source:v1:0000000000000000:entry:entry.ts",
          line: 17,
          column: 1,
          declarationStart: 676,
          declarationEnd: 844,
        },
        sourceFile: "entry.ts",
      });
      console.log(
        "SPIKE_IDENTITIES",
        JSON.stringify({
          gvn,
          decoded,
          units: [...current.units.keys()],
          functions: current.ir.functions.map((fn) => ({ unitId: fn.unitId, name: fn.name })),
        }),
      );
      console.log(
        "SPIKE_ASYNC",
        JSON.stringify({
          fixtureHash,
          gvn,
          decoded,
          units: current.units.size,
          functions: current.ir.functions.length,
          abi: current.abi.entries.length,
          allocations: current.allocations.size,
          supportBatches: current.runtimeSupport?.batches.length,
          outcome: accepted.kind === "accepted" ? { kind: "accepted" } : accepted,
          legacyCalls: calls,
        }),
      );
      // This pins the actual stop, not success of the async example. If support
      // changes, the experiment must execute/compare it rather than silently pass.
      expect(accepted.kind).toBe("unsupported");
      expect(calls).toEqual([]);
      await setImmediate();
    });
  }
}
