// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import * as binary from "../src/emit/binary.js";
import * as wat from "../src/emit/wat.js";
import * as output from "../src/compiler/output.js";
import { preparedIrProgramOwner } from "../src/ir/program.js";
import { emittedPhysicalSetupPlan, emittedProgramBindingIndex } from "../src/ir/program-consumer.js";
import { renderPreparedWit, type PreparedWitView } from "../src/wit-generator.js";
import { ts } from "../src/ts-api.js";
import type { CompileOptions } from "../src/index.js";

const BACKENDS = ["wasmgc", "linear"] as const;
type Backend = (typeof BACKENDS)[number];
type Input = Parameters<typeof runPreparedIrPipelinePresentation>[0];
type Prepared = Extract<
  ReturnType<typeof presentation.prepareIrProgramPresentation>,
  { kind: "prepared-presentation" }
>;
type Artifact = Extract<ReturnType<typeof runPreparedIrPipelinePresentation>, { kind: "artifacts" }>;
type Files = Record<string, string>;
interface Call {
  name: string;
  args: unknown[];
  promise?: true;
}
interface Fixture {
  name: string;
  files: Files;
  signatures: string[];
  calls: Call[];
}
const NUMBERS = [-0, NaN, Infinity, -Infinity, 7.25];
const ORIGINAL_MIXED = {
  "./a.ts": "export let left: number = 1; left = left + 1;",
  "./b.ts": "export let right: number = 10; right = right + 2;",
  "./entry.ts":
    '\n    import { left } from "./a";\n    import { right } from "./b";\n    let phase: number = 0;\n    export function initial(): number { return left * 100 + right; }\n    export function readPhase(): number { return phase; }\n    function compute(seed: number): number {\n      let total = 0;\n      for (let i = 0; i < 4; i++) {\n        if (i % 2 === 0) total = total + Math.imul(seed, i + 1);\n        else total = total - i;\n      }\n      return total;\n    }\n    \n  export async function run(seed: number): Promise<number> {\n    phase = 1;\n    const first = await (seed + 1);\n    phase = 2;\n    const second = await compute(first);\n    phase = 3;\n    return second + initial();\n  }\n\n  ',
};

const NUMERIC = { "./entry.ts": "export function echo(value:number){return value;}" };
const FIXTURES: Fixture[] = [
  {
    name: "escaped source keywords",
    files: { "./entry.ts": "export function map(async:number):number{return async*2;}" },
    signatures: ["%map: func(%async: f64) -> f64;"],
    calls: [
      { name: "map", args: [7] },
      { name: "map", args: [11] },
    ],
  },
  {
    name: "inferred numeric result",
    files: NUMERIC,
    signatures: ["echo: func(value: f64) -> f64;"],
    calls: NUMBERS.map((value) => ({ name: "echo", args: [value] })),
  },
  {
    name: "annotated numeric result and argument order",
    files: { "./entry.ts": "export function calculate(left:number,right:number):number{return left*3+right;}" },
    signatures: ["calculate: func(left: f64, right: f64) -> f64;"],
    calls: [
      { name: "calculate", args: [7, 11] },
      { name: "calculate", args: [11, 7] },
    ],
  },
  {
    name: "logical Boolean and physical i32",
    files: {
      "./entry.ts":
        "export function negate(flag:boolean):boolean{return !flag;} export function compare(left:number,right:number):boolean{return left>right;}",
    },
    signatures: ["negate: func(flag: bool) -> bool;", "compare: func(left: f64, right: f64) -> bool;"],
    calls: [
      ...[true, false, 0, 1, -0, NaN, "", null].map((flag) => ({ name: "negate", args: [flag] })),
      { name: "compare", args: [7, 11] },
      { name: "compare", args: [11, 7] },
    ],
  },
  {
    name: "genuine void with parameter",
    files: { "./entry.ts": "export function finish(value:number):void{return;}" },
    signatures: ["finish: func(value: f64);"],
    calls: NUMBERS.map((value) => ({ name: "finish", args: [value] })),
  },
  {
    name: "genuine void without parameter",
    files: { "./entry.ts": "export function finish():void{}" },
    signatures: ["finish: func();"],
    calls: [{ name: "finish", args: [] }],
  },
  {
    name: "local aliases preserve every external identity",
    files: { "./entry.ts": "function echo(value:number){return value;} export {echo as first,echo as second};" },
    signatures: ["first: func(value: f64) -> f64;", "second: func(value: f64) -> f64;"],
    calls: NUMBERS.flatMap((value) => [
      { name: "first", args: [value] },
      { name: "second", args: [value] },
    ]),
  },
  {
    name: "cross-source reexport",
    files: {
      "./math.ts": "export function echo(value:number){return value;}",
      "./entry.ts": 'export {echo as forwarded} from "./math";',
    },
    signatures: ["forwarded: func(value: f64) -> f64;"],
    calls: NUMBERS.map((value) => ({ name: "forwarded", args: [value] })),
  },
  {
    name: "same-spelling donor ownership",
    files: {
      "./left.ts": "export function same(value:number):number{return value*3;}",
      "./right.ts": "export function same(value:number):number{return value+11;}",
      "./entry.ts": 'export {same as left} from "./left"; export {same as right} from "./right";',
    },
    signatures: ["left: func(value: f64) -> f64;", "right: func(value: f64) -> f64;"],
    calls: [
      { name: "left", args: [7] },
      { name: "right", args: [7] },
      { name: "left", args: [11] },
      { name: "right", args: [11] },
    ],
  },
  {
    name: "user module-init spelling is public",
    files: { "./entry.ts": "export function __module_init(value:number):number{return value+7;}" },
    signatures: ["module-init: func(value: f64) -> f64;"],
    calls: [{ name: "__module_init", args: [11] }],
  },
];

function realPipelineInput(
  files: Files,
  backend: Backend,
  overrides: CompileOptions = {},
  entryFile = "./entry.ts",
): Input {
  const ast = analyzeMultiSource(files, entryFile);
  expect(ast.syntacticDiagnostics).toEqual([]);
  const options: CompileOptions = {
    target: backend === "linear" ? "linear" : "gc",
    optimize: false,
    sourceMap: false,
    moduleName: "prepared-wit",
    wit: true,
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
    codegenOptions: { link: [], sourceMap: false },
    sourcesContent: new Map(ast.sourceFiles.map((file) => [file.fileName, file.text])),
    diagnosticAnchor: ast.entryFile,
    options,
  };
}
function request(current: Input, backend: Backend): presentation.IrProgramPresentationRequest {
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
function prepared(files: Files = NUMERIC, backend: Backend = "wasmgc", overrides: CompileOptions = {}): Prepared {
  const result = presentation.prepareIrProgramPresentation(
    request(realPipelineInput(files, backend, overrides), backend),
  );
  expect(result.kind, inspect(result, { depth: 5 })).toBe("prepared-presentation");
  if (result.kind !== "prepared-presentation") throw Error(inspect(result));
  return result;
}
function artifact(current: Input): Artifact {
  const result = runPreparedIrPipelinePresentation(current);
  expect(result.kind, inspect(result, { depth: 5 })).toBe("artifacts");
  if (result.kind !== "artifacts") throw Error(inspect(result));
  expect(result.artifacts.success).toBe(true);
  expect(result.artifacts.errors).toEqual([]);
  expect(WebAssembly.validate(new Uint8Array(result.artifacts.binary))).toBe(true);
  return result;
}
function logicalKind(type: ts.Type): "number" | "boolean" | null {
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  expect(type.flags & ts.TypeFlags.Void).not.toBe(0);
  return null;
}
/** Independent checker -> export ABI -> callable unit -> absolute physical signature census. */
function census(current: Input, result: Pick<Prepared, "program" | "emission">, view: PreparedWitView): void {
  const ast = current.multiAst!;
  const checker = ast.checker;
  const moduleSymbol = checker.getSymbolAtLocation(ast.entryFile)!;
  const publicSymbols = checker.getExportsOfModule(moduleSymbol);
  expect(view.exports.map((row) => row.externalName).sort()).toEqual(publicSymbols.map((symbol) => symbol.name).sort());
  const abi = result.program.abi.entries;
  expect(
    abi
      .filter((entry) => entry.contract.kind === "export")
      .map((entry) => (entry.contract.kind === "export" ? entry.contract.externalName : ""))
      .sort(),
  ).toEqual(publicSymbols.map((symbol) => symbol.name).sort());
  for (const symbol of publicSymbols) {
    const row = view.exports.find((exported) => exported.externalName === symbol.name)!;
    let target = symbol;
    if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
    const declaration = target.valueDeclaration!;
    expect(ts.isFunctionDeclaration(declaration)).toBe(true);
    if (!ts.isFunctionDeclaration(declaration)) throw Error("noncallable checker export");
    const signature = checker.getSignatureFromDeclaration(declaration)!;
    const expectedParams = declaration.parameters.map((parameter) => ({
      sourceName: parameter.name.getText(),
      kind: logicalKind(checker.getTypeAtLocation(parameter)),
    }));
    const expectedResult = logicalKind(checker.getReturnTypeOfSignature(signature));
    expect(row.params).toEqual(expectedParams);
    expect(row.result).toBe(expectedResult);
    expect(row.sourceFile).toBe(declaration.getSourceFile().fileName);
    const exported = abi.find(
      (entry) => entry.contract.kind === "export" && entry.contract.externalName === symbol.name,
    )!;
    expect(row.bindingId).toBe(exported.plan.id);
    if (exported.contract.kind !== "export") throw Error("missing export ABI");
    const targetId = exported.contract.targetId;
    let owner = abi.find((entry) => entry.plan.id === targetId)!;
    const visited = new Set();
    while (owner.plan.aliasOf) {
      expect(visited.has(owner.plan.id)).toBe(false);
      visited.add(owner.plan.id);
      owner = abi.find((entry) => entry.plan.id === owner.plan.aliasOf)!;
    }
    expect(owner.contract.kind).toBe("callable");
    expect(owner.plan.intent.kind).toBe("callable");
    if (owner.contract.kind !== "callable" || owner.plan.intent.kind !== "callable")
      throw Error("missing callable owner");
    expect(row.unitId).toBe(owner.plan.intent.unitId);
    const sourceOwner = preparedIrProgramOwner(result.program, row.unitId)!;
    const terminal = result.program.units.get(row.unitId)!;
    expect(sourceOwner.sourceFile).toBe(declaration.getSourceFile().fileName);
    expect(terminal.id).toBe(row.unitId);
    expect(sourceOwner.location.declarationStart).toBe(declaration.getStart());
    expect(sourceOwner.location.declarationEnd).toBe(declaration.end);
    expect(terminal.declarationStart).toBe(declaration.getStart());
    expect(terminal.declarationEnd).toBe(declaration.end);
    expect(sourceOwner.location.sourceId).toBe(
      result.program.inventory.sources.find((source) => source.originalFileName === sourceOwner.sourceFile)!.id,
    );
    const slot = emittedProgramBindingIndex(result.emission, exported.contract.targetId)!;
    expect(slot.space).toBe("function");
    const module = result.emission.module;
    const physical = module.exports.filter((entry) => entry.name === symbol.name);
    expect(physical).toHaveLength(1);
    expect(physical[0]!.desc).toEqual({ kind: "func", index: slot.index });
    const fn = module.functions[slot.index - module.imports.filter((entry) => entry.desc.kind === "func").length]!;
    const type = module.types[fn.typeIdx]!;
    expect(type.kind).toBe("func");
    if (type.kind !== "func") throw Error("nonfunction physical signature");
    const wire = (kind: "number" | "boolean" | null) =>
      kind === "boolean" ? { kind: "i32", boolean: true } : { kind: "f64" };
    expect(type.params).toEqual(expectedParams.map((parameter) => wire(parameter.kind)));
    expect(type.results).toEqual(expectedResult === null ? [] : [wire(expectedResult)]);
    expect(owner.contract.params.map((parameter) => (parameter.kind === "val" ? parameter.val : parameter))).toEqual(
      type.params,
    );
    expect(owner.contract.results.map((parameter) => (parameter.kind === "val" ? parameter.val : parameter))).toEqual(
      type.results,
    );
  }
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.exports)).toBe(true);
  for (const row of view.exports) {
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.params)).toBe(true);
    for (const parameter of row.params) expect(Object.isFrozen(parameter)).toBe(true);
  }
}
function encode(value: unknown): unknown {
  if (value === undefined) return "undefined";
  if (typeof value !== "number") return value;
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return value;
}
/** Preserve the ORIGINAL helper; Node's loader maps its package import to the real runtime. */
function childObservations(files: Files, result: Artifact, calls: Call[]): unknown[] {
  const root = join(import.meta.dirname, "../.tmp/prepared-wit-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "observation-"));
  writeFileSync(join(dir, "module.imports.mjs"), result.artifacts.importsHelper);
  writeFileSync(join(dir, "module.wasm"), result.artifacts.binary);
  for (const [name, source] of Object.entries(files))
    writeFileSync(
      join(dir, name.replace(/\.ts$/, ".mjs")),
      ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
        .outputText,
    );
  const runtime = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
  writeFileSync(
    join(dir, "run.mjs"),
    `import {registerHooks} from 'node:module'; import {readFileSync,existsSync} from 'node:fs'; registerHooks({resolve(specifier,context,nextResolve){if(specifier==='js2wasm')return nextResolve(${JSON.stringify(runtime)},context);if(specifier.startsWith('./')&&!/\\.[a-z]+$/.test(specifier)){const url=new URL(specifier+'.mjs',context.parentURL);if(existsSync(url))return nextResolve(url.href,context);}return nextResolve(specifier,context);}});const e=process.argv[2]==='native'?await import('./entry.mjs'):(await (await import('./module.imports.mjs')).instantiateBytes(readFileSync(new URL('./module.wasm',import.meta.url)))).exports;const encode=${encode.toString()};const calls=${inspect(calls, { depth: null, maxArrayLength: null })};const rows=[];for(const call of calls){const value=e[call.name](...call.args);if(call.promise&&!(value instanceof Promise))throw Error('not a real Promise');rows.push(encode(call.promise?await value:value));}console.log(JSON.stringify(rows));`,
  );
  const rows = [];
  for (const mode of ["native", "helper"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", join(dir, "run.mjs"), mode], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 30000,
    });
    writeFileSync(join(dir, `${mode}.stdout`), child.stdout ?? "");
    writeFileSync(join(dir, `${mode}.stderr`), child.stderr ?? "");
    writeFileSync(
      join(dir, `${mode}.status.json`),
      JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message }),
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    rows.push(JSON.parse(child.stdout.trim()) as unknown[]);
  }
  expect(rows[1]).toEqual(rows[0]);
  return rows[0]!;
}
function rawObservations(result: Artifact, view: PreparedWitView, calls: Call[]): unknown[] {
  expect(result.emission.module.imports).toEqual([]);
  const exports = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.artifacts.binary))).exports;
  return calls.map((call) => {
    const row = view.exports.find((exported) => exported.externalName === call.name)!;
    const fn = exports[call.name] as (...args: unknown[]) => unknown;
    const value = fn(
      ...call.args.map((arg, index) => (row.params[index]!.kind === "boolean" ? Number(Boolean(arg)) : arg)),
    );
    return encode(row.result === "boolean" ? Boolean(value) : value);
  });
}
function typedGap(result: ReturnType<typeof runPreparedIrPipelinePresentation>, field: string, code: string): void {
  expect(result.kind, inspect(result)).toBe("presentation-unsupported");
  if (result.kind !== "presentation-unsupported") throw Error("expected WIT refusal");
  const gaps = result.gaps.filter((gap) => gap.field === field && gap.code === code);
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) {
    expect(gap.detail.length).toBeGreaterThan(0);
    expect(gap.sourceFile).toBeDefined();
  }
  expect(result).not.toHaveProperty("artifacts");
  expect(result).not.toHaveProperty("emission");
}
afterEach(() => vi.restoreAllMocks());

describe("prepared WIT genuine source transactions", () => {
  for (const backend of BACKENDS)
    for (const fixture of FIXTURES)
      it(`${backend}: ${fixture.name} joins the complete census and executes original helper/native/binary`, () => {
        const current = realPipelineInput(fixture.files, backend);
        const admission = presentation.prepareIrProgramPresentation(request(current, backend));
        expect(admission.kind).toBe("prepared-presentation");
        if (admission.kind !== "prepared-presentation") throw Error(inspect(admission));
        const view = presentation.preparedPresentationWitView(admission, admission.emission.module);
        census(current, admission, view);
        const result = artifact(current);
        const functions = result.artifacts
          .wit!.split("\n")
          .filter((line) => line.trim().startsWith("export "))
          .map((line) => line.trim().replace(/^export /, ""));
        expect(functions.sort()).toEqual([...fixture.signatures].sort());
        const observations = childObservations(fixture.files, result, fixture.calls);
        expect(rawObservations(result, view, fixture.calls)).toEqual(observations);
        const plain = artifact(realPipelineInput(fixture.files, backend, { wit: false }));
        expect(plain.artifacts.wit).toBeUndefined();
        expect(rawObservations(plain, view, fixture.calls)).toEqual(observations);
      });
  for (const backend of BACKENDS)
    it(`${backend}: default and legal custom naming preserve exact naming`, () => {
      expect(artifact(realPipelineInput(NUMERIC, backend)).artifacts.wit).toContain("package js2wasm:entry;");
      for (const names of [
        { packageName: "UPPER:WORLD", worldName: "UPPER-WORLD" },
        { packageName: "demo:%map", worldName: "%async" },
        { packageName: "demo:%world@1.2.3-alpha.1+build.7", worldName: "%world" },
      ]) {
        Object.freeze(names);
        const result = artifact(realPipelineInput(NUMERIC, backend, { wit: names }));
        expect(result.artifacts.wit).toContain(`package ${names.packageName};`);
        expect(result.artifacts.wit).toContain(`world ${names.worldName} {`);
      }
    });
  for (const backend of BACKENDS)
    for (const [name, files, field] of [
      [
        "export collision",
        {
          "./entry.ts":
            "export function fooBar(value:number):number{return value;} export function foo_bar(value:number):number{return value+1;}",
        },
        "wit.exports",
      ],
      [
        "parameter collision",
        { "./entry.ts": "export function choose(fooBar:number,foo_bar:number):number{return fooBar*3+foo_bar;}" },
        "wit.params",
      ],
      [
        "public global",
        { "./entry.ts": "export let marker:number=7; export function read():number{return marker;}" },
        "wit.exports",
      ],
    ] as const)
      it(`${backend}: ${name} refuses requested WIT and preserves no-WIT`, () => {
        artifact(realPipelineInput(files, backend, { wit: false }));
        const binarySpy = vi.spyOn(binary, "emitBinary"),
          watSpy = vi.spyOn(wat, "emitWat"),
          dtsSpy = vi.spyOn(output, "generateDts"),
          helperSpy = vi.spyOn(output, "generateImportsHelper");
        typedGap(
          runPreparedIrPipelinePresentation(realPipelineInput(files, backend)),
          field,
          name === "public global" ? "unmapped-wit-export" : "wit-name-collision",
        );
        expect(binarySpy).not.toHaveBeenCalled();
        expect(watSpy).not.toHaveBeenCalled();
        expect(dtsSpy).not.toHaveBeenCalled();
        expect(helperSpy).not.toHaveBeenCalled();
      });
  for (const backend of BACKENDS)
    for (const [field, names] of [
      ["wit.packageName", { packageName: "bad/name:entry" }],
      ["wit.worldName", { worldName: "bad_world" }],
      ["wit.worldName", { worldName: "async" }],
      ["wit.worldName", { worldName: "map" }],
      ["wit.packageName", { packageName: "demo:map" }],
      ["wit.worldName", { worldName: "x; export injected: func();" }],
      ["wit.worldName", { worldName: "bad\nworld" }],
    ] as const)
      it(`${backend}: located ${field} refusal for ${JSON.stringify(names)}`, () => {
        const binarySpy = vi.spyOn(binary, "emitBinary"),
          watSpy = vi.spyOn(wat, "emitWat"),
          dtsSpy = vi.spyOn(output, "generateDts"),
          helperSpy = vi.spyOn(output, "generateImportsHelper");
        typedGap(
          runPreparedIrPipelinePresentation(realPipelineInput(NUMERIC, backend, { wit: names })),
          field,
          "invalid-wit-name",
        );
        expect(binarySpy).not.toHaveBeenCalled();
        expect(watSpy).not.toHaveBeenCalled();
        expect(dtsSpy).not.toHaveBeenCalled();
        expect(helperSpy).not.toHaveBeenCalled();
      });
});

describe("prepared WIT authority from fresh genuine transactions", () => {
  it("rejects forged presentation, another module and unrequested authority", () => {
    const first = prepared(),
      second = prepared();
    const forged = new Proxy(first, {
      get() {
        throw Error("forged property inspected");
      },
    });
    expect(() => presentation.preparedPresentationWitView(forged, first.emission.module)).toThrow(
      "prepared presentation WIT: invalid presentation",
    );
    expect(() => presentation.preparedPresentationWitView({ ...first }, first.emission.module)).toThrow(
      "prepared presentation WIT: invalid presentation",
    );
    expect(() => presentation.preparedPresentationWitView(first, second.emission.module)).toThrow(
      "prepared presentation WIT: foreign module",
    );
    expect(presentation.preparedPresentationWitView(first, first.emission.module).exports).toHaveLength(1);
    const plain = prepared(NUMERIC, "wasmgc", { wit: false });
    expect(() => presentation.preparedPresentationWitView(plain, plain.emission.module)).toThrow(
      "prepared presentation WIT: invalid presentation",
    );
    expect(presentation.preparedPresentationWitView(second, second.emission.module).exports).toHaveLength(1);
  });
  for (const mutation of ["signature", "export slot", "metadata"] as const)
    it(`permanently rejects ${mutation} mutation followed by restoration; fresh source remains healthy`, () => {
      const genuine = prepared();
      const module = genuine.emission.module;
      const original = inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true });
      presentation.preparedPresentationWitView(genuine, module);
      let restore: () => void;
      if (mutation === "signature") {
        const exported = module.exports.find((row) => row.name === "echo")!;
        if (exported.desc.kind !== "func") throw Error("expected func");
        const fn =
          module.functions[exported.desc.index - module.imports.filter((row) => row.desc.kind === "func").length]!;
        const type = module.types[fn.typeIdx]!;
        if (type.kind !== "func") throw Error("expected signature");
        const old = type.results[0]!;
        type.results[0] = { kind: "i32" };
        restore = () => {
          type.results[0] = old;
        };
      } else if (mutation === "export slot") {
        const exported = module.exports.find((row) => row.name === "echo")!;
        if (exported.desc.kind !== "func") throw Error("expected func");
        const old = exported.desc.index;
        exported.desc.index = old + 1;
        restore = () => {
          exported.desc.index = old;
        };
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(module, "exportSignatures");
        module.exportSignatures = { echo: { params: [], result: "boolean" } };
        restore = () => {
          if (descriptor) Object.defineProperty(module, "exportSignatures", descriptor);
          else Reflect.deleteProperty(module, "exportSignatures");
        };
      }
      try {
        expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
          "prepared presentation finalization: output-changed",
        );
      } finally {
        restore();
      }
      expect(inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true })).toBe(
        original,
      );
      expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
        "prepared presentation WIT: invalid presentation",
      );
      const fresh = prepared();
      expect(presentation.preparedPresentationWitView(fresh, fresh.emission.module).exports).toHaveLength(1);
    });
});

describe("renderer-only malformed data and resource validation (not pipeline authority)", () => {
  const view = (): PreparedWitView => ({
    entryFile: "./entry.ts",
    exports: [
      {
        externalName: "echo",
        params: [{ sourceName: "value", kind: "number" }],
        result: "number",
        sourceFile: "./entry.ts",
        unitId: "unit" as PreparedWitView["exports"][number]["unitId"],
        bindingId: "binding" as PreparedWitView["exports"][number]["bindingId"],
      },
    ],
  });
  const options = () => ({ imports: [], types: [], capabilities: [] });
  for (const malformed of [
    "missing result",
    "missing parameter",
    "invalid kind",
    "duplicate external identity",
  ] as const)
    it(`refuses ${malformed} without silent omission`, () => {
      const input = view();
      const rows = input.exports as unknown as Record<string, unknown>[];
      if (malformed === "missing result") Reflect.deleteProperty(rows[0]!, "result");
      if (malformed === "missing parameter") rows[0]!.params = [undefined];
      if (malformed === "invalid kind") rows[0]!.result = "promise";
      if (malformed === "duplicate external identity") rows.push({ ...rows[0] });
      const settings = options();
      const original = inspect({ input, settings }, { depth: null });
      const result = renderPreparedWit(input, settings);
      expect(inspect({ input, settings }, { depth: null })).toBe(original);
      expect(result.kind).toBe("unsupported");
      if (result.kind !== "unsupported") throw Error("silent malformed success");
      expect(result.gaps).toContainEqual(expect.objectContaining({ field: "wit.exports", code: "invalid-wit-export" }));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.gaps)).toBe(true);
    });
  it("refuses supplied nonempty imports before rendering scalar subset", () => {
    const genuine = prepared();
    const input = presentation.preparedPresentationWitView(genuine, genuine.emission.module);
    const result = renderPreparedWit(input, {
      imports: [{ module: "external", name: "call", desc: { kind: "func", typeIdx: 0 } }],
      types: genuine.emission.module.types,
      capabilities: [],
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("silent resource success");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ field: "wit.resources", code: "unmapped-wit-resources", sourceFile: input.entryFile }),
    );
  });
});

describe("prepared WIT original mixed and earlier source refusals", () => {
  it("locates ORIGINAL_MIXED Promise mapping before detached begin and preserves no-WIT original helper", () => {
    expect(createHash("sha256").update(JSON.stringify(ORIGINAL_MIXED)).digest("hex")).toBe(
      "236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb",
    );
    const plain = artifact(realPipelineInput(ORIGINAL_MIXED, "wasmgc", { wit: false }));
    expect(plain.artifacts.wit).toBeUndefined();
    const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization");
    const finalBinary = vi.spyOn(binary, "emitBinary"),
      finalWat = vi.spyOn(wat, "emitWat"),
      dts = vi.spyOn(output, "generateDts"),
      helper = vi.spyOn(output, "generateImportsHelper");
    typedGap(
      runPreparedIrPipelinePresentation(realPipelineInput(ORIGINAL_MIXED, "wasmgc")),
      "wit.exports",
      "unmapped-wit-export",
    );
    expect(begin).not.toHaveBeenCalled();
    expect(finalBinary).not.toHaveBeenCalled();
    expect(finalWat).not.toHaveBeenCalled();
    expect(dts).not.toHaveBeenCalled();
    expect(helper).not.toHaveBeenCalled();
    // Observe real Promise fulfillment; full microtask/rejection ordering is outside this finite test.
    vi.restoreAllMocks();
    expect(
      childObservations(ORIGINAL_MIXED, plain, [
        { name: "initial", args: [] },
        { name: "readPhase", args: [] },
        { name: "run", args: [7], promise: true },
        { name: "readPhase", args: [] },
      ]),
    ).toEqual([212, 0, 240, 3]);
  });
  it("preserves the earlier linear Promise producer refusal", () => {
    for (const wit of [false, true]) {
      const result = runPreparedIrPipelinePresentation(realPipelineInput(ORIGINAL_MIXED, "linear", { wit }));
      expect(result.kind).toBe("unsupported");
      expect(inspect(result, { depth: null })).toContain("promise.capability.create");
      expect(result).not.toHaveProperty("artifacts");
    }
  });
});

describe("earlier preparation failures remain distinct from WIT preflight", () => {
  for (const backend of BACKENDS)
    for (const [name, source, code, detail] of [
      [
        "default-inferred",
        "export function add(value=2):number{return value+1;}",
        "type-resolution-unsupported",
        "function add has an unresolved parameter contract",
      ],
      [
        "original void local",
        "export function discard(value:number):void{const ignored=value+1;}",
        "body-shape-rejected",
        "ir/from-ast: unsupported tail statement FirstStatement in discard",
      ],
    ] as const)
      it(`${backend}: ${name} preserves the exact earlier failure with and without WIT`, () => {
        for (const wit of [false, true]) {
          const result = runPreparedIrPipelinePresentation(
            realPipelineInput({ "./entry.ts": source }, backend, { wit }),
          );
          expect(result.kind).toBe("unsupported");
          if (result.kind !== "unsupported") throw Error("earlier refusal erased");
          expect(result.phase).toBe("preparation");
          expect(result.failure).toMatchObject({ code, detail, sourceFile: "entry.ts" });
          expect(result).not.toHaveProperty("artifacts");
        }
      });
});

describe("genuine empty public census", () => {
  for (const backend of BACKENDS)
    it(`${backend}: a private callable has zero public WIT exports`, () => {
      const files = { "./entry.ts": "function privateFn(x:number):number{return x*2;} export {};" };
      const current = realPipelineInput(files, backend);
      const genuine = prepared(files, backend);
      const view = presentation.preparedPresentationWitView(genuine, genuine.emission.module);
      census(current, genuine, view);
      expect(genuine.program.abi.entries.some((entry) => entry.contract.kind === "callable")).toBe(true);
      expect(view.exports).toEqual([]);
      expect(genuine.emission.module.exports).toEqual([]);
      const result = artifact(current);
      expect(result.artifacts.wit).toBe("package js2wasm:entry;\n\nworld module {\n}\n");
      expect(new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.artifacts.binary))).exports).toEqual(
        {},
      );
    });
});

describe("genuine private Promise resources are not a scalar export authority", () => {
  const files = {
    "./entry.ts":
      "async function hidden(x:number):Promise<number>{const y=await (x+1);return y+1;} export function main(x:number):number{return x*2;}",
  };
  it("refuses requested GC resource graph before detached begin, while the no-WIT helper stays healthy", () => {
    const plain = artifact(realPipelineInput(files, "wasmgc", { wit: false }));
    expect(plain.finalization).toMatchObject({
      kind: "prepared-presentation-finalization",
      originalEmissionUnchanged: true,
    });
    expect(plain.emission.module.imports.length).toBeGreaterThan(0);
    expect(plain.artifacts.capabilityRequirements).toEqual([]);
    const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization"),
      finalBinary = vi.spyOn(binary, "emitBinary"),
      finalWat = vi.spyOn(wat, "emitWat"),
      dts = vi.spyOn(output, "generateDts"),
      helper = vi.spyOn(output, "generateImportsHelper");
    typedGap(
      runPreparedIrPipelinePresentation(realPipelineInput(files, "wasmgc")),
      "wit.resources",
      "unmapped-wit-resources",
    );
    expect(begin).not.toHaveBeenCalled();
    expect(finalBinary).not.toHaveBeenCalled();
    expect(finalWat).not.toHaveBeenCalled();
    expect(dts).not.toHaveBeenCalled();
    expect(helper).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(
      childObservations(files, plain, [
        { name: "main", args: [7] },
        { name: "main", args: [11] },
      ]),
    ).toEqual([14, 22]);
  });
  it("renderer-only: refuses a synthetic nonempty capability population", () => {
    const scalar = prepared();
    const view = presentation.preparedPresentationWitView(scalar, scalar.emission.module);
    const result = renderPreparedWit(view, {
      imports: [],
      types: scalar.emission.module.types,
      capabilities: [
        {
          id: "unmapped",
          abiNamespace: "external",
          abiVersion: 1,
          permissions: [],
          selectedProviders: [],
          compatibleProviders: [],
          imports: [],
        },
      ],
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("silent capability omission");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ field: "wit.resources", code: "unmapped-wit-resources", sourceFile: view.entryFile }),
    );
  });
});

describe("genuine C guard priority and alias target integrity", () => {
  for (const backend of BACKENDS)
    it(`${backend}: genuine C failure poisons WIT authority without being reported as a WIT mapping check`, () => {
      const genuine = prepared(NUMERIC, backend);
      const module = genuine.emission.module;
      const original = inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true });
      const exported = module.exports.find((row) => row.name === "echo")!;
      if (exported.desc.kind !== "func") throw Error("expected function");
      const fn =
        module.functions[exported.desc.index - module.imports.filter((row) => row.desc.kind === "func").length]!;
      const type = module.types[fn.typeIdx]!;
      if (type.kind !== "func") throw Error("expected signature");
      const old = type.results[0]!;
      type.results[0] = { kind: "i32" };
      try {
        expect(() => emittedPhysicalSetupPlan(genuine.emission)).toThrow(
          "physical module reservations: altered reserved type definition/signature",
        );
      } finally {
        type.results[0] = old;
      }
      expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
        "physical module reservations: completion requested in failed",
      );
      expect(inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true })).toBe(
        original,
      );
      expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
        "prepared presentation WIT: invalid presentation",
      );
      const fresh = prepared(NUMERIC, backend);
      expect(presentation.preparedPresentationWitView(fresh, fresh.emission.module).exports).toHaveLength(1);
    });
  for (const backend of BACKENDS)
    it(`${backend}: same-spelling donor alias target corruption cannot revive after restoration`, () => {
      const fixture = FIXTURES.find((row) => row.name === "same-spelling donor ownership")!;
      const genuine = prepared(fixture.files, backend);
      const module = genuine.emission.module;
      const original = inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true });
      const view = presentation.preparedPresentationWitView(genuine, module);
      expect(new Set(view.exports.map((row) => row.unitId)).size).toBe(2);
      const left = module.exports.find((row) => row.name === "left")!,
        right = module.exports.find((row) => row.name === "right")!;
      if (left.desc.kind !== "func" || right.desc.kind !== "func") throw Error("expected functions");
      const old = left.desc.index;
      left.desc.index = right.desc.index;
      try {
        expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
          "prepared presentation finalization: output-changed",
        );
      } finally {
        left.desc.index = old;
      }
      expect(inspect(module, { depth: null, maxArrayLength: null, maxStringLength: null, showHidden: true })).toBe(
        original,
      );
      expect(() => presentation.preparedPresentationWitView(genuine, module)).toThrow(
        "prepared presentation WIT: invalid presentation",
      );
      const fresh = prepared(fixture.files, backend);
      expect(
        new Set(presentation.preparedPresentationWitView(fresh, fresh.emission.module).exports.map((row) => row.unitId))
          .size,
      ).toBe(2);
    });
});

describe("genuine keyword source filename defaults", () => {
  for (const backend of BACKENDS)
    it(`${backend}: default package escapes keyword filenames`, () => {
      for (const name of ["async", "map"]) {
        const result = artifact(
          realPipelineInput({ [`./${name}.ts`]: NUMERIC["./entry.ts"] }, backend, {}, `./${name}.ts`),
        );
        expect(result.artifacts.wit).toContain(`package js2wasm:%${name};`);
        const exports = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.artifacts.binary)))
          .exports;
        expect((exports.echo as (value: number) => number)(7.25)).toBe(7.25);
      }
    });
});
