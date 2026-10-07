// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import * as linearIr from "../src/ir/backend/linear-integration.js";
import * as preparation from "../src/ir/program-preparation.js";
import * as consumer from "../src/ir/program-consumer.js";
import { preparedIrProgramOwner } from "../src/ir/program.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compileMultiSource, runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { buildCompiledAdapterImports, instantiateWasm } from "../src/runtime.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { verifyIrBackendLegality } from "../src/ir/analysis/backend-legality.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, type IrFunction, type IrInstr, type IrValueId } from "../src/ir/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

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
const BACKENDS = ["wasmgc", "linear"] as const;
type Backend = (typeof BACKENDS)[number];
type Call = { name: string; args: number[] };
type Artifact = Pick<
  Awaited<ReturnType<typeof compileMultiSource>>,
  "success" | "binary" | "importsHelper" | "adapterManifest"
>;

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
      moduleName: "linear-early-return",
    },
  };
}
function publicGeneratorSpies(poison = false) {
  const spies = [
    vi.spyOn(gcCodegen, "generateModule"),
    vi.spyOn(gcCodegen, "generateMultiModule"),
    vi.spyOn(linearCodegen, "generateLinearModule"),
    vi.spyOn(linearCodegen, "generateLinearMultiModule"),
  ];
  if (poison)
    for (const spy of spies)
      spy.mockImplementation(() => {
        throw new Error("prepared path called public legacy generator");
      });
  return spies;
}
function prepared(files: Record<string, string>, backend: Backend) {
  const current = input(files, backend);
  const generators = publicGeneratorSpies(true);
  const prepare = vi.spyOn(preparation, "prepareWholeIrProgram");
  const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
  const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
  try {
    const result = runPreparedIrPipelinePresentation(current);
    expect(result.kind, JSON.stringify(result)).toBe("artifacts");
    if (result.kind !== "artifacts") throw new Error(JSON.stringify(result));
    expect(prepare).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(prepare.mock.results[0]!.value.program).toBe(result.program);
    const acceptance = accept.mock.results[0]!.value;
    expect(consumer.isAuthenticAcceptedIrProgram(acceptance)).toBe(true);
    expect(acceptance.program).toBe(result.program);
    expect(emit).toHaveBeenCalledWith(acceptance);
    expect(emit.mock.results[0]!.value).toBe(result.emission);
    for (const generator of generators) expect(generator).not.toHaveBeenCalled();
    expect(result.program.sealed).toBe(true);
    expect(result.program.inventory.sources).toHaveLength(Object.keys(files).length);
    const projection = result.program.runtime.find((row) => row.backend === backend && row.target === "host");
    expect(projection).toBeDefined();
    if (!projection) throw new Error("missing prepared host projection");
    expect(projection.prepared.functions.length).toBeGreaterThan(0);
    expect(result.emission.emittedUnitIds).toEqual(projection.prepared.functions.map((fn) => fn.unitId));
    expect(new Set(result.emission.emittedUnitIds).size).toBe(result.emission.emittedUnitIds.length);
    expect(result.emission.emittedUnitIds).toHaveLength(result.program.units.size);
    for (const unitId of result.emission.emittedUnitIds) {
      const owner = preparedIrProgramOwner(result.program, unitId);
      const terminal = result.program.units.get(unitId);
      expect(owner).toBeDefined();
      expect(terminal?.id).toBe(unitId);
      if (!owner || !terminal) throw new Error(`missing complete receipt for ${unitId}`);
      const source = current.userSourceFiles.find((file) => file.fileName === owner.sourceFile);
      expect(source).toBeDefined();
      if (!source) throw new Error(`missing source for ${unitId}`);
      expect(owner.location.declarationStart).toBe(terminal.declarationStart);
      expect(owner.location.declarationEnd).toBe(terminal.declarationEnd);
      expect(source.text.slice(terminal.declarationStart, terminal.declarationEnd).length).toBeGreaterThan(0);
      expect(owner.location.sourceId).toBe(
        result.program.inventory.sources.find((row) => row.originalFileName === owner.sourceFile)?.id,
      );
    }
    return result;
  } finally {
    for (const spy of [...generators, prepare, accept, emit]) spy.mockRestore();
  }
}
async function directLegacy(files: Record<string, string>, backend: Backend) {
  const hadLinearIr = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
  const previousLinearIr = process.env.JS2WASM_LINEAR_IR;
  const generators = publicGeneratorSpies();
  const overlays = [
    vi.spyOn(linearIr, "prepareLinearIrOverlay"),
    vi.spyOn(linearIr, "compileLinearIr"),
    vi.spyOn(linearIr, "compileLinearIrFunctions"),
  ];
  for (const overlay of overlays)
    overlay.mockImplementation(() => {
      throw new Error("direct legacy reference called Linear IR overlay");
    });
  try {
    process.env.JS2WASM_LINEAR_IR = "0";
    const options = { ...input(files, backend).options, experimentalIR: false, disableIrFirst: true };
    const artifact = await compileMultiSource(files, "./entry.ts", options);
    expect(artifact.success).toBe(true);
    for (const [index, generator] of generators.entries()) {
      if (index === (backend === "wasmgc" ? 1 : 3)) expect(generator).toHaveBeenCalledOnce();
      else expect(generator).not.toHaveBeenCalled();
    }
    for (const overlay of overlays) expect(overlay).not.toHaveBeenCalled();
    return artifact;
  } finally {
    if (hadLinearIr) process.env.JS2WASM_LINEAR_IR = previousLinearIr;
    else Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
    for (const spy of [...generators, ...overlays]) spy.mockRestore();
    expect(Object.hasOwn(process.env, "JS2WASM_LINEAR_IR")).toBe(hadLinearIr);
    expect(process.env.JS2WASM_LINEAR_IR).toBe(previousLinearIr);
  }
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

const SEMANTICS = [
  {
    name: "nested if and loop returns versus fallthrough",
    source:
      "export function choose(x:number):number { let i=0; while(i<5){ if(i===x){if(x>1)return i*10+3;return i+7;}i=i+1;}return 99; }",
    calls: [
      { name: "choose", args: [0] },
      { name: "choose", args: [3] },
      { name: "choose", args: [9] },
    ],
    values: [7, 33, 99],
  },
  {
    name: "callee return does not exit caller",
    source:
      "function inner(x:number):number { if(x>0)return x+1;return 5; } export function outer(x:number):number { return inner(x)*10+2; }",
    calls: [
      { name: "outer", args: [3] },
      { name: "outer", args: [-1] },
    ],
    values: [42, 52],
  },
  {
    name: "void early return skips later effects",
    source:
      "var count:number=0; function act(x:number):void { if(x>0){count=count+1;return;}count=count+10; } export function run(x:number):number { count=0;act(x);return count; }",
    calls: [
      { name: "run", args: [1] },
      { name: "run", args: [0] },
    ],
    values: [1, 10],
  },
  {
    name: "return operand evaluates exactly once",
    source:
      "var count:number=0; function next():number { count=count+1;return count; } function inner(x:number):number { if(x>0)return next()+10;return next()+20; } export function run(x:number):number { count=0;const value=inner(x);return value*10+count; }",
    calls: [
      { name: "run", args: [1] },
      { name: "run", args: [0] },
    ],
    values: [111, 211],
  },
];
const identities = createTestIrFunctionIdentityFactory("prepared-linear-early-return");
const i32 = irVal({ kind: "i32" });
const f64 = irVal({ kind: "f64" });
function nestedReturn(result: "value" | "void", operand: "i32" | "f64" | "null"): IrFunction {
  const builder = new IrFunctionBuilder(
    identities.next(`nested-${result}-${operand}`),
    result === "value" ? [i32] : [],
  );
  builder.openBlock();
  const cond = builder.emitConst({ kind: "i32", value: 1 }, i32);
  let value: IrValueId | null = null;
  if (operand !== "null")
    value = builder.emitConst(
      operand === "i32" ? { kind: "i32", value: 7 } : { kind: "f64", value: 7 },
      operand === "i32" ? i32 : f64,
    );
  const early: IrInstr = { kind: "early.return", value, result: null, resultType: null };
  builder.emitIfStmt({ cond, then: [early], else: [] });
  builder.terminate({ kind: "return", values: result === "value" ? [cond] : [] });
  return builder.finish();
}
afterEach(async () => {
  await setImmediate();
});
describe("#3525 genuine prepared Linear early returns", () => {
  it("retains all four original application source pins and independent native eight-call oracle", () => {
    expect(SOURCE_PINS).toHaveLength(4);
    for (const pin of SOURCE_PINS) {
      const text = APPLICATION[pin.logical]!;
      expect(Buffer.byteLength(text)).toBe(pin.bytes);
      expect(createHash("sha256").update(text).digest("hex")).toBe(pin.sha256);
    }
    const values = native(APPLICATION, APPLICATION_CALLS);
    valuesEqual(values, APPLICATION_VALUES);
    for (const [index, root] of [Math.sqrt(2), 7, 0.5, 1000].entries())
      expect(Math.abs(values[index]! - root)).toBeLessThanOrEqual(1e-10);
    expect(values[4]).toBe(-1);
    expect(values[5]).toBe(1.25);
    expect(Object.is(values[6], 0)).toBe(true);
  });
  it("observes the enabled Linear overlay positive control and restores a preexisting switch exactly", async () => {
    const hadLinearIr = Object.hasOwn(process.env, "JS2WASM_LINEAR_IR");
    const previousLinearIr = process.env.JS2WASM_LINEAR_IR;
    const prepare = vi.spyOn(linearIr, "prepareLinearIrOverlay");
    const emit = vi.spyOn(linearIr, "compileLinearIr");
    try {
      process.env.JS2WASM_LINEAR_IR = "1";
      const module = linearCodegen.generateLinearModule(
        input({ "./entry.ts": SEMANTICS[0]!.source }, "linear").entryAst,
      );
      expect(module.functions.length).toBeGreaterThan(0);
      expect(prepare).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledOnce();
      prepare.mockRestore();
      emit.mockRestore();
      await directLegacy(APPLICATION, "linear");
      expect(process.env.JS2WASM_LINEAR_IR).toBe("1");
    } finally {
      if (hadLinearIr) process.env.JS2WASM_LINEAR_IR = previousLinearIr;
      else Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
      prepare.mockRestore();
      emit.mockRestore();
    }
  });
  for (const backend of BACKENDS) {
    it(`executes the complete five-function eight-call application through ${backend} prepared and legacy binaries and helpers`, async () => {
      const result = prepared(APPLICATION, backend);
      expect(result.program.units.size).toBe(5);
      expect(result.emission.emittedUnitIds).toHaveLength(5);
      const actual = await execute(result.artifacts, APPLICATION_CALLS);
      const legacy = await directLegacy(APPLICATION, backend);
      const original = await execute(legacy, APPLICATION_CALLS);
      for (const rows of [actual.direct, actual.helper, original.direct, original.helper])
        valuesEqual(rows, APPLICATION_VALUES);
    });
    for (const fixture of SEMANTICS) {
      it(`preserves ${fixture.name} on ${backend} native and original generated-helper paths`, async () => {
        const files = { "./entry.ts": fixture.source };
        valuesEqual(native(files, fixture.calls), fixture.values);
        const result = prepared(files, backend);
        const actual = await execute(result.artifacts, fixture.calls);
        const legacy = await directLegacy(files, backend);
        const original = await execute(legacy, fixture.calls);
        for (const rows of [actual.direct, actual.helper, original.direct, original.helper])
          valuesEqual(rows, fixture.values);
      });
    }
  }
  it("accepts healthy deeply nested value and void return controls independently of legality", () => {
    for (const fn of [nestedReturn("value", "i32"), nestedReturn("void", "null")]) {
      expect(verifyIrFunction(fn)).toEqual([]);
      expect(verifyIrBackendLegality(fn, "linear")).toEqual([]);
      expect(verifyIrBackendLegality(fn, "wasmgc")).toEqual([]);
    }
  });
  for (const control of [
    { result: "value", operand: "null", message: "early.return arity 0 != declared result arity 1" },
    { result: "void", operand: "i32", message: "early.return arity 1 != declared result arity 0" },
    { result: "value", operand: "f64", message: "early.return value type f64 not assignable to declared result i32" },
  ] as const) {
    it(`deep verifier rejects ${control.operand} operand in ${control.result} return despite legality admission`, () => {
      const fn = nestedReturn(control.result, control.operand);
      expect(verifyIrBackendLegality(fn, "linear")).toEqual([]);
      expect(verifyIrFunction(fn)).toContainEqual(
        expect.objectContaining({ message: control.message, func: fn.name, block: 0, demote: true }),
      );
    });
  }
  it("retains unrelated Linear type refusal and non-Linear early-return refusal", () => {
    const builder = new IrFunctionBuilder(identities.next("externref-refusal"), []);
    builder.addParam("input", irVal({ kind: "externref" }));
    builder.openBlock();
    builder.terminate({ kind: "return", values: [] });
    expect(verifyIrBackendLegality(builder.finish(), "linear").some((error) => error.message.includes("extern"))).toBe(
      true,
    );
    const fn = nestedReturn("value", "i32");
    expect(verifyIrBackendLegality(fn, "bytecode").some((error) => error.message.includes("early.return"))).toBe(true);
  });
});
