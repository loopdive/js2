// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#1058 namespace re-export member calls", () => {
  it("resolves a namespace member through an export-star barrel", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import * as performance from "./performance-barrel.js";

          export function test(): number {
            performance.mark(2);
            return performance.measure(3);
          }
        `,
        "./performance-barrel.ts": `export * from "./performance.js";`,
        "./performance.ts": `
          let total = 37;

          export function mark(value: number): void {
            total += value;
          }

          export function measure(value: number): number {
            return total + value;
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

});
