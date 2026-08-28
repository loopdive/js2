// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_ROW = "built-ins/Set/prototype/forEach/callback-not-callable-symbol.js";

async function runControl(target: "host" | "standalone"): Promise<{ result: number; setForEachImports: number }> {
  const source = `
    export function test(): number {
      const set = new Set([1]);
      try {
        set.forEach(Symbol());
        return 0;
      } catch (error) {
        let sum = 0;
        set.forEach((value) => {
          sum += value;
        });
        return sum === 1 ? 1 : 2;
      }
    }
  `;
  const options = target === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {};
  const compiled = await compile(source, {
    fileName: "issue-5091-set-foreach-symbol.ts",
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(compiled.success, compiled.errors?.map((error) => error.message).join("\n") ?? "").toBe(true);
  if (!compiled.success) return { result: -1, setForEachImports: -1 };

  const module = await WebAssembly.compile(compiled.binary);
  const setForEachImports = WebAssembly.Module.imports(module).filter(
    (entry) => entry.module === "env" && entry.name === "Set_forEach",
  ).length;
  const imports = target === "host" ? buildImports(compiled.imports, undefined, compiled.stringPool) : {};
  const instance = await WebAssembly.instantiate(module, imports);
  imports.setInstance?.(instance);
  const result = (instance.exports as { test: () => number }).test();
  return { result, setForEachImports };
}

describe("#5091 Set.prototype.forEach(Symbol()) callback guard", () => {
  it("passes the exact Test262 row in the host lane", { timeout: 180_000 }, async () => {
    const outcome = await runTest262File(resolve("test262/test", EXACT_ROW), "issue-5091-host", 120_000);
    expect(outcome.status, outcome.error ?? outcome.reason).toBe("pass");
  });

  it("passes the exact Test262 row in standalone", { timeout: 180_000 }, async () => {
    const outcome = await runTest262File(
      resolve("test262/test", EXACT_ROW),
      "issue-5091-standalone",
      120_000,
      "standalone",
    );
    expect(outcome.status, outcome.error ?? outcome.reason).toBe("pass");
  });

  it("throws natively without a Set_forEach host import in standalone", async () => {
    const outcome = await runControl("standalone");
    expect(outcome).toEqual({ result: 1, setForEachImports: 0 });
  });

  it("preserves the host Set.forEach TypeError behavior", async () => {
    const outcome = await runControl("host");
    expect(outcome.result).toBe(1);
  });
});
