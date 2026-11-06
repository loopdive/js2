// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// (#6979) host-strings variant removed with the host-assisted profile: the
// cases that pinned the `wasm:js-string` intrinsic and the `env.string_*`
// general-path imports are gone. The UTF-16 behaviour check stays.

async function compileRun(source: string): Promise<() => number> {
  const result = await compile(source, {
    fileName: "host-string-prefix-suffix.ts",
    experimentalIR: false,
    optimize: 4,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => number>).run!;
}

describe("string prefix/suffix fixed needles", () => {
  it("compares UTF-16 code units and handles empty or longer needles", async () => {
    const run = await compileRun(`
      export function run(): number {
        const values: string[] = ["😀tail", "plain", "a longer suffix", ""];
        let count = 0;
        for (let i = 0; i < values.length; i = i + 1) {
          const value = values[i];
          if (value.startsWith("😀")) count = count + 1;
          if (value.endsWith("")) count = count + 2;
          if (value.endsWith("a longer suffix")) count = count + 4;
        }
        return count;
      }
    `);

    expect(run()).toBe(13);
  });
});
