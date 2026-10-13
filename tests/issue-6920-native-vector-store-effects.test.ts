// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { nativeVectorStoreFailure } from "../src/ir/program/native-vector-store-proof.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { nativeModuleGlobalEvidence } from "../src/ir/program/native-module-vector-context.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import { forEachInstrDeep, type IrInstr, type IrValueId } from "../src/ir/core/nodes.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const source = `
function grow(a:number[]):number { let i=0;while(i<40){a.push(i);i++;}return 9; }
function change(a:number[]):number { a[0]=100;return grow(a); }
export function plain():number {const a=[2,5];const b=a;a[0]=grow(b);return a[0]*100+a.length+b[41];}
export function compound():number {const a=[2,5];a[0]+=change(a);return a[0]*100+a.length+a[41];}
export function prefix():number {const a=[2,5];grow(a);a[0]++;return a[0]+a.length;}
`;
function prepare(text = source, gcOnly = false) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: gcOnly ? policies[2] : policies[0],
    runtimePolicies: gcOnly ? [policies[2]] : policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}
afterEach(() => vi.restoreAllMocks());
it("executes plain and compound original-index stores across RHS append, aliases and backing growth on four profiles, live and codec", () => {
  const result = prepare();
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  expect(nativeVectorStoreFailure(result.program.ir)).toBeUndefined();
  const sealed = encodePreparedIrProgram(result.program);
  const forbidden = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source replay forbidden");
  });
  const directA = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct emission forbidden");
  });
  const directB = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct emission forbidden");
  });
  let executions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const program of [result.program, decodePreparedIrProgram(sealed)]) {
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "store-effects",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
      binaries.push(binary);
      expect(WebAssembly.validate(binary)).toBe(true);
      const module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const e = new WebAssembly.Instance(module, {}).exports;
      for (const [name, value] of [
        ["plain", 981],
        ["compound", 1181],
        ["prefix", 45],
      ] as const) {
        expect(Reflect.apply(e[name] as Function, undefined, []), name).toBe(value);
        executions++;
      }
    }
    expect(binaries[0]).toEqual(binaries[1]);
  }
  expect(executions).toBe(24);
  expect(forbidden).not.toHaveBeenCalled();
  expect(directA).not.toHaveBeenCalled();
  expect(directB).not.toHaveBeenCalled();
});
it("executes genuine public source stores with direct generators forbidden", async () => {
  vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct emission forbidden");
  });
  vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct emission forbidden");
  });
  for (const policy of policies) {
    const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const e = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(result.binary!)), {}).exports;
    for (const [name, value] of [
      ["plain", 981],
      ["compound", 1181],
      ["prefix", 45],
    ] as const)
      expect(Reflect.apply(e[name] as Function, undefined, [])).toBe(value);
  }
});
it("refuses empty, short, post-append-only, public, fractional and hidden length-changing store origins", () => {
  for (const text of [
    "export function run():number{const a:number[]=[];a[0]=9;return a.length;}",
    "export function run():number{const a:number[]=[];a.push(1);a[0]=9;return a[0];}",
    "function set(a:number[]):number{a[0]=9;return a[0];}export function run():number{return set([]);}",
    "export function run(a:number[]):number{a[0]=9;return a[0];}",
    "export function run():number{const a=[1,2];a[1.5]=9;return a[0];}",
    "function reset(a:number[]):number{a.length=0;return 9;}export function run():number{const a=[1,2];a[0]=reset(a);return a[0];}",
  ])
    for (const gcOnly of [false, true]) {
      const result = prepare(text, gcOnly);
      expect(result.kind, text).not.toBe("prepared");
    }
});
it("recomputes all original lengths independently of equal capacity and warm validation", () => {
  const result = prepare();
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const module = structuredClone(result.program.ir);
  expect(nativeVectorStoreFailure(module)).toBeUndefined();
  let constructors = 0;
  for (const fn of module.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (i) => {
          if (i.kind === "vec.new_fixed") {
            (i as { capacity: number }).capacity = 16;
            (i as { elements: readonly number[] }).elements = [];
            constructors++;
          }
        });
  expect(constructors).toBe(3);
  expect(nativeVectorStoreFailure(module)?.detail).toContain("original constructor logical length");
});

it("rejects a type-correct arbitrary dynamic index after warm GC-only validation and codec replay", () => {
  const result = prepare("export function run(n:number):number{const a=[2,5];a[0]=n;return a[0];}", true);
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const program = result.program,
    sealed = encodePreparedIrProgram(program),
    module = structuredClone(program.ir);
  assertPreparedIrProgram(program);
  expect(program.linearAllocationFacts).toBeUndefined();
  expect(nativeVectorStoreFailure(module)).toBeUndefined();
  const fn = module.functions.find((f) => f.name === "run")!,
    body = fn.blocks[0]!.instrs as IrInstr[];
  const store = body.find((i): i is Extract<IrInstr, { kind: "vec.set" }> => i.kind === "vec.set")!;
  const at = body.findIndex((i) => i.result === store.index),
    old = body[at]!;
  body[at] = {
    kind: "unary",
    op: "i32.trunc_sat_f64_s",
    rand: fn.params[0]!.value,
    result: old.result,
    resultType: old.resultType,
  };
  expect(nativeVectorStoreFailure(module)?.detail).toContain("dynamic store lacks");
  expect(() => encodePreparedIrProgram({ ...program, ir: module })).toThrow("dynamic store lacks");
  const original = JSON.parse(sealed);
  let changed = 0;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.kind === "const" && node.result === old.result && (node.value as { kind?: string })?.kind === "i32") {
      changed++;
      return rewrite({
        kind: "unary",
        op: "i32.trunc_sat_f64_s",
        rand: 0,
        result: old.result,
        resultType: old.resultType,
      });
    }
    return Object.fromEntries(
      Object.keys(node)
        .sort()
        .map((key) => [key, rewrite(node[key])]),
    );
  };
  const mutated = JSON.stringify(rewrite(original));
  expect(changed).toBeGreaterThanOrEqual(2);
  expect(() => decodePreparedIrProgram(mutated)).toThrow();
  expect(encodePreparedIrProgram(program)).toBe(sealed);
});

it("reconstructs live counted-loop guards and rejects altered guards, updates and stale outer-iteration index reads", () => {
  const result = prepare(
    "export function run():number{const a=[2,5];for(let j=0;j<2;j++){for(let i=0;i<a.length;i++){a[i]+=1;}}return a[0]+a[1];}",
  );
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  expect(nativeVectorStoreFailure(result.program.ir)).toBeUndefined();
  for (const change of ["guard", "update", "stale-index"] as const) {
    const module = structuredClone(result.program.ir),
      fn = module.functions.find((f) => f.name === "run")!;
    const outer = fn.blocks[0]!.instrs.find((i): i is Extract<IrInstr, { kind: "for.loop" }> => i.kind === "for.loop")!;
    const inner = outer.body.find((i): i is Extract<IrInstr, { kind: "for.loop" }> => i.kind === "for.loop")!;
    const store = inner.body.find((i): i is Extract<IrInstr, { kind: "vec.set" }> => i.kind === "vec.set")!;
    if (change === "guard") (inner as { condValue: IrValueId }).condValue = inner.cond[0]!.result!;
    else if (change === "update") {
      const one = inner.update.find((i): i is Extract<IrInstr, { kind: "const" }> => i.kind === "const")!;
      (one as { value: unknown }).value = { kind: "i32", value: 2 };
    } else {
      const read = inner.body.find((i) => i.result === store.index)!;
      const stale = fn.valueCount as IrValueId;
      (fn as { valueCount: number }).valueCount++;
      (outer.body as IrInstr[]).splice(outer.body.indexOf(inner) - 1, 0, { ...read, result: stale });
      (store as { index: IrValueId }).index = stale;
    }
    expect(nativeVectorStoreFailure(module)?.detail, change).toContain("counted-loop proof");
  }
});

it("checks every joined constructor original length even when their requested capacities agree", () => {
  const ast = analyzeMultiSource(
    { "./entry.ts": "export function run(flag:number):number{const a=flag>0?[1]:[2,3];a[1]=9;return a[0];}" },
    "./entry.ts",
  );
  const raw = sourceProducer.prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
  });
  if (raw.kind !== "prepared") throw Error(JSON.stringify(raw));
  let count = 0;
  for (const fn of raw.ir.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (i) => {
          if (i.kind === "vec.new_fixed") {
            (i as { capacity: number }).capacity = 16;
            count++;
          }
        });
  expect(count).toBe(2);
  expect(nativeVectorStoreFailure(raw.ir)?.detail).toContain("every original constructor logical length");
});

it("censuses a hidden length writer in a scalar helper with no vector arguments", () => {
  const result = prepare(
    "const a=[2,5];function read():number{return a[0];}export function run():number{a[0]=read();return a[0];}",
  );
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const module = structuredClone(result.program.ir),
    evidence = () => nativeModuleGlobalEvidence(result.program);
  expect(nativeVectorStoreFailure(module, evidence)).toBeUndefined();
  const fn = module.functions.find((f) => f.name === "read")!,
    body = fn.blocks[0]!.instrs as IrInstr[];
  expect(fn.params).toHaveLength(0);
  const get = body.find(
    (i): i is Extract<IrInstr, { kind: "global.get" }> => i.kind === "global.get" && i.resultType?.kind === "vec",
  )!;
  expect(get).toBeDefined();
  const zero = fn.valueCount as IrValueId;
  (fn as { valueCount: number }).valueCount++;
  body.push(
    {
      kind: "const",
      value: { kind: "i32", value: 0 },
      result: zero,
      resultType: { kind: "val", val: { kind: "i32" } },
    },
    { kind: "vec.set_length", vec: get.result!, length: zero, result: null, resultType: null },
  );
  expect(nativeVectorStoreFailure(module, evidence)?.detail).toContain("unproved vec.set_length effect");
});
