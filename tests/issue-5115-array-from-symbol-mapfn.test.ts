// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5115 — standalone Array.from must reject a Symbol mapper.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_ROW = "built-ins/Array/from/mapfn-is-symbol-throws.js";
const hasTest262Corpus = existsSync(join(process.cwd(), "test262/harness/assert.js"));
const corpusIt = hasTest262Corpus ? it : it.skip;

const CONTROL_SOURCE = `
  export function test(): number {
    let thisArgEvaluations = 0;
    try {
      Array.from([], Symbol("mapper"), thisArgEvaluations++);
      return 0;
    } catch (error) {
      const mapped: any = Array.from([1, 2], (value: number, index: number) => value + index);
      return thisArgEvaluations === 1 && mapped.length === 2 && mapped[0] === 1 && mapped[1] === 3 ? 1 : 2;
    }
  }
`;

const HOST_CONTROL_SOURCE = `
  export function test(): number {
    try {
      Array.from([], Symbol("mapper"));
      return 0;
    } catch {
      return 1;
    }
  }
`;

async function runControl(target: "host" | "standalone"): Promise<{ result: number; imports: string[] }> {
  const compiled = await compile(target === "standalone" ? CONTROL_SOURCE : HOST_CONTROL_SOURCE, {
    allowJs: true,
    fileName: "issue-5115-array-from-symbol-mapfn.ts",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(compiled.success, compiled.errors?.map((error) => error.message).join("\n") ?? "").toBe(true);
  if (!compiled.success) return { result: -1, imports: [] };

  const module = await WebAssembly.compile(compiled.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  const instance = await WebAssembly.instantiate(
    module,
    target === "standalone" ? {} : buildImports(compiled.imports, undefined, compiled.stringPool),
  );
  const result = (instance.exports as { test: () => number }).test();
  return { result, imports };
}

describe("#5115 standalone Array.from Symbol mapper guard", () => {
  corpusIt("passes the exact Test262 row in the host lane", { timeout: 180_000 }, async () => {
    const result = await runTest262File(resolve("test262/test", EXACT_ROW), "issue-5115-host", 120_000);
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  corpusIt("passes the exact Test262 row in standalone", { timeout: 180_000 }, async () => {
    const result = await runTest262File(
      resolve("test262/test", EXACT_ROW),
      "issue-5115-standalone",
      120_000,
      "standalone",
    );
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("throws after evaluating thisArg and preserves callable mapping without host imports", async () => {
    const outcome = await runControl("standalone");
    expect(outcome.result).toBe(1);
    expect(outcome.imports).toEqual([]);
  });

  it("preserves the host Array.from mapper behavior", async () => {
    const outcome = await runControl("host");
    expect(outcome.result).toBe(1);
  });
});
