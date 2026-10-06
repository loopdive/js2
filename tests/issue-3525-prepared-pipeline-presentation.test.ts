// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource, type MultiTypedAST } from "../src/checker/index.js";
import { compileMultiSource, runPreparedIrPipelinePresentation } from "../src/compiler.js";
import {
  prepareIrProgramPresentation,
  type IrProgramPresentationRequest,
  type IrProgramPresentationResult,
} from "../src/compiler/ir-program-presentation.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";
import * as binaryEmitter from "../src/emit/binary.js";
import * as preparation from "../src/ir/program-preparation.js";
import * as consumer from "../src/ir/program-consumer.js";
import { subscribePreparedIrProgram, type PreparedIrProgramObservation } from "../src/ir/program-observation.js";
import { preparedIrProgramOwner, type PreparedIrBackendOptions, type PreparedIrProgram } from "../src/ir/program.js";
import type { WasmModule } from "../src/ir/types.js";
import type { CompileOptions } from "../src/index.js";
import { buildCompiledAdapterImports, instantiateWasm } from "../src/runtime.js";
function backendOptions(backend: Backend): PreparedIrBackendOptions {
  return {
    backend,
    target: "host",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "prepared-presentation-control",
  };
}

const BACKENDS = ["wasmgc", "linear"] as const;
type Backend = (typeof BACKENDS)[number];
type Input = Parameters<typeof runPreparedIrPipelinePresentation>[0];
type ArtifactResult = Extract<ReturnType<typeof runPreparedIrPipelinePresentation>, { kind: "artifacts" }>;

const SCALAR = {
  "./entry.ts": "export function calculate(value: number): number { return value * 3 + 2; }",
};
const TWO_SOURCE = {
  "./math.ts": "export function double(x: number): number { return x * 2; }",
  "./entry.ts": 'import { double } from "./math"; export function main(): number { return double(20) + 2; }',
};
const CROSS_SOURCE = {
  "./math.ts": "export function double(x: number): number { return x * 2; }",
  "./entry.ts":
    'import { double } from "./math"; export function calculate(value: number): number { return double(value) + 2; }',
};
const VISITS = {
  "./entry.ts":
    "export var visits: number = (visits > 0 ? visits : 0) + 1; export function read(): number { return visits; }",
};
const USER_INIT = {
  "./entry.ts": `${VISITS["./entry.ts"]} export function __module_init(): number { visits = visits * 10 + 7; return visits; }`,
};
const FIXTURES = [
  {
    name: "scalar",
    files: SCALAR,
    calls: [
      { name: "calculate", args: [7], value: 23 },
      { name: "calculate", args: [11], value: 35 },
    ],
    units: 1,
  },
  { name: "two-source 42", files: TWO_SOURCE, calls: [{ name: "main", args: [], value: 42 }], units: 2 },
  {
    name: "nonconstant cross-source",
    files: CROSS_SOURCE,
    calls: [
      { name: "calculate", args: [7], value: 16 },
      { name: "calculate", args: [11], value: 24 },
    ],
    units: 2,
  },
];

function input(files: Record<string, string>, backend: Backend, overrides: CompileOptions = {}): Input {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  const options: CompileOptions = {
    target: backend === "linear" ? "linear" : "gc",
    sourceMap: false,
    optimize: false,
    moduleName: "prepared-presentation-control",
    ...overrides,
  };
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
    codegenOptions: { link: [], sourceMap: false, deferTopLevelInit: options.deferTopLevelInit },
    sourcesContent: new Map(ast.sourceFiles.map((source) => [source.fileName, source.text])),
    diagnosticAnchor: ast.entryFile,
    options,
  };
}

function request(current: Input, backend: Backend): IrProgramPresentationRequest {
  const ast: MultiTypedAST = current.multiAst!;
  return {
    preparation: {
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend, target: "host" },
      deferTopLevelInit: current.options.deferTopLevelInit === true,
    },
    backendOptions: { ...backendOptions(backend), moduleName: current.options.moduleName! },
    output: current,
  };
}

function expectGap(
  result: IrProgramPresentationResult | ReturnType<typeof runPreparedIrPipelinePresentation>,
  field: string,
  code: string,
): void {
  expect(result.kind, JSON.stringify(result)).toBe("presentation-unsupported");
  if (result.kind !== "presentation-unsupported") throw new Error(`expected ${field}/${code}`);
  expect(result.gaps).toContainEqual(expect.objectContaining({ field, code }));
  expect(result.gaps.every((gap) => gap.detail.length > 0)).toBe(true);
  expect(result).not.toHaveProperty("artifacts");
  expect(result).not.toHaveProperty("emission");
}

function artifacts(current: Input): ArtifactResult {
  const result = runPreparedIrPipelinePresentation(current);
  expect(result.kind, JSON.stringify(result)).toBe("artifacts");
  if (result.kind !== "artifacts") throw new Error(`presentation failed: ${JSON.stringify(result)}`);
  expect(result.artifacts.binary.byteLength).toBeGreaterThan(8);
  expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(true);
  return result;
}

function callable(exports: WebAssembly.Exports, name: string): (...args: number[]) => number {
  const value = exports[name];
  expect(value, name).toBeTypeOf("function");
  if (typeof value !== "function") throw new Error(`missing callable ${name}`);
  return value as (...args: number[]) => number;
}

function instantiate(result: ArtifactResult): WebAssembly.Instance {
  expect(result.emission.module.imports).toEqual([]);
  return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.artifacts.binary)));
}

function poisonGenerators() {
  const poison = () => {
    throw new Error("attached prepared presentation legacy poison");
  };
  return [
    vi.spyOn(gcCodegen, "generateModule").mockImplementation(poison),
    vi.spyOn(gcCodegen, "generateMultiModule").mockImplementation(poison),
    vi.spyOn(linearCodegen, "generateLinearModule").mockImplementation(poison),
    vi.spyOn(linearCodegen, "generateLinearMultiModule").mockImplementation(poison),
  ];
}

function physicalSnapshot(module: WasmModule) {
  return {
    module,
    state: structuredClone(module),
    bytes: emitBinary(module),
    collections: {
      functions: module.functions,
      types: module.types,
      globals: module.globals,
      exports: module.exports,
      imports: module.imports,
      tags: module.tags,
      tables: module.tables,
      elements: module.elements,
      memories: module.memories,
      dataSegments: module.dataSegments,
      stringPool: module.stringPool,
      asyncFunctions: module.asyncFunctions,
      stringLiteralValues: module.stringLiteralValues,
    },
    functions: module.functions.map((fn) => ({ fn, body: fn.body, locals: fn.locals })),
    types: module.types.map((type) => ({
      type,
      params: type.kind === "func" ? type.params : undefined,
      results: type.kind === "func" ? type.results : undefined,
    })),
    globals: [...module.globals],
    exports: [...module.exports],
  };
}

function verifyPhysicalSnapshot(before: ReturnType<typeof physicalSnapshot>, result: ArtifactResult): void {
  const module = result.emission.module;
  expect(module).toBe(before.module);
  expect(module).toEqual(before.state);
  for (const key of Object.keys(before.collections) as (keyof typeof before.collections)[])
    expect(module[key]).toBe(before.collections[key]);
  expect(module.functions).toHaveLength(before.functions.length);
  for (const [index, row] of before.functions.entries()) {
    expect(module.functions[index]).toBe(row.fn);
    expect(module.functions[index]!.body).toBe(row.body);
    expect(module.functions[index]!.locals).toBe(row.locals);
  }
  expect(module.types).toHaveLength(before.types.length);
  for (const [index, row] of before.types.entries()) {
    const type = module.types[index]!;
    expect(type).toBe(row.type);
    if (type.kind === "func") {
      expect(type.params).toBe(row.params);
      expect(type.results).toBe(row.results);
    }
  }
  for (const [index, value] of before.globals.entries()) expect(module.globals[index]).toBe(value);
  for (const [index, value] of before.exports.entries()) expect(module.exports[index]).toBe(value);
  // Byte equality authenticates this serialization; the separate checks above bind physical identities.
  expect(result.artifacts.binary).toEqual(before.bytes);
}

function verifyJoins(result: ArtifactResult, current: Input, backend: Backend, units: number): void {
  const { program, emission } = result;
  expect(program.sealed).toBe(true);
  expect(Object.isFrozen(program)).toBe(true);
  const projection = program.runtime.find((row) => row.backend === backend && row.target === "host");
  expect(projection).toBeDefined();
  if (!projection) throw new Error("missing real host projection");
  expect(emission.emittedUnitIds).toEqual(projection.prepared.functions.map((fn) => fn.unitId));
  expect(emission.emittedUnitIds).toHaveLength(units);
  expect(program.inventory.sources.map((source) => source.originalFileName)).toEqual(
    current.userSourceFiles.map((source) => source.fileName),
  );
  for (const unitId of emission.emittedUnitIds) {
    const owner = preparedIrProgramOwner(program, unitId);
    expect(owner).toBeDefined();
    if (!owner) throw new Error(`unowned emitted unit ${unitId}`);
    const source = current.userSourceFiles.find((file) => file.fileName === owner.sourceFile);
    expect(source).toBeDefined();
    if (!source) throw new Error(`unjoined source ${owner.sourceFile}`);
    const terminal = program.units.get(unitId);
    expect(terminal?.id).toBe(unitId);
    expect(owner.location.declarationStart).toBe(terminal?.declarationStart);
    expect(owner.location.declarationEnd).toBe(terminal?.declarationEnd);
    expect(source.text.slice(owner.location.declarationStart, owner.location.declarationEnd).length).toBeGreaterThan(0);
    expect(owner.location.sourceId).toBe(
      program.inventory.sources.find((row) => row.originalFileName === owner.sourceFile)?.id,
    );
  }
  for (const entry of program.abi.entries) {
    if (entry.contract.kind !== "export") continue;
    const exportContract = entry.contract;
    const target = program.abi.entries.find((row) => row.plan.id === exportContract.targetId);
    expect(target).toBeDefined();
    if (!target || target.contract.kind !== "callable") continue;
    const index = consumer.emittedProgramBindingIndex(emission, target.plan.id);
    expect(index?.space).toBe("function");
    expect(emission.module.exports).toContainEqual({
      name: entry.contract.externalName,
      desc: { kind: "func", index: index?.index },
    });
    const slot = emission.module.functions[index!.index];
    expect(slot).toBeDefined();
    const signature = emission.module.types[slot!.typeIdx];
    expect(signature?.kind).toBe("func");
    if (signature?.kind !== "func") throw new Error("export is not a genuine function type");
    expect(signature.params).toHaveLength(target.contract.params.length);
    expect(signature.results).toHaveLength(target.contract.results.length);
  }
  expect(emission.module.exportSignatures).toBeUndefined();
  expect(result.artifacts.exportSignatures).toBeUndefined();
  expect(emission.module.asyncFunctions.size).toBe(0);
  expect(result.artifacts.imports).toEqual([]);
  expect(result.artifacts.hostImportInventory).toEqual([]);
  expect(result.artifacts.capabilityProviderDiagnostics).toEqual([]);
  expect(result.artifacts.hasTopLevelStatements).toBe(false);
  expect(result.artifacts.wit).toBeUndefined();
  expect(result.startup).toEqual({ kind: "none", hasTopLevelStatements: false });
  for (const key of [
    "fallbackCounts",
    "irPostClaimErrors",
    "irCompiledFuncs",
    "irFirstSkipped",
    "irOutcomes",
    "irBodyRouteAudit",
  ])
    expect(result.artifacts).not.toHaveProperty(key);
}

async function generatedHelperRead(result: ArtifactResult): Promise<{ before: number; after: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ir-prepared-presentation-helper-"));
  try {
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const helper = result.artifacts.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(helper).not.toBe(result.artifacts.importsHelper);
    writeFileSync(join(dir, "module.imports.mjs"), helper);
    writeFileSync(join(dir, "module.wasm"), result.artifacts.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { readFileSync } from "node:fs";\nimport { instantiateBytes } from "./module.imports.mjs";\nconst result = await instantiateBytes(readFileSync(new URL("./module.wasm", import.meta.url)));\nconst before = result.exports.read();\nresult.imports.setInstance?.(result.instance);\nconst after = result.exports.read();\nconsole.log(JSON.stringify({before,after}));\n`,
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs")], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout.trim()) as { before: number; after: number };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function helperManifestSection(helper: string): { prefix: string; suffix: string; manifest: unknown } {
  const marker = "const adapterManifest = ";
  const start = helper.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  expect(helper.indexOf(marker, start + marker.length)).toBe(-1);
  const end = helper.indexOf(";\n\nexport function createImports", start);
  expect(end).toBeGreaterThan(start);
  return {
    prefix: helper.slice(0, start),
    suffix: helper.slice(end),
    manifest: JSON.parse(helper.slice(start + marker.length, end)),
  };
}

async function generatedHelperCalls(
  artifact: Pick<ArtifactResult["artifacts"], "importsHelper" | "binary">,
  calls: readonly { name: string; args: number[]; value: number }[],
): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "ir-prepared-presentation-values-"));
  try {
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const helper = artifact.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(helper).not.toBe(artifact.importsHelper);
    writeFileSync(join(dir, "module.imports.mjs"), helper);
    writeFileSync(join(dir, "module.wasm"), artifact.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { readFileSync } from "node:fs";\nimport { instantiateBytes } from "./module.imports.mjs";\nconst result = await instantiateBytes(readFileSync(new URL("./module.wasm", import.meta.url)));\nconst calls = ${JSON.stringify(calls)};\nconsole.log(JSON.stringify(calls.map(call => result.exports[call.name](...call.args))));\n`,
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs")], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

describe("#3525 internal genuine prepared-pipeline presentation", () => {
  for (const backend of BACKENDS) {
    for (const fixture of FIXTURES) {
      it(`executes ${fixture.name} through real ${backend}/host preparation, emission and finalization`, () => {
        const current = input(fixture.files, backend);
        const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
        const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
        const originalEmit = consumer.emitAcceptedIrProgram;
        let before: ReturnType<typeof physicalSnapshot> | undefined;
        const emit = vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementation((accepted) => {
          const emitted = originalEmit(accepted);
          before = physicalSnapshot(emitted.module);
          return emitted;
        });
        const events: PreparedIrProgramObservation[] = [];
        const unsubscribe = subscribePreparedIrProgram((event) => events.push(event));
        const poisons = poisonGenerators();
        try {
          const result = artifacts(current);
          const instance = instantiate(result);
          for (const call of fixture.calls)
            expect(callable(instance.exports, call.name)(...call.args)).toBe(call.value);
          verifyJoins(result, current, backend, fixture.units);
          expect(before).toBeDefined();
          if (!before) throw new Error("missing actual pre-finalizer emission snapshot");
          verifyPhysicalSnapshot(before, result);
          expect(prepare).toHaveBeenCalledOnce();
          expect(accept).toHaveBeenCalledOnce();
          expect(emit).toHaveBeenCalledOnce();
          expect(events.map((event) => event.phase)).toEqual(["prepared", "accepted", "emission-started", "emitted"]);
          for (const event of events) {
            expect(event.program).toBe(result.program);
            expect(event.programId).toBe(events[0]!.programId);
            expect(event.backend).toBe(backend);
            expect(event.target).toBe("host");
          }
          const acceptance = accept.mock.results[0]!.value;
          expect(consumer.isAuthenticAcceptedIrProgram(acceptance)).toBe(true);
          expect(acceptance.program).toBe(result.program);
          expect(emit.mock.results[0]!.value).toBe(result.emission);
          for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
        } finally {
          unsubscribe();
        }
      });
      it(`matches genuine legacy ${fixture.name} values and presentation on ${backend}/host`, async () => {
        const current = input(fixture.files, backend);
        const legacy = await compileMultiSource(fixture.files, "./entry.ts", current.options);
        expect(legacy.success, JSON.stringify(legacy.errors)).toBe(true);
        expect(legacy.adapterManifest).toBeDefined();
        if (!legacy.adapterManifest) throw new Error("legacy adapter manifest missing");
        const imports = buildCompiledAdapterImports(legacy.adapterManifest);
        const { instance: original } = await instantiateWasm(
          legacy.binary,
          imports.env,
          imports.string_constants,
          imports.string_constants16,
        );
        imports.setInstance?.(original);
        const prepared = artifacts(current);
        const actual = instantiate(prepared);
        for (const call of fixture.calls) {
          expect(callable(original.exports, call.name)(...call.args)).toBe(call.value);
          expect(callable(actual.exports, call.name)(...call.args)).toBe(call.value);
        }
        expect(prepared.artifacts.dts).toBe(legacy.dts);
        expect(prepared.artifacts.imports).toEqual(legacy.imports);
        expect(prepared.artifacts.stringPool).toEqual([]);
        if (backend === "wasmgc") {
          const legacyPools: Record<string, string[]> = {
            scalar: ["calculate", ""],
            "two-source 42": ["double", "", "./math", "main"],
            "nonconstant cross-source": ["double", "", "./math", "calculate"],
          };
          expect(legacy.stringPool).toEqual(legacyPools[fixture.name]);
        } else {
          expect(prepared.artifacts.stringPool).toEqual(legacy.stringPool);
        }
        expect(prepared.artifacts.exportSignatures).toEqual(legacy.exportSignatures);
        expect(prepared.artifacts.exportBoundaryPolicies).toEqual(legacy.exportBoundaryPolicies);
        const actualManifest = prepared.artifacts.adapterManifest;
        expect(actualManifest).toBeDefined();
        if (!actualManifest) throw new Error("prepared adapter manifest missing");
        const { stringPool: actualPool, ...actualOtherFields } = actualManifest;
        const { stringPool: legacyPool, ...legacyOtherFields } = legacy.adapterManifest;
        expect(actualPool).toEqual(prepared.artifacts.stringPool);
        expect(legacyPool).toEqual(legacy.stringPool);
        expect(actualOtherFields).toEqual(legacyOtherFields);
        const actualHelper = helperManifestSection(prepared.artifacts.importsHelper);
        const originalHelper = helperManifestSection(legacy.importsHelper);
        expect(actualHelper.manifest).toEqual(actualManifest);
        expect(originalHelper.manifest).toEqual(legacy.adapterManifest);
        expect(actualHelper.prefix).toBe(originalHelper.prefix);
        expect(actualHelper.suffix).toBe(originalHelper.suffix);
        if (backend === "wasmgc") {
          // Preserve the real field difference; this is not byte/artifact parity.
          expect(prepared.artifacts.importsHelper).not.toBe(legacy.importsHelper);
        } else {
          expect(prepared.artifacts.importsHelper).toBe(legacy.importsHelper);
        }
        const values = fixture.calls.map((call) => call.value);
        expect(await generatedHelperCalls(prepared.artifacts, fixture.calls)).toEqual(values);
        expect(await generatedHelperCalls(legacy, fixture.calls)).toEqual(values);
        expect(prepared.artifacts.hasMain).toBe(legacy.hasMain);
        expect(prepared.artifacts.hasTopLevelStatements).toBe(legacy.hasTopLevelStatements);
      });
    }
    it(`proves the four-generator poison attaches to the legacy ${backend} route`, async () => {
      const poisons = poisonGenerators();
      const legacy = await compileMultiSource(SCALAR, "./entry.ts", input(SCALAR, backend).options);
      expect(legacy.success).toBe(false);
      expect(
        legacy.errors.some((error) => error.message.includes("attached prepared presentation legacy poison")),
      ).toBe(true);
      expect(poisons[backend === "linear" ? 3 : 1]).toHaveBeenCalledOnce();
    });
    it(`snapshots ${backend} output and backend options before actual preparation observers run`, () => {
      const current = input(SCALAR, backend);
      const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
      const unsubscribe = subscribePreparedIrProgram((event) => {
        if (event.phase !== "prepared") return;
        current.options.target = "wasi";
        current.options.moduleName = "mutated-after-preparation";
        current.options.sourceMap = true;
        current.options.emitWat = false;
      });
      try {
        const result = artifacts(current);
        expect(current.options.target).toBe("wasi");
        expect(result.artifacts.targetProfile?.target).toBe(backend === "linear" ? "linear" : "gc");
        expect(result.artifacts.sourceMap).toBeUndefined();
        expect(result.artifacts.wat.length).toBeGreaterThan(0);
        expect(accept.mock.calls[0]![1]).toMatchObject({
          backend,
          target: "host",
          moduleName: "prepared-presentation-control",
          sourceMap: false,
        });
        expect(callable(instantiate(result).exports, "calculate")(11)).toBe(35);
      } finally {
        unsubscribe();
      }
    });
    it(`executes non-idempotent deferred ${backend} startup zero, once, and deliberately twice`, () => {
      const result = artifacts(input(VISITS, backend, { deferTopLevelInit: true }));
      expect(result.startup.kind).toBe("deferred-export");
      if (result.startup.kind !== "deferred-export") throw new Error("missing deferred startup disposition");
      expect(result.emission.module.startFuncIdx).toBeUndefined();
      expect(result.startup.adapterIndex).toBe(consumer.emittedStartupAdapterIndex(result.emission));
      expect(result.emission.module.exports).toContainEqual({
        name: result.startup.exportName,
        desc: { kind: "func", index: result.startup.adapterIndex },
      });
      expect(result.artifacts.hasTopLevelStatements).toBe(true);
      const once = instantiate(result);
      expect(callable(once.exports, "read")()).toBe(0);
      callable(once.exports, result.startup.exportName)();
      expect(callable(once.exports, "read")()).toBe(1);
      const twice = instantiate(result);
      expect(callable(twice.exports, "read")()).toBe(0);
      callable(twice.exports, result.startup.exportName)();
      expect(callable(twice.exports, "read")()).toBe(1);
      callable(twice.exports, result.startup.exportName)();
      expect(callable(twice.exports, "read")()).toBe(2);
    });
    it(`executes automatic ${backend} startup once through native and actual generated-helper wiring`, async () => {
      const result = artifacts(input(VISITS, backend));
      expect(result.startup.kind).toBe("wasm-start");
      if (result.startup.kind !== "wasm-start") throw new Error("missing automatic startup disposition");
      expect(result.startup.adapterIndex).toBe(result.emission.module.startFuncIdx);
      expect(result.startup.adapterIndex).toBe(consumer.emittedStartupAdapterIndex(result.emission));
      expect(result.artifacts.hasTopLevelStatements).toBe(true);
      expect(callable(instantiate(result).exports, "read")()).toBe(1);
      expect(await generatedHelperRead(result)).toEqual({ before: 1, after: 1 });
    });
    it(`keeps the user __module_init distinct from the automatic ${backend} adapter`, () => {
      const result = artifacts(input(USER_INIT, backend));
      expect(result.startup.kind).toBe("wasm-start");
      if (result.startup.kind !== "wasm-start") throw new Error("missing automatic startup disposition");
      const user = result.emission.module.exports.find((entry) => entry.name === "__module_init");
      expect(user?.desc.kind).toBe("func");
      if (user?.desc.kind !== "func") throw new Error("missing genuine user initializer export");
      expect(user.desc.index).not.toBe(result.startup.adapterIndex);
      expect(result.emission.module.startFuncIdx).toBe(result.startup.adapterIndex);
      const instance = instantiate(result);
      expect(callable(instance.exports, "read")()).toBe(1);
      expect(callable(instance.exports, "__module_init")()).toBe(17);
      expect(callable(instance.exports, "read")()).toBe(17);
    });
    it(`retains the real ${backend} deferred user-name collision refusal`, () => {
      const result = runPreparedIrPipelinePresentation(input(USER_INIT, backend, { deferTopLevelInit: true }));
      expect(result.kind, JSON.stringify(result)).toBe("unsupported");
      if (result.kind !== "unsupported") throw new Error("expected genuine planner refusal");
      expect(result.phase).toBe("acceptance");
      expect(result.failure.detail).toContain("__module_init");
      expect(result.failure.sourceFile).toBe("entry.ts");
      expect(result.failure.location.line).toBeGreaterThan(0);
      expect(result).not.toHaveProperty("artifacts");
    });
  }

  it("uses one authentic A packet with both host projections in a separate real C witness", () => {
    const current = input(TWO_SOURCE, "wasmgc");
    const base = request(current, "wasmgc").preparation;
    const prepared = preparation.prepareWholeIrProgram({
      ...base,
      runtimePolicies: BACKENDS.map((backend) => ({ backend, target: "host" as const })),
    });
    expect(prepared.kind, JSON.stringify(prepared)).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error(prepared.detail);
    const program: PreparedIrProgram = prepared.program;
    expect(program.runtime.map((row) => `${row.backend}:${row.target}`)).toEqual(["wasmgc:host", "linear:host"]);
    const originalIr = program.ir;
    const originalAbi = program.abi;
    for (const backend of BACKENDS) {
      const accepted = consumer.acceptPreparedIrProgram(program, backendOptions(backend));
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw new Error(accepted.detail);
      expect(consumer.isAuthenticAcceptedIrProgram(accepted)).toBe(true);
      expect(accepted.program).toBe(program);
      expect(accepted.program.ir).toBe(originalIr);
      expect(accepted.program.abi).toBe(originalAbi);
      const emitted = consumer.emitAcceptedIrProgram(accepted);
      expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
      const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(emitted.module))));
      expect(callable(instance.exports, "main")()).toBe(42);
      expect(() => consumer.emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
    }
  });

  it("keeps an actual located namespace preparation refusal and never enters a generator", () => {
    const poisons = poisonGenerators();
    const result = runPreparedIrPipelinePresentation(
      input(
        {
          "./entry.ts":
            "namespace N { export function f(): number { return 7; } } export function main(): number { return N.f(); }",
        },
        "wasmgc",
      ),
    );
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("expected genuine namespace refusal");
    expect(result.phase).toBe("preparation");
    expect(result.failure.sourceFile).toBe("entry.ts");
    expect(result.failure.location.line).toBeGreaterThan(0);
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
  });

  it("rejects contradictory actual entry/checker association before preparing any packet", () => {
    const current = input(SCALAR, "wasmgc");
    const other = input(SCALAR, "wasmgc");
    const candidate = request(current, "wasmgc");
    const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
    const result = prepareIrProgramPresentation({
      ...candidate,
      preparation: { ...candidate.preparation, checker: other.entryAst.checker },
    });
    expect(result.kind).toBe("presentation-unsupported");
    if (result.kind !== "presentation-unsupported") throw new Error("expected source association gap");
    expect(result.gaps.length).toBeGreaterThan(0);
    expectGap(result, "source", "source-association");
    expect(prepare).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("emission");
  });

  it("rejects a same-spelling declaration from a different real source instead of joining by name", () => {
    const current = input(
      {
        "./math.ts": "export function calculate(value:number):number { return value*2; }",
        "./entry.ts":
          'import { calculate as twice } from "./math"; export function calculate(value:number):number { return twice(value)+2; }',
      },
      "wasmgc",
    );
    const candidate = request(current, "wasmgc");
    const wrongEntry = current.userSourceFiles.find((source) => source !== current.entryAst.sourceFile)!;
    const result = prepareIrProgramPresentation({
      ...candidate,
      preparation: { ...candidate.preparation, entrySource: wrongEntry },
    });
    expect(result.kind).toBe("presentation-unsupported");
    if (result.kind !== "presentation-unsupported") throw new Error("expected source identity gap");
    expectGap(result, "source", "source-association");
    expect(result).not.toHaveProperty("emission");
  });
  it.each([
    { name: "source-map request", options: { sourceMap: true } },
    { name: "optimization request", options: { optimize: true } },
    { name: "C ABI request", options: { target: "linear", abi: "c" } },
  ] satisfies { name: string; options: CompileOptions }[])(
    "refuses nonadmitted $name without an artifact",
    ({ options }) => {
      const result = runPreparedIrPipelinePresentation(input(SCALAR, "wasmgc", options));
      expect(result.kind, JSON.stringify(result)).toBe("presentation-unsupported");
      if (result.kind !== "presentation-unsupported") throw new Error("expected an explicit option gap");
      expect(result.gaps.length).toBeGreaterThan(0);
      expectGap(result, "options", "unproved-output-option");
      expect(result).not.toHaveProperty("artifacts");
    },
  );

  it("refuses contradictory backend options associated with the genuine source graph", () => {
    const current = input(SCALAR, "wasmgc");
    const candidate = request(current, "wasmgc");
    const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
    const result = prepareIrProgramPresentation({
      ...candidate,
      backendOptions: { ...candidate.backendOptions, backend: "linear" },
    });
    expect(result.kind).toBe("presentation-unsupported");
    if (result.kind !== "presentation-unsupported") throw new Error("expected backend association gap");
    expectGap(result, "backend", "option-association");
    expect(prepare).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("emission");
  });

  it("refuses a changed source text map beside the original analyzed source", () => {
    const current = input(SCALAR, "wasmgc");
    current.sourcesContent.set(current.entryAst.sourceFile.fileName, SCALAR["./entry.ts"].replace("* 3", "* 9"));
    const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
    const result = prepareIrProgramPresentation(request(current, "wasmgc"));
    expect(result.kind).toBe("presentation-unsupported");
    if (result.kind !== "presentation-unsupported") throw new Error("expected source-content association gap");
    expectGap(result, "sourcesContent", "source-content");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses a string boundary rather than infer numeric semantics from physical storage", () => {
    const result = runPreparedIrPipelinePresentation(
      input({ "./entry.ts": "export function echo(value: string): string { return value; }" }, "wasmgc"),
    );
    expect(result.kind).toBe("presentation-unsupported");
    if (result.kind !== "presentation-unsupported") throw new Error("expected boundary classification gap");
    expectGap(result, "declaration", "non-numeric-boundary");
    expect(result).not.toHaveProperty("artifacts");
  });

  it("executes genuine async work through the original helper without a legacy generator", () => {
    const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
    const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
    const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
    const poisons = poisonGenerators();
    const result = artifacts(
      input(
        {
          "./entry.ts":
            "export async function calculate(value: number): Promise<number> { return await (value * 3 + 2); }",
        },
        "wasmgc",
      ),
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
    expect(result).toHaveProperty("finalization.phase", "after-reference-widening");
    expect(result).toHaveProperty("finalization.originalEmissionUnchanged", true);
    expect(consumer.emittedPhysicalSetupPlan(result.emission).functions.length).toBeGreaterThan(0);
    expect(result.emission.module.asyncFunctions).toEqual(new Set(["calculate"]));
    const dir = mkdtempSync(join(tmpdir(), "ir-prepared-presentation-async-"));
    try {
      const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
      const helper = result.artifacts.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
      expect(helper).not.toBe(result.artifacts.importsHelper);
      writeFileSync(join(dir, "module.imports.mjs"), helper);
      writeFileSync(join(dir, "module.wasm"), result.artifacts.binary);
      writeFileSync(
        join(dir, "run.mjs"),
        `import { readFileSync } from "node:fs";\nimport { types } from "node:util";\nimport { instantiateBytes } from "./module.imports.mjs";\nconst result = await instantiateBytes(readFileSync(new URL("./module.wasm", import.meta.url)));\nconst values = [];\nfor (const seed of [5, -3, 0.5]) { const promise = result.exports.calculate(seed); if (!types.isPromise(promise)) throw Error("expected real Promise"); values.push(await promise); }\nconsole.log(JSON.stringify(values));\n`,
      );
      const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs")], {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
      });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout.trim())).toEqual([17, -7, 3.5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a real located acceptance refusal from the consumer", () => {
    const current = input(SCALAR, "wasmgc");
    const candidate = request(current, "wasmgc");
    const prepared = preparation.prepareWholeIrProgram(candidate.preparation);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error(prepared.detail);
    const failure = consumer.acceptPreparedIrProgram(prepared.program, { ...candidate.backendOptions, target: "wasi" });
    expect(failure.kind).toBe("unsupported");
    if (failure.kind !== "unsupported") throw new Error("expected genuine missing runtime projection");
    const accept = vi.spyOn(consumer, "acceptPreparedIrProgram").mockReturnValueOnce(failure);
    const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
    const result = prepareIrProgramPresentation(candidate);
    expect(result).toEqual({ kind: "unsupported", phase: "acceptance", failure });
    if (result.kind !== "unsupported") throw new Error("expected original located failure");
    expect(result.failure).toBe(failure);
    expect(result.failure.detail).toContain("no wasmgc:wasi runtime projection");
    expect(result.failure.location).toEqual(failure.location);
    expect(accept).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(["preparation", "acceptance", "emission"] as const)("propagates the original thrown %s error", (phase) => {
    const candidate = request(input(SCALAR, "wasmgc"), "wasmgc");
    const error = new Error(`original presentation ${phase} failure`);
    const fail = () => {
      throw error;
    };
    if (phase === "preparation") vi.spyOn(preparation, "prepareWholeIrProgram").mockImplementationOnce(fail);
    else if (phase === "acceptance") vi.spyOn(consumer, "acceptPreparedIrProgram").mockImplementationOnce(fail);
    else vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce(fail);
    let caught = false;
    try {
      prepareIrProgramPresentation(candidate);
    } catch (actual) {
      caught = true;
      expect(actual).toBe(error);
    }
    expect(caught).toBe(true);
  });
  it("retains actual engine rejection, diagnostic identity and nonempty failed output bytes", () => {
    const current = input(SCALAR, "wasmgc");
    const original = binaryEmitter.emitBinary;
    vi.spyOn(binaryEmitter, "emitBinary").mockImplementationOnce((module) => {
      const bytes = original(module);
      bytes[4] = 0xff; // A real invalid Wasm version; the engine and finalizer gate remain unmocked.
      return bytes;
    });
    const result = runPreparedIrPipelinePresentation(current);
    expect(result.kind).toBe("output-failed");
    if (result.kind !== "output-failed") throw new Error("invalid binary was published as success");
    expect(result.artifacts.success).toBe(false);
    expect(result.artifacts.binary.byteLength).toBeGreaterThan(8);
    expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(false);
    expect(result.errors).toBe(current.errors);
    expect(result.artifacts.errors).toBe(result.errors);
    const failure = result.errors.find((error) => error.code === "invalid-module");
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe("error");
    expect(failure?.line).toBe(1);
    expect(failure?.column).toBe(1);
    expect(failure?.file).toBeUndefined();
    expect(failure?.message).toContain("failed validation");
  });
  it("refuses a real emitted scalar module with an introduced string resource", () => {
    // Healthy original transaction first; the mutant must retain C reservation refusal priority.
    const healthy = artifacts(input(SCALAR, "wasmgc"));
    const positive = instantiate(healthy);
    expect(callable(positive.exports, "calculate")(7)).toBe(23);
    const original = consumer.emitAcceptedIrProgram;
    vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
      const emitted = original(accepted);
      emitted.module.stringPool.push("introduced unproved string resource");
      return emitted;
    });
    expect(() => runPreparedIrPipelinePresentation(input(SCALAR, "wasmgc"))).toThrow(
      /^physical module reservations: unregistered, substituted or reordered stringPool population$/,
    );
  });

  it("refuses an actual physical export index that contradicts its authentic source/ABI binding", () => {
    // Healthy original transaction first; the mutant must retain C reservation refusal priority.
    const healthy = artifacts(input(SCALAR, "wasmgc"));
    const positive = instantiate(healthy);
    expect(callable(positive.exports, "calculate")(7)).toBe(23);
    const original = consumer.emitAcceptedIrProgram;
    vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
      const emitted = original(accepted);
      const exported = emitted.module.exports.find((entry) => entry.name === "calculate");
      if (!exported || exported.desc.kind !== "func") throw new Error("genuine positive export missing");
      exported.desc.index = emitted.module.functions.length + 10;
      return emitted;
    });
    expect(() => runPreparedIrPipelinePresentation(input(SCALAR, "wasmgc"))).toThrow(
      /^physical module reservations: altered publication descriptor$/,
    );
  });
  it("refuses an extra global export absent from the authentic prepared ABI census", () => {
    // Healthy original transaction first; the mutant must retain C reservation refusal priority.
    const healthy = artifacts(input(VISITS, "wasmgc"));
    const positive = instantiate(healthy);
    expect(callable(positive.exports, "read")()).toBe(1);
    const original = consumer.emitAcceptedIrProgram;
    vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
      const emitted = original(accepted);
      const global = emitted.module.exports.find((entry) => entry.name === "visits");
      if (!global || global.desc.kind !== "global") throw new Error("healthy exported visits global missing");
      emitted.module.exports.push({ name: "unjoined_visits", desc: { ...global.desc } });
      return emitted;
    });
    expect(() => runPreparedIrPipelinePresentation(input(VISITS, "wasmgc"))).toThrow(
      /^physical module reservations: unregistered, substituted or reordered exports population$/,
    );
  });

  it("refuses a duplicate physical global export beside one genuine source/ABI export", () => {
    // Healthy original transaction first; the mutant must retain C reservation refusal priority.
    const healthy = artifacts(input(VISITS, "wasmgc"));
    const positive = instantiate(healthy);
    expect(callable(positive.exports, "read")()).toBe(1);
    const original = consumer.emitAcceptedIrProgram;
    vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
      const emitted = original(accepted);
      const global = emitted.module.exports.find((entry) => entry.name === "visits");
      if (!global || global.desc.kind !== "global") throw new Error("healthy exported visits global missing");
      emitted.module.exports.push({ name: global.name, desc: { ...global.desc } });
      return emitted;
    });
    expect(() => runPreparedIrPipelinePresentation(input(VISITS, "wasmgc"))).toThrow(
      /^physical module reservations: unregistered, substituted or reordered exports population$/,
    );
  });
});
