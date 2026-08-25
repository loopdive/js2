// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2668) A descriptor-overlay mutation can make a typed-looking indexed
// read undefined at runtime. `typeof a[i]` must observe that value instead of
// folding from the checker-visible element type.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
  if (!result.success) return 0;
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as Record<string, () => number>).test!();
}

describe("#2668 — standalone typeof observes descriptor-overlay indexed reads", () => {
  it("reports undefined after deleting an Object.keys result element", async () => {
    await expect(
      run(`
        const array = Object.keys({ prop1: 100 });
        delete array[0];
        export function test(): number {
          return typeof array[0] === "undefined" ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("keeps the ordinary typed typeof result when no overlay mutation occurs", async () => {
    await expect(
      run(`
        const array = ["value"];
        export function test(): number {
          return typeof array[0] === "string" ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });
});
