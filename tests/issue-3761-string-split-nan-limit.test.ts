// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3761 — host String.prototype.split used NaN as the ABI sentinel for an
 * omitted limit. That made split(separator, NaN) indistinguishable from
 * split(separator), even though ToUint32(NaN) is 0 and the former must return
 * an empty array. The omitted-limit sentinel is now -1; ToUint32(-1) is the
 * same unbounded 2^32 - 1 limit, so the collision is behaviorally harmless.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, target?: "standalone"): Promise<number> {
  const result = await compile(`export function test(): number { ${source} }`, {
    fileName: "test.ts",
    target,
  });
  expect(result.success, result.errors?.[0]?.message ?? "compile failed").toBe(true);
  const imports = target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (target !== "standalone") {
    (imports as ReturnType<typeof buildImports>).setExports?.(instance.exports as WebAssembly.Exports);
  }
  return (instance.exports as { test(): number }).test();
}

describe("#3761 String.prototype.split NaN limit", () => {
  it("host: explicit NaN is ToUint32(NaN) = 0, not an omitted limit", async () => {
    expect(await run(`return "hello".split("l", NaN).length;`)).toBe(0);
  });

  it("host: an omitted limit remains unbounded", async () => {
    expect(await run(`return "hello".split("l").length;`)).toBe(3);
  });

  it("host: explicit -1 remains equivalent to the 2^32 - 1 limit", async () => {
    expect(await run(`return "hello".split("l", -1).length;`)).toBe(3);
  });

  it("standalone: explicit NaN remains an empty result", async () => {
    expect(await run(`return "hello".split("l", NaN).length;`, "standalone")).toBe(0);
  });
});
