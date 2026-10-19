// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const SOURCE = `
type RecordValue={value:number};
export function make(value:number):RecordValue{return {value};}
export function eq(a:RecordValue,b:RecordValue):number{return a===b?1:0;}
export function ne(a:RecordValue,b:RecordValue):number{return a!==b?1:0;}
export function looseEq(a:RecordValue,b:RecordValue):number{return a==b?1:0;}
export function looseNe(a:RecordValue,b:RecordValue):number{return a!=b?1:0;}
export function run(value:number):number{
 const a={value};const b={value};
 return eq(a,a)+2*eq(a,b)+4*ne(a,b)+8*looseEq(a,a)+16*looseNe(a,b);
}
`;

for (const target of ["standalone", "wasi", "gc"] as const) {
  describe(`IR native object identity (${target})`, () => {
    let result: Awaited<ReturnType<typeof compile>>;
    let ex: Record<string, (...args: any[]) => any>;
    beforeAll(async () => {
      result = await compile(SOURCE, { target, experimentalIR: true, trackIrOutcomes: true });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      if (target === "gc") {
        const imports = buildCompiledImports(result);
        const instance = new WebAssembly.Instance(module, imports);
        imports.setInstance?.(instance);
        ex = wrapCompiledExports(result, instance) as typeof ex;
      } else {
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        ex = new WebAssembly.Instance(module, {}).exports as typeof ex;
      }
    });
    for (const name of ["eq", "ne", "looseEq", "looseNe"]) {
      it(`actually emits the ${name} source body through IR`, () => {
        expect(result.irCompiledFuncs).toContain(name);
        const row = result.irOutcomes!.find((o) => o.displayName === name)!;
        expect(row).toMatchObject({ kind: "emitted", irBodyEmitted: true });
        // IR emission alone does not prove prepared ownership. Its actual
        // direct/IR counters are recorded separately, not pinned as a required fallback.
      });
    }
    for (const value of [0, 1, 41, NaN]) {
      it(`compares native aliases rather than record contents (${value})`, () => {
        expect(ex.run!(value)).toBe(29);
      });
    }
    if (target === "gc") {
      for (const [name, same, different] of [
        ["eq", 1, 0],
        ["ne", 0, 1],
        ["looseEq", 1, 0],
        ["looseNe", 0, 1],
      ] as const) {
        it(`preserves native facade identity through ${name}`, () => {
          const a = ex.make!(41),
            b = ex.make!(41);
          expect(ex[name]!(a, a)).toBe(same);
          expect(ex[name]!(a, b)).toBe(different);
        });
        it(`classifies nullable ABI values honestly through ${name}`, () => {
          const a = ex.make!(41);
          expect(ex[name]!(null, null)).toBe(same);
          expect(ex[name]!(a, null)).toBe(different);
        });
      }
    }
  });
}
