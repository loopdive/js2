// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("keeps an accessor-bearing object's generator method lazy and iterable", async () => {
  const result = await compile(
    `
    export function run(): number {
      let steps = 0;
      const offset = 7;
      function* values() { yield offset; yield offset + 1; }
      const object = {
        get size() { return steps; },
        *entries() {
          for (const value of values()) {
            steps++;
            yield [value, value];
          }
        }
      };
      const iterator = object.entries();
      if (steps !== 0) return -1;
      const first = iterator.next();
      if (first.done || first.value[0] !== 7 || steps !== 1) return -2;
      const second = iterator.next();
      if (second.done || second.value[1] !== 8 || steps !== 2) return -3;
      return iterator.next().done ? 1 : -4;
    }
  `,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});

it("preserves the open method receiver across lazy resumptions", async () => {
  const result = await compile(
    `
    export function run(): number {
      const object = {
        value: 7,
        get size() { return this.value; },
        *values() { yield this.value; yield this.value; }
      };
      const iterator = object.values();
      const other = { value: 99, read() { return this.value; } };
      other.read();
      if (iterator.next().value !== 7) return -1;
      object.value = 9;
      other.read();
      if (iterator.next().value !== 9) return -2;
      return iterator.next().done ? 1 : -3;
    }
  `,
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
