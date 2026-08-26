// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
  var fallbackCalls4755: number = 0;
  var completedWrites4755: number = 0;
  var verdict4755: number = 0;
  function fallback4755(): number { fallbackCalls4755 += 1; return 41; }
  function assign4755(useDefault: number): number {
    const input: { first: any } = { first: useDefault ? undefined : 7 };
    ({ first: target4755 = fallback4755() } = input);
    completedWrites4755 += 1;
    return target4755;
  }
  try { assign4755(1); }
  catch (error) { verdict4755 = error instanceof ReferenceError ? 1 : 2; }
  let target4755: number;
  export function run(): number {
    const value4755 = assign4755(0);
    var score4755: number = 0;
    if (verdict4755 === 1) score4755 += 1;
    if (fallbackCalls4755 === 1) score4755 += 2;
    if (completedWrites4755 === 1) score4755 += 4;
    if (value4755 === 7) score4755 += 8;
    if (target4755 === 7) score4755 += 16;
    return score4755;
  }
`;

async function run(result: CompileResult, target: "gc" | "standalone"): Promise<number> {
  if (target === "standalone") {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "--input-type=module",
        "--eval",
        `const chunks=[]; for await (const c of process.stdin) chunks.push(c);
         const { instance } = await WebAssembly.instantiate(Buffer.concat(chunks), {});
         if (typeof instance.exports.__module_init === "function") instance.exports.__module_init();
         process.stdout.write(String(instance.exports.run()));`,
      ],
      { input: result.binary, encoding: "utf8" },
    );
    expect(child.status, child.stderr || child.error?.message).toBe(0);
    return Number(child.stdout);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports);
  if (typeof instance.exports.__module_init === "function") instance.exports.__module_init();
  return (instance.exports.run as () => number)();
}

describe.each(["gc", "standalone"] as const)("#4755 detached assignment repoint — %s", (target) => {
  it("keeps the default arm live while the value arm registers a later coercion helper", async () => {
    const result = await compile(SOURCE, {
      fileName: `issue-4755-detached-assignment-repoint-${target}.ts`,
      deferTopLevelInit: true,
      experimentalIR: false,
      emitWat: true,
      skipSemanticDiagnostics: true,
      target,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("fallback4755");
    expect(result.wat).toContain("__unbox_number");
    expect(result.wat).toMatch(/ReferenceError/);
    expect(await run(result, target)).toBe(31);
  });
});
