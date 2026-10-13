// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMulti, type CompileOptions } from "../src/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as consumer from "../src/ir/program-consumer.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import { indexPhysicalTypes } from "../src/wasm/physical/type-layout.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const factory = "function make(a:number,b:number):number[]{return [a,b];}";
const identity = "function identity(a:number[]):number[]{return a;}";
const pick = "function pick(a:number[],i:number):number{return a[i];}";
const fixtures: readonly { name: string; files: Record<string, string>; expected: number; payloads: number[][] }[] = [
  {
    name: "local positive",
    files: { "./entry.ts": "export function run():number{const a=[2,5];return a[0]+a[1];}" },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "argument",
    files: { "./entry.ts": `${pick} export function run():number{return pick([2,5],1);}` },
    expected: 5,
    payloads: [[2, 5]],
  },
  {
    name: "result",
    files: { "./entry.ts": `${factory} export function run():number{const a=make(2,5);return a[0]+a[1];}` },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "result to parameter",
    files: {
      "./entry.ts": `${factory}${identity}${pick} export function run():number{return pick(identity(make(2,5)),1);}`,
    },
    expected: 5,
    payloads: [[2, 5]],
  },
  {
    name: "repeated fresh results",
    files: {
      "./entry.ts": `${factory} export function run():number{const a=make(2,5);const b=make(3,7);return a[0]+a[1]+b[0]+b[1];}`,
    },
    expected: 17,
    payloads: [
      [2, 5],
      [3, 7],
    ],
  },
  {
    name: "parameter result alias",
    files: {
      "./entry.ts": `${identity} export function run():number{const a=[2,5];const b=identity(a);return a[0]+b[1];}`,
    },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "cross source",
    files: {
      "./vec.ts": `export ${factory} export ${pick}`,
      "./entry.ts": "import {make,pick} from './vec';export function run():number{return pick(make(2,5),1);}",
    },
    expected: 5,
    payloads: [[2, 5]],
  },
];

const swapped = {
  name: "distinct argument order",
  files: {
    "./entry.ts":
      "function pair(a:number[],b:number[]):number{return a[0]*10+b[1];}export function run():number{const a=[2,5];const b=[3,7];return pair(b,a);}",
  },
  expected: 35,
};
const booleanWit = {
  name: "scalar Boolean and WIT boundary",
  files: {
    "./entry.ts": `${factory}${pick}export function run():number{return pick(make(2,5),1);}export function echo(value:boolean):boolean{return value;}`,
  },
  expected: 5,
};
const refusals: readonly { name: string; files: Record<string, string> }[] = [
  { name: "public result", files: { "./entry.ts": "export function make():number[]{return [2,5];}" } },
  { name: "public parameter", files: { "./entry.ts": "export function pick(a:number[]):number{return a[0];}" } },
  { name: "entry reexport", files: { "./vec.ts": `export ${factory}`, "./entry.ts": 'export {make} from "./vec";' } },
  {
    name: "aliased reexport",
    files: { "./vec.ts": `export ${factory}`, "./entry.ts": 'export {make as exposed} from "./vec";' },
  },
  {
    name: "async vector",
    files: {
      "./entry.ts": "async function make():Promise<number[]>{return [2,5];}export function run():number{return 5;}",
    },
  },
  {
    name: "Boolean vector",
    files: {
      "./entry.ts":
        "function pick(a:boolean[]):boolean{return a[0];}export function run():boolean{return pick([true]);}",
    },
  },
  {
    name: "optional vector",
    files: {
      "./entry.ts": "function pick(a?:number[]):number{return 5;}export function run():number{return pick([2,5]);}",
    },
  },
  {
    name: "default vector",
    files: {
      "./entry.ts": "function pick(a:number[]=[2,5]):number{return a[0];}export function run():number{return pick();}",
    },
  },
  {
    name: "canonical source collision",
    files: {
      "./entry.ts": "export function run():number{return 5;}",
      "entry.ts": "export function run():number{return 7;}",
    },
  },
];
function forbidDirect() {
  return [
    vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("direct Linear forbidden");
    }),
    vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("direct GC forbidden");
    }),
  ];
}
async function execute(files: Record<string, string>, options: CompileOptions, expected: number, wit = false) {
  const result = await compileMulti(files, "./entry.ts", { ...options, optimize: false, sourceMap: false, wit });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const bytes = Uint8Array.from(result.binary);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = await WebAssembly.compile(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  if (typeof instance.exports._start === "function") instance.exports._start();
  const run = instance.exports.run as () => number;
  expect(run()).toBe(expected);
  expect(run()).toBe(expected);
  if (wit) {
    expect(result.wit).toContain("run: func() -> f64");
    expect(result.wit).toContain("echo: func(value: bool) -> bool");
    expect(result.exportSignatures?.echo).toEqual({ params: ["boolean"], result: "boolean" });
    expect((instance.exports.echo as (value: number) => number)(1)).toBe(1);
    expect((instance.exports.echo as (value: number) => number)(0)).toBe(0);
  }
}
afterEach(() => vi.restoreAllMocks());
describe("native internal vector public presentation", () => {
  for (const policy of policies) {
    it(`${policy.backend}/${policy.target}: executes nine real public fixtures without direct generation`, async () => {
      const direct = forbidDirect();
      const shared = vi.spyOn(consumer, "emitAcceptedIrProgram");
      const finalize = vi.spyOn(presentation, "completePreparedPresentationFinalization");
      for (const fixture of [...fixtures, swapped, booleanWit])
        await execute(fixture.files, policy, fixture.expected, fixture === booleanWit);
      expect(shared).toHaveBeenCalledTimes(9);
      if (policy.backend === "wasmgc") {
        expect(finalize).toHaveBeenCalledTimes(9);
        for (const result of finalize.mock.results) {
          expect(result.type).toBe("return");
          expect(result.value).toMatchObject({ originalEmissionUnchanged: true, phase: "after-reference-widening" });
          expect(result.value.widenedSlots).toBeGreaterThan(0);
        }
      }
      for (const spy of direct) expect(spy).not.toHaveBeenCalled();
    });
    it(`${policy.backend}/${policy.target}: refuses nine unsupported logical or public boundaries`, async () => {
      const direct = forbidDirect();
      for (const fixture of refusals) {
        const result = await compileMulti(fixture.files, "./entry.ts", {
          ...policy,
          optimize: false,
          sourceMap: false,
        });
        expect(result.success, fixture.name).toBe(false);
        expect(result.binary.length, fixture.name).toBe(0);
        expect(JSON.stringify(result.errors), fixture.name).not.toMatch(/captured source text|direct .* forbidden/);
        expect(
          result.errors.some((error) => error.severity === "error" && error.line !== undefined),
          fixture.name,
        ).toBe(true);
      }
      for (const spy of direct) expect(spy).not.toHaveBeenCalled();
    });
  }
  for (const victim of ["original", "output"] as const) {
    it(`authenticates the canonical pack and both WIT snapshots after ${victim} mutation`, async () => {
      const prepare = vi.spyOn(presentation, "prepareIrProgramPresentation");
      const begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization");
      await execute(booleanWit.files, policies[2], 5, true);
      const result = prepare.mock.results[0]!;
      expect(result.type).toBe("return");
      if (result.type !== "return" || result.value.kind !== "prepared-presentation")
        throw Error("missing real presentation");
      const prepared = result.value;
      const finalized = begin.mock.results[0]!;
      if (finalized.type !== "return") throw Error("missing real detached output");
      const output = finalized.value.outputModule;
      const layouts = consumer.emittedNativeVectorLayouts(prepared.emission);
      expect(layouts).toHaveLength(1);
      expect(Object.isFrozen(layouts)).toBe(true);
      expect(Object.isFrozen(layouts[0])).toBe(true);
      expect(Object.isFrozen(layouts[0]!.elementValType)).toBe(true);
      expect(layouts[0]!.elementValType.kind).toBe("f64");
      expect(output).not.toBe(prepared.emission.module);
      expect(() => consumer.emittedNativeVectorLayouts({ ...prepared.emission })).toThrow("emission was not produced");
      const view = presentation.preparedPresentationWitView(prepared, output);
      expect(presentation.preparedPresentationWitView(prepared, output)).toBe(view);
      expect(presentation.preparedPresentationWitView(prepared, prepared.emission.module)).toBe(view);
      expect(() => presentation.preparedPresentationWitView(prepared, structuredClone(output))).toThrow(
        "foreign module",
      );
      const changed = victim === "original" ? prepared.emission.module : output;
      changed.functions[0]!.name += "-changed";
      expect(() => presentation.preparedPresentationWitView(prepared, output)).toThrow("output-changed");
      expect(() => presentation.preparedPresentationWitView(prepared, output)).toThrow("invalid presentation");
    });
  }
  for (const target of ["standalone", "wasi"] as const) {
    it(`refuses a changed completed GC backing array on ${target}`, async () => {
      const emit = consumer.emitAcceptedIrProgram;
      vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementation((accepted) => {
        const emission = emit(accepted);
        const layouts = consumer.emittedNativeVectorLayouts(emission);
        expect(layouts).toHaveLength(1);
        const array = indexPhysicalTypes(emission.module.types).entries[layouts[0]!.arrayTypeIdx]!.definition;
        if (array.kind !== "array") throw Error("missing actual backing array");
        array.element = { kind: "i32" };
        expect(() => consumer.emittedNativeVectorLayouts(emission)).toThrow("backing array descriptor mismatch");
        return emission;
      });
      const direct = forbidDirect();
      const result = await compileMulti(booleanWit.files, "./entry.ts", {
        backend: "wasmgc",
        target,
        optimize: false,
        sourceMap: false,
      });
      expect(result.success).toBe(false);
      expect(result.binary.length).toBe(0);
      expect(JSON.stringify(result.errors)).toContain("backing array descriptor mismatch");
      for (const spy of direct) expect(spy).not.toHaveBeenCalled();
    });
  }
});
