// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedPhysicalSetupPlan,
} from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { isNativeNumericAppendCall } from "../src/ir/analysis/allocation-evidence/numeric-append-protocol.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as legacyOutput from "../src/compiler/output.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const source = `const shared:number[]=[2,5];
function observe(a:number[]):number{let sum:number=0;for(let i=0;i<a.length;i++){sum=sum+a[i];}const n=a.push();return n*100+sum;}
function receiver(a:number[]):number[]{a.push(9);return a;}
export function plain():number{const a=[2,5];return a.push();}
export function empty():number{const a:number[]=[];return a.push();}
export function statement():number{const a=[2,5];a.push();return a.length*100+a[0]*10+a[1];}
export function receiverStatement():number{const a=[2,5];receiver(a).push();return a.length*100+a[2];}
export function receiverOnce():number{const a=[2,5];const n=receiver(a).push();return n*100+a.length*10+a[2];}
export function alias():number{const a=[2,5];const b=a;const n=b.push();return n*100+a.length;}
export function global():number{return shared.push();}
export function internal():number{return observe([3,4]);}
export function boundary():number{const a=[2,5];const b=a;let i=0;while(i<40){b.push(i);i++;}const n=a.push();return n*100+b.length+a[41];}
export function observation():number{const a=[2,5];const before=a.push();a.push(7,11);const after=a.push();return before*100+after;}`;
const expected = {
  plain: 2,
  empty: 0,
  statement: 225,
  receiverStatement: 309,
  receiverOnce: 339,
  alias: 202,
  global: 2,
  internal: 207,
  boundary: 4281,
  observation: 204,
};
const pure = `export function plain():number{const a=[2,5];return a.push();}
export function empty():number{const a:number[]=[];return a.push();}
export function statement():number{const a=[2,5];a.push();return a.length;}`;
const pureExpected = { plain: 2, empty: 0, statement: 2 };
const deferred = "const a=[2,5];export function read():number{return a.push();}";
function prepare(text = source, deferTopLevelInit = false, gcOnly = false) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: gcOnly ? policies[2] : policies[0],
    runtimePolicies: gcOnly ? [policies[2]] : policies,
    deferTopLevelInit,
    linearVectorProjection: "native-f64",
  });
}
function requireProgram(result: ReturnType<typeof prepare>): PreparedIrProgram {
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
function emit(program: PreparedIrProgram, policy: (typeof policies)[number]) {
  const accepted = acceptPreparedIrProgram(program, {
    ...policy,
    moduleName: "zero-push",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  });
  if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
  return emitAcceptedIrProgram(accepted);
}
function exportsOf(binary: Uint8Array<ArrayBuffer>, start = true) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports;
  if (start && exports._start) Reflect.apply(exports._start as Function, undefined, []);
  return exports;
}
function execute(exports: WebAssembly.Exports, values: Record<string, number>): number {
  for (const [name, value] of Object.entries(values))
    expect(Reflect.apply(exports[name] as Function, undefined, []), name).toBe(value);
  return Object.keys(values).length;
}
function nodeReference(text: string, names: readonly string[]): Record<string, number> {
  // This independent JavaScript reference executes the fixture's actual Array
  // methods before PreparedIR exists; it never emits or reconstructs Wasm.
  const javascript = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, Function> = {};
  new Function("exports", javascript)(exports);
  return Object.fromEntries(names.map((name) => [name, exports[name]!()]));
}
function instructions(program: PreparedIrProgram): IrInstr[] {
  const all: IrInstr[] = [];
  for (const fn of program.ir.functions)
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => all.push(i));
  return all;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("executes actual zero-argument push on four profiles live/codec against JavaScript with once-only receivers, aliases, globals, loops and post-growth length", async () => {
  expect(nodeReference(source, Object.keys(expected))).toEqual(expected);
  const program = requireProgram(prepare()),
    sealed = encodePreparedIrProgram(program);
  const noSource = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source reconstruction forbidden");
  });
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  let executions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const value of [program, decodePreparedIrProgram(sealed)]) {
      assertPreparedIrProgram(value);
      const emission = emit(value, policy),
        binary = Uint8Array.from(emitBinary(emission.module));
      binaries.push(binary);
      executions += execute(exportsOf(binary), expected);
      await yieldTurn();
    }
    expect(binaries[0]).toEqual(binaries[1]);
  }
  expect(executions).toBe(80);
  expect(noSource).not.toHaveBeenCalled();
  expect(noLinear).not.toHaveBeenCalled();
  expect(noGc).not.toHaveBeenCalled();
}, 120000);
it("publishes actual zero-push source on four profiles without direct/legacy renderers or post-Prepared AST reads", async () => {
  expect(nodeReference(source, Object.keys(expected))).toEqual(expected);
  const original = presentation.prepareIrProgramPresentation;
  let restore: (() => void)[] = [];
  vi.spyOn(presentation, "prepareIrProgramPresentation").mockImplementation((request) => {
    const prepared = original(request);
    if (prepared.kind === "prepared-presentation") {
      for (const [object, key] of [
        [prepared.output.entryAst, "checker"],
        [prepared.output.entryAst.sourceFile, "statements"],
      ] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        Object.defineProperty(object, key, {
          configurable: true,
          get() {
            throw Error(`post-Prepared AST ${key} forbidden`);
          },
        });
        restore.push(() => Object.defineProperty(object, key, descriptor));
      }
    }
    return prepared;
  });
  const noDts = vi.spyOn(legacyOutput, "generateDts").mockImplementation(() => {
    throw Error("legacy DTS forbidden");
  });
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  let executions = 0;
  for (const policy of policies) {
    try {
      const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      executions += execute(exportsOf(Uint8Array.from(result.binary)), expected);
      expect(result.dts).toContain("export declare function empty(): number;");
    } finally {
      for (const callback of restore.reverse()) callback();
      restore = [];
    }
    await yieldTurn();
  }
  expect(executions).toBe(40);
  expect(noDts).not.toHaveBeenCalled();
  expect(noLinear).not.toHaveBeenCalled();
  expect(noGc).not.toHaveBeenCalled();
}, 120000);
it("keeps pure empty/nonempty/statement zero-push modules free of append calls, writers, helpers and demand population on four profiles live/codec", async () => {
  expect(nodeReference(pure, Object.keys(pureExpected))).toEqual(pureExpected);
  const program = requireProgram(prepare(pure));
  const all = instructions(program);
  expect(all.some(isNativeNumericAppendCall)).toBe(false);
  expect(all.some((i) => i.kind === "vec.set" || i.kind === "vec.set_length")).toBe(false);
  expect(all.filter((i) => i.kind === "vec.len").length).toBeGreaterThan(0);
  const sealed = encodePreparedIrProgram(program);
  let executions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const value of [program, decodePreparedIrProgram(sealed)]) {
      const emission = emit(value, policy),
        plan = emittedPhysicalSetupPlan(emission);
      expect(plan.vectors.numericAppendHelper).toBeUndefined();
      expect(plan.vectors.helper).toBeUndefined();
      expect(plan.vectors.demands).toHaveLength(value.ir.functions.length);
      expect(plan.vectors.demands.reduce((n, row) => n + row.uses.length, 0)).toBe(0);
      expect(plan.linearMemory?.functions.filter((fn) => fn.role === "append-f64") ?? []).toEqual([]);
      const binary = Uint8Array.from(emitBinary(emission.module));
      binaries.push(binary);
      executions += execute(exportsOf(binary), pureExpected);
      await yieldTurn();
    }
    expect(binaries[0]).toEqual(binaries[1]);
  }
  expect(executions).toBe(24);
}, 120000);
it("executes pure f64 multiplication for actual zero push and its identical length counterpart", async () => {
  let executions = 0;
  const values = { plain: 225, empty: 0, statement: 2 };
  for (const read of ["a.push()", "a.length"]) {
    const text = `export function plain():number{const a=[2,5];const n=${read};return n*100+a[0]*10+a[1];}
export function empty():number{const a:number[]=[];return ${read};}
export function statement():number{const a=[2,5];${read};return a.length;}`;
    expect(nodeReference(text, Object.keys(values))).toEqual(values);
    const program = requireProgram(prepare(text)),
      sealed = encodePreparedIrProgram(program);
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const value of [program, decodePreparedIrProgram(sealed)]) {
        const binary = Uint8Array.from(emitBinary(emit(value, policy).module));
        binaries.push(binary);
        executions += execute(exportsOf(binary), values);
        await yieldTurn();
      }
      expect(binaries[0]).toEqual(binaries[1]);
    }
  }
  expect(executions).toBe(48);
}, 120000);
it("retains authentic deferred global TDZ and current length across repeated zero pushes on four profiles live/codec", async () => {
  const program = requireProgram(prepare(deferred, true)),
    sealed = encodePreparedIrProgram(program);
  let exceptions = 0,
    executions = 0;
  for (const policy of policies) {
    const binaries: Uint8Array[] = [];
    for (const value of [program, decodePreparedIrProgram(sealed)]) {
      const emission = emit(value, policy),
        binary = Uint8Array.from(emitBinary(emission.module)),
        exports = exportsOf(binary, false);
      binaries.push(binary);
      expect(() => Reflect.apply(exports.read as Function, undefined, [])).toThrow(WebAssembly.Exception);
      exceptions++;
      Reflect.apply(exports[policy.target === "wasi" ? "_start" : "__module_init"] as Function, undefined, []);
      executions += execute(exports, { read: 2 });
      executions += execute(exports, { read: 2 });
      await yieldTurn();
    }
    expect(binaries[0]).toEqual(binaries[1]);
  }
  expect(exceptions).toBe(8);
  expect(executions).toBe(16);
}, 120000);
it("preserves spread, non-f64, async, mutable and unknown-producer refusals and the separate tiny-helper callerless gap", () => {
  for (const text of [
    "export function run():number{const a=[2,5];const b:number[]=[];return a.push(...b);}",
    "export function run():number{const a=[true,false];return a.push();}",
    "export async function run():Promise<number>{const a=[2,5];return a.push();}",
    "export function run():number{let a=[2,5];return a.push();}",
    "export function run():number{const a=JSON.parse('[2,5]') as number[];return a.push();}",
  ])
    expect(prepare(text).kind, text).not.toBe("prepared");
  const tiny = requireProgram(
    prepare(
      `${source} function size(a:number[]):number{return a.push();}export function tiny():number{return size([2,5]);}`,
    ),
  );
  const accepted = acceptPreparedIrProgram(tiny, {
    ...policies[0],
    moduleName: "tiny-gap",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  });
  expect(accepted.kind).toBe("unsupported");
  if (accepted.kind !== "unsupported") throw Error("missing separate gap");
  expect(accepted.detail).toContain("vector formal has no complete internal callers");
});
it("retains public vector transport refusal before artifacts with both direct generators forbidden", async () => {
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC forbidden");
  });
  for (const policy of policies) {
    const result = await compile("export function run(a:number[]):number{return a.push();}", {
      ...policy,
      optimize: false,
      sourceMap: false,
    });
    expect(result.success).toBe(false);
    expect(result.binary.length).toBe(0);
    expect(result.errors.some((row) => row.severity === "error" && row.line !== undefined)).toBe(true);
    await yieldTurn();
  }
  expect(noLinear).not.toHaveBeenCalled();
  expect(noGc).not.toHaveBeenCalled();
}, 120000);
it("rechecks genuine zero-read type and ownership evidence after warm validation, before live/codec publication", () => {
  vi.stubEnv("JS2WASM_IR_OWNERSHIP", "1");
  const program = requireProgram(prepare("export function run():number{const a=[2,5];return a.push();}", false, true));
  assertPreparedIrProgram(program);
  encodePreparedIrProgram(program);
  const mutations = [
    (p: PreparedIrProgram) => {
      const list = instructions(p),
        length = list.find((i) => i.kind === "vec.len")!;
      if (length.kind !== "vec.len") throw Error("missing actual length");
      Object.assign(length, {
        vec: list.find((i) => i.kind === "const" && i.resultType?.kind === "val" && i.resultType.val.kind === "f64")!
          .result!,
      });
    },
    (p: PreparedIrProgram) => {
      const length = instructions(p).find((i) => i.kind === "vec.len")!;
      Object.assign(length, { resultType: { kind: "val", val: { kind: "i32" } } });
    },
    (p: PreparedIrProgram) => {
      const length = instructions(p).find((i) => i.kind === "vec.len")!;
      Object.assign(length, { integer: true });
    },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(program);
    mutate(altered);
    expect(() => assertPreparedIrProgram(altered)).toThrow();
    expect(() => encodePreparedIrProgram(altered)).toThrow();
  }
  const altered = structuredClone(program);
  const row = altered.allocations.metadata.find((row) => row.entries.some(([key]) => key === "ownership"));
  expect(row, "owned actual constructor evidence").toBeDefined();
  const annotation = row!.entries.find(([key]) => key === "ownership")!;
  Object.assign(annotation[1] as object, { ops: ["write"] });
  expect(() => assertPreparedIrProgram(altered)).toThrow();
  expect(() => encodePreparedIrProgram(altered)).toThrow();
});
