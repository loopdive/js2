// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const original = readFileSync("tests/fixtures/issue-3518-native-object-access-712.ts.txt", "utf8");
const cases = [
  { name: "unchanged Number712", source: original },
  {
    name: "distinct data, method and accessor keys",
    source:
      "export function run():number{const o={data:5,first(){return 6;},second(){return 7;},get anchor(){return 8;}};return o.data*1000+o.first()*100+o.second()*10+o.anchor;}",
  },
  {
    name: "paired setter/getter and a second getter",
    source:
      "export function run():number{let stored=1;let trace=0;const o={set left(v:number){stored=v;trace=trace*10+1;},get left(){trace=trace*10+2;return stored;},get right(){trace=trace*10+3;return 4;}};o.left=7;const a=o.left;const b=o.right;return a*1000+b*100+trace;}",
  },
  {
    name: "Unicode, lone surrogate and NUL keys",
    source:
      'export function run():number{const o={get ["é"](){return 3;},get ["😀"](){return 4;},get ["\\ud800"](){return 5;},get ["x\\0y"](){return 6;}};return o["é"]*1000+o["😀"]*100+o["\\ud800"]*10+o["x\\0y"];}',
  },
  {
    name: "module initialization retains distinct accessor keys",
    source:
      "let trace=0;const o={get valueOf(){trace=trace*10+1;return function(){trace=trace*10+2;return 7;};},get toString(){throw 99;}};export function run():number{return Number(o)*100+trace;}",
  },
  {
    name: "original abrupt getter is not replaced or swallowed",
    source:
      "export function run():number{const o={get valueOf(){throw 99;},get toString(){return function(){return 1;};}};try{return Number(o);}catch(e){return e===99?99:-1;}}",
  },
  {
    name: "genuinely evaluated numeric-key control",
    source:
      "export function run():number{let trace=0;function key():number{trace++;return 4;}const o={get [key()](){trace=trace*10+2;return 7;},get anchor(){return 3;}};return o[4]*100+trace*10+o.anchor;}",
  },
  {
    name: "fixed arities and spread method bridge",
    source:
      "export function run():number{const o={m0(){return 1;},m1(x:number){return x;},m2(x:number,y:number){return x+y;},m3(x:number,y:number,z:number){return x+y+z;},get anchor(){return 5;}};const args=[2];return o.m0()*10000+o.m1(2)*1000+o.m2(1,2)*100+o.m3(1,1,2)*10+o.anchor+o.m1(...args);}",
  },
] as const;

function oracle(source: string): () => number {
  const exports: { run?: () => number } = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
      .outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("Source lost its actual run export");
  return exports.run;
}

afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("host/native open-object literal key parity", () => {
  it("keeps the original regression source and oracle712", () => {
    expect(oracle(original)()).toBe(712);
  });
  for (const target of ["host", "standalone"] as const)
    for (const utf8Storage of [false, true])
      for (const row of cases) {
        it(`${row.name},target=${target},utf8=${utf8Storage}`, async () => {
          const result = await compile(row.source, { target, experimentalIR: false, utf8Storage });
          expect(result.success, JSON.stringify(result.errors)).toBe(true);
          const module = new WebAssembly.Module(result.binary as BufferSource);
          if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
          // The literal's object is a native object on both targets since the native-first core (#6979); the
          // host target no longer builds it through `__defineProperty_accessor` / `__extern_set` imports, so the
          // answer, not those imports, is what is compared.
          for (let fresh = 0; fresh < 2; fresh++) {
            const expected = oracle(row.source);
            const imports = target === "host" ? buildImports(result.imports, undefined, result.stringPool) : undefined;
            const instance = new WebAssembly.Instance(module, imports ?? {});
            imports?.setInstance?.(instance);
            const run = instance.exports.run as () => number;
            expect(run()).toBe(expected());
            expect(run()).toBe(expected());
          }
        });
      }
});
