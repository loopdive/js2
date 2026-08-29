// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, wrapExports } from "../src/index.js";

async function instantiate(result: Awaited<ReturnType<typeof compile>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 host builtin function values", () => {
  it("keeps a conditional Date.now alias callable through an export-star barrel", async () => {
    const result = await compileMulti(
      {
        "./provider.ts": `
          const nativeClock: { now(): number } | undefined = undefined;
          export const timestamp: () => number = nativeClock ? () => nativeClock.now() : Date.now;
        `,
        "./barrel.ts": `export * from "./provider.js";`,
        "./entry.ts": `
          import { timestamp } from "./barrel.js";
          const timeOrigin = timestamp();
          export function test(): number { return timeOrigin; }
        `,
      },
      "./entry.ts",
      {
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
        resolve: { consumerDrivenBarrels: true },
      },
    );

    const originalNow = Date.now;
    try {
      Date.now = () => 123_456_789;
      const exports = await instantiate(result);
      expect(exports.test()).toBe(123_456_789);
    } finally {
      Date.now = originalNow;
    }
  });

  it("calls a fixed-arity builtin static alias from a module global", async () => {
    const result = await compile(`
      const absolute: (value: number) => number = Math.abs;
      const answer = absolute(-42);
      export function test(): number { return answer; }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("widens a compiled-closure binding before a later host-function assignment", async () => {
    const result = await compile(`
      let moduleAbsolute: (value: number) => number = (value) => value + 100;
      moduleAbsolute = Math.abs;

      export function moduleTest(): number { return moduleAbsolute(-2); }

      export function localTest(): number {
        let localAbsolute: (value: number) => number = (value) => value + 100;
        localAbsolute = Math.abs;
        return localAbsolute(-2);
      }
    `);

    const exports = await instantiate(result);
    expect(exports.moduleTest()).toBe(2);
    expect(exports.localTest()).toBe(2);
  });

  it("does not reinterpret a shadowed builtin namespace as a host object", async () => {
    const result = await compile(`
      const Date = { now: () => 42 };
      const timestamp: () => number = Date.now;
      export function test(): number { return timestamp(); }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });
});
