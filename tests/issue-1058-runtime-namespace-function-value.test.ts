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

describe("#1058 runtime namespace function values", () => {
  it("initializes top-level aliases from local namespace function values", async () => {
    const result = await compile(`
      namespace tracingEnabled {
        let count = 40;

        export function startTracing(): number {
          return ++count;
        }

        export function dumpLegend(): number {
          return 2;
        }
      }

      export const startTracing: typeof tracingEnabled.startTracing = tracingEnabled.startTracing;
      export const dumpTracingLegend: typeof tracingEnabled.dumpLegend = tracingEnabled.dumpLegend;

      export function test(): number {
        return startTracing() * 100 + dumpTracingLegend();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(4102);
  });

  it("resolves function values from every declaration in a merged local namespace", async () => {
    const result = await compile(`
      namespace N {
        export function first(): number { return 40; }
      }

      namespace N {
        export function second(): number { return 2; }
      }

      const first: typeof N.first = N.first;
      const second: typeof N.second = N.second;

      export function test(): number {
        return first() + second();
      }
    `);

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("resolves a named namespace import alias used as a function value", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { N as ImportedNamespace } from "./barrel.js";

          const f: typeof ImportedNamespace.f = ImportedNamespace.f;
          export function test(): number { return f(); }
        `,
        "./barrel.ts": `export * from "./provider.js";`,
        "./provider.ts": `
          export namespace N {
            export function f(): number { return 42; }
          }
        `,
      },
      "./entry.ts",
      { resolve: { consumerDrivenBarrels: true } },
    );

    const exports = await instantiate(result);
    expect(exports.test()).toBe(42);
  });

  it("keeps a namespace function value separate from a same-named top-level function", async () => {
    const result = await compile(`
      function f(): number { return 2; }

      namespace N {
        export function f(): number { return 40; }
      }

      const topLevelF: typeof f = f;
      const namespaceF: typeof N.f = N.f;

      export function namespaceResult(): number { return namespaceF(); }
      export function topLevelResult(): number { return topLevelF(); }
    `);

    const exports = await instantiate(result);
    expect(exports.namespaceResult()).toBe(40);
    expect(exports.topLevelResult()).toBe(2);
  });
});
