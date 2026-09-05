// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 standalone own-descriptor pins for the two remaining built-in function
// properties: Function.prototype.constructor and the realm's eval binding.
// The Test262 rows assert the descriptor shape; the direct probe below adds
// non-vacuous identity/type witnesses so a null≡null implementation cannot
// silently satisfy the equality assertions.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const TARGET_ROWS = [
  "built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-34.js",
  "built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-4.js",
] as const;

describe("ES5 standalone getOwnPropertyDescriptor function properties", () => {
  it("keeps the eval provider demand-gated", async () => {
    const result = await compile(`export function plainGlobal(): boolean { return globalThis !== null; }`, {
      allowJs: true,
      fileName: "es5-standalone-gopd-demand.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(imports.some((entry) => entry.module === "js2wasm:runtime-eval")).toBe(false);
  });

  it("keeps both descriptor values real and identity-stable", async () => {
    const result = await compile(
      `
const functionDesc: any = Object.getOwnPropertyDescriptor(Function.prototype, "constructor");
const evalDesc: any = Object.getOwnPropertyDescriptor(globalThis, "eval");
export function functionLive(): boolean {
  return functionDesc !== null && typeof functionDesc.value === "function" &&
    functionDesc.value === Function.prototype.constructor && functionDesc.value === Function &&
    functionDesc.writable === true && functionDesc.enumerable === false && functionDesc.configurable === true;
}
export function evalLive(): boolean {
  return evalDesc !== null && typeof evalDesc.value === "function" &&
    evalDesc.value === globalThis.eval && evalDesc.value === eval &&
    evalDesc.writable === true && evalDesc.enumerable === false && evalDesc.configurable === true;
}
`,
      {
        allowJs: true,
        fileName: "es5-standalone-getownpropertydescriptor.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );
    expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
    const instance = await instantiateTest262Module(
      result.binary,
      {},
      {
        target: "standalone",
        providerLabel: "es5-standalone-gopd",
      },
    );
    const exports = instance.exports as { functionLive(): number; evalLive(): number };
    expect({ functionLive: exports.functionLive(), evalLive: exports.evalLive() }).toEqual({
      functionLive: 1,
      evalLive: 1,
    });
  });
});

describe.skipIf(!TEST262)("authoritative Test262 rows", () => {
  for (const rel of TARGET_ROWS) {
    it(`${rel} passes on standalone`, { timeout: 60_000 }, async () => {
      const result = await runTest262File(join(TEST262_ROOT, "test", rel), "es5-standalone-gopd", 30_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
