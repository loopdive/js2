// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4449-producers.ts", target: "standalone" });
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#4449 dynamic TypedArray species producers", () => {
  it("map runs only the TypedArray custom species and writes its result", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(16);
          let calls = 0;
          let other: any;
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            holder[Symbol.species] = function(count: number): any {
              calls++;
              other = new C(count);
              return other;
            };
            sample.constructor = holder;
            sample[0] = 40;
            sample[1] = 41;
            const result: any = sample.map(function(value: number): number { return value + 7; });
            answer = calls * 1000 + (result === other ? 100 : 0) + result[0] + result[1];
          }
          return answer;
        }
      `),
    ).toBe(1195);
  });

  it("map defaults nullish species to the published original constructor", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(8);
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            sample.constructor = holder;
            const result: any = sample.map(function(value: number): number { return value + 1; });
            answer = (result.constructor === C ? 1 : 0) * 10 + result[0];
            holder[Symbol.species] = null;
            const result2: any = sample.map(function(value: number): number { return value + 2; });
            answer += (result2.constructor === C ? 1 : 0) * 100 + result2[0];
          }
          return answer;
        }
      `),
    ).toBe(113);
  });

  it("map propagates an abrupt species getter", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(8);
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            sample.constructor = holder;
            Object.defineProperty(holder, Symbol.species, { get: function(): any { throw 79; } });
            try { sample.map(function(value: number): number { return value; }); }
            catch (error) { answer = error === 79 ? 1 : 2; }
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("map rejects a custom result shorter than the requested length", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(12);
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            holder[Symbol.species] = function(): any { return new C(1); };
            sample.constructor = holder;
            try { sample.map(function(value: number): number { return value; }); }
            catch (error) { answer = error instanceof TypeError ? 1 : 2; }
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("filter constructs the custom species and copies selected values", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(12);
          let calls = 0;
          let other: any;
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            holder[Symbol.species] = function(count: number): any {
              calls++;
              other = new C(count);
              return other;
            };
            sample.constructor = holder;
            sample[0] = 1;
            sample[1] = 2;
            sample[2] = 3;
            const result: any = sample.filter(function(value: number): boolean { return value >= 2; });
            answer = calls * 1000 + (result === other ? 100 : 0) + result[0] + result[1];
          }
          return answer;
        }
      `),
    ).toBe(1105);
  });

  it("slice constructs the custom species and copies the window", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(12);
          let calls = 0;
          let other: any;
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            holder[Symbol.species] = function(count: number): any {
              calls++;
              other = new C(count);
              return other;
            };
            sample.constructor = holder;
            sample[0] = 10;
            sample[1] = 20;
            sample[2] = 30;
            const result: any = sample.slice(1, 3);
            answer = calls * 1000 + (result === other ? 100 : 0) + result[0] + result[1];
          }
          return answer;
        }
      `),
    ).toBe(1150);
  });

  it("subarray constructs the custom species over the shared buffer", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(12);
          let calls = 0;
          let other: any;
          let answer = 0;
          for (const C of ctors) {
            const sample: any = new C(buffer);
            const holder: any = {};
            holder[Symbol.species] = function(bufferArg: any, offset: number, length: number): any {
              calls++;
              other = new C(bufferArg, offset, length);
              return other;
            };
            sample.constructor = holder;
            sample[0] = 10;
            sample[1] = 20;
            sample[2] = 30;
            const result: any = sample.subarray(1, 3);
            answer = calls * 1000 + (result === other ? 100 : 0) + result[0] + result[1];
          }
          return answer;
        }
      `),
    ).toBe(1150);
  });

  it("keeps #5145 Array species active for an ordinary array map", async () => {
    expect(
      await run(`
        export function test(): number {
          const input: number[] = [2, 3];
          const holder: any = {};
          let calls = 0;
          let target: any = null;
          holder[Symbol.species] = function(count: number): any {
            calls++;
            target = {};
            return target;
          };
          (input as any).constructor = holder;
          const result: any = input.map(function(value: number): number { return value + 1; });
          return calls * 100 + (result === target ? 10 : 0) + result[0] + result[1];
        }
      `),
    ).toBe(117);
  });
});
