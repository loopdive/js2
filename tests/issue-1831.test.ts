// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, { fileName: "issue-1831.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: () => number }).test();
}

describe("#1831 partial redefine preserves omitted descriptor attributes", () => {
  it("preserves previously true attributes on descriptor readback", async () => {
    expect(
      await run(`
        export function test(): number {
          const o = { k: 1 };
          Object.defineProperty(o, "k", { value: 1, enumerable: true, writable: true, configurable: true });
          Object.defineProperty(o, "k", { value: 5 });
          const d: any = Object.getOwnPropertyDescriptor(o, "k");
          if (d === undefined) return 100;
          if (d.value !== 5) return 101;
          if (d.writable !== true) return 102;
          if (d.enumerable !== true) return 103;
          if (d.configurable !== true) return 104;
          return Object.keys(o).length === 1 ? 0 : 105;
        }
      `),
    ).toBe(0);
  });

  it("preserves default attributes when redefining an existing struct field", async () => {
    expect(
      await run(`
        export function test(): number {
          const o = { k: 1 };
          Object.defineProperty(o, "k", { value: 5 });
          const d: any = Object.getOwnPropertyDescriptor(o, "k");
          if (d === undefined) return 100;
          if (d.value !== 5) return 101;
          if (d.writable !== true) return 102;
          if (d.enumerable !== true) return 103;
          return d.configurable === true ? 0 : 104;
        }
      `),
    ).toBe(0);
  });

  it("keeps an explicitly non-enumerable field hidden across a partial redefine", async () => {
    expect(
      await run(`
        export function test(): number {
          const o = { k: 1 };
          Object.defineProperty(o, "k", { value: 1, enumerable: false, configurable: true });
          Object.defineProperty(o, "k", { value: 5 });
          return Object.keys(o).length;
        }
      `),
    ).toBe(0);
  });

  it("still defaults omitted attributes to false for a new property", async () => {
    expect(
      await run(`
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "k", { value: 7 });
          const d: any = Object.getOwnPropertyDescriptor(o, "k");
          if (d === undefined) return 100;
          if (d.value !== 7) return 101;
          if (d.writable !== false) return 102;
          if (d.enumerable !== false) return 103;
          return d.configurable === false ? 0 : 104;
        }
      `),
    ).toBe(0);
  });
});
