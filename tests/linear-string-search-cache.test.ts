// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileLinear(source: string, allocator?: "arena-reset") {
  const result = await compile(source, { target: "linear", allocator });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { result, exports: instance.exports as Record<string, CallableFunction> };
}

describe("linear string search and literal caching", () => {
  it("materializes each immutable literal once and invalidates caches on arena reset", async () => {
    const { result, exports } = await compileLinear(
      `
        export function first(): number { return "cached".length; }
        export function second(): number { return "different literal".length; }
      `,
      "arena-reset",
    );
    const used = exports.__arena_used as () => number;
    const reset = exports.__arena_reset as () => void;

    expect(result.wat).toContain("__str_literal_cache_");
    expect(used()).toBe(0);
    expect(exports.first()).toBe(6);
    const afterFirstUse = used();
    expect(afterFirstUse).toBeGreaterThan(0);
    expect(exports.first()).toBe(6);
    expect(used()).toBe(afterFirstUse);

    reset();
    expect(used()).toBe(0);
    expect(exports.second()).toBe(17); // Reuses the first arena address.
    expect(exports.first()).toBe(6); // Must rematerialize, not read the overwritten record.
  });

  it("folds bounded literal repeat and searches from an ASCII position", async () => {
    const { exports } = await compileLinear(`
      export function run(): number {
        const text = "abc".repeat(4);
        let score = text.indexOf("bc", 4) * 100;
        if (text.includes("bc", 4)) score = score + 10;
        if (text.includes("zz")) score = score + 1;
        return score;
      }
    `);
    expect(exports.run()).toBe(410);
  });

  it("handles allocation-free includes and endsWith over UTF-8 strings", async () => {
    const { exports } = await compileLinear(`
      export function run(): number {
        const text = "naïve🚀";
        let score = 0;
        if (text.includes("ïve")) score = score + 100;
        if (text.endsWith("🚀")) score = score + 10;
        if (text.endsWith("na")) score = score + 1;
        return score;
      }
    `);
    expect(exports.run()).toBe(110);
  });

  it("rejects a UTF-16 position when the receiver is not proven ASCII", async () => {
    for (const source of [
      `export function run(text: string): boolean { return text.includes("x", 1); }`,
      `export function run(): boolean { const text = "é".repeat(2); return text.includes("é", 1); }`,
    ]) {
      const result = await compile(source, { target: "linear" });
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain(
        "receiver needs a compile-time ASCII proof",
      );
    }
  });
});
