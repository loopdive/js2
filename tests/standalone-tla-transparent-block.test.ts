// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("standalone top-level await in transparent blocks", () => {
  it("resumes through nested block statements", async () => {
    const result = await compile(
      `
        let state = 0;
        {
          {
            {
              await null;
              state = 1;
            }
          }
        }
        export function test(): number { return state; }
      `,
      {
        target: "standalone",
        fileName: "standalone-tla-transparent-block.ts",
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as WebAssembly.Exports & {
      __module_init?: () => void;
      __drain_microtasks?: () => void;
      test: () => number;
    };
    exports.__module_init?.();
    exports.__drain_microtasks?.();
    expect(exports.test()).toBe(1);
  });

  it.each([
    [
      "await in an if condition",
      `
        let completed = 0;
        const promise = Promise.resolve(true);
        if (await promise) completed += 1;
        export function test(): number { return completed; }
      `,
      1,
    ],
    [
      "await in exported variable declarations",
      `
        const value = 1;
        export var first = await value;
        export var { second = await value } = {};
        export function test(): number { return first + second; }
      `,
      2,
    ],
    [
      "await in a while condition",
      `
        let iterations = 0;
        while (await null) iterations += 1;
        export function test(): number { return iterations; }
      `,
      0,
    ],
  ] as const)("retains established lowering for unsupported graph shape: %s", async (_name, source, expected) => {
    const result = await compile(source, {
      target: "standalone",
      fileName: "standalone-tla-unsupported-graph-shape.ts",
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as WebAssembly.Exports & {
      __module_init?: () => void;
      __drain_microtasks?: () => void;
      test: () => number;
    };
    exports.__module_init?.();
    exports.__drain_microtasks?.();
    expect(exports.test()).toBe(expected);
  });
});
