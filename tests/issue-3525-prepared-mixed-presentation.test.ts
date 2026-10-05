// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { inspect, types as utilTypes } from "node:util";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compileMultiSource, runPreparedIrPipelinePresentation } from "../src/compiler.js";
import {
  prepareIrProgramPresentation,
  beginPreparedPresentationFinalization,
  completePreparedPresentationFinalization,
  type IrProgramPresentationRequest,
} from "../src/compiler/ir-program-presentation.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import {
  emittedPhysicalSetupPlan,
  emittedSupportFunctionReceipts,
  emittedProgramBindingIndex,
} from "../src/ir/program-consumer.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { ts } from "../src/ts-api.js";
import type { CompileOptions } from "../src/index.js";
import type { WasmModule, TypeDef, Instr, ValType } from "../src/ir/types.js";

const ORIGINAL_MIXED = {
  "./a.ts": "export let left: number = 1; left = left + 1;",
  "./b.ts": "export let right: number = 10; right = right + 2;",
  "./entry.ts":
    '\n    import { left } from "./a";\n    import { right } from "./b";\n    let phase: number = 0;\n    export function initial(): number { return left * 100 + right; }\n    export function readPhase(): number { return phase; }\n    function compute(seed: number): number {\n      let total = 0;\n      for (let i = 0; i < 4; i++) {\n        if (i % 2 === 0) total = total + Math.imul(seed, i + 1);\n        else total = total - i;\n      }\n      return total;\n    }\n    \n  export async function run(seed: number): Promise<number> {\n    phase = 1;\n    const first = await (seed + 1);\n    phase = 2;\n    const second = await compute(first);\n    phase = 3;\n    return second + initial();\n  }\n\n  ',
};

const MIXED_DIGEST = "236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb";
const SEEDS = [0, 7, -3, -0, 0.5, 2147483647, NaN, Infinity];
type Input = Parameters<typeof runPreparedIrPipelinePresentation>[0];
type Prepared = Extract<ReturnType<typeof prepareIrProgramPresentation>, { kind: "prepared-presentation" }>;
type Artifact = Extract<ReturnType<typeof runPreparedIrPipelinePresentation>, { kind: "artifacts" }>;
type Exports = { initial: () => number; readPhase: () => number; run: (value: number) => Promise<number> };
const snapshot = (value: unknown) =>
  inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, sorted: false, compact: false });

function input(files: Record<string, string> = ORIGINAL_MIXED, backend: "wasmgc" | "linear" = "wasmgc"): Input {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.syntacticDiagnostics).toEqual([]);
  const options: CompileOptions = {
    target: backend === "wasmgc" ? "gc" : "linear",
    optimize: false,
    sourceMap: false,
    moduleName: "mixed-presentation",
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
    codegenOptions: { link: [], sourceMap: false },
    sourcesContent: new Map(ast.sourceFiles.map((file) => [file.fileName, file.text])),
    diagnosticAnchor: ast.entryFile,
    options,
  };
}
function request(current: Input, backend: "wasmgc" | "linear" = "wasmgc"): IrProgramPresentationRequest {
  const ast = current.multiAst!;
  return {
    preparation: {
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend, target: "host" },
      deferTopLevelInit: false,
    },
    backendOptions: {
      backend,
      target: "host",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: current.options.moduleName!,
    },
    output: current,
  };
}
function prepared(files: Record<string, string> = ORIGINAL_MIXED): Prepared {
  const result = prepareIrProgramPresentation(request(input(files)));
  expect(result.kind, snapshot(result)).toBe("prepared-presentation");
  if (result.kind !== "prepared-presentation") throw new Error(snapshot(result));
  return result;
}
function artifacts(current: Input): Artifact {
  const result = runPreparedIrPipelinePresentation(current);
  expect(result.kind, snapshot(result)).toBe("artifacts");
  if (result.kind !== "artifacts") throw new Error(snapshot(result));
  expect(result.artifacts.success).toBe(true);
  expect(result.artifacts.errors).toEqual([]);
  expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(true);
  return result;
}
function nativeExports(files: Record<string, string>): Exports {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const context = createContext({ Math });
  const load = (name: string): Record<string, unknown> => {
    const key = name.endsWith(".ts") ? name : `${name}.ts`;
    const cached = cache.get(key);
    if (cached) return cached.exports;
    const source = files[key];
    if (source === undefined) throw new Error(`native source absent ${key}`);
    const module = { exports: {} as Record<string, unknown> };
    cache.set(key, module);
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInContext(`(function(exports,require,module){${js}\n})`, context)(module.exports, load, module);
    return module.exports;
  };
  return load("./entry.ts") as Exports;
}
function encode(value: number): number | string {
  return Number.isNaN(value)
    ? "NaN"
    : Object.is(value, -0)
      ? "-0"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : value;
}
async function observations(exports: Exports) {
  expect(exports.initial()).toBe(212);
  expect(exports.readPhase()).toBe(0);
  const rows = [];
  for (const seed of SEEDS) {
    const promise = exports.run(seed);
    expect(utilTypes.isPromise(promise)).toBe(true);
    const phases = [exports.readPhase()];
    expect(phases[0]).toBe(1);
    for (let turn = 0; turn < 16 && phases.at(-1) !== 3; turn++) {
      await Promise.resolve();
      phases.push(exports.readPhase());
    }
    const value = await promise;
    phases.push(exports.readPhase());
    expect(phases).toContain(2);
    expect(phases.at(-1)).toBe(3);
    expect(phases.every((phase, index) => index === 0 || phase >= phases[index - 1]!)).toBe(true);
    rows.push({
      seed: encode(seed),
      value: encode(value),
      immediate: phases[0],
      sawIntermediate: phases.includes(2),
      final: phases.at(-1),
    });
  }
  return rows;
}
async function helperObservations(artifact: Pick<Artifact["artifacts"], "binary" | "importsHelper">) {
  const dir = mkdtempSync(join(tmpdir(), "prepared-mixed-helper-"));
  try {
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const helper = artifact.importsHelper.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(helper).not.toBe(artifact.importsHelper);
    writeFileSync(join(dir, "module.imports.mjs"), helper);
    writeFileSync(join(dir, "module.wasm"), artifact.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import {readFileSync} from 'node:fs'; import {instantiateBytes} from './module.imports.mjs'; const instance=await instantiateBytes(readFileSync(new URL('./module.wasm',import.meta.url))); const e=instance.exports; const encode=${encode.toString()}; const rows=[]; if(e.initial()!==212||e.readPhase()!==0) throw Error('initial state'); for(const seed of [0,7,-3,-0,0.5,2147483647,NaN,Infinity]){const p=e.run(seed);if(!(p instanceof Promise))throw Error('not real Promise'); const phases=[e.readPhase()]; for(let t=0;t<16&&phases.at(-1)!==3;t++){await Promise.resolve();phases.push(e.readPhase());}const value=await p;phases.push(e.readPhase());if(phases[0]!==1||!phases.includes(2)||phases.at(-1)!==3)throw Error('phase order '+phases);if(!phases.every((x,i)=>!i||x>=phases[i-1]))throw Error('phase reversal');rows.push({seed:encode(seed),value:encode(value),immediate:phases[0],sawIntermediate:phases.includes(2),final:phases.at(-1)});}instance.imports.setInstance?.(instance.instance); if(e.readPhase()!==3||e.initial()!==212)throw Error('repeat wiring changed state'); console.log(JSON.stringify(rows));`,
    );
    const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs")], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Enumerate only the structural positions visited by the unchanged widening pass.
function wideningSlots(module: WasmModule): Set<string> {
  const slots = new Set<string>();
  const slot = (type: ValType, path: string) => {
    if (type.kind === "ref") slots.add(path);
  };
  const type = (value: TypeDef, path: string): void => {
    if (value.kind === "func") {
      value.params.forEach((x, i) => slot(x, `${path}.params.${i}`));
      value.results.forEach((x, i) => slot(x, `${path}.results.${i}`));
    } else if (value.kind === "struct") value.fields.forEach((x, i) => slot(x.type, `${path}.fields.${i}.type`));
    else if (value.kind === "array") slot(value.element, `${path}.element`);
    else if (value.kind === "rec") value.types.forEach((x, i) => type(x, `${path}.types.${i}`));
    else if (value.kind === "sub") type(value.type, `${path}.type`);
  };
  const bodies = new Set<Instr[]>();
  const body = (values: Instr[], path: string): void => {
    if (bodies.has(values)) return;
    bodies.add(values);
    values.forEach((value, i) => {
      const row = value as unknown as Record<string, unknown>;
      const here = `${path}.${i}`;
      const block = row.blockType as { kind?: string; type?: ValType } | undefined;
      if (block?.kind === "val" && block.type) slot(block.type, `${here}.blockType.type`);
      for (const key of ["then", "else", "body", "catchAll"])
        if (Array.isArray(row[key])) body(row[key] as Instr[], `${here}.${key}`);
      if (Array.isArray(row.catches))
        row.catches.forEach((entry: { body?: Instr[] }, j: number) => {
          if (entry.body) body(entry.body, `${here}.catches.${j}.body`);
        });
    });
  };
  module.types.forEach((x, i) => type(x, `module.types.${i}`));
  module.functions.forEach((fn, i) => {
    fn.locals.forEach((x, j) => slot(x.type, `module.functions.${i}.locals.${j}.type`));
    body(fn.body, `module.functions.${i}.body`);
  });
  module.globals.forEach((x, i) => slot(x.type, `module.globals.${i}.type`));
  module.imports.forEach((x, i) => {
    if (x.desc.kind === "global") slot(x.desc.type, `module.imports.${i}.desc.type`);
  });
  return slots;
}
function compareGraphs(
  original: unknown,
  copied: unknown,
  slots: ReadonlySet<string>,
  path = "module",
  pairs = new Map<object, object>(),
  reverse = new Map<object, object>(),
): void {
  if (original === null || typeof original !== "object") {
    expect(Object.is(original, copied), path).toBe(true);
    return;
  }
  expect(copied, path).not.toBe(original);
  expect(typeof copied).toBe("object");
  if (copied === null || typeof copied !== "object") throw new Error(path);
  if (slots.has(path)) {
    expect(original).toEqual({ kind: "ref", typeIdx: (original as { typeIdx: number }).typeIdx });
    expect(copied).toEqual({ kind: "ref_null", typeIdx: (original as { typeIdx: number }).typeIdx });
    return;
  }
  if (pairs.has(original)) {
    expect(copied, path).toBe(pairs.get(original));
    return;
  }
  expect(reverse.has(copied), path).toBe(false);
  pairs.set(original, copied);
  reverse.set(copied, original);
  expect(Object.getPrototypeOf(copied), path).toBe(Object.getPrototypeOf(original));
  if (original instanceof Map) {
    expect(copied).toBeInstanceOf(Map);
    const rows = [...(copied as Map<unknown, unknown>)];
    expect(rows).toHaveLength(original.size);
    [...original].forEach(([key, value], i) => {
      compareGraphs(key, rows[i]![0], slots, `${path}.key.${i}`, pairs, reverse);
      compareGraphs(value, rows[i]![1], slots, `${path}.value.${i}`, pairs, reverse);
    });
    return;
  }
  if (original instanceof Set) {
    const rows = [...(copied as Set<unknown>)];
    expect(rows).toHaveLength(original.size);
    [...original].forEach((value, i) => compareGraphs(value, rows[i], slots, `${path}.set.${i}`, pairs, reverse));
    return;
  }
  if (original instanceof Uint8Array) {
    expect(copied).toBeInstanceOf(Uint8Array);
    expect([...(copied as Uint8Array)]).toEqual([...original]);
    expect((copied as Uint8Array).buffer).not.toBe(original.buffer);
    return;
  }
  const keys = Reflect.ownKeys(original);
  expect(Reflect.ownKeys(copied), path).toEqual(keys);
  for (const key of keys) {
    const a = Object.getOwnPropertyDescriptor(original, key)!;
    const b = Object.getOwnPropertyDescriptor(copied, key)!;
    expect(a).toHaveProperty("value");
    expect(b).toHaveProperty("value");
    expect([b.enumerable, b.configurable, b.writable], path).toEqual([a.enumerable, a.configurable, a.writable]);
    compareGraphs(a.value, b.value, slots, `${path}.${String(key)}`, pairs, reverse);
  }
}
function finish(current: Prepared) {
  const plan = emittedPhysicalSetupPlan(current.emission);
  const before = snapshot(current.emission.module);
  const binary = emitBinary(current.emission.module);
  const token = beginPreparedPresentationFinalization(current);
  compareGraphs(current.emission.module, token.outputModule, new Set());
  const slots = wideningSlots(current.emission.module);
  expect(slots.size).toBeGreaterThan(0);
  widenNonDefaultableTypes(token.outputModule);
  compareGraphs(current.emission.module, token.outputModule, slots);
  const receipt = completePreparedPresentationFinalization(token);
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(receipt).toEqual({
    kind: "prepared-presentation-finalization",
    phase: "after-reference-widening",
    widenedSlots: slots.size,
    originalEmissionUnchanged: true,
  });
  expect(snapshot(current.emission.module)).toBe(before);
  expect(emitBinary(current.emission.module)).toEqual(binary);
  expect(emittedPhysicalSetupPlan(current.emission)).toBe(plan);
  expect(emittedSupportFunctionReceipts(current.emission).length).toBeGreaterThan(0);
  return { token, receipt, plan };
}
function constant(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.op === "string" && record.op.endsWith(".const") && typeof record.value === "number") return record;
  for (const child of Object.values(record)) {
    const found = constant(child);
    if (found) return found;
  }
  return undefined;
}
afterEach(() => vi.restoreAllMocks());
describe("#3525 genuine mixed prepared presentation and detached finalization", () => {
  it("executes the exact original three-source seven-terminal application through native, legacy and original prepared helper", async () => {
    expect(createHash("sha256").update(JSON.stringify(ORIGINAL_MIXED)).digest("hex")).toBe(MIXED_DIGEST);
    const oracle = await observations(nativeExports(ORIGINAL_MIXED));
    const current = input();
    const originalBegin = presentation.beginPreparedPresentationFinalization;
    let handoff: Prepared | undefined;
    let handoffSnapshot = "";
    let handoffBinary: Uint8Array | undefined;
    const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization").mockImplementation((value) => {
      handoff = value;
      handoffSnapshot = snapshot(value.emission.module);
      handoffBinary = emitBinary(value.emission.module);
      return originalBegin(value);
    });
    const result = artifacts(current);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(handoff).toBeDefined();
    expect(result.program).toBe(handoff!.program);
    expect(result.emission).toBe(handoff!.emission);
    expect(snapshot(result.emission.module)).toBe(handoffSnapshot);
    expect(emitBinary(result.emission.module)).toEqual(handoffBinary);
    expect(result.program.inventory.sources).toHaveLength(3);
    expect(result.program.inventory.terminalUnits).toHaveLength(7);
    expect(result.emission.emittedUnitIds).toHaveLength(14);
    expect(result.emission.module.functions).toHaveLength(18);
    expect(result.emission.module.imports.filter((x) => x.desc.kind === "func")).toHaveLength(9);
    expect(result).toHaveProperty("finalization");
    expect(Object.isFrozen(result.finalization)).toBe(true);
    expect(result.finalization).toEqual({
      kind: "prepared-presentation-finalization",
      phase: "after-reference-widening",
      widenedSlots: wideningSlots(result.emission.module).size,
      originalEmissionUnchanged: true,
    });
    expect(emittedPhysicalSetupPlan(result.emission).asyncFrames!.entries.length).toBeGreaterThan(0);
    expect(result.artifacts.exportSignatures?.run?.result).toBe("promise");
    expect(await helperObservations(result.artifacts)).toEqual(oracle);
    const legacy = await compileMultiSource(ORIGINAL_MIXED, "./entry.ts", current.options);
    expect(legacy.success).toBe(true);
    expect(legacy.errors).toEqual([]);
    expect(result.artifacts.dts).toBe(legacy.dts);
    expect(await helperObservations(legacy)).toEqual(oracle);
    expect(emittedPhysicalSetupPlan(result.emission)).toBe(emittedPhysicalSetupPlan(result.emission));
  });
  it("uses the admitted mixed branch without calling any of four attached legacy generators", () => {
    const poison = () => {
      throw new Error("mixed attached legacy generator poison");
    };
    vi.spyOn(gcCodegen, "generateModule").mockImplementation(poison);
    vi.spyOn(gcCodegen, "generateMultiModule").mockImplementation(poison);
    vi.spyOn(linearCodegen, "generateLinearModule").mockImplementation(poison);
    vi.spyOn(linearCodegen, "generateLinearMultiModule").mockImplementation(poison);
    expect(artifacts(input()).emission.emittedUnitIds).toHaveLength(14);
  });
  it("joins each actual callback entry, alias target, physical export and imported-function offset", () => {
    const current = prepared();
    const plan = emittedPhysicalSetupPlan(current.emission);
    const imports = current.emission.module.imports.filter((x) => x.desc.kind === "func").length;
    const callbacks = plan.asyncFrames!.frames.flatMap((x) => x.callbacks);
    expect(callbacks.length).toBeGreaterThan(0);
    for (const callback of callbacks) {
      const entry = plan.asyncFrames!.entries.filter((x) => x.id === callback.entry.id);
      expect(entry).toHaveLength(1);
      expect(entry[0]).toEqual(callback.entry);
      expect(callback.entry.aliasOf).toBe(callback.targetBindingId);
      expect(callback.entry.intent).toEqual({
        kind: "export",
        externalName: callback.externalName,
        targetId: callback.targetBindingId,
      });
      const frame = plan.asyncFrames!.frames.filter((row) =>
        row.callbacks.some((value) => value.entry.id === callback.entry.id),
      );
      expect(frame).toHaveLength(1);
      const auxiliary = [frame[0]!.auxiliaries.fulfillStep, frame[0]!.auxiliaries.rejectStep].filter(
        (row) => row.bindingId === callback.targetBindingId,
      );
      expect(auxiliary).toHaveLength(1);
      const target = emittedProgramBindingIndex(current.emission, callback.targetBindingId)!;
      const alias = emittedProgramBindingIndex(current.emission, callback.entry.id)!;
      expect(target.space).toBe("function");
      expect(alias).toEqual(target);
      expect(Number.isSafeInteger(target.index)).toBe(true);
      expect(target.index).toBeGreaterThanOrEqual(imports);
      const body = current.emission.module.functions[target.index - imports]!;
      expect(body).toBeDefined();
      const signature = current.emission.module.types[body.typeIdx];
      expect(signature?.kind).toBe("func");
      if (!signature || signature.kind !== "func") throw Error("actual callback function signature absent");
      const resolve = (value: (typeof auxiliary)[number]["params"][number]): ValType => {
        if (value.kind !== "support-ref") return value;
        const slot = emittedProgramBindingIndex(current.emission, value.ref.binding.bindingId);
        expect(slot?.space).toBe("type");
        if (!slot || slot.space !== "type") throw Error("actual callback support type absent");
        expect(Number.isSafeInteger(slot.index)).toBe(true);
        return { kind: value.nullable ? "ref_null" : "ref", typeIdx: slot.index };
      };
      expect(signature.params).toEqual(auxiliary[0]!.params.map(resolve));
      expect(signature.results).toEqual(auxiliary[0]!.results.map(resolve));
      expect(current.emission.module.exports).toContainEqual({
        name: callback.externalName,
        desc: { kind: "func", index: target.index },
      });
    }
    finish(current);
  });
  it("preserves every original physical identity while detached output performs exactly allowed reference widening", () => {
    const current = prepared();
    const original = current.emission.module;
    const functions = [...original.functions];
    const types = [...original.types];
    const { token } = finish(current);
    expect(token.outputModule).not.toBe(original);
    functions.forEach((fn, i) => expect(original.functions[i]).toBe(fn));
    types.forEach((type, i) => expect(original.types[i]).toBe(type));
    expect(emitBinary(token.outputModule)).not.toEqual(emitBinary(original));
    const provenance = original.platformCapabilityImportProvenance;
    if (provenance) {
      expect(provenance.size).toBe(0);
      expect(token.outputModule.platformCapabilityImportProvenance).not.toBe(provenance);
      expect(token.outputModule.platformCapabilityImportProvenance).toEqual(provenance);
      for (const [key, value] of provenance) {
        const i = original.imports.indexOf(key);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(token.outputModule.platformCapabilityImportProvenance!.get(token.outputModule.imports[i]!)).toEqual(
          value,
        );
        expect(token.outputModule.platformCapabilityImportProvenance!.has(key)).toBe(false);
      }
    }
  });
  for (const backend of ["wasmgc", "linear"] as const)
    for (const source of [
      "export function value(x:number):number{return x+2;}",
      "export function value(x:boolean):boolean{return !x;}",
    ])
      it(`keeps ${backend} ${source.includes("boolean") ? "Boolean" : "numeric"} output on its existing no-copy fast path`, () => {
        const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization");
        const files = { "./entry.ts": source };
        const leaf = prepareIrProgramPresentation(request(input(files, backend), backend));
        expect(leaf.kind).toBe("prepared-presentation");
        expect(leaf).not.toHaveProperty("requiresDetachedFinalization");
        const result = artifacts(input(files, backend));
        expect(result).not.toHaveProperty("finalization");
        expect(begin).not.toHaveBeenCalled();
        expect(emittedPhysicalSetupPlan(result.emission)).toBeDefined();
      });
  it("retains genuine Linear promise capability refusal for the same complete original sources", () => {
    const result = runPreparedIrPipelinePresentation(input(ORIGINAL_MIXED, "linear"));
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error(snapshot(result));
    expect(result.failure.detail).toMatch(/promise\.capability\.create has no linear adapter/);
    expect(result.failure.sourceFile).toBe("entry.ts");
  });
  it("retains the authentic producer refusal for a distinct rejecting async body without claiming rejection execution", () => {
    const files = {
      "./entry.ts": "export async function reject(value:number):Promise<number>{if(value<0)throw null;return value+1;}",
    };
    expect(Buffer.byteLength(files["./entry.ts"])).toBe(97);
    const result = runPreparedIrPipelinePresentation(input(files));
    expect(result.kind, snapshot(result)).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error(snapshot(result));
    expect(result.phase).toBe("preparation");
    expect(result.failure).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: "async-plan producer cannot represent the complete body of reject",
      sourceFile: "entry.ts",
      location: { line: 1, column: 1, declarationStart: 0, declarationEnd: 97 },
    });
    expect(result).not.toHaveProperty("artifacts");
    expect(result).not.toHaveProperty("emission");
  });
  it("rejects forged and spread prepared objects after a genuine healthy completion", () => {
    finish(prepared());
    const current = prepared();
    expect(() => beginPreparedPresentationFinalization({} as Prepared)).toThrow(
      /^prepared presentation finalization: invalid-presentation$/,
    );
    expect(() => beginPreparedPresentationFinalization({ ...current })).toThrow(
      /^prepared presentation finalization: invalid-presentation$/,
    );
    finish(current);
  });
  it("rejects forged and cloned tokens without consuming a distinct genuine token", () => {
    const current = prepared();
    const token = beginPreparedPresentationFinalization(current);
    expect(() => completePreparedPresentationFinalization({} as typeof token)).toThrow(
      /^prepared presentation finalization: invalid-token$/,
    );
    expect(() => completePreparedPresentationFinalization({ ...token })).toThrow(
      /^prepared presentation finalization: invalid-token$/,
    );
    widenNonDefaultableTypes(token.outputModule);
    expect(Object.isFrozen(completePreparedPresentationFinalization(token))).toBe(true);
  });
  it("consumes completion exactly once and refuses a stale completed prepared transaction", () => {
    const current = prepared();
    const { token } = finish(current);
    expect(() => completePreparedPresentationFinalization(token)).toThrow(
      /^prepared presentation finalization: invalid-token$/,
    );
    expect(() => beginPreparedPresentationFinalization(current)).toThrow(
      /^prepared presentation finalization: invalid-presentation$/,
    );
    finish(prepared());
  });
  for (const mutation of [
    "omitted widening",
    "wrong type index",
    "opcode immediate",
    "function census",
    "export census",
    "data-segment census",
    "mutable original alias",
  ] as const)
    it(`permanently refuses ${mutation} on a genuine detached token, with restored bytes and a fresh healthy counterwitness`, () => {
      finish(prepared());
      const current = prepared();
      const token = beginPreparedPresentationFinalization(current);
      const mod = token.outputModule;
      widenNonDefaultableTypes(mod);
      let restore: () => void;
      if (mutation === "omitted widening" || mutation === "wrong type index") {
        const ordinal = current.emission.module.types.findIndex(
          (x) => x.kind === "func" && x.params.some((v) => v.kind === "ref"),
        );
        const original = current.emission.module.types[ordinal];
        const def = mod.types[ordinal];
        if (!original || original.kind !== "func" || !def || def.kind !== "func")
          throw Error("real required reference function parameter absent");
        const i = original.params.findIndex((x) => x.kind === "ref");
        const before = def.params[i]!;
        def.params[i] =
          mutation === "omitted widening"
            ? { kind: "ref", typeIdx: (before as { typeIdx: number }).typeIdx }
            : { kind: "ref_null", typeIdx: (before as { typeIdx: number }).typeIdx + 1 };
        restore = () => {
          def.params[i] = before;
        };
      } else if (mutation === "opcode immediate") {
        const value = constant(mod.functions);
        if (!value) throw Error("actual constant absent");
        const before = value.value;
        value.value = Number(before) + 1;
        restore = () => {
          value.value = before;
        };
      } else if (mutation === "function census") {
        const fn = mod.functions[0]!;
        mod.functions.push(fn);
        restore = () => {
          mod.functions.pop();
        };
      } else if (mutation === "export census") {
        const before = mod.exports[0]!.name;
        mod.exports[0]!.name = before + "_unjoined";
        restore = () => {
          mod.exports[0]!.name = before;
        };
      } else if (mutation === "mutable original alias") {
        const before = mod.stringPool;
        mod.stringPool = current.emission.module.stringPool;
        expect(mod.stringPool).toBe(current.emission.module.stringPool);
        restore = () => {
          mod.stringPool = before;
        };
      } else {
        expect(mod.dataSegments).toHaveLength(0);
        mod.dataSegments.push({ offset: 0, bytes: new Uint8Array([1]) });
        restore = () => {
          mod.dataSegments.pop();
        };
      }
      expect(() => completePreparedPresentationFinalization(token)).toThrow(
        /^prepared presentation finalization: output-changed$/,
      );
      restore();
      expect(() => completePreparedPresentationFinalization(token)).toThrow(
        /^prepared presentation finalization: invalid-token$/,
      );
      expect(emittedPhysicalSetupPlan(current.emission)).toBeDefined();
      finish(prepared());
    });
  it("keeps C's separate direct-original-mutation poison permanent after exact restoration", () => {
    const current = prepared();
    const plan = emittedPhysicalSetupPlan(current.emission);
    const before = emitBinary(current.emission.module);
    const slots = [...wideningSlots(current.emission.module)].map((path) => {
      const keys = path.split(".").slice(1);
      const key = keys.pop()!;
      let parent: unknown = current.emission.module;
      for (const part of keys) parent = (parent as Record<string, unknown>)[part];
      const record = parent as Record<string, unknown>;
      return { record, key, value: record[key] };
    });
    expect(slots.length).toBeGreaterThan(0);
    widenNonDefaultableTypes(current.emission.module);
    expect(() => emittedPhysicalSetupPlan(current.emission)).toThrow(/physical module reservations:/);
    for (const slot of slots) slot.record[slot.key] = slot.value;
    expect(emitBinary(current.emission.module)).toEqual(before);
    expect(() => emittedPhysicalSetupPlan(current.emission)).toThrow(
      /physical module reservations: completion requested in failed/,
    );
    expect(emittedPhysicalSetupPlan(prepared().emission)).not.toBe(plan);
  });
});
