// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { compile, compileMulti } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { createNativePreparedDtsView, renderNativePreparedDts } from "../src/compiler/native-ir-dts.js";
import { sourceInput, typedOptions } from "./helpers/typed-program-fixtures.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import * as legacyOutput from "../src/compiler/output.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as sourceProducer from "../src/ir/program-source.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const files = {
  "./math.ts": "export function double(x:number):number{return x*2;}",
  "./entry.ts": `export {double as twice} from './math';
export let state:number=2; state=state+1;
function f(x:number):number{return x+1;} export {f as renamed,f as 'class',f as 'not-a-name'};
export function inferred(x:number){return x+1;}
export function fü(x:number):number{return x+1;}
export default function named(x:number):number{return x+1;}
export function yes(flag:boolean):boolean{return flag;}
export function empty():void{}
export function run():number{const a=[2,5];return a[0]+a[1]+state;}`,
};
function prepare(input: Record<string, string> = files): PreparedIrProgram {
  const result = prepareWholeIrProgram({
    ...sourceInput(input),
    ...typedOptions,
    runtimePolicies: policies,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
function emit(program: PreparedIrProgram, policy: (typeof policies)[number] = policies[0]) {
  const accepted = acceptPreparedIrProgram(program, {
    ...policy,
    moduleName: "native-dts",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
  });
  if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
  return emitAcceptedIrProgram(accepted);
}
function validDeclarations(text: string): void {
  const name = "/native-generated.d.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    strict: true,
    types: [],
  };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile;
  host.getSourceFile = (file, version, onError, newFile) =>
    file === name ? ts.createSourceFile(file, text, version, true) : original(file, version, onError, newFile);
  host.fileExists = (
    (original) => (file) =>
      file === name || original(file)
  )(host.fileExists);
  const program = ts.createProgram([name], options, host);
  expect(
    ts.getPreEmitDiagnostics(program).map((row) => ts.flattenDiagnosticMessageText(row.messageText, "\n")),
  ).toEqual([]);
}
afterEach(() => vi.restoreAllMocks());
it("derives actual scalar, Boolean, void, inferred, alias/reexport, default and Unicode declarations on four profiles, live and source-free codec", () => {
  const program = prepare(),
    sealed = encodePreparedIrProgram(program);
  const forbidden = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source replay forbidden");
  });
  const legacy = vi.spyOn(legacyOutput, "generateDts").mockImplementation(() => {
    throw Error("legacy DTS forbidden");
  });
  const texts: string[] = [];
  let renders = 0;
  for (const policy of policies)
    for (const value of [program, decodePreparedIrProgram(sealed)]) {
      const emission = emit(value, policy),
        view = createNativePreparedDtsView(value, emission),
        text = renderNativePreparedDts(view);
      expect(text).toContain("export declare function inferred(x: number): number;");
      expect(text).toContain("export declare function twice(x: number): number;");
      expect(text).toContain("export declare function renamed(x: number): number;");
      expect(text).toContain("export declare function fü(x: number): number;");
      expect(text).toContain(" as default }");
      expect(text).not.toContain("export declare function named");
      expect(text).toContain("yes(flag: boolean): boolean;");
      expect(text).toContain("empty(): void;");
      expect(view.census.find((row) => row.externalName === "state")?.kind).toBe("source-global");
      expect(text).not.toMatch(/state\s*[:(]/);
      expect(view.census.filter((row) => row.kind === "linear-memory").length).toBe(
        policy.backend === "linear" ? 1 : 0,
      );
      expect(view.census.filter((row) => row.kind === "startup").length).toBe(policy.target === "wasi" ? 1 : 0);
      expect(view.census).toHaveLength(emission.module.exports.length);
      expect(renderNativePreparedDts(view)).toBe(text);
      texts.push(text);
      renders++;
    }
  expect(new Set(texts).size).toBe(1);
  expect(renders).toBe(8);
  validDeclarations(texts[0]!);
  expect(forbidden).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
}, 120000);
it("publishes native declarations with legacy renderer, direct generators and post-Prepared AST fields forbidden", async () => {
  const original = presentation.prepareIrProgramPresentation;
  const restores: (() => void)[] = [];
  vi.spyOn(presentation, "prepareIrProgramPresentation").mockImplementation((request) => {
    const result = original(request);
    if (result.kind === "prepared-presentation") {
      for (const [object, key] of [
        [result.output.entryAst, "checker"],
        [result.output.entryAst.sourceFile, "statements"],
      ] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        Object.defineProperty(object, key, {
          configurable: true,
          get() {
            throw Error(`post-Prepared AST ${key} forbidden`);
          },
        });
        restores.push(() => Object.defineProperty(object, key, descriptor));
      }
    }
    return result;
  });
  const legacy = vi.spyOn(legacyOutput, "generateDts").mockImplementation(() => {
    throw Error("legacy DTS forbidden");
  });
  const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct linear forbidden");
  });
  const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  const texts: string[] = [];
  try {
    for (const policy of policies) {
      const result = await compileMulti(files, "./entry.ts", {
        ...policy,
        optimize: false,
        sourceMap: false,
        wit: false,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      texts.push(result.dts);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(result.binary)), {});
      if (policy.target === "wasi") Reflect.apply(instance.exports._start as Function, undefined, []);
      expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(10);
      expect(instance.exports.state).toBeInstanceOf(WebAssembly.Global);
    }
  } finally {
    for (const restore of restores.reverse()) restore();
  }
  expect(new Set(texts).size).toBe(1);
  validDeclarations(texts[0]!);
  expect(legacy).not.toHaveBeenCalled();
  expect(linear).not.toHaveBeenCalled();
  expect(gc).not.toHaveBeenCalled();
}, 120000);
it("rejects a structurally similar foreign prepared program, fake emission and fake declaration view", () => {
  const first = prepare({ "./entry.ts": "export function f(x:number):number{return x+1}" });
  const second = prepare({ "./entry.ts": "export function f(y:number):number{return y+2}" });
  const emission = emit(first);
  expect(() => createNativePreparedDtsView(second, emission)).toThrow("does not belong");
  expect(() => createNativePreparedDtsView(first, { ...emission })).toThrow("does not belong");
  const view = createNativePreparedDtsView(first, emission);
  expect(() => renderNativePreparedDts({ ...view })).toThrow("invalid declaration view");
});
it("refuses changed physical export names, targets, signatures, missing/duplicate/unknown exports, globals and startup", () => {
  const program = prepare();
  const mutations = [
    (e: ReturnType<typeof emit>) => {
      e.module.exports[0]!.name += "changed";
    },
    (e: ReturnType<typeof emit>) => {
      e.module.exports[0]!.desc.index++;
    },
    (e: ReturnType<typeof emit>) => {
      e.module.exports.pop();
    },
    (e: ReturnType<typeof emit>) => {
      e.module.exports.push({ ...e.module.exports[0]! });
    },
    (e: ReturnType<typeof emit>) => {
      e.module.exports.push({ name: "unknown", desc: { kind: "func", index: 0 } });
    },
    (e: ReturnType<typeof emit>) => {
      const fn = e.module.functions[0]!,
        type = e.module.types[fn.typeIdx]!;
      if (type.kind !== "func") throw Error("wrong type");
      type.params.push({ kind: "i32" });
    },
    (e: ReturnType<typeof emit>) => {
      e.module.globals[0]!.mutable = !e.module.globals[0]!.mutable;
    },
    (e: ReturnType<typeof emit>) => {
      e.module.startFuncIdx = 0;
    },
  ];
  let rejected = 0;
  for (const change of mutations) {
    const emission = emit(program),
      view = createNativePreparedDtsView(program, emission);
    change(emission);
    expect(() => renderNativePreparedDts(view)).toThrow();
    expect(() => createNativePreparedDtsView(program, emission)).toThrow();
    rejected++;
  }
  expect(rejected).toBe(8);
}, 120000);
it("rejects malformed immutable unit, formal/type/result, alias target and cycle records before declaration publication", () => {
  const program = prepare({ "./entry.ts": "export function f(x:number):number{return x+1}" });
  const emission = emit(program);
  const mutations = [
    (p: any) => {
      p.ir.functions[0].unitId = "unknown";
    },
    (p: any) => {
      p.ir.functions[0].params[0].type = { kind: "val", val: { kind: "i32", boolean: true } };
    },
    (p: any) => {
      p.ir.functions[0].resultTypes = [];
    },
    (p: any) => {
      p.abi.entries.find((row: any) => row.contract.kind === "export").contract.targetId = "unknown";
    },
    (p: any) => {
      const row = p.abi.entries.find((row: any) => row.plan.slotPolicy === "alias");
      row.plan.aliasOf = row.plan.id;
    },
  ];
  for (const change of mutations) {
    const altered = structuredClone(program);
    change(altered);
    expect(() => createNativePreparedDtsView(altered, emission)).toThrow();
  }
});
for (const victim of ["original", "output"] as const)
  it(`reauthenticates both exact native presentation modules after ${victim} mutation with WIT off`, async () => {
    const prepareSpy = vi.spyOn(presentation, "prepareIrProgramPresentation"),
      begin = vi.spyOn(presentation, "beginPreparedPresentationFinalization");
    const result = await compile("export function run():number{const a=[2,5];return a[0]+a[1]}", {
      backend: "wasmgc",
      target: "standalone",
      optimize: false,
      wit: false,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const prepared = prepareSpy.mock.results[0]!.value;
    const output = begin.mock.results[0]!.value.outputModule;
    expect(presentation.preparedPresentationNativeDts(prepared, output)).toBe(result.dts);
    expect(() => presentation.preparedPresentationNativeDts({ ...prepared }, output)).toThrow("invalid presentation");
    expect(() => presentation.preparedPresentationNativeDts(prepared, structuredClone(output))).toThrow(
      "foreign module",
    );
    const changed = victim === "original" ? prepared.emission.module : output;
    changed.exports[0].name += "changed";
    expect(() => presentation.preparedPresentationNativeDts(prepared, output)).toThrow("output-changed");
    expect(() => presentation.preparedPresentationNativeDts(prepared, output)).toThrow("invalid presentation");
  }, 120000);
