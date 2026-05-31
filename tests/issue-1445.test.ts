// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1445 — String.prototype.* argument coercion (ToInteger / ToLength).
 *
 * Per ECMA-262 §7.1.4 ToNumber, invoking ToNumber on a BigInt or Symbol throws
 * TypeError. String.prototype methods that take numeric arguments
 * (charAt, indexOf, slice, padStart, repeat, …) feed those args through
 * ToInteger / ToLength (both of which call ToNumber). Previously the compiler
 * silently converted BigInt → f64 via `f64.convert_i64_s`, returning a numeric
 * result instead of throwing.
 *
 * This fix emits an explicit `__throw_type_error` host import call when the
 * static TS type of a ToInteger-coerced argument is `bigint` or `symbol`,
 * propagating the abrupt completion to the test262 `assert.throws(TypeError, …)`
 * harness.
 *
 * Test262 cases this targets:
 *   built-ins/String/prototype/indexOf/position-tointeger-bigint.js
 *   built-ins/String/prototype/indexOf/position-tointeger-errors.js
 *   built-ins/String/prototype/charAt/pos-coerce-err.js (BigInt path)
 *   built-ins/String/prototype/{slice,substring,padStart,padEnd,repeat}/...
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWasm, buildImports as buildRuntimeImports } from "../src/runtime.js";
import { buildImports, compileToWasm } from "./equivalence/helpers.js";

/**
 * Compile + instantiate with `skipSemanticDiagnostics: true` so the test
 * body can pass BigInt literals to `String.prototype` methods (which the TS
 * checker rejects as `bigint` not assignable to `number`). Test262 runs in
 * the same mode — see `tests/test262-runner.ts`.
 */
async function compileLoose(source: string) {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const manualImports = buildImports(result);
  if (result.imports && result.imports.length > 0) {
    const runtimeResult = buildRuntimeImports(result.imports, undefined, result.stringPool);
    const mergedEnv = { ...(manualImports.env as Record<string, Function>), ...runtimeResult.env };
    manualImports.env = mergedEnv;
    if (runtimeResult.string_constants) manualImports.string_constants = runtimeResult.string_constants;
  }
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    manualImports.env as Record<string, Function>,
    manualImports.string_constants as Record<string, WebAssembly.Global>,
  );
  return instance.exports;
}

async function runThrows(src: string, expectedCtor: string): Promise<boolean> {
  const exports = await compileLoose(src);
  try {
    (exports.test as () => unknown)();
    return false;
  } catch (e) {
    return (e as Error)?.constructor?.name === expectedCtor;
  }
}

async function runValue(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

describe("#1445 — String.prototype numeric-arg ToInteger coercion", () => {
  describe("BigInt argument → TypeError (ToNumber on BigInt)", () => {
    it("indexOf(search, 0n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "".indexOf("", 0n); return 0; }`, "TypeError")).toBe(true);
    });

    it("charAt(0n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "x".charAt(0n); return 0; }`, "TypeError")).toBe(true);
    });

    it("padStart(5n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "x".padStart(5n); return 0; }`, "TypeError")).toBe(true);
    });

    it("padEnd(5n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "x".padEnd(5n); return 0; }`, "TypeError")).toBe(true);
    });

    it("repeat(2n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "x".repeat(2n); return 0; }`, "TypeError")).toBe(true);
    });

    it("substring(0n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "abc".substring(0n); return 0; }`, "TypeError")).toBe(true);
    });

    it("slice(0n) throws TypeError", async () => {
      expect(await runThrows(`export function test() { "abc".slice(0n); return 0; }`, "TypeError")).toBe(true);
    });
  });

  describe("Numeric args still work normally", () => {
    it("indexOf finds char", async () => {
      expect(await runValue(`export function test() { return "abc".indexOf("b"); }`)).toBe(1);
    });

    it("charAt(NaN) returns first char", async () => {
      expect(await runValue(`export function test() { return "abc".charAt(NaN); }`)).toBe("a");
    });

    it("charAt(Infinity) returns empty string", async () => {
      expect(await runValue(`export function test() { return "abc".charAt(Infinity); }`)).toBe("");
    });

    it("repeat(NaN) returns empty string", async () => {
      expect(await runValue(`export function test() { return "x".repeat(NaN); }`)).toBe("");
    });

    it("padStart with number works", async () => {
      expect(await runValue(`export function test() { return "x".padStart(3, "0"); }`)).toBe("00x");
    });

    it("slice with negative index works", async () => {
      expect(await runValue(`export function test() { return "abc".slice(-2); }`)).toBe("bc");
    });
  });
});
