// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { compile, compileMulti } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as provenance from "../src/ir/native-vector-undefined-provenance.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function prepare(text: string, policy: (typeof policies)[number]) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}
function reference(text: string, args: readonly number[]) {
  const javascript = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, Function> = {};
  new Function("exports", javascript)(exports);
  return exports.run!(...args) as number;
}
function execute(binary: Uint8Array<ArrayBuffer>, args: readonly number[]) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
  return Reflect.apply(instance.exports.run as Function, undefined, args) as number;
}
const refused = {
  direct: "const a=[2];return a[99]===undefined?1:0;",
  emptyDirect: "const a:number[]=[];return a[0]===undefined?1:0;",
  alias: "const a=[2];const v=a[99];return v===undefined?1:0;",
  emptyAlias: "const a:number[]=[];const v=a[0];return v===undefined?1:0;",
  chain: "const a=[2];const v=a[99];const w=v;return w===undefined?1:0;",
  assertedAlias: "const a=[2];const v=(a[99] as number);return (v!)===undefined?1:0;",
  mutable: "const a=[2];let v=1;v=a[99];return v===undefined?1:0;",
  conditionalWrite: "const a=[2];let v=1;if(x)v=a[99];return v===undefined?1:0;",
  conditionalAlias: "const a=[2];const v=x?a[99]:3;return v===undefined?1:0;",
  loopWrite: "const a=[2];let v=1;for(let i=0;i<1;i++)v=a[99];return v===undefined?1:0;",
  overwritten: "const a=[2];let v=a[99];v=3;return v===undefined?1:0;",
  witness: "const a=[2];const v=a[99];const n=a.length;return n*2+(v===undefined?1:0);",
  emptyWitness: "const a:number[]=[];const v=a[99];const n=a.length;return n*2+(v===undefined?1:0);",
  unknownCall: "const v=helper(x);return v===undefined?1:0;",
};
afterEach(() => vi.restoreAllMocks());
it.each(Object.entries(refused))(
  "refuses unsupported native numeric undefined observation %s on four actual source policies",
  async (name, body) => {
    const text = "function helper(x:number):number{return x;} export function run(x:number):number{" + body + "}";
    const expected = reference(text, [1]);
    expect(typeof expected).toBe("number");
    if (name === "witness") expect(expected).toBe(3);
    if (name === "emptyWitness") expect(expected).toBe(1);
    for (const policy of policies) {
      await yieldTurn();
      const result = prepare(text, policy);
      expect(result).toMatchObject({ kind: "unsupported", code: "nullish-value-unsupported", stage: "build" });
      if (result.kind !== "unsupported") throw Error("unexpected admission");
      expect(result.detail).toMatch(/unproven indexed read|no defined-value provenance/);
      const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
      expect(publicResult.success).toBe(false);
      expect(publicResult.errors.some((error) => error.message.includes("nullish-value-unsupported"))).toBe(true);
    }
  },
  120000,
);
const defined = {
  rawArithmetic: "const a=[2];return a[99]+1;",
  rawNumber: "const a:number[]=[];return Number(a[0]);",
  scalarNaN: "const v=x;return v===undefined?1:0;",
  scalarChain: "const v=x;const w=v;return w===undefined?1:0;",
  scalarMutable: "let v=x;v=2;return v===undefined?1:0;",
  arithmetic: "const a=[2];const v=a[99]+1;return v===undefined?1:0;",
  numberCoercion: "const a=[2];const v=Number(a[99]);return v===undefined?1:0;",
  negativeCoercion: "const a=[2];const v=-a[99];return v===undefined?1:0;",
  nanCellCoercion: "const a=[x];const v=Number(a[0]);return v===undefined?1:0;",
  shadow: "const a=[2];const v=a[99];{const v=x;if(v===undefined)return 1;}return 0;",
  observer: "const a=[2,5];return a.length*100+a[0]*10+a[1];",
};
it.each(Object.entries(defined))(
  "preserves genuine numeric source %s live/codec/public on four profiles",
  async (_name, body) => {
    const text = "export function run(x:number):number{" + body + "}",
      args = [NaN],
      expected = reference(text, args);
    let executions = 0;
    for (const policy of policies) {
      await yieldTurn();
      const result = prepare(text, policy);
      if (result.kind === "unsupported") {
        if (_name === "shadow") {
          expect(result).toMatchObject({ code: "body-shape-rejected", stage: "build" });
          expect(result.detail).toContain("unexpected statement before tail");
        } else {
          expect(policy.backend).toBe("linear");
          expect(result).toMatchObject({ code: "array-representation-unsupported", stage: "resolve" });
          expect(result.detail).toContain("outside the finite semantic profile");
        }
        const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
        expect(publicResult.success).toBe(false);
        expect(publicResult.errors.some((error) => error.message.includes(result.code))).toBe(true);
        continue;
      }
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw Error(JSON.stringify(result));
      const encoded = encodePreparedIrProgram(result.program);
      const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
        throw Error("source reconstruction forbidden");
      });
      const binaries: Uint8Array<ArrayBuffer>[] = [];
      for (const program of [result.program, decodePreparedIrProgram(encoded)]) {
        assertPreparedIrProgram(program);
        const accepted = acceptPreparedIrProgram(program, {
          ...policy,
          moduleName: "undefined-boundary",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind).toBe("accepted");
        if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
        const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
        binaries.push(binary);
        expect(Object.is(execute(binary, args), expected)).toBe(true);
        executions++;
      }
      expect(binaries[0]).toEqual(binaries[1]);
      expect(poison).not.toHaveBeenCalled();
      poison.mockRestore();
      const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
      expect(publicResult.success).toBe(true);
      expect(Object.is(execute(Uint8Array.from(publicResult.binary), args), expected)).toBe(true);
      executions++;
    }
    expect(executions).toBe(
      _name === "shadow"
        ? 0
        : ["arithmetic", "numberCoercion", "negativeCoercion", "nanCellCoercion"].includes(_name)
          ? 6
          : 12,
    );
  },
  120000,
);
it("retains healthy scalar prepared bytes against the historical no-provenance fold", async () => {
  const text = "export function run(x:number):number{const v=x;return v===undefined?1:0;}";
  for (const policy of policies) {
    await yieldTurn();
    const current = prepare(text, policy);
    expect(current.kind).toBe("prepared");
    if (current.kind !== "prepared") throw Error(JSON.stringify(current));
    const historical = vi.spyOn(provenance, "nativeNumericUndefinedProof").mockReturnValue("defined");
    const previous = prepare(text, policy);
    expect(previous.kind).toBe("prepared");
    if (previous.kind !== "prepared") throw Error(JSON.stringify(previous));
    expect(historical).toHaveBeenCalled();
    expect(encodePreparedIrProgram(current.program)).toEqual(encodePreparedIrProgram(previous.program));
    historical.mockRestore();
    const binaries = [current.program, previous.program].map((program) => {
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "scalar-preservation",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      return Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
    });
    expect(binaries[0]).toEqual(binaries[1]);
    expect(execute(binaries[0]!, [NaN])).toBe(0);
  }
}, 120000);

it("conservatively refuses initialized NaN vector alias without immutable read-site proof", async () => {
  const text = "export function run(x:number):number{const a=[x];const v=a[0];return v===undefined?1:0;}";
  expect(reference(text, [NaN])).toBe(0);
  for (const policy of policies) {
    await yieldTurn();
    expect(prepare(text, policy)).toMatchObject({
      kind: "unsupported",
      code: "nullish-value-unsupported",
      stage: "build",
    });
    const result = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("no defined-value provenance"))).toBe(true);
  }
}, 120000);
it("refuses unknown shadowed Number return rather than assuming ambient numeric conversion", async () => {
  const text =
    "function Number(x:number):number{return (undefined as unknown) as number;} export function run(x:number):number{const v=Number(x);return v===undefined?1:0;}";
  expect(reference(text, [NaN])).toBe(1);
  for (const policy of policies) {
    await yieldTurn();
    const result = prepare(text, policy);
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw Error("shadowed Number unexpectedly admitted");
    const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors.some((error) => error.message.includes(result.code))).toBe(true);
  }
}, 120000);

it("refuses source-defined Number returning an absent vector cell before numeric undefined folding", async () => {
  const text =
    "function Number(x:number):number{const a=[2];return a[99];} export function run(x:number):number{const v=Number(x);return v===undefined?1:0;}";
  expect(reference(text, [NaN])).toBe(1);
  for (const policy of policies) {
    await yieldTurn();
    const result = prepare(text, policy);
    expect(result).toMatchObject({ kind: "unsupported", code: "nullish-value-unsupported", stage: "build" });
    if (result.kind !== "unsupported") throw Error("shadowed Number admitted");
    expect(result.detail).toContain("no defined-value provenance");
    const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors.some((error) => error.message.includes("nullish-value-unsupported"))).toBe(true);
  }
}, 120000);
it("refuses cyclic all-write scalar alias provenance without declaring it defined", async () => {
  const text = "export function run(x:number):number{let v=x;const w=v;v=w;return v===undefined?1:0;}";
  expect(reference(text, [NaN])).toBe(0);
  for (const policy of policies) {
    await yieldTurn();
    expect(prepare(text, policy)).toMatchObject({
      kind: "unsupported",
      code: "nullish-value-unsupported",
      stage: "build",
    });
    const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors.some((error) => error.message.includes("nullish-value-unsupported"))).toBe(true);
  }
}, 120000);

it("refuses incoming source absence at a numeric helper parameter rather than assuming ABI initializedness", async () => {
  const text =
    "export function observe(x:number):number{return x===undefined?1:0;} export function run():number{const a=[2];return observe(a[99]);}";
  expect(reference(text, [])).toBe(1);
  for (const policy of policies) {
    await yieldTurn();
    const result = prepare(text, policy);
    expect(result).toMatchObject({ kind: "unsupported", code: "nullish-value-unsupported", stage: "build" });
    const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors.some((error) => error.message.includes("nullish-value-unsupported"))).toBe(true);
  }
}, 120000);

it("retains earlier direct/public storage refusals for captured exported numeric function aliases", async () => {
  const text =
    "export function observe(x:number):number{return x===undefined?1:0;} const alias=observe; export function run():number{const a=[2];return alias(a[99]);}";
  expect(reference(text, [])).toBe(1);
  for (const policy of policies) {
    await yieldTurn();
    const result = prepare(text, policy);
    expect(result).toMatchObject({ kind: "unsupported", code: "type-resolution-unsupported", stage: "build" });
    if (result.kind !== "unsupported") throw Error("captured alias admitted");
    expect(result.detail).toBe("module binding alias has no exact typed storage: unsupported");
    const publicResult = await compile(text, { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors).toEqual([
      {
        message: "Prepared IR: top-level global storage needs a numeric source classification",
        line: 1,
        column: 1,
        severity: "error",
      },
    ]);
  }
}, 120000);
it("resolves imported checker aliases across the complete native source population before parameter folding", async () => {
  const files = {
    "./entry.ts":
      "import {observe as alias} from './observe'; export function run():number{const a=[2];return alias(a[99]);}",
    "./observe.ts": "export function observe(x:number):number{return x===undefined?1:0;}",
  };
  const outputs = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [
      name,
      ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
        .outputText,
    ]),
  );
  const cache: Record<string, Record<string, Function>> = {};
  const load = (name: string): Record<string, Function> => {
    name = name.endsWith(".ts") ? name : name + ".ts";
    if (cache[name]) return cache[name]!;
    const exports: Record<string, Function> = {};
    cache[name] = exports;
    new Function("exports", "require", outputs[name]!)(exports, load);
    return exports;
  };
  expect(load("./entry.ts").run!()).toBe(1);
  for (const policy of policies) {
    await yieldTurn();
    const ast = analyzeMultiSource(files, "./entry.ts");
    const result = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(result).toMatchObject({ kind: "unsupported", code: "nullish-value-unsupported", stage: "build" });
    const publicResult = await compileMulti(files, "./entry.ts", { ...policy, optimize: false, sourceMap: false });
    expect(publicResult.success).toBe(false);
    expect(publicResult.errors.some((error) => error.message.includes("nullish-value-unsupported"))).toBe(true);
  }
}, 120000);
