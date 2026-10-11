// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { createJavaScriptAdapterManifest, validateJavaScriptAdapterManifest } from "../src/adapter-manifest.js";
import { validateExportBoundaryPolicies } from "../src/boundary-policy.js";
import { buildCompiledAdapterImports, instantiateWasm, wrapExports, wrapCompiledExports } from "../src/runtime.js";
import * as consumer from "../src/ir/program-consumer.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";
import type { WasmModule, ExportSignature } from "../src/ir/types.js";
import type { CompileOptions } from "../src/index.js";
const BACKENDS = ["wasmgc", "linear"] as const;
type Backend = (typeof BACKENDS)[number];
type Input = Parameters<typeof runPreparedIrPipelinePresentation>[0];
type ArtifactResult = Extract<ReturnType<typeof runPreparedIrPipelinePresentation>, { kind: "artifacts" }>;
const BOOLEAN = `export function negate(flag: boolean): boolean { return !flag; }
export function echo(flag: boolean): boolean { return flag; }
export function yes(): boolean { return true; }
export function no(): boolean { return false; }
export function compare(a: number, b: number): boolean { return a > b; }
export function choose(value: number, flag: boolean): number { return flag ? value + 2 : value - 2; }`;
const SPECIAL = `export function __negate(flag: boolean): boolean { return !flag; }
export function __module_init(flag: boolean): boolean { return !flag; }
export function __proto__(flag: boolean): boolean { return !flag; }
export function constructor(flag: boolean): boolean { return !flag; }`;
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

function physicalSnapshot(module: WasmModule) {
  const { exportSignatures: _presentationMetadata, ...physical } = module;
  return {
    module,
    state: structuredClone(physical),
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
  const { exportSignatures: _presentationMetadata, ...physical } = module;
  expect(physical).toEqual(before.state);
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

function artifacts(source: string, backend: Backend): ArtifactResult {
  const result = runPreparedIrPipelinePresentation(input({ "./entry.ts": source }, backend));
  expect(result.kind, JSON.stringify(result)).toBe("artifacts");
  if (result.kind !== "artifacts") throw new Error("genuine Boolean presentation was refused");
  expect(result.artifacts.success, JSON.stringify(result.artifacts.errors)).toBe(true);
  expect(result.artifacts.errors).toEqual([]);
  expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(true);
  return result;
}
async function instantiated(result: ArtifactResult) {
  const manifest = result.artifacts.adapterManifest;
  expect(manifest).toBeDefined();
  if (!manifest) throw new Error("genuine adapter manifest missing");
  const imports = buildCompiledAdapterImports(manifest);
  const { instance } = await instantiateWasm(
    result.artifacts.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return { instance, wrapped: wrapCompiledExports(result.artifacts, instance) };
}
function callable(
  exports: Record<string, unknown> | WebAssembly.Exports,
  name: string,
): (...args: unknown[]) => unknown {
  const value = exports[name];
  expect(Object.hasOwn(exports, name)).toBe(true);
  expect(typeof value).toBe("function");
  if (typeof value !== "function") throw new Error(`actual own export ${name} missing`);
  return (...args) => value(...args);
}
function parsedHelperManifest(helper: string): unknown {
  const marker = "const adapterManifest = ";
  const start = helper.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  expect(helper.indexOf(marker, start + marker.length)).toBe(-1);
  const end = helper.indexOf(";\n\nexport function createImports", start);
  expect(end).toBeGreaterThan(start);
  const expression = helper.slice(start + marker.length, end);
  if (expression.startsWith("JSON.parse(")) {
    expect(expression.endsWith(")")).toBe(true);
    return JSON.parse(JSON.parse(expression.slice("JSON.parse(".length, -1)));
  }
  return JSON.parse(expression);
}
function generatedHelper(result: ArtifactResult, body: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), "ir-boolean-original-helper-"));
  try {
    const original = result.artifacts.importsHelper;
    const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
    const helper = original.replace('from "js2wasm"', `from ${JSON.stringify(runtime)}`);
    expect(helper).not.toBe(original);
    writeFileSync(join(dir, "module.imports.mjs"), helper);
    writeFileSync(join(dir, "module.wasm"), result.artifacts.binary);
    writeFileSync(
      join(dir, "run.mjs"),
      `import {readFileSync} from "node:fs";import {instantiateBytes} from "./module.imports.mjs";const result=await instantiateBytes(readFileSync(new URL("./module.wasm",import.meta.url)));${body}`,
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
const TRUTHINESS = `const calls=[];let hooks=0;const cases=[undefined,null,false,0,-0,NaN,"",0n,true,1,-1,Infinity,"0","not-a-number",2**32,1n,Symbol("truthy"),{},[],new Boolean(false),{valueOf(){hooks++;throw new Error("unexpected numeric hook");},toString(){hooks++;throw new Error("unexpected string hook");},[Symbol.toPrimitive](){hooks++;throw new Error("unexpected primitive hook");}}];for(const value of cases){const actual=result.exports.negate(value);calls.push({actual,type:typeof actual,expected:!value});}const missing=result.exports.negate();console.log(JSON.stringify({calls,hooks,missing,missingType:typeof missing}));`;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await setImmediate();
});
describe("#3525 genuine prepared Boolean materialization boundary", () => {
  for (const backend of BACKENDS) {
    it(`executes true/false, identity, constants, comparison and mixed slots through the original ${backend}/host helper`, async () => {
      const result = artifacts(BOOLEAN, backend);
      const { instance, wrapped } = await instantiated(result);
      expect(callable(instance.exports, "negate")(0)).toBe(1);
      expect(callable(instance.exports, "negate")(1)).toBe(0);
      for (const flag of [true, false]) {
        expect(callable(wrapped, "negate")(flag)).toBe(!flag);
        expect(callable(wrapped, "echo")(flag)).toBe(flag);
        expect(typeof callable(wrapped, "echo")(flag)).toBe("boolean");
      }
      expect(callable(wrapped, "yes")()).toBe(true);
      expect(callable(wrapped, "no")()).toBe(false);
      expect(callable(wrapped, "compare")(5, 2)).toBe(true);
      expect(callable(wrapped, "compare")(2, 5)).toBe(false);
      expect(callable(wrapped, "choose")(10, true)).toBe(12);
      expect(callable(wrapped, "choose")(10, false)).toBe(8);
      expect(
        generatedHelper(
          result,
          `console.log(JSON.stringify({negateTrue:result.exports.negate(true),negateFalse:result.exports.negate(false),identityTrue:result.exports.echo(true),identityFalse:result.exports.echo(false),yes:result.exports.yes(),no:result.exports.no(),compareTrue:result.exports.compare(5,2),compareFalse:result.exports.compare(2,5),mixedTrue:result.exports.choose(10,true),mixedFalse:result.exports.choose(10,false),type:typeof result.exports.negate(true)}));`,
        ),
      ).toEqual({
        negateTrue: false,
        negateFalse: true,
        identityTrue: true,
        identityFalse: false,
        yes: true,
        no: false,
        compareTrue: true,
        compareFalse: false,
        mixedTrue: 12,
        mixedFalse: 8,
        type: "boolean",
      });
    });
    it(`never falls back to any attached legacy generator for genuine Boolean ${backend}/host output`, () => {
      const poison = () => {
        throw new Error("attached Boolean legacy generator poison");
      };
      const spies = [
        vi.spyOn(gcCodegen, "generateModule").mockImplementation(poison),
        vi.spyOn(gcCodegen, "generateMultiModule").mockImplementation(poison),
        vi.spyOn(linearCodegen, "generateLinearModule").mockImplementation(poison),
        vi.spyOn(linearCodegen, "generateLinearMultiModule").mockImplementation(poison),
      ];
      const result = artifacts("export function negate(flag:boolean):boolean{return !flag;}", backend);
      expect(
        generatedHelper(
          result,
          `console.log(JSON.stringify({atTrue:result.exports.negate(true),atFalse:result.exports.negate(false),type:typeof result.exports.negate(false)}));`,
        ),
      ).toEqual({ atTrue: false, atFalse: true, type: "boolean" });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
    it(`uses source ToBoolean including missing and truthy coercion counterexamples without hooks on ${backend}/host`, () => {
      const result = artifacts(BOOLEAN, backend);
      const observed = generatedHelper(result, TRUTHINESS);
      expect(observed).toEqual({
        calls: [
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          false,
        ].map((actual) => ({ actual, type: "boolean", expected: actual })),
        hooks: 0,
        missing: true,
        missingType: "boolean",
      });
    });
    it(`preserves all physical identities, bytes and exact branded ABI slots while attaching ${backend}/host metadata`, () => {
      const original = consumer.emitAcceptedIrProgram;
      let before: ReturnType<typeof physicalSnapshot> | undefined;
      let receipts: ReturnType<typeof consumer.emittedSupportFunctionReceipts> | undefined;
      vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
        const emitted = original(accepted);
        expect(emitted.module.exportSignatures).toBeUndefined();
        before = physicalSnapshot(emitted.module);
        receipts = consumer.emittedSupportFunctionReceipts(emitted);
        return emitted;
      });
      const result = artifacts(BOOLEAN, backend);
      expect(before).toBeDefined();
      if (!before) throw new Error("real emission observer missing");
      verifyPhysicalSnapshot(before, result);
      expect(consumer.emittedSupportFunctionReceipts(result.emission)).toEqual(receipts);
      const expected: Record<string, ExportSignature> = {
        negate: { params: ["boolean"], result: "boolean" },
        echo: { params: ["boolean"], result: "boolean" },
        yes: { params: [], result: "boolean" },
        no: { params: [], result: "boolean" },
        compare: { params: ["other", "other"], result: "boolean" },
        choose: { params: ["other", "boolean"], result: "other" },
      };
      expect(result.artifacts.exportSignatures).toEqual(expected);
      expect(result.emission.module.exportSignatures).toBe(result.artifacts.exportSignatures);
      expect(Object.isFrozen(result.artifacts.exportSignatures)).toBe(true);
      for (const name of ["negate", "echo"]) {
        const exported = result.emission.module.exports.find((row) => row.name === name);
        if (!exported || exported.desc.kind !== "func") throw new Error("real Boolean function export missing");
        const fn = result.emission.module.functions[exported.desc.index];
        if (!fn) throw new Error("real function slot missing");
        const type = result.emission.module.types[fn.typeIdx];
        if (type?.kind !== "func") throw new Error("real physical signature missing");
        expect(type.params).toEqual([{ kind: "i32", boolean: true }]);
        expect(type.results).toEqual([{ kind: "i32", boolean: true }]);
      }
      for (const name of ["negate", "echo"]) {
        const exported = result.program.abi.entries.find(
          (entry) => entry.contract.kind === "export" && entry.contract.externalName === name,
        );
        if (!exported || exported.contract.kind !== "export") throw new Error("actual Boolean ABI export join missing");
        const targetId = exported.contract.targetId;
        const target = result.program.abi.entries.find((entry) => entry.plan.id === targetId);
        if (!target || target.contract.kind !== "callable") throw new Error("actual Boolean callable contract missing");
        expect(target.contract.params).toEqual([{ kind: "val", val: { kind: "i32", boolean: true } }]);
        expect(target.contract.results).toEqual([{ kind: "val", val: { kind: "i32", boolean: true } }]);
        const binding = consumer.emittedProgramBindingIndex(result.emission, target.plan.id);
        expect(binding?.space).toBe("function");
        expect(result.emission.module.exports).toContainEqual({ name, desc: { kind: "func", index: binding?.index } });
      }
      const manifest = result.artifacts.adapterManifest;
      if (!manifest) throw new Error("actual manifest missing");
      expect(manifest.exportSignatures).toEqual(expected);
      expect(parsedHelperManifest(result.artifacts.importsHelper)).toEqual(manifest);
      expect(validateJavaScriptAdapterManifest(manifest)).toEqual([]);
      expect(
        validateExportBoundaryPolicies(result.artifacts.exportSignatures, result.artifacts.exportBoundaryPolicies),
      ).toEqual([]);
      for (const name of Object.keys(expected)) {
        const policies = result.artifacts.exportBoundaryPolicies?.[name];
        expect(policies).toBeDefined();
        if (!policies) throw new Error("actual policy missing");
        for (const [index, kind] of expected[name]!.params.entries())
          if (kind === "boolean")
            expect(policies.params[index]).toEqual({ kind: "boolean", policy: "primitive-value" });
        if (expected[name]!.result === "boolean")
          expect(policies.result).toEqual({ kind: "boolean", policy: "primitive-value" });
      }
    });
    it(`leaves numeric and void artifacts unmarked and their original ${backend}/host helpers unchanged`, () => {
      const result = artifacts(
        "export function calculate(value:number):number{return value*3+2;} export function finish(value:number):void{if(value>0)return;return;}",
        backend,
      );
      expect(result.artifacts.exportSignatures).toBeUndefined();
      expect(result.emission.module.exportSignatures).toBeUndefined();
      expect(result.artifacts.importsHelper).not.toContain("JSON.parse(");
      expect(
        generatedHelper(
          result,
          `const value=result.exports.finish(1);console.log(JSON.stringify({at7:result.exports.calculate(7),at11:result.exports.calculate(11),voidType:typeof value,isUndefined:value===undefined}));`,
        ),
      ).toEqual({ at7: 23, at11: 35, voidType: "undefined", isUndefined: true });
    });
    it(`preserves specifically marked __ user names, own __proto__ and constructor through ${backend}/host clone, policy and original helper`, async () => {
      const result = artifacts(SPECIAL, backend);
      const manifest = result.artifacts.adapterManifest;
      if (!manifest) throw new Error("actual special-name manifest missing");
      const { wrapped } = await instantiated(result);
      for (const name of ["__negate", "__module_init", "__proto__", "constructor"]) {
        expect(Object.hasOwn(manifest.exportSignatures, name)).toBe(true);
        expect(Object.hasOwn(manifest.exportBoundaries, name)).toBe(true);
        expect(callable(wrapped, name)(true)).toBe(false);
        expect(callable(wrapped, name)(false)).toBe(true);
      }
      expect(Object.getPrototypeOf(manifest.exportSignatures)).toBe(Object.prototype);
      expect(result.artifacts.importsHelper).toContain("const adapterManifest = JSON.parse(");
      expect(parsedHelperManifest(result.artifacts.importsHelper)).toEqual(manifest);
      expect(
        generatedHelper(
          result,
          `console.log(JSON.stringify(["__negate","__module_init","__proto__","constructor"].map(name=>({name,own:Object.hasOwn(result.exports,name),atTrue:result.exports[name](true),atFalse:result.exports[name](false),type:typeof result.exports[name](true)}))));`,
        ),
      ).toEqual(
        ["__negate", "__module_init", "__proto__", "constructor"].map((name) => ({
          name,
          own: true,
          atTrue: false,
          atFalse: true,
          type: "boolean",
        })),
      );
      expect(result.startup).toEqual({ kind: "none", hasTopLevelStatements: false });
    });
    for (const [name, source] of [
      ["string", "export function bad(flag:string):boolean{return flag.length>0;}"],
      ["Boolean object", "export function bad(flag:Boolean):boolean{return !!flag;}"],
      ["Boolean global", "export var flag:boolean=true;export function read():boolean{return flag;}"],
      ["default parameter", "export function bad(flag:boolean=true):boolean{return !flag;}"],
      ["optional parameter", "export function bad(flag?:boolean):boolean{return flag===true;}"],
      ["rest parameter", "export function bad(...flags:boolean[]):boolean{return flags.length>0;}"],
    ] as const)
      it(`retains genuine unsupported ${name} source on ${backend}/host`, () => {
        artifacts("export function negate(flag:boolean):boolean{return !flag;}", backend);
        const result = runPreparedIrPipelinePresentation(input({ "./entry.ts": source }, backend));
        expect(result.kind).toBe("presentation-unsupported");
        if (result.kind !== "presentation-unsupported") throw new Error("unsupported source unexpectedly admitted");
        expect(result.gaps).toContainEqual(
          expect.objectContaining({ field: "declaration", code: "non-numeric-boundary" }),
        );
      });
    for (const mutation of ["unbranded", "conflicting", "wrong-carrier", "wrong-arity", "wrong-index"] as const)
      it(`keeps authentic earlier C physical refusal for ${mutation} Boolean evidence on ${backend}/host`, () => {
        artifacts("export function negate(flag:boolean):boolean{return !flag;}", backend);
        const original = consumer.emitAcceptedIrProgram;
        vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
          const emitted = original(accepted);
          const exp = emitted.module.exports.find((row) => row.name === "negate");
          if (!exp || exp.desc.kind !== "func") throw new Error("healthy bound export missing");
          if (mutation === "wrong-index") {
            exp.desc.index = emitted.module.functions.length + 10;
            return emitted;
          }
          const fn = emitted.module.functions[exp.desc.index];
          if (!fn) throw new Error("healthy function missing");
          const type = emitted.module.types[fn.typeIdx];
          if (type?.kind !== "func") throw new Error("healthy type missing");
          if (mutation === "unbranded") type.params[0] = { kind: "i32" };
          if (mutation === "conflicting") type.params[0] = { kind: "i32", boolean: true, int32: true };
          if (mutation === "wrong-carrier") type.params[0] = { kind: "f64" };
          if (mutation === "wrong-arity") type.params.push({ kind: "i32", boolean: true });
          return emitted;
        });
        expect(() =>
          runPreparedIrPipelinePresentation(
            input({ "./entry.ts": "export function negate(flag:boolean):boolean{return !flag;}" }, backend),
          ),
        ).toThrow(/^physical module reservations:/);
      });
    it(`refuses injected pre-existing Boolean metadata instead of accepting observer authority on ${backend}/host`, () => {
      artifacts("export function negate(flag:boolean):boolean{return !flag;}", backend);
      const original = consumer.emitAcceptedIrProgram;
      vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce((accepted) => {
        const emitted = original(accepted);
        emitted.module.exportSignatures = { negate: { params: ["boolean"], result: "boolean" } };
        return emitted;
      });
      const result = runPreparedIrPipelinePresentation(
        input({ "./entry.ts": "export function negate(flag:boolean):boolean{return !flag;}" }, backend),
      );
      expect(result.kind).toBe("presentation-unsupported");
      if (result.kind !== "presentation-unsupported") throw new Error("observer signature map was accepted");
      expect(result.gaps).toContainEqual(
        expect.objectContaining({ field: "exportSignatures", code: "boundary-metadata" }),
      );
    });
  }
  for (const marshal of ["copy", false] as const) {
    for (const [label, wire] of [
      ["two", 2],
      ["negative", -1],
      ["negative zero", -0],
      ["NaN", NaN],
      ["undefined", undefined],
      ["reference", {}],
    ] as const)
      it(`rejects malformed ${label} Boolean wire result with marshal ${marshal}`, () => {
        const original = vi.fn(() => wire);
        const raw: WebAssembly.Exports = { flag: original };
        const wrapped = wrapExports(raw, { marshal, signatures: { flag: { params: [], result: "boolean" } } });
        expect(() => wrapped.flag()).toThrow(TypeError);
        expect(original).toHaveBeenCalledTimes(1);
      });
    it(`materializes ToBoolean exactly once without replaceable global converters with marshal ${marshal}`, () => {
      const original = vi.fn((value: number) => value);
      const raw: WebAssembly.Exports = { echo: original };
      const wrapped = wrapExports(raw, { marshal, signatures: { echo: { params: ["boolean"], result: "boolean" } } });
      const hooks = vi.fn(() => {
        throw new Error("unreachable coercion sentinel");
      });
      const object = { [Symbol.toPrimitive]: hooks, valueOf: hooks, toString: hooks };
      vi.stubGlobal("Boolean", () => {
        throw new Error("replaceable Boolean converter invoked");
      });
      expect(wrapped.echo(object)).toBe(true);
      expect(wrapped.echo()).toBe(false);
      expect(hooks).not.toHaveBeenCalled();
      expect(original.mock.calls).toEqual([[1], [0]]);
    });
  }
  it("ignores an inherited Boolean signature on an unmarked internal-name export", () => {
    const original = vi.fn(() => 0);
    const raw: WebAssembly.Exports = { __negate: original };
    const inherited = Object.create({ __negate: { params: ["boolean"], result: "boolean" } });
    const wrapped = wrapExports(raw, { signatures: inherited });
    expect(wrapped.__negate).toBe(original);
    expect(wrapped.__negate(true)).toBe(0);
    expect(original).toHaveBeenCalledWith(true);
  });
  for (const name of ["__proto__", "constructor"])
    it(`rejects inherited-only ${name} policy for an own authentic signature key`, () => {
      const result = artifacts(SPECIAL, "wasmgc");
      const manifest = result.artifacts.adapterManifest;
      if (!manifest) throw new Error("actual manifest missing");
      const inherited = Object.create({ [name]: manifest.exportBoundaries[name] });
      for (const [key, row] of Object.entries(manifest.exportBoundaries))
        if (key !== name) Object.defineProperty(inherited, key, { value: row, enumerable: true });
      expect(validateExportBoundaryPolicies(manifest.exportSignatures, inherited)).toContain(
        `export '${name}' has no boundary policy`,
      );
    });
  it("rejects tampered positional Boolean boundary policy from a genuine manifest", () => {
    const result = artifacts(BOOLEAN, "wasmgc");
    const manifest = result.artifacts.adapterManifest;
    if (!manifest) throw new Error("actual manifest missing");
    const boundaries = { ...manifest.exportBoundaries };
    const row = boundaries.negate;
    if (!row) throw new Error("actual policy missing");
    boundaries.negate = { ...row, params: [{ kind: "other", policy: "primitive-value" }, ...row.params.slice(1)] };
    const forged = createJavaScriptAdapterManifest({ ...manifest, exportBoundaries: boundaries });
    expect(validateJavaScriptAdapterManifest(forged)).toContain(
      "export 'negate' parameter #0 policy kind 'other' does not match 'boolean'",
    );
    expect(() => buildCompiledAdapterImports(forged)).toThrow(/boundary|policy/i);
  });
});
