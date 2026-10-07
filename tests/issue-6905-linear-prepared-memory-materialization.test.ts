// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as linearRuntime from "../src/codegen-linear/runtime.js";
import {
  addArrayRuntime,
  addLinearIrVecRuntime,
  addRuntime,
  LINEAR_IR_VEC_INIT_F64_FN,
} from "../src/codegen-linear/runtime.js";
import { compileMultiSource, runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { emitBinary } from "../src/emit/binary.js";
import { compile } from "../src/index.js";
import { resolveLayout } from "../src/emit/resolve-layout.js";
import * as overlay from "../src/ir/backend/linear-integration.js";
import {
  LINEAR_VECTOR_ELEMENTS_OFFSET,
  LINEAR_VECTOR_LENGTH_OFFSET,
  LINEAR_VECTOR_CAPACITY_OFFSET,
} from "../src/ir/analysis/linear-memory-plan.js";
import { forEachInstrDeep } from "../src/ir/nodes.js";
import * as preparation from "../src/ir/program-preparation.js";
import * as consumer from "../src/ir/program-consumer.js";
import { preparedIrProgramOwner, type PreparedIrProgram } from "../src/ir/program.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import { buildCompiledAdapterImports, instantiateWasm } from "../src/runtime.js";

const SOURCE = `export function run(a:number,b:number):number {
  const values=[a,b]; return values[0]+values[1]+values.length;
}`;
const SCALAR_SOURCE = "export function run(a:number,b:number):number { return a+b+2; }";
const ARGS = [1.5, -2.25];
const OPTIONS = { target: "linear", optimize: false, sourceMap: false, moduleName: "issue-6905" } as const;
const TEST_PATH = "tests/issue-6905-linear-prepared-memory-materialization.test.ts";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const rows = new Set<string>();
type Evidence = { phase: string; [key: string]: unknown };
function record(kind: string, data: object) {
  console.log(
    JSON.stringify({ issue: 6905, schemaVersion: 1, kind, ...data }, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    ),
  );
}
function native(a: number, b: number): number {
  const values = [a, b];
  return values[0] + values[1] + values.length;
}
async function row(id: string, lane: string, action: (evidence: Evidence) => Promise<void>) {
  const evidence: Evidence = { phase: "setup", nativeObservation: native(ARGS[0], ARGS[1]), args: ARGS };
  let failure: unknown;
  let passed = false;
  try {
    await action(evidence);
    passed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    rows.add(id);
    record("row", {
      id,
      lane,
      status: passed ? "passed" : "failed",
      evidence,
      failure:
        failure instanceof Error ? { name: failure.name, message: failure.message } : passed ? null : String(failure),
    });
  }
}
beforeAll(() => {
  const helper = "src/codegen-linear/runtime/vector-initialization.ts";
  record("provenance", {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    baseline: "609286c99f06ea7abcfed51aebd33ecaec3f454c",
    testSha256: sha256(readFileSync(TEST_PATH)),
    runtimeSha256: sha256(readFileSync("src/codegen-linear/runtime.ts")),
    helperSha256: existsSync(helper) ? sha256(readFileSync(helper)) : "absent",
    source: SOURCE,
    sourceSha256: sha256(SOURCE),
    scalarSource: SCALAR_SOURCE,
    scalarSourceSha256: sha256(SCALAR_SOURCE),
    logicalFile: "./entry.ts",
    node: process.version,
    v8: process.versions.v8,
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    options: OPTIONS,
    expectedRows: 8,
    sourceRows: 5,
    initializerUnitRows: 3,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => {
  record("population", { count: rows.size, expected: 8, ids: [...rows] });
  expect(rows.size).toBe(8);
});

function input(source: string, evidence: Evidence) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  evidence.diagnostics = { syntactic: ast.syntacticDiagnostics, semantic: ast.diagnostics };
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
    sourcesContent: new Map(ast.sourceFiles.map((file) => [file.fileName, file.text])),
    diagnosticAnchor: ast.entryFile,
    options: OPTIONS,
  };
}
function generatorSpies(poison: boolean) {
  const spies = [
    vi.spyOn(gcCodegen, "generateModule"),
    vi.spyOn(gcCodegen, "generateMultiModule"),
    vi.spyOn(linearCodegen, "generateLinearModule"),
    vi.spyOn(linearCodegen, "generateLinearMultiModule"),
  ] as const;
  if (poison)
    for (const spy of spies)
      spy.mockImplementation(() => {
        throw new Error("shared Prepared source called legacy generator");
      });
  return spies;
}
function overlaySpies() {
  const spies = [
    vi.spyOn(overlay, "prepareLinearIrOverlay"),
    vi.spyOn(overlay, "compileLinearIr"),
    vi.spyOn(overlay, "compileLinearIrFunctions"),
  ];
  for (const spy of spies)
    spy.mockImplementation(() => {
      throw new Error("source control called forbidden overlay");
    });
  return spies;
}
function census(program: PreparedIrProgram) {
  const projection = program.runtime.find((item) => item.backend === "linear" && item.target === "host");
  const retained: { ownerUnitId: string; kind: string; id: number; state: string | null }[] = [];
  for (const fn of projection?.prepared.functions ?? [])
    for (const block of fn.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          if (nested.alloc !== undefined)
            retained.push({
              ownerUnitId: fn.unitId,
              kind: nested.kind,
              id: nested.alloc,
              state: program.allocations.entries[nested.alloc]?.state ?? null,
            });
        });
  return {
    sealed: program.sealed,
    units: [...program.units.keys()],
    sources: program.inventory.sources,
    projectedUnits: projection?.prepared.functions.map((fn) => fn.unitId) ?? [],
    allocations: program.allocations,
    retained,
  };
}
type Artifact = Pick<Awaited<ReturnType<typeof compileMultiSource>>, "success" | "binary" | "adapterManifest">;
async function execute(artifact: Artifact, evidence: Evidence) {
  const wasmBytes = new Uint8Array(artifact.binary);
  Object.assign(evidence, {
    artifact: {
      success: artifact.success,
      byteLength: artifact.binary.byteLength,
      sha256: sha256(artifact.binary),
      valid: WebAssembly.validate(wasmBytes),
    },
  });
  expect(artifact.success).toBe(true);
  expect(artifact.binary.byteLength).toBeGreaterThan(8);
  expect(WebAssembly.validate(wasmBytes)).toBe(true);
  expect(artifact.adapterManifest).toBeDefined();
  if (!artifact.adapterManifest) throw new Error("missing actual compiler adapter manifest");
  const imports = buildCompiledAdapterImports(artifact.adapterManifest);
  const { instance } = await instantiateWasm(
    wasmBytes,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  const run = instance.exports.run;
  expect(typeof run).toBe("function");
  if (typeof run !== "function") throw new Error("missing emitted run export");
  const actual = run(...ARGS);
  evidence.actual = typeof actual === "bigint" ? actual.toString() : actual;
  evidence.phase = "runtime value";
  expect(actual).toBe(1.25);
}
async function shared(source: string, allocationRequired: boolean, evidence: Evidence) {
  Object.assign(evidence, { source, sourceSha256: sha256(source), phase: "shared analysis", options: OPTIONS });
  const current = input(source, evidence);
  const generators = generatorSpies(true);
  const overlays = overlaySpies();
  const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
  const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
  const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
  try {
    evidence.phase = "shared pipeline";
    const result = runPreparedIrPipelinePresentation(current);
    evidence.pipeline =
      result.kind === "artifacts" ? { kind: result.kind, emittedUnitIds: result.emission.emittedUnitIds } : result;
    const prepared = prepare.mock.results[0];
    if (prepared?.type === "return" && prepared.value.kind === "prepared")
      evidence.preparedCensus = census(prepared.value.program);
    const accepted = accept.mock.results[0];
    if (accepted?.type === "return")
      evidence.acceptance = consumer.isAuthenticAcceptedIrProgram(accepted.value)
        ? { authentic: true, kind: accepted.value.kind }
        : accepted.value;
    expect(result.kind, JSON.stringify(evidence.pipeline)).toBe("artifacts");
    if (result.kind !== "artifacts") throw new Error(JSON.stringify(evidence.pipeline));
    expect(prepare).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    if (prepared?.type !== "return" || prepared.value.kind !== "prepared")
      throw new Error("missing real prepared program");
    expect(prepared.value.program).toBe(result.program);
    if (accepted?.type !== "return" || !consumer.isAuthenticAcceptedIrProgram(accepted.value))
      throw new Error("missing authentic acceptance");
    expect(accepted.value.program).toBe(result.program);
    expect(accept.mock.calls[0][0]).toBe(result.program);
    expect(emit).toHaveBeenCalledWith(accepted.value);
    const emitted = emit.mock.results[0];
    if (emitted?.type !== "return") throw new Error("missing actual emission");
    expect(emitted.value).toBe(result.emission);
    evidence.exactProgramAcceptanceEmissionIdentity = true;
    for (const spy of [...generators, ...overlays]) expect(spy).not.toHaveBeenCalled();
    const actualCensus = census(result.program);
    expect(actualCensus.sealed).toBe(true);
    expect(actualCensus.sources).toHaveLength(1);
    expect(actualCensus.projectedUnits.length).toBeGreaterThan(0);
    expect(result.emission.emittedUnitIds).toEqual(actualCensus.projectedUnits);
    expect(new Set(result.emission.emittedUnitIds).size).toBe(result.program.units.size);
    for (const id of result.emission.emittedUnitIds) {
      const owner = preparedIrProgramOwner(result.program, id);
      const terminal = result.program.units.get(id);
      expect(owner).toBeDefined();
      expect(terminal?.id).toBe(id);
      if (!owner || !terminal) throw new Error("missing actual emitted owner");
      expect(owner.location.declarationStart).toBe(terminal.declarationStart);
      expect(owner.location.declarationEnd).toBe(terminal.declarationEnd);
      expect(
        current.userSourceFiles.some(
          (file) =>
            file.fileName === owner.sourceFile &&
            file.text.slice(terminal.declarationStart, terminal.declarationEnd).length > 0,
        ),
      ).toBe(true);
    }
    if (allocationRequired) {
      const live = actualCensus.retained.filter((site) => site.state === "live");
      evidence.retainedLiveAllocations = live;
      expect(live.length).toBeGreaterThan(0);
      expect(live.some((site) => site.kind === "vec.new_fixed")).toBe(true);
    }
    evidence.phase = "shared artifact execution";
    await execute(result.artifacts, evidence);
  } finally {
    evidence.receipts = {
      prepare: prepare.mock.calls.length,
      accept: accept.mock.calls.length,
      emit: emit.mock.calls.length,
      generators: generators.map((spy) => spy.mock.calls.length),
      overlays: overlays.map((spy) => spy.mock.calls.length),
    };
    for (const spy of [...generators, ...overlays, prepare, accept, emit]) spy.mockRestore();
  }
}

describe("independent source controls and positive shared allocation requirement", () => {
  it("native JavaScript independently returns literal 1.25", async () =>
    row("native", "native-JS", async (evidence) => {
      evidence.actual = native(1.5, -2.25);
      evidence.phase = "native value";
      expect(evidence.actual).toBe(1.25);
    }));
  it("shared Linear scalar is authentically accepted, emitted and executed", async () =>
    row("shared-scalar", "Prepared-source", async (evidence) => {
      await shared(SCALAR_SOURCE, false, evidence);
    }));
  it("unchanged allocation source executes through proven direct legacy only", async () =>
    row("direct-allocation", "direct-legacy", async (evidence) => {
      const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
      const previous = process.env.JS2WASM_LINEAR_IR;
      const generators = generatorSpies(false);
      const overlays = overlaySpies();
      const options = { ...OPTIONS, experimentalIR: false, disableIrFirst: true };
      try {
        // Vitest restores both prior presence and value, avoiding Node's stringified undefined.
        vi.stubEnv("JS2WASM_LINEAR_IR", "0");
        Object.assign(evidence, {
          phase: "direct compilation",
          source: SOURCE,
          sourceSha256: sha256(SOURCE),
          options,
          flags: { JS2WASM_LINEAR_IR: process.env.JS2WASM_LINEAR_IR },
        });
        const artifact = await compileMultiSource({ "./entry.ts": SOURCE }, "./entry.ts", options);
        evidence.compile = { success: artifact.success, errors: artifact.errors };
        expect(artifact.success, JSON.stringify(artifact.errors)).toBe(true);
        expect(generators[3]).toHaveBeenCalledOnce();
        for (const [index, spy] of generators.entries()) if (index !== 3) expect(spy).not.toHaveBeenCalled();
        for (const spy of overlays) expect(spy).not.toHaveBeenCalled();
        await execute(artifact, evidence);
      } finally {
        evidence.receipts = {
          generators: generators.map((spy) => spy.mock.calls.length),
          overlays: overlays.map((spy) => spy.mock.calls.length),
        };
        for (const spy of [...generators, ...overlays]) spy.mockRestore();
        vi.unstubAllEnvs();
        evidence.environmentRestored = {
          hadFlag,
          hasFlag: Object.hasOwn(process.env, "JS2WASM_LINEAR_IR"),
          previous: previous ?? null,
          restored: process.env.JS2WASM_LINEAR_IR ?? null,
        };
        expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadFlag);
        expect(process.env.JS2WASM_LINEAR_IR).toBe(previous);
      }
    }));
  it("positive shared Linear allocation must be accepted, emitted and return 1.25", async () =>
    row("shared-allocation", "Prepared-source-positive-requirement", async (evidence) => {
      await shared(SOURCE, true, evidence);
    }));
  it("public single-source overlay owns the compiled body and real initializer caller", async () =>
    row("overlay-allocation", "source-overlay-not-Prepared", async (evidence) => {
      const hadFlag = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
      const previous = process.env.JS2WASM_LINEAR_IR;
      const generators = generatorSpies(false);
      const prepare = vi.spyOn(overlay, "prepareLinearIrOverlay");
      const emit = vi.spyOn(overlay, "compileLinearIr");
      const initialize = vi.spyOn(linearRuntime, "addLinearIrVecRuntime");
      const options = { ...OPTIONS, moduleName: "issue-6905.ts", experimentalIR: false, disableIrFirst: true };
      try {
        vi.stubEnv("JS2WASM_LINEAR_IR", "1");
        Object.assign(evidence, {
          phase: "public overlay compilation",
          source: SOURCE,
          sourceSha256: sha256(SOURCE),
          options,
          flags: { JS2WASM_LINEAR_IR: process.env.JS2WASM_LINEAR_IR },
        });
        const artifact = await compile(SOURCE, options);
        evidence.compile = { success: artifact.success, errors: artifact.errors };
        const generated = generators[2].mock.results[0];
        const prepared = prepare.mock.results[0];
        const emitted = emit.mock.results[0];
        if (emitted?.type === "return")
          evidence.bodyAdmission = {
            compiled: emitted.value.compiled,
            rejected: emitted.value.rejected,
            ownerEvidence: emitted.value.ownerEvidence,
          };
        expect(artifact.success, JSON.stringify(artifact.errors)).toBe(true);
        expect(generators[2]).toHaveBeenCalledOnce();
        for (const [index, spy] of generators.entries()) if (index !== 2) expect(spy).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledOnce();
        expect(initialize).toHaveBeenCalledOnce();
        if (generated?.type !== "return" || prepared?.type !== "return" || emitted?.type !== "return")
          throw new Error("missing current compilation module/preparation/emission");
        const module = generated.value;
        const context = prepare.mock.calls[0][0];
        expect(context.mod).toBe(module);
        expect(initialize.mock.calls[0][0]).toBe(module);
        expect(prepared.value.context).toBe(context);
        expect(prepared.value.sourceFile).toBe(prepare.mock.calls[0][1]);
        expect(prepared.value.sourceFile.text).toBe(SOURCE);
        expect(emit.mock.calls[0][0]).toBe(context);
        expect(emit.mock.calls[0][3]).toBe(prepared.value);
        const helper = module.functions.find((fn) => fn.name === LINEAR_IR_VEC_INIT_F64_FN);
        if (!helper) throw new Error("current production module has no vector initializer");
        evidence.initializer = {
          name: helper.name,
          signature: module.types[helper.typeIdx],
          locals: helper.locals,
          body: helper.body,
        };
        expect(module.types[helper.typeIdx]).toMatchObject({
          kind: "func",
          params: [{ kind: "f64" }, { kind: "i32" }, { kind: "i32" }],
          results: [],
        });
        expect(helper.locals).toEqual([]);
        expect(helper.body).toEqual(EXPECTED_INITIALIZER);
        expect(emitted.value.compiled).toEqual(["run"]);
        expect(emitted.value.rejected).toEqual([]);
        const owners = emitted.value.ownerEvidence.filter((owner) => owner.outcome === "compiled");
        expect(owners).toHaveLength(1);
        const owner = owners[0];
        const body = emitted.value.funcs.get(owner.ownerUnitId);
        if (!body) throw new Error("current overlay has no admitted run body");
        expect(body.name).toBe("run");
        expect(module.functions).toContain(body);
        const slot = emitted.value.legacySlots.find((entry) => entry.ownerUnitId === owner.ownerUnitId);
        if (!slot) throw new Error("current admitted owner has no legacy slot");
        const declaration = emit.mock.calls[0][2].find((entry) => entry.funcIdx === slot.funcIdx)?.declaration;
        expect(declaration).toBeDefined();
        expect(declaration).toBe(
          prepared.value.ownerIndex.owners.find((entry) => entry.ownerUnitId === owner.ownerUnitId)?.declaration,
        );
        const runExport = module.exports.find((entry) => entry.name === "run");
        if (!runExport || runExport.desc.kind !== "func") throw new Error("missing current run function export");
        const imported = module.imports.filter((entry) => entry.desc.kind === "func").length;
        const layout = resolveLayout(module);
        expect(module.functions[layout.func(runExport.desc.index) - imported]).toBe(body);
        const initializerCalls = body.body.filter(
          (instruction) =>
            instruction.op === "call" && module.functions[layout.func(instruction.funcIdx) - imported] === helper,
        );
        expect(initializerCalls).toHaveLength(2);
        evidence.currentModuleOwnership = {
          exactContextModule: true,
          exactPreparedIdentity: true,
          exactAdmittedBody: true,
          ownerUnitId: owner.ownerUnitId,
          slot,
          body: body.body,
          initializerCalls,
        };
        await execute(artifact, evidence);
      } finally {
        evidence.receipts = {
          generators: generators.map((spy) => spy.mock.calls.length),
          prepare: prepare.mock.calls.length,
          emit: emit.mock.calls.length,
          initialize: initialize.mock.calls.length,
        };
        for (const spy of [...generators, prepare, emit, initialize]) spy.mockRestore();
        vi.unstubAllEnvs();
        evidence.environmentRestored = {
          hadFlag,
          hasFlag: Object.hasOwn(process.env, "JS2WASM_LINEAR_IR"),
          previous: previous ?? null,
          restored: process.env.JS2WASM_LINEAR_IR ?? null,
        };
        expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadFlag);
        expect(process.env.JS2WASM_LINEAR_IR).toBe(previous);
      }
    }));
});

// Literal unit oracle only; never emitted or passed to a Prepared producer.
const EXPECTED_INITIALIZER: Instr[] = [
  { op: "local.get", index: 1 },
  { op: "local.get", index: 2 },
  { op: "i32.const", value: 8 },
  { op: "i32.mul" },
  { op: "i32.add" },
  { op: "local.get", index: 0 },
  { op: "f64.store", align: 3, offset: 16 },
];
function unitFixture() {
  const module = createEmptyModule();
  module.types.push({ kind: "func", params: [], results: [] });
  module.imports.push({ module: "issue6905", name: "harmless", desc: { kind: "func", typeIdx: 0 } });
  addRuntime(module, { exposeArenaReset: true });
  addArrayRuntime(module);
  addLinearIrVecRuntime(module);
  const imported = module.imports.filter((item) => item.desc.kind === "func").length;
  for (const name of [LINEAR_IR_VEC_INIT_F64_FN, "__arr_new", "__malloc"]) {
    const position = module.functions.findIndex((fn) => fn.name === name);
    if (position < 0) throw new Error(`missing real ${name}`);
    module.exports.push({ name, desc: { kind: "func", index: imported + position } });
  }
  const initializer = module.functions.find((fn) => fn.name === LINEAR_IR_VEC_INIT_F64_FN);
  if (!initializer) throw new Error("missing actual initializer");
  const heap = module.globals.findIndex((global) => global.name === "__heap_ptr");
  if (heap < 0) throw new Error("missing heap");
  module.exports.push({ name: "heap", desc: { kind: "global", index: heap } });
  return { module, initializer, imported };
}
function unitArtifact(fixture: ReturnType<typeof unitFixture>) {
  const binary = emitBinary(fixture.module);
  const bytes = new Uint8Array(binary);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = new WebAssembly.Module(bytes);
  return {
    module,
    witness: {
      sha256: sha256(binary),
      binaryBase64: Buffer.from(binary).toString("base64"),
      byteLength: binary.byteLength,
      valid: true,
      imports: WebAssembly.Module.imports(module),
      exports: WebAssembly.Module.exports(module),
    },
  };
}
describe("actual existing vector initializer API — unit-only, not Prepared coverage", () => {
  it("registers the exact ABI/seven instructions once", async () =>
    row("unit-abi", "runtime-unit", async (evidence) => {
      const fixture = unitFixture();
      const before = fixture.module.functions.length;
      addLinearIrVecRuntime(fixture.module);
      const artifact = unitArtifact(fixture);
      Object.assign(evidence, {
        phase: "unit ABI",
        artifact: artifact.witness,
        name: fixture.initializer.name,
        signature: fixture.module.types[fixture.initializer.typeIdx],
        body: fixture.initializer.body,
        locals: fixture.initializer.locals,
        beforeFunctions: before,
        afterFunctions: fixture.module.functions.length,
      });
      expect(fixture.module.functions.length).toBe(before);
      expect(fixture.module.functions.filter((fn) => fn.name === LINEAR_IR_VEC_INIT_F64_FN)).toEqual([
        fixture.initializer,
      ]);
      expect(fixture.module.types[fixture.initializer.typeIdx]).toMatchObject({
        kind: "func",
        params: [{ kind: "f64" }, { kind: "i32" }, { kind: "i32" }],
        results: [],
      });
      expect(fixture.initializer.locals).toEqual([]);
      expect(fixture.initializer.body).toEqual(EXPECTED_INITIALIZER);
      expect(fixture.initializer.body).toHaveLength(7);
    }));
  it("allocates fresh body arrays and every instruction object across modules", async () =>
    row("unit-freshness", "runtime-unit", async (evidence) => {
      const first = unitFixture();
      const second = unitFixture();
      evidence.originalArtifacts = [unitArtifact(first).witness, unitArtifact(second).witness];
      const distinct = first.initializer.body.map(
        (instruction, index) => instruction !== second.initializer.body[index],
      );
      Object.assign(evidence, {
        phase: "unit freshness",
        distinctArrays: first.initializer.body !== second.initializer.body,
        distinctInstructions: distinct,
      });
      expect(first.initializer.body).toEqual(second.initializer.body);
      expect(first.initializer.body).not.toBe(second.initializer.body);
      expect(distinct).toEqual(Array(7).fill(true));
      const instruction = first.initializer.body[0];
      if (instruction.op !== "local.get") throw new Error("unexpected first initializer instruction");
      instruction.index = 99;
      first.initializer.body.push({ op: "nop" });
      const third = unitFixture();
      Object.assign(evidence, {
        mutation: first.initializer.body,
        unaffectedSecond: second.initializer.body,
        subsequentThird: third.initializer.body,
        subsequentArtifact: unitArtifact(third).witness,
      });
      expect(second.initializer.body).toEqual(EXPECTED_INITIALIZER);
      expect(third.initializer.body).toEqual(EXPECTED_INITIALIZER);
      expect(third.initializer.body).not.toBe(second.initializer.body);
      for (const [index, item] of third.initializer.body.entries())
        expect(item).not.toBe(second.initializer.body[index]);
    }));
  it("executes fractional stores into real fresh vectors with import offset and unchanged surrounding bytes", async () =>
    row("unit-runtime", "runtime-unit", async (evidence) => {
      const fixture = unitFixture();
      const artifact = unitArtifact(fixture);
      evidence.artifact = artifact.witness;
      let harmlessCalls = 0;
      const instance = await WebAssembly.instantiate(artifact.module, {
        issue6905: {
          harmless: () => {
            harmlessCalls++;
          },
        },
      });
      const e = instance.exports;
      const memory = e.memory as WebAssembly.Memory;
      const allocate = e.__arr_new as (capacity: number) => number;
      const malloc = e.__malloc as (bytes: number) => number;
      const initialize = e[LINEAR_IR_VEC_INIT_F64_FN] as (value: number, pointer: number, index: number) => void;
      const used = e.__arena_used as () => number;
      const heap = e.heap as WebAssembly.Global;
      const first = allocate(4) >>> 0;
      const second = allocate(4) >>> 0;
      const neighbor = malloc(32) >>> 0;
      new Uint8Array(memory.buffer, neighbor, 32).fill(0x93);
      for (const pointer of [first, second])
        new Uint8Array(memory.buffer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET, 32).fill(0xa5);
      const before = new Uint8Array(memory.buffer).slice();
      const beforeState = { heap: Number(heap.value), used: used(), bytes: before.length, sha256: sha256(before) };
      const writes = [
        { pointer: first, index: 0, value: 1.5 },
        { pointer: first, index: 1, value: -2.25 },
        { pointer: second, index: 0, value: -2.25 },
        { pointer: second, index: 1, value: 1.5 },
      ];
      for (const write of writes) initialize(write.value, write.pointer, write.index);
      const after = new Uint8Array(memory.buffer).slice();
      const view = new DataView(memory.buffer);
      const headers = [first, second].map((pointer) => ({
        pointer,
        tag: view.getUint32(pointer, true),
        length: view.getUint32(pointer + LINEAR_VECTOR_LENGTH_OFFSET, true),
        capacity: view.getUint32(pointer + LINEAR_VECTOR_CAPACITY_OFFSET, true),
        before: Array.from(before.slice(pointer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET)),
        after: Array.from(after.slice(pointer, pointer + LINEAR_VECTOR_ELEMENTS_OFFSET)),
      }));
      const observed = writes.map((write) => ({
        ...write,
        actual: view.getFloat64(write.pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + write.index * 8, true),
      }));
      const exported = fixture.module.exports.find((entry) => entry.name === LINEAR_IR_VEC_INIT_F64_FN);
      if (!exported) throw new Error("missing initializer export binding");
      const index = resolveLayout(fixture.module).func(exported.desc.index);
      Object.assign(evidence, {
        phase: "unit runtime",
        importedFunctionCount: fixture.imported,
        initializerIndex: index,
        actualDefinedName: fixture.module.functions[index - fixture.imported]?.name,
        harmlessCalls,
        first,
        second,
        neighbor,
        before: beforeState,
        after: { heap: Number(heap.value), used: used(), bytes: after.length, sha256: sha256(after) },
        headers,
        observed,
        neighborBefore: Array.from(before.slice(neighbor, neighbor + 32)),
        neighborAfter: Array.from(after.slice(neighbor, neighbor + 32)),
      });
      expect(fixture.imported).toBe(1);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(fixture.module.functions[index - fixture.imported]).toBe(fixture.initializer);
      expect(harmlessCalls).toBe(0);
      expect(first).not.toBe(second);
      expect(Number(heap.value)).toBe(beforeState.heap);
      expect(used()).toBe(beforeState.used);
      expect(after.length).toBe(before.length);
      for (const header of headers) {
        expect(header).toMatchObject({ tag: 1, length: 0, capacity: 4 });
        expect(header.after).toEqual(header.before);
      }
      const expected = before.slice();
      const expectedView = new DataView(expected.buffer);
      for (const write of writes)
        expectedView.setFloat64(write.pointer + LINEAR_VECTOR_ELEMENTS_OFFSET + write.index * 8, write.value, true);
      expect(observed.map((write) => write.actual)).toEqual(writes.map((write) => write.value));
      expect(after).toEqual(expected);
    }));
});
