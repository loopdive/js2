// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../src/ts-api.js";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import { collectNativeNumberUndefinedRequirements } from "../src/ir/program/native-number-undefined-requirements.js";
const forms = {
  direct: "const a=[2];return a[99]===undefined?1:0;",
  alias: "const a=[2];const v=a[99];return v===undefined?1:0;",
  chain: "const a=[2];const v=a[99];const w=v;return w===undefined?1:0;",
  empty: "const a:number[]=[];return a[0]===undefined?1:0;",
  double: "const a=[2];return a[99]===a[99]?1:0;",
  coercion: "const a=[x];const v=a[0];return v===undefined?1:(+v===+v?2:3);",
  aliasSelf: "const a=[x];const v=a[0];return v===v?1:0;",
  absentAliasSelf: "const a=[x];const v=a[99];return v===v?1:0;",
  initializedAlias: "const a=[x];const v=a[0];return v===undefined?1:0;",
  initializedNaN: "const a=[x];return a[0]===a[0]?1:0;",
  numericJoin: "const a=[2];const v=x?a[99]:3;return v===undefined?1:0;",
  annotatedAlias: "const a=[2];const v:number=a[99];return v===undefined?1:0;",
  fractional: "const a=[2];return a[0.5]===undefined?1:0;",
  joined: "const a=[2];const v=x?a[99]:a[0];return v===undefined?1:0;",
};
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function source(body: string, policy: (typeof policies)[number] = policies[0]) {
  const ast = analyzeMultiSource({ "./entry.ts": `export function run(x:number):number{${body}}` }, "./entry.ts");
  return prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
  });
}
it.each(Object.entries(forms))(
  "lowers genuine original %s on four native source profiles",
  async (name, body) => {
    const text = `export function run(x:number):number{${body}}`;
    const javascript = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, Function> = {};
    new Function("exports", javascript)(exports);
    for (const value of [0, 1, NaN, -0, Infinity]) {
      const actual = exports.run!(value);
      expect(typeof actual).toBe("number");
      if (name === "initializedNaN") expect(actual).toBe(Number.isNaN(value) ? 0 : 1);
      if (name === "double" || name === "absentAliasSelf") expect(actual).toBe(1);
      if (name === "aliasSelf") expect(actual).toBe(Number.isNaN(value) ? 0 : 1);
      if (name === "initializedAlias") expect(actual).toBe(0);
      if (name === "coercion") expect(actual).toBe(Number.isNaN(value) ? 3 : 2);
    }
    for (const policy of policies) {
      await yieldTurn();
      const result = source(body, policy);
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw Error("source preparation refused");
      const kinds: string[] = [];
      for (const fn of result.ir.functions)
        for (const block of fn.blocks)
          for (const instr of block.instrs) forEachInstrDeep(instr, (nested) => kinds.push(nested.kind));
      expect(kinds).toContain("box");
      const requirements = collectNativeNumberUndefinedRequirements(result.ir, result.allocations.snapshot());
      expect(requirements?.boxes.length).toBeGreaterThan(0);
      expect(
        requirements?.occurrences.some((at) => at.instr.kind === "const" && at.instr.value.kind === "undefined"),
      ).toBe(true);
    }
  },
  120000,
);
it("refuses mutable carrier aliases before preparation", () => {
  expect(source("const a=[2];let v=a[99];v=3;return v===undefined?1:0;")).toMatchObject({
    kind: "unsupported",
    code: "nullish-value-unsupported",
  });
}, 120000);

it.each([
  ["hole constructor", "const a=new Array<number>(3);return a[0]===undefined?1:0;"],
  ["omitted cell", "const a=[,2];return a[0]===undefined?1:0;"],
  ["effectful index", "const a=[2];return a[(x++,x)]===undefined?1:0;"],
  ["boolean property index", "const a=[2,3];return a[true as any]===undefined?1:0;"],
  ["asserted boolean cell", "const a=[true as unknown as number];return a[0]===a[0]?1:0;"],
  ["asserted alias cell", "const v=true as unknown as number;const a=[v];return a[0]===a[0]?1:0;"],
])(
  "refuses unproved %s before producing a native carrier",
  (_name, body) => {
    expect(source(body).kind).toBe("unsupported");
  },
  120000,
);

it("refuses incoming absent numeric call arguments before optimizer inlining can erase their custody", () => {
  const text =
    "export function observe(x:number):number{const a=[x];return a[0]===undefined?1:0;}export function run():number{const a=[2];return observe(a[99]);}";
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  expect(
    prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend: "wasmgc", target: "standalone" },
      linearVectorProjection: "native-f64",
      deferTopLevelInit: false,
    }),
  ).toMatchObject({ kind: "unsupported", code: "nullish-value-unsupported" });
}, 120000);

it.each([
  [
    "module prototype index",
    "(Array.prototype as any)[99]=7;export function run():number{const a=[2];return a[99]===undefined?1:0;}",
  ],
  [
    "inherited accessor",
    "Object.defineProperty(Array.prototype,'99',{get(){return 7;},configurable:true});export function run():number{const a=[2];return a[99]===undefined?1:0;}",
  ],
  [
    "unknown mutating call",
    "function mutate():void{(Array.prototype as any)[99]=7;}mutate();export function run():number{const a=[2];return a[99]===undefined?1:0;}",
  ],
  [
    "source-defined Number",
    "function Number(x:number):number{const a=[2];return a[99];}export function run():number{const a=[2];return Number(a[99])===undefined?1:0;}",
  ],
  [
    "module Number mutation",
    "Number=((x:number)=>undefined) as unknown as NumberConstructor;export function run():number{const a=[2];return Number(a[99])===undefined?1:0;}",
  ],
])(
  "refuses unclosed complete-source %s population",
  async (_name, text) => {
    for (const policy of policies) {
      await yieldTurn();
      const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
      const result = prepareIrProgramSources({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy,
        linearVectorProjection: "native-f64",
        deferTopLevelInit: false,
      });
      expect(result.kind, JSON.stringify(result)).toBe("unsupported");
    }
  },
  120000,
);
