// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti, type CompileResult } from "../src/index.js";

function expectCompiled(result: CompileResult): Uint8Array {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result.binary;
}

describe("v8x cross-module dynamic receiver", () => {
  it("binds a renamed declaration's TypeScript this parameter from dynamic apply", async () => {
    const result = await compileMulti(
      {
        "target.ts": `
          export function bump(this: any, delta: number): number {
            if (
              this === undefined || this === null ||
              typeof this.base !== "number"
            ) return -1;
            return this.base + delta;
          }
        `,
        "entry.ts": `
          import { bump as targetBump } from "./target.ts";

          const handles: any[] = [targetBump];

          export function probe(): number {
            return handles[0].apply({ base: 41 }, [1]);
          }

          export function capturedProbe(): number {
            const extra = 1;
            function capturedBump(this: any, delta: number): number {
              if (
                this === undefined || this === null ||
                typeof this.base !== "number"
              ) return -1;
              return this.base + delta + extra;
            }
            const capturedHandles: any[] = [capturedBump];
            return capturedHandles[0].apply({ base: 40 }, [1]);
          }
        `,
      },
      "entry.ts",
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
        hostBridge: "always",
      },
      undefined,
      { "entry.ts": { "./target.ts": "target.ts" } },
    );
    const { instance } = await WebAssembly.instantiate(expectCompiled(result), {});

    expect((instance.exports.probe as () => number)()).toBe(42);
    expect((instance.exports.capturedProbe as () => number)()).toBe(42);
  });

  it("keeps an unrenamed import bound to its exact declaration across same-name modules", async () => {
    const result = await compileMulti(
      {
        "target.ts": `
          export function bump(this: any, delta: number): number {
            if (
              this === undefined || this === null ||
              typeof this.base !== "number"
            ) return -1;
            return this.base + delta;
          }
        `,
        "unrelated.ts": `
          export function bump(delta: number): number {
            return 900 + delta;
          }
        `,
        "entry.ts": `
          import { bump } from "./target.ts";

          const handles: any[] = [bump];

          export function probe(): number {
            return handles[0].apply({ base: 41 }, [1]);
          }
        `,
      },
      "entry.ts",
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
        hostBridge: "always",
      },
      undefined,
      { "entry.ts": { "./target.ts": "target.ts" } },
    );
    const { instance } = await WebAssembly.instantiate(expectCompiled(result), {});

    expect((instance.exports.probe as () => number)()).toBe(42);
  });
});
