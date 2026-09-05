// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The upstream ES5 row is intentionally pinned here because it exercises the
// native realm object through the same concrete string-vector path used by the
// standalone runner. The literal upstream harness currently has an unrelated
// compiler-shape failure, so the runner's synthetic mode is the executable
// permanent pin for this exact source row.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runSyntheticTest262File } from "./test262-runner.js";

const ROW = resolve("test262/test/built-ins/Object/getOwnPropertyNames/15.2.3.4-4-1.js");

async function runStandalone(source: string): Promise<Record<string, () => unknown>> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, () => unknown>;
}

describe("ES5 global Object.getOwnPropertyNames standalone row", () => {
  it("passes the exact upstream 15.2.3.4-4-1 source", async () => {
    const result = await runSyntheticTest262File(ROW, "es5-global-gopn", 30_000, "standalone");
    expect(result.status, result.reason ?? result.error).toBe("pass");
    expect(result.wasm_sha).toBeTruthy();
  }, 40_000);

  it("keeps for-in string keys dynamic for concrete string vectors", async () => {
    const exports = await runStandalone(`
      export function test(): number {
        const names: string[] = ["NaN", "Infinity"];
        let found = 0;
        for (var p in names) {
          if (p === "0" && names[p] === "NaN") found += 1;
          if (p === "1" && names[p] === "Infinity") found += 1;
        }
        return found;
      }
    `);
    expect(exports.test!()).toBe(2);
  });

  it("owns the added global names with builtin descriptor flags", async () => {
    const exports = await runStandalone(`
      export function test(): number {
        const evalDesc: any = Object.getOwnPropertyDescriptor(globalThis, "eval");
        const functionDesc: any = Object.getOwnPropertyDescriptor(globalThis, "Function");
        return evalDesc !== undefined && functionDesc !== undefined &&
          evalDesc.writable && !evalDesc.enumerable && evalDesc.configurable &&
          functionDesc.writable && !functionDesc.enumerable && functionDesc.configurable ? 1 : 0;
      }
    `);
    expect(exports.test!()).toBe(1);
  });
});
