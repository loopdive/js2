// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

let instance: WebAssembly.Instance;
beforeAll(async () => {
  const result = await compileMulti(
    {
      "./entry.ts": `
        function rename(key:any) {
          return typeof key === "symbol"
            ? "Symbol" + key.description[7].toUpperCase() + key.description.slice(8)
            : key[0].toUpperCase() + key.slice(1);
        }
        export function symbolNames(index:number):number {
          const keys:any[]=["assign", "name", Symbol.iterator, Symbol.toStringTag, Symbol.species];
          return rename(keys[index]).length;
        }
        export function optional(index:number):number {
          const value:string|undefined=index===0 ? "abc" : undefined;
          try { return value[1].charCodeAt(0); }
          catch(error) { return error instanceof TypeError ? -1 : -2; }
        }
        export function mixed(index:number):number {
          const value:string|number[]=index===0 ? "abc" : [4,5];
          const first=value[0];
          return typeof first === "string" ? first.charCodeAt(0) : first;
        }
        export function bounds(index:number):number {
          const value:string|undefined=index>=0 ? "abc" : undefined;
          return value[index]===undefined ? 1 : 0;
        }
      `,
    },
    "./entry.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
});

it("dispatches optional symbol descriptions through Deno's key renaming helper", () => {
  const symbolNames = instance.exports.symbolNames as (index: number) => number;
  expect([0, 1, 2, 3, 4].map(symbolNames)).toEqual([6, 4, 14, 17, 13]);
});
it("throws TypeError for an undefined optional string instead of a Wasm trap", () => {
  const optional = instance.exports.optional as (index: number) => number;
  expect(optional(0)).toBe(98);
  expect(optional(1)).toBe(-1);
});
it("preserves the array alternative of a string union", () => {
  const mixed = instance.exports.mixed as (index: number) => number;
  expect(mixed(0)).toBe(97);
  expect(mixed(1)).toBe(4);
});
it("preserves bounds and canonical integer indexing for optional strings", () => {
  const bounds = instance.exports.bounds as (index: number) => number;
  expect(bounds(0)).toBe(0);
  expect(bounds(3)).toBe(1);
  expect(bounds(1.5)).toBe(1);
});
