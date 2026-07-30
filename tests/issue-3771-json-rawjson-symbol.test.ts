// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function compileStandalone(src: string) {
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3771 JSON.rawJSON Symbol ToString (standalone)", () => {
  it("throws TypeError for direct and representation-erased Symbol values", async () => {
    const exports = await compileStandalone(`
      function catchesTypeError(value: any): number {
        try {
          JSON.rawJSON(value);
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }

      export function direct(): number {
        return catchesTypeError(Symbol("123"));
      }

      export function erasedLocal(): number {
        const value: any = Symbol("123");
        return catchesTypeError(value);
      }

      export function erasedArrayRead(): number {
        const values: any[] = [Symbol("123")];
        return catchesTypeError(values[0]);
      }
    `);

    expect(exports.direct!()).toBe(1);
    expect(exports.erasedLocal!()).toBe(1);
    expect(exports.erasedArrayRead!()).toBe(1);
  });

  it("keeps non-Symbol validation behavior unchanged", async () => {
    const exports = await compileStandalone(`
      function catchesSyntaxError(value: any): number {
        try {
          JSON.rawJSON(value);
          return 0;
        } catch (error) {
          return error instanceof SyntaxError ? 1 : 2;
        }
      }

      export function undefinedValue(): number {
        return catchesSyntaxError(undefined);
      }

      export function objectValue(): number {
        return catchesSyntaxError({});
      }

      export function arrayValue(): number {
        return catchesSyntaxError([]);
      }

      export function validNumber(): number {
        return JSON.isRawJSON(JSON.rawJSON(123)) ? 1 : 0;
      }
    `);

    expect(exports.undefinedValue!()).toBe(1);
    expect(exports.objectValue!()).toBe(1);
    expect(exports.arrayValue!()).toBe(1);
    expect(exports.validNumber!()).toBe(1);
  });

  it("passes the exact Test262 regression", async () => {
    const result = await runTest262File(
      resolve("test262/test/built-ins/JSON/rawJSON/invalid-JSON-text.js"),
      "built-ins/JSON",
      30_000,
      "standalone",
    );
    expect(result.status, result.error).toBe("pass");
  });
});
