// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4449-controls.ts", target: "standalone" });
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#4449 TypedArray species lookup controls", () => {
  it("honors an own constructor shadow on a dynamic view", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(16);
          let answer = 0;
          for (const C of ctors) {
            const view: any = new C(buffer);
            view.constructor = 17;
            answer = view.constructor === 17 ? 1 : 0;
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("propagates an abrupt own constructor getter unchanged", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(16);
          let answer = 0;
          for (const C of ctors) {
            const view: any = new C(buffer);
            Object.defineProperty(view, "constructor", { get: function(): any { throw 73; } });
            try { view.constructor; } catch (error) { answer = error === 73 ? 1 : 2; }
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("walks the selected prototype for an inherited constructor getter", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          Object.defineProperty(Int32Array.prototype, "constructor", {
            get: function(): any { return 91; }, configurable: true
          });
          const buffer = new ArrayBuffer(16);
          let answer = 0;
          for (const C of ctors) {
            const view: any = new C(buffer);
            answer = view.constructor === 91 ? 1 : 0;
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("reads an own Symbol.species value after the constructor shadow", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(16);
          let answer = 0;
          for (const C of ctors) {
            const view: any = new C(buffer);
            const constructorObject: any = {};
            view.constructor = constructorObject;
            constructorObject[Symbol.species] = 123;
            answer = view.constructor[Symbol.species] === 123 ? 1 : 0;
          }
          return answer;
        }
      `),
    ).toBe(1);
  });

  it("propagates an abrupt Symbol.species getter unchanged", async () => {
    expect(
      await run(`
        export function test(): number {
          const ctors: any[] = [Int32Array];
          const buffer = new ArrayBuffer(16);
          let answer = 0;
          for (const C of ctors) {
            const view: any = new C(buffer);
            const constructorObject: any = {};
            view.constructor = constructorObject;
            Object.defineProperty(constructorObject, Symbol.species,
              { get: function(): any { throw 79; } });
            try { view.constructor[Symbol.species]; } catch (error) { answer = error === 79 ? 1 : 2; }
          }
          return answer;
        }
      `),
    ).toBe(1);
  });
});
