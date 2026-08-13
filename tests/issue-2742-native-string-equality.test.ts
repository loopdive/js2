// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2742 — String results that reach equality through a dynamic carrier still
 * obey JavaScript String value equality. In standalone mode both `$AnyValue`
 * and `$AnyString` are WasmGC refs; their carrier identity is not observable.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const ES5_STRING_EQUALITY_FILES = [
  "built-ins/String/prototype/charAt/S15.5.4.4_A1_T1.js",
  "built-ins/String/prototype/charAt/S15.5.4.4_A1_T2.js",
  "built-ins/String/prototype/slice/S15.5.4.13_A3_T3.js",
  "built-ins/String/prototype/toLowerCase/S15.5.4.16_A1_T3.js",
  "built-ins/String/prototype/toUpperCase/S15.5.4.18_A1_T3.js",
] as const;

async function compileStandalone(source: string) {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2742 — standalone native String value equality", () => {
  it.each(ES5_STRING_EQUALITY_FILES)("passes the exact ES5 Test262 row %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "String.prototype", 20_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });

  it("compares an inline borrowed-method concatenation by value in both operand orders", async () => {
    expect(
      await runStandalone(`
        var receiver = new Boolean();
        receiver.charAt = String.prototype.charAt;
        export function test(): number {
          return receiver.charAt(false) + receiver.charAt(true) + receiver.charAt(true + 1) === "fal" &&
            "fal" === receiver.charAt(false) + receiver.charAt(true) + receiver.charAt(true + 1) &&
            receiver.charAt(false) + receiver.charAt(true) !== "fail" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps dynamic String concatenation and equality genuinely IR-emitted", async () => {
    const result = await compileStandalone(`
      function identity(value: any): any { return value; }
      export function test(): number {
        return identity("f") + identity("a") + identity("l") === "fal" ? 1 : 0;
      }
    `);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["identity", "test"]));
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
