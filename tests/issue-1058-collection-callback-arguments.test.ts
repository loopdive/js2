// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

it.each([false, true])("passes collection callback surplus arguments (source factory: %s)", async (factory) => {
  const source = factory
    ? `
    function createSet(value: number): Set<number> {
      const set = {
        get size() { return 1; },
        forEach(action: (value: number, key: number, owner: Set<number>) => void): void { action(value, value, set); }
      } as Set<number>;
      return set;
    }
    export function run(): number {
      const owner = createSet(7);
      let total = 0;
      owner.forEach(value => { total += value; });
      return total;
    }
  `
    : `
    function visit(action: (value: number, key: number, owner: Set<number>) => void, owner: Set<number>) {
      action(7, 7, owner);
    }
    export function run(): number {
      const owner = new Set<number>();
      let total = 0;
      visit(value => { total += value; }, owner);
      return total;
    }
  `;
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(7);
});

it.each(["number", "any", "boolean"])(
  "calls a later-module %s callback through erased generic arguments",
  async (annotation) => {
    const result = await compileMulti(
      {
        "./visit.ts": `
      export function createSet<T, H>(hash: (value: T) => H, equal: (a: T, b: T) => boolean): Set<T> {
        let last: T;
        const set: Set<T> = {
          get size() { return 1; },
          add(value: T): Set<T> { last = value; return this; },
          forEach(action: (value: T, key: T, owner: Set<T>) => void): void { action(last, last, set); }
        };
        return set;
      }
    `,
        "./entry.ts": `
      import { createSet } from "./visit.js";
      export function run(): number {
        let total = 0;
        const set = createSet<${annotation === "boolean" ? "boolean" : "number"}, number>(x => 1, (a,b) => a === b);
        set.add(${annotation === "boolean" ? "true" : "7"});
        set.forEach((value: ${annotation}) => { total += ${annotation === "boolean" ? "value ? 7 : 0" : "value"}; });
        return total;
      }
    `,
      },
      "./entry.ts",
      { target: "standalone" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    expect((instance.exports.run as () => number)()).toBe(7);
  },
);
