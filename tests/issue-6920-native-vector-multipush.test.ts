// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import { collectNativeNumericAppendProtocol } from "../src/ir/analysis/allocation-evidence/numeric-append-protocol.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const source = `
const globalVector=[2,5];
function first(a:number[]):number {a.push(7);return 11;}
function later(a:number[]):number {const before=a.length;a.push(13);return before*10+a.length;}
function read(a:number[]):number {return a.length;}
function receiver(a:number[]):number[] {a.push(17);return a;}
function add(a:number[],x:number,y:number):number {return a.push(x,y);}
export function plain():number {const a=[2,5];const n=a.push(7,11);return n*100+a[2]*10+a[3];}
export function statement():number {const a=[2,5];a.push(7,11);return a.length*100+a[2]*10+a[3];}
export function effects():number {const a=[2,5];const b=a;const n=a.push(first(b),later(b));return n*1000+b[2]*100+b[3]*10+b[4]+b[5];}
export function internal():number {const a=[2,5];return add(a,7,11)*100+a[2]*10+a[3];}
export function observation():number {const a=[2,5];const n=a.push(7,read(a));return n*100+a[2]*10+a[3];}
export function receiverOnce():number {const a=[2,5];const n=receiver(a).push(7,11);return n*100+a[2]*10+a[3]*10+a[4];}
export function global():number {const n=globalVector.push(7,11);return n*100+globalVector[2]*10+globalVector[3];}
export function boundary():number {const a=[2,5];const b=a;let i=0;while(i<30){b.push(i+.5);i++;}const n=a.push(41.5,42.5,43.5);return n*100+b[32]+b[33]+b[34]+a[31];}
export function payload():number {const a=[2,5];const n=a.push(0/0,-0,1/0);return n*10+(a[2]!==a[2]&&1/a[3]===-1/0&&a[4]===1/0?1:0);}
`;
const cases = [
  ["plain", 481],
  ["statement", 481],
  ["effects", 6875],
  ["internal", 481],
  ["observation", 472],
  ["receiverOnce", 751],
  ["global", 481],
  ["boundary", 3657],
  ["payload", 51],
] as const;
function prepare(text = source, deferTopLevelInit = false) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit,
    linearVectorProjection: "native-f64",
  });
}
function check(binary: Uint8Array<ArrayBuffer>) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports;
  if (exports._start) Reflect.apply(exports._start as Function, undefined, []);
  for (const [name, expected] of cases)
    expect(Reflect.apply(exports[name] as Function, undefined, []), name).toBe(expected);
}
afterEach(() => vi.restoreAllMocks());
it("executes all arguments before outer appends across four profiles live/codec with aliases, globals, capacity growth and exact payloads", async () => {
  const result = prepare();
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const sealed = encodePreparedIrProgram(result.program);
  const forbidden = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source replay forbidden");
  });
  const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear emission forbidden");
  });
  const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC emission forbidden");
  });
  let executions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const program of [result.program, decodePreparedIrProgram(sealed)]) {
      assertPreparedIrProgram(program);
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "multipush",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
      binaries.push(binary);
      check(binary);
      executions += cases.length;
    }
    expect(binaries[0]).toEqual(binaries[1]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(executions).toBe(72);
  expect(forbidden).not.toHaveBeenCalled();
  expect(linear).not.toHaveBeenCalled();
  expect(gc).not.toHaveBeenCalled();
}, 120_000);
it("executes genuine public multi-argument source with both direct generators forbidden", async () => {
  const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear emission forbidden");
  });
  const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC emission forbidden");
  });
  let executions = 0;
  for (const policy of policies) {
    const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    check(Uint8Array.from(result.binary!));
    executions += cases.length;
  }
  expect(executions).toBe(36);
  expect(linear).not.toHaveBeenCalled();
  expect(gc).not.toHaveBeenCalled();
});
it("rejects an altered actual per-append length capture after warm validation and codec replay", () => {
  const result = prepare("export function run():number{const a=[2,5];return a.push(7,11);}");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const sealed = encodePreparedIrProgram(result.program);
  assertPreparedIrProgram(result.program);
  const module = structuredClone(result.program.ir);
  const fn = module.functions.find((f) => f.name === "run")!;
  const all: IrInstr[] = [];
  fn.blocks.forEach((block) => block.instrs.forEach((root) => forEachInstrDeep(root, (i) => all.push(i))));
  const appends = collectNativeNumericAppendProtocol([fn]);
  expect(appends).toHaveLength(2);
  const index = all.find((i) => i.result === appends[1]!.call.args[1])!;
  expect(index.kind).toBe("unary");
  if (index.kind !== "unary") throw Error("actual append lacks its index conversion");
  const old = index.rand;
  (index as { rand: typeof old }).rand = appends[1]!.call.args[2]!;
  expect(() => collectNativeNumericAppendProtocol([fn])).toThrow("length-captured append sequence");
  expect(() => encodePreparedIrProgram({ ...result.program, ir: module })).toThrow();
  let changed = 0;
  const mutate = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(mutate);
    if (!node || typeof node !== "object") return node;
    const row = node as Record<string, unknown>;
    if (row.kind === "unary" && row.result === index.result && row.rand === old) {
      changed++;
      return { ...row, rand: index.rand };
    }
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, mutate(value)]));
  };
  const data = JSON.parse(sealed);
  const owner = data.program.ir.functions.find((f: { name: string }) => f.name === "run");
  owner.blocks = mutate(owner.blocks);
  const altered = JSON.stringify(data);
  expect(changed).toBe(1);
  expect(() => decodePreparedIrProgram(altered)).toThrow();
});
const throwSource = `
const a=[2,5];
const ignored=run();
const value:number=4;
function fail():number {let result:number=0;result=value;return result;}
function run():number {return a.push(7,fail());}
export function length():number {return a.length;}
`;
function checkThrow(binary: Uint8Array<ArrayBuffer>) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports;
  const initialize = exports.__module_init ?? exports._start;
  expect(initialize).toBeTypeOf("function");
  expect(() => Reflect.apply(initialize as Function, undefined, [])).toThrow(WebAssembly.Exception);
  expect(Reflect.apply(exports.length as Function, undefined, [])).toBe(2);
}
it("preserves no outer append when the later argument throws an authentic TDZ exception on four profiles live/codec", async () => {
  const result = prepare(throwSource, true);
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const sealed = encodePreparedIrProgram(result.program);
  const forbidden = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source replay forbidden");
  });
  let exceptions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const program of [result.program, decodePreparedIrProgram(sealed)]) {
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "multipush-throw",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
      binaries.push(binary);
      checkThrow(binary);
      exceptions++;
    }
    expect(binaries[0]).toEqual(binaries[1]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(exceptions).toBe(8);
  expect(forbidden).not.toHaveBeenCalled();
});
it("executes the genuine public later-argument TDZ throw without a first outer append", async () => {
  const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear emission forbidden");
  });
  const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC emission forbidden");
  });
  let exceptions = 0;
  for (const policy of policies) {
    const result = await compile(throwSource, {
      ...policy,
      optimize: false,
      sourceMap: false,
      deferTopLevelInit: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    checkThrow(Uint8Array.from(result.binary!));
    exceptions++;
  }
  expect(exceptions).toBe(4);
  expect(linear).not.toHaveBeenCalled();
  expect(gc).not.toHaveBeenCalled();
});
it("admits native zero-argument push and retains spread, non-f64 and async refusals", () => {
  const zero = prepare("export function run():number{const a=[2,5];return a.push();}");
  expect(zero.kind).toBe("prepared");
  for (const text of [
    "export function run():number{const a=[2,5];const b=[7,11];return a.push(...b);}",
    "export function run():number{const a=[true,false];return a.push(true,false);}",
    "export async function run():Promise<number>{const a=[2,5];return a.push(7,11);}",
  ]) {
    const result = prepare(text);
    expect(result.kind, text).not.toBe("prepared");
  }
});
