// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each([false, true])("reads qualified namespace functions and live values (barrel=%s)", async (barrel) => {
  const result = await compileMulti(
    {
      "./debug.ts": `
      export namespace Debug {
        export let enabled = true;
        export function format(value: number): string { return enabled ? "Kind" + value : "off"; }
        export function disable() { enabled = false; }
      }
    `,
      "./barrel.ts": 'export * from "./debug.js";',
      "./entry.ts": `
      import * as ts from "./${barrel ? "barrel" : "debug"}.js";
      let stage = 0;
      export function getStage(): number { return stage; }
      export function run(): number {
        stage = 1;
        const format = ts.Debug.format;
        stage = 2;
        if (format(7) !== "Kind7") return -1;
        stage = 3;
        if (ts.Debug.format(8) !== "Kind8") return -1;
        stage = 4;
        if (!ts.Debug.enabled) return -2;
        stage = 5;
        ts.Debug.disable();
        stage = 6;
        return !ts.Debug.enabled && format(9) === "off" ? 1 : -3;
      }
    `,
    },
    "./entry.ts",
    { target: "standalone" },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  let value: number;
  try {
    value = (instance.exports.run as () => number)();
  } catch {
    throw new Error(`Failed at stage ${(instance.exports.getStage as () => number)()}`);
  }
  expect(value).toBe(1);
});
