// #3415 — runtime-generated strict-set failures must use the active Test262
// sandbox's TypeError constructor so the upstream `instanceof TypeError` check
// observes the correct realm identity.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { join } from "node:path";
import { createTestSandbox, runTest262File } from "./test262-runner.js";

describe("#3415 sandbox-realm runtime errors", () => {
  it("catches a strict read-only write as the sandbox TypeError", async () => {
    const result = await compile(
      `
      function isWritable(target, key) {
        "use strict";
        try {
          target[key] = "unlikelyValue";
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
        return 0;
      }
      export function test() {
        var TypedArray = Object.getPrototypeOf(Int8Array);
        return isWritable(TypedArray.prototype.copyWithin, "name");
      }
    `,
      { allowJs: true, fileName: "test.js", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const sandbox = createTestSandbox();
    const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);

    expect((instance.exports as { test?: () => number }).test?.()).toBe(1);
  });

  it("passes the literal strict-rerun propertyHelper probe", async () => {
    const path = join(
      import.meta.dirname,
      "..",
      "test262",
      "test",
      "built-ins",
      "TypedArray",
      "prototype",
      "copyWithin",
      "name.js",
    );
    const result = await runTest262File(path, "built-ins/TypedArray");
    expect(result.status, result.error).toBe("pass");
  });
});
