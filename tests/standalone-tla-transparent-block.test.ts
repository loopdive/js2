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
});
