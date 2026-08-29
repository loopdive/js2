// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, wrapExports } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = await compile(source, {
    target: "gc",
    platform: "node",
    nativeStrings: false,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 host collection iterable materialization", () => {
  it("constructs a top-level Map from Object.entries during module initialization", async () => {
    const exports = await compileAndRun(`
      const source = { alpha: 40, beta: 2 };
      const map = new Map(Object.entries(source));

      export function test(): number {
        return (map.get("alpha") ?? 0) + (map.get("beta") ?? 0);
      }

      export function size(): number { return map.size; }
      export function hasAlpha(): boolean { return map.has("alpha"); }

      export function localTest(): number {
        const localSource = { first: 20, second: 22 };
        const local = new Map(Object.entries(localSource));
        return (local.get("first") ?? 0) + (local.get("second") ?? 0);
      }
    `);

    expect(exports.size()).toBe(2);
    expect(exports.hasAlpha()).toBe(1);
    expect(exports.test()).toBe(42);
    expect(exports.localTest()).toBe(42);
  });

  it("constructs a top-level Map from a read-only projected pair table", async () => {
    const exports = await compileAndRun(`
      const entries: [string, string][] = [
        ["alpha", "20"],
        ["beta", "22"],
      ];
      export const names = entries.map(entry => entry[0]);
      const map = new Map(entries);

      export function size(): number { return map.size; }
      export function hasBeta(): boolean { return map.has("beta"); }
      export function projectedCount(): number { return names.length; }
    `);

    expect(exports.size()).toBe(2);
    expect(exports.hasBeta()).toBe(1);
    expect(exports.projectedCount()).toBe(2);
  });

  it("constructs a top-level Set from a dense array during module initialization", async () => {
    const exports = await compileAndRun(`
      const values = [20, 20, 22];
      const set = new Set(values);

      export function size(): number { return set.size; }
      export function hasTwentyTwo(): boolean { return set.has(22); }
    `);

    expect(exports.size()).toBe(2);
    expect(exports.hasTwentyTwo()).toBe(1);
  });

  it("constructs a top-level Set from an unaliased spread-array temporary", async () => {
    const exports = await compileAndRun(`
      const base = ["alpha", "beta"];
      const prefixed = new Set(["node:extra"]);
      const set = new Set([
        ...base,
        ...base.map(value => "node:" + value),
        ...prefixed,
      ]);

      export function size(): number { return set.size; }
      export function hasMappedValue(): boolean { return set.has("node:beta"); }
      export function hasSpreadSetValue(): boolean { return set.has("node:extra"); }
    `);

    expect(exports.size()).toBe(5);
    expect(exports.hasMappedValue()).toBe(1);
    expect(exports.hasSpreadSetValue()).toBe(1);
  });
});
