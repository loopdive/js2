// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

describe("#1058 dynamically materialized namespace exports through a circular barrel", () => {
  it("keeps the named namespace import initialized when a member replaces itself", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { run } from "./barrel.js";
          export function test(): number { return run(); }
        `,
        "./barrel.ts": `
          export * from "./core.js";
          export * from "./debug.js";
          export * from "./visitor.js";
        `,
        "./core.ts": `
          export function noop(): void {}
        `,
        "./debug.ts": `
          import { noop } from "./barrel.js";

          export namespace Debug {
            type AssertionKey = "assertEachNode";
            const assertionCache: { [key: string]: { assertion: unknown } | undefined } = {};

            function shouldAssertFunction(name: AssertionKey): boolean {
              assertionCache[name] = { assertion: Debug[name] };
              (Debug as any)[name] = noop;
              return false;
            }

            export function assertEachNode(nodes: readonly number[]): void;
            export function assertEachNode(nodes: number[]): void;
            export function assertEachNode(nodes: readonly number[] | undefined): void;
            export function assertEachNode(nodes: readonly number[] | undefined): void {
              if (shouldAssertFunction("assertEachNode")) {
                if (nodes === undefined || nodes.length !== 1) throw new Error("unexpected nodes");
              }
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
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(42);
  });
});
