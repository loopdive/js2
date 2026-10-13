// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedStartupGuardIndex,
  emittedStartupAdapterIndex,
  emittedReferenceErrorResourceReceipt,
} from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as nativeProducer from "../src/ir/analysis/allocation-evidence/native-control-producer.js";
import * as sourceProducer from "../src/ir/program-source.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
import { forEachInstrDeep, type IrModule, type IrInstr } from "../src/ir/core/nodes.js";
import { nativeModuleGlobalEvidence } from "../src/ir/program/native-module-vector-context.js";
import { verifyNativeAllocationEvidence } from "../src/ir/analysis/allocation-evidence/structured-vector-profile.js";
import { nativeModuleVectorType } from "../src/ir/native-module-vector-source.js";
import { ts } from "../src/ts-api.js";
const fixtures = [
  {
    name: "original initializer read order",
    source: "const a=[2,5];const n=a[1]*10+a[0];export function run():number{return n;}",
    value: 52,
  },
  {
    name: "read and logical length",
    source:
      "const a=[2,5];export function run():number{return a[0]+a[1];}export function length():number{return a.length;}",
    value: 7,
    length: 2,
  },
  { name: "empty", source: "const a:number[]=[];export function run():number{return a.length;}", value: 0 },
  {
    name: "two original initializers",
    source: "const a=[2,5];const b=[11];export function run():number{return a[0]+a[1]+b[0];}",
    value: 18,
  },
  {
    name: "shadowed local",
    readsGlobal: false,
    source: "const a=[2,5];export function run():number{const a=[11,13];return a[0]+a[1];}",
    value: 24,
  },
  {
    name: "lifetime and repeated startup",
    source:
      "const a=[2,5];export function run():number{return a[0]+a[1];}export function churn(x:number,y:number):number{const b=[x,y];return b[0]+b[1];}export function change(n:number):number{for(let i=0;i<a.length;i++){a[i]+=n;}return a[0]+a[1];}",
    value: 7,
    lifetime: true,
  },
  {
    name: "actual internal global result",
    source:
      "const a=[2,5];function get():number[]{return a;}function sum(a:number[]):number{return a[0]+a[1];}export function run():number{return sum(get());}",
    value: 7,
  },
] as const;
const negatives = [
  "let a=[2,5];export function run():number{return a[0];}",
  "let a=[2,5];export function run():number{a=[9];return a[0];}",
  "const a=[2,5];export {a};export function run():number{return a[0];}",
  "export const a=[2,5];export function run():number{return a[0];}",
  "const a=[2,5];export {a as exposed};export function run():number{return a[0];}",
  "const a=[2,5];export function run():number[]{return a;}",
  "const a=[2,5];export function run():number{a[0]=9;return a[0];}",
  "const a=[2,5];export function run():number{a.push(9);return a[0];}",
  "const a=[2,5];export function run():number{a=[9];return a[0];}",
  "const a=[2,5];const b=a;export function run():number{return b[0];}",
  "const a=[2,5];const b=[a[0]];export function run():number{return b[0];}",
  "const a=[2,5];export function run():number{const a={0:9};return a[0];}",
  "const a=[2,,5];export function run():number{return a[0];}",
  "const a=[2,...[5]];export function run():number{return a[0];}",
];
function prepare(source: string, deferTopLevelInit = false) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit,
    linearVectorProjection: "native-f64",
  });
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? "prepared" : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return { program: result.program, ast };
}
function instructions(module: IrModule) {
  const all: IrInstr[] = [];
  for (const fn of module.functions)
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => all.push(i));
  return all;
}
afterEach(() => vi.restoreAllMocks());
describe("native original module vector storage", () => {
  it.each(fixtures)("$name: four profiles live/codec and real startup", async (fixture) => {
    const { program } = prepare(fixture.source);
    const sealed = encodePreparedIrProgram(program);
    const native = vi.spyOn(nativeProducer, "analyzeNativeVectorControl").mockImplementation(() => {
      throw new Error("producer replay forbidden");
    });
    const source = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw new Error("source replay forbidden");
    });
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw new Error("direct Linear forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw new Error("direct GC forbidden");
    });
    const decoded = decodePreparedIrProgram(sealed);
    expect(encodePreparedIrProgram(decoded)).toBe(sealed);
    expect(instructions(program.ir).filter((i) => i.kind === "vec.new_fixed").length).toBeGreaterThan(0);
    let emissions = 0;
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const current of [program, decoded]) {
        const accepted = acceptPreparedIrProgram(current, {
          ...policy,
          moduleName: "global",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? "accepted" : accepted)).toBe("accepted");
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const emitted = emitAcceptedIrProgram(accepted);
        expect(emittedStartupGuardIndex(emitted)).toBeTypeOf("number");
        expect(emittedStartupAdapterIndex(emitted)).toBeTypeOf("number");
        if (!("readsGlobal" in fixture)) expect(emittedReferenceErrorResourceReceipt(emitted)).toBeDefined();
        const bytes = new Uint8Array(emitBinary(emitted.module));
        binaries.push(bytes);
        expect(WebAssembly.validate(bytes)).toBe(true);
        const mod = await WebAssembly.compile(bytes);
        expect(WebAssembly.Module.imports(mod)).toEqual([]);
        const instance = await WebAssembly.instantiate(mod, {});
        const run = instance.exports.run as () => number;
        if (policy.target === "wasi") {
          if (!("readsGlobal" in fixture)) expect(() => run()).toThrow(WebAssembly.Exception);
          else expect(run()).toBe(fixture.value);
          (instance.exports._start as () => void)();
        }
        expect(run()).toBe(fixture.value);
        expect(run()).toBe(fixture.value);
        if ("length" in fixture) expect((instance.exports.length as () => number)()).toBe(fixture.length);
        if ("lifetime" in fixture) {
          expect((instance.exports.churn as (x: number, y: number) => number)(17, 19)).toBe(36);
          expect(run()).toBe(7);
          expect((instance.exports.change as (n: number) => number)(3)).toBe(13);
          expect(run()).toBe(13);
        }
        if (policy.target === "wasi") (instance.exports._start as () => void)();
        expect(run()).toBe("lifetime" in fixture ? 13 : fixture.value);
        emissions++;
      }
      expect(binaries[0]).toEqual(binaries[1]);
    }
    expect(emissions).toBe(8);
    expect(native).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
    expect(encodePreparedIrProgram(program)).toBe(sealed);
  });
  it("executes genuine public sources and preserves changed contents on repeated WASI startup", async () => {
    for (const fixture of fixtures)
      for (const policy of policies) {
        const result = await compile(fixture.source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const mod = await WebAssembly.compile(Uint8Array.from(result.binary!));
        expect(WebAssembly.Module.imports(mod)).toEqual([]);
        const inst = await WebAssembly.instantiate(mod, {});
        if (inst.exports._start) (inst.exports._start as () => void)();
        expect((inst.exports.run as () => number)()).toBe(fixture.value);
        if ("lifetime" in fixture) {
          expect((inst.exports.change as (n: number) => number)(3)).toBe(13);
          if (inst.exports._start) (inst.exports._start as () => void)();
          expect((inst.exports.run as () => number)()).toBe(13);
        }
      }
  });
  it("retains deferred TDZ and once-only startup on both actual backends", async () => {
    const { program } = prepare(fixtures.find((row) => "lifetime" in row)!.source, true);
    for (const policy of policies.filter((p) => p.target === "standalone")) {
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "deferred",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
      const emitted = emitAcceptedIrProgram(accepted);
      const mod = await WebAssembly.compile(new Uint8Array(emitBinary(emitted.module)));
      const inst = await WebAssembly.instantiate(mod, {});
      expect(() => (inst.exports.run as () => number)()).toThrow(WebAssembly.Exception);
      (inst.exports.__module_init as () => void)();
      expect((inst.exports.change as (n: number) => number)(3)).toBe(13);
      (inst.exports.__module_init as () => void)();
      expect((inst.exports.run as () => number)()).toBe(13);
    }
  });
  it("refuses unproved mutable storage, aliases, public vector ABIs and writes", async () => {
    for (const source of negatives)
      for (const policy of policies) {
        const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, source).toBe(false);
        expect(result.binary?.length ?? 0).toBe(0);
        expect(result.errors.some((e) => e.severity === "error" && typeof e.line === "number")).toBe(true);
      }
  });
  it("rechecks actual original declaration type and keeps clones outside source membership", () => {
    const { ast } = prepare(fixtures.find((row) => row.name === "read and logical length")!.source);
    const declaration = (ast.entryFile.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    expect(nativeModuleVectorType(ast.checker, declaration)?.nullable).toBe(false);
    const clone = ts.factory.createVariableDeclaration(
      "a",
      undefined,
      undefined,
      ts.factory.createArrayLiteralExpression([ts.factory.createNumericLiteral(2)]),
    );
    expect(nativeModuleVectorType(ast.checker, clone)).toBeUndefined();
  });
  it("rejects an initializer read before publication of its initialized flag", () => {
    const { program } = prepare(fixtures.find((row) => row.name === "original initializer read order")!.source);
    const module = structuredClone(program.ir);
    const init = module.functions.find((fn) => fn.unitId === program.startup[0]!.unitId)!;
    const body = init.blocks[0]!.instrs as IrInstr[];
    const get = body.findIndex((i) => i.kind === "global.get" && i.resultType?.kind === "vec");
    const flag = body.findIndex((i, index) => index < get && i.kind === "global.set" && i.target.name !== "a");
    expect(flag).toBeGreaterThan(0);
    expect(get).toBeGreaterThan(flag);
    const publication = body.splice(flag - 1, 2);
    body.push(...publication);
    expect(verifyNativeAllocationEvidence(module, program.allocations, nativeModuleGlobalEvidence(program)).kind).toBe(
      "invalid",
    );
  });
  it("rejects detached global writer/type/owner changes without rerunning source or producer", () => {
    const { program } = prepare(fixtures.find((row) => row.name === "read and logical length")!.source);
    const context = nativeModuleGlobalEvidence(program);
    for (const change of [
      "foreign-writer",
      "second-writer",
      "wrong-type",
      "missing-guard",
      "flag-first",
      "flag-reset",
      "conditional-writer",
      "forged-guard",
      "wrong-tdz-identity",
    ] as const) {
      const module = structuredClone(program.ir);
      const init = module.functions.find((f) => f.unitId === program.startup[0]!.unitId)!;
      const store = init.blocks[0]!.instrs.find((i) => i.kind === "global.set" && i.target.name === "a")!;
      if (change === "conditional-writer") {
        const body = init.blocks[0]!.instrs as IrInstr[];
        body[body.indexOf(store)] = {
          kind: "if.stmt",
          result: null,
          resultType: null,
          cond: (store as Extract<IrInstr, { kind: "global.set" }>).value,
          then: [store],
          else: [],
        };
      } else if (change === "forged-guard") {
        const call = instructions(module).find(
          (i) =>
            i.kind === "call" &&
            i.target.binding.kind === "runtime" &&
            i.target.binding.symbol === "__new_ReferenceError",
        )!;
        (call as { target: unknown }).target = { binding: { kind: "runtime", symbol: "__new_TypeError" } };
      } else if (change === "wrong-tdz-identity") {
        const get = instructions(module).find((i) => i.kind === "global.get" && i.resultType?.kind !== "vec")!;
        (get as { target: unknown }).target = structuredClone(
          (store as Extract<IrInstr, { kind: "global.set" }>).target,
        );
      } else if (change === "missing-guard") {
        const fn = module.functions.find((f) => f !== init)!;
        const body = fn.blocks[0]!.instrs as IrInstr[];
        const guard = body.findIndex((i) => i.kind === "if.stmt");
        body.splice(guard, 1);
      } else if (change === "flag-first") {
        const body = init.blocks[0]!.instrs as IrInstr[];
        const index = body.indexOf(store);
        const flag = body.splice(index + 1, 2);
        body.unshift(...flag);
      } else if (change === "flag-reset") {
        const body = init.blocks[0]!.instrs as IrInstr[];
        const one = body.find((i) => i.kind === "const" && i.value.kind === "i32")!;
        (one as { value: unknown }).value = { kind: "i32", value: 0 };
      } else if (change === "foreign-writer") {
        (init.blocks[0]!.instrs as IrInstr[]).splice(init.blocks[0]!.instrs.indexOf(store), 1);
        (module.functions.find((f) => f !== init)!.blocks[0]!.instrs as IrInstr[]).push(store);
      } else if (change === "second-writer") (init.blocks[0]!.instrs as IrInstr[]).push(structuredClone(store));
      else {
        const get = instructions(module).find((i) => i.kind === "global.get" && i.resultType?.kind === "vec")!;
        (get as { resultType: unknown }).resultType = { kind: "val", val: { kind: "f64" } };
      }
      expect(verifyNativeAllocationEvidence(module, program.allocations, context).kind).toBe("invalid");
    }
  });
});
