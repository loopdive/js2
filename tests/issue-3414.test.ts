// #3414 — a bare TypedArray constructor used as a top-level value in the
// literal Test262 harness must cross the host boundary as the real constructor,
// not null, before Object.getPrototypeOf observes it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { createTestSandbox } from "./test262-runner.js";

async function compileAndInitialize(source: string): Promise<WebAssembly.Instance> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    emitWat: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success).toBe(true);
  expect(WebAssembly.validate(result.binary), result.wat).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool, {
    globalSandbox: createTestSandbox(),
  });
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance;
}

function typedArrayHarnessPrefix(): string {
  const root = join(import.meta.dirname, "..", "test262", "harness");
  return [
    readFileSync(join(root, "testTypedArray.js"), "utf8"),
    readFileSync(join(root, "propertyHelper.js"), "utf8"),
    readFileSync(join(import.meta.dirname, "..", "scripts", "test262-fyi-runtime.js"), "utf8"),
    readFileSync(join(root, "assert.js"), "utf8"),
    readFileSync(join(root, "sta.js"), "utf8"),
  ].join("\n");
}

describe("#3414 top-level TypedArray constructor values", () => {
  it("initializes Object.getPrototypeOf(Int8Array)", async () => {
    await expect(
      compileAndInitialize(`
        var TypedArray = Object.getPrototypeOf(Int8Array);
      `),
    ).resolves.toBeDefined();
  });

  it("keeps the constructor when the original-harness runtime shim is present", async () => {
    const runtime = readFileSync(join(import.meta.dirname, "..", "scripts", "test262-fyi-runtime.js"), "utf8");
    await expect(
      compileAndInitialize(`
        var TypedArray = Object.getPrototypeOf(Int8Array);
        ${runtime}
      `),
    ).resolves.toBeDefined();
  });

  it("initializes the prefix with the property-verification call", async () => {
    await expect(
      compileAndInitialize(`${typedArrayHarnessPrefix()}
        verifyProperty(TypedArray.prototype.with, "length", {
          value: 2,
          writable: false,
          enumerable: false,
          configurable: true
        });
      `),
    ).resolves.toBeDefined();
  });
});
