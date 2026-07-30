// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const CASES = [
  "built-ins/Array/prototype/filter/target-array-with-non-writable-property.js",
  "built-ins/Array/prototype/map/target-array-with-non-writable-property.js",
] as const;

async function runArgumentsProbe(target: "gc" | "standalone"): Promise<number> {
  const result: any = await compile(
    `
function inspect(a: any, b: any, c?: any, d?: any): number {
  return arguments.length * 10 + (arguments[2] === 7 ? 1 : 0);
}
export function test(): number {
  return inspect({}, 0, 7);
}
`,
    {
      fileName: "issue-3420-arguments-extras-offset.ts",
      target,
      skipSemanticDiagnostics: true,
    },
  );
  expect(result.success, result.errors?.map((error: any) => error.message).join("\n")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

describe("#3420 arguments extras offset", () => {
  for (const target of ["gc", "standalone"] as const) {
    it(`copies optional extras after the supplied formal prefix (${target})`, async () => {
      expect(await runArgumentsProbe(target)).toBe(31);
    });
  }

  for (const relativePath of CASES) {
    it(`passes the authoritative host case: ${relativePath}`, async () => {
      const result = await runTest262File(resolve("test262/test", relativePath), "issue-3420", 30_000);
      expect(result.status, result.error).toBe("pass");
    });
  }
});
