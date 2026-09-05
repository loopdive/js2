// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#1058 overloaded namespace exports through circular barrels", () => {
  it("calls the implementation declaration instead of an overload signature", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { run } from "./barrel.js";
          export function test(): number { return run(); }
        `,
        "./barrel.ts": `
          export * from "./debug.js";
          export * from "./visitor.js";
        `,
        "./debug.ts": `
          export namespace Debug {
            export function assertEachNode(nodes: readonly number[]): void;
            export function assertEachNode(nodes: number[]): void;
            export function assertEachNode(nodes: readonly number[] | undefined): void;
            export function assertEachNode(nodes: readonly number[] | undefined): void {
              if (nodes === undefined || nodes.length !== 1) throw new Error("unexpected nodes");
            }
          }
        `,
        "./visitor.ts": `
          import { Debug } from "./barrel.js";
          export function run(): number {
            const nodes = [42];
            Debug.assertEachNode(nodes);
            return nodes[0];
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module).some(({ name }) => name.startsWith("__extern_method_call_"))).toBe(false);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(module, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(42);
  });
});
